import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../domain/errors.js";

export interface ProductInput {
  brand: string;
  genericName?: string;
  manufacturer?: string;
  strength?: string;
  dosageForm?: string;
  packSize?: string;
  barcode?: string;
  hsnCode?: string;
  gstRate?: number;
  prescriptionRequired?: boolean;
  categoryId?: string;
  unitConfig?: Record<string, unknown>;
}

function buildWhere(params: {
  organizationId: string;
  search?: string;
  categoryId?: string;
  prescriptionRequired?: boolean;
  branchId?: string;
  active?: boolean;
}) {
  const { organizationId, search, categoryId, prescriptionRequired, active } = params;
  return {
    organizationId,
    deletedAt: null,
    ...(active !== undefined ? { isActive: active } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(prescriptionRequired !== undefined
      ? { prescriptionRequired }
      : {}),
    ...(search
      ? {
          OR: [
            { brand: { contains: search, mode: "insensitive" as const } },
            {
              genericName: {
                contains: search,
                mode: "insensitive" as const,
              },
            },
            { barcode: { contains: search, mode: "insensitive" as const } },
            { manufacturer: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
}

export async function listProducts(params: {
  organizationId: string;
  search?: string;
  categoryId?: string;
  prescriptionRequired?: boolean;
  branchId?: string;
  page: number;
  pageSize: number;
}) {
  const where = buildWhere(params);
  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: { category: true },
      orderBy: { brand: "asc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.product.count({ where }),
  ]);
  return { items, total };
}

export async function getProduct(organizationId: string, id: string) {
  const product = await prisma.product.findFirst({
    where: { id, organizationId, deletedAt: null },
    include: {
      category: true,
      batches: {
        include: { branch: true, supplier: true },
        orderBy: { expiryDate: "asc" },
      },
    },
  });
  if (!product) throw new AppError("Product not found.", 404, "NOT_FOUND");
  return product;
}

export async function createProduct(
  organizationId: string,
  input: ProductInput,
) {
  return prisma.product.create({
    data: {
      organizationId,
      brand: input.brand,
      genericName: input.genericName,
      manufacturer: input.manufacturer,
      strength: input.strength,
      dosageForm: input.dosageForm,
      packSize: input.packSize,
      barcode: input.barcode,
      hsnCode: input.hsnCode,
      gstRate: input.gstRate ?? 0,
      prescriptionRequired: input.prescriptionRequired ?? false,
      categoryId: input.categoryId,
      unitConfig: (input.unitConfig as Prisma.InputJsonValue) ?? "{}",
    },
    include: { category: true },
  });
}

export async function updateProduct(
  organizationId: string,
  id: string,
  input: Partial<ProductInput>,
) {
  const existing = await prisma.product.findFirst({
    where: { id, organizationId, deletedAt: null },
  });
  if (!existing) throw new AppError("Product not found.", 404, "NOT_FOUND");
  const data: Prisma.ProductUpdateInput = {};
  if (input.brand !== undefined) data.brand = input.brand;
  if (input.genericName !== undefined) data.genericName = input.genericName;
  if (input.manufacturer !== undefined) data.manufacturer = input.manufacturer;
  if (input.strength !== undefined) data.strength = input.strength;
  if (input.dosageForm !== undefined) data.dosageForm = input.dosageForm;
  if (input.packSize !== undefined) data.packSize = input.packSize;
  if (input.barcode !== undefined) data.barcode = input.barcode;
  if (input.hsnCode !== undefined) data.hsnCode = input.hsnCode;
  if (input.gstRate !== undefined) data.gstRate = input.gstRate;
  if (input.prescriptionRequired !== undefined) data.prescriptionRequired = input.prescriptionRequired;
  if (input.categoryId !== undefined) data.category = input.categoryId ? { connect: { id: input.categoryId } } : { disconnect: true };
  if (input.unitConfig !== undefined) data.unitConfig = input.unitConfig as Prisma.InputJsonValue;
  return prisma.product.update({
    where: { id },
    data,
    include: { category: true },
  });
}

export async function listCategories(organizationId: string) {
  return prisma.productCategory.findMany({
    where: { organizationId },
    orderBy: { name: "asc" },
  });
}

export async function createCategory(organizationId: string, name: string) {
  const existing = await prisma.productCategory.findFirst({
    where: { organizationId, name: { equals: name, mode: "insensitive" } },
  });
  if (existing) return existing;
  return prisma.productCategory.create({
    data: { organizationId, name },
  });
}

export async function deleteProduct(organizationId: string, id: string) {
  const existing = await prisma.product.findFirst({
    where: { id, organizationId, deletedAt: null },
  });
  if (!existing) throw new AppError("Product not found.", 404, "NOT_FOUND");
  return prisma.product.update({
    where: { id },
    data: { deletedAt: new Date(), isActive: false },
  });
}