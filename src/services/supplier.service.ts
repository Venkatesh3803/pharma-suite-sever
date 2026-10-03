import { prisma } from "../lib/prisma.js";
import { AppError } from "../domain/errors.js";

export interface SupplierInput {
  name: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  gstin?: string;
  address?: string;
  paymentTerms?: string;
  leadTimeDays?: number;
  isActive?: boolean;
}

async function nextVendorCode(organizationId: string) {
  const count = await prisma.supplier.count({ where: { organizationId } });
  return `VEN-${String(count + 1).padStart(4, "0")}`;
}

export async function listSuppliers(params: {
  organizationId: string;
  search?: string;
  isActive?: boolean;
  page: number;
  pageSize: number;
}) {
  const { organizationId } = params;
  const where = {
    organizationId,
    ...(params.isActive === undefined
      ? {}
      : { isActive: params.isActive }),
    ...(params.search
      ? {
          OR: [
            { name: { contains: params.search, mode: "insensitive" as const } },
            { code: { contains: params.search, mode: "insensitive" as const } },
            {
              contactPerson: {
                contains: params.search,
                mode: "insensitive" as const,
              },
            },
            { phone: { contains: params.search, mode: "insensitive" as const } },
            { gstin: { contains: params.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.supplier.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.supplier.count({ where }),
  ]);

  const supplierIds = items.map(s => s.id);
  const [valueAgg, openAgg, lastAgg] = await Promise.all([
    prisma.purchase.groupBy({
      by: ["supplierId"],
      where: { organizationId, supplierId: { in: supplierIds } },
      _sum: { total: true },
      _count: { _all: true },
    }),
    prisma.purchase.groupBy({
      by: ["supplierId"],
      where: {
        organizationId,
        supplierId: { in: supplierIds },
        status: { notIn: ["RECEIVED", "COMPLETED", "CANCELLED"] },
      },
      _count: { _all: true },
    }),
    prisma.purchase.groupBy({
      by: ["supplierId"],
      where: { organizationId, supplierId: { in: supplierIds } },
      _max: { createdAt: true },
    }),
  ]);

  const valueMap = new Map(valueAgg.map(v => [v.supplierId, v]));
  const openMap = new Map(openAgg.map(v => [v.supplierId, v]));
  const lastMap = new Map(lastAgg.map(v => [v.supplierId, v]));

  return {
    items: items.map(s => ({
      ...s,
      totalPurchased: Number(valueMap.get(s.id)?._sum.total ?? 0),
      purchaseCount: valueMap.get(s.id)?._count._all ?? 0,
      openOrders: openMap.get(s.id)?._count._all ?? 0,
      lastPurchase: lastMap.get(s.id)?._max.createdAt ?? null,
    })),
    total,
  };
}

export async function getSupplier(organizationId: string, id: string) {
  const supplier = await prisma.supplier.findFirst({
    where: { id, organizationId },
    include: {
      vendorMedicines: { include: { product: true } },
      purchases: {
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { items: true, branch: true },
      },
    },
  });
  if (!supplier) throw new AppError("Supplier not found.", 404, "NOT_FOUND");
  return supplier;
}

export async function createSupplier(
  organizationId: string,
  input: SupplierInput,
) {
  const code = await nextVendorCode(organizationId);
  return prisma.supplier.create({
    data: {
      ...input,
      organizationId,
      code,
      leadTimeDays: input.leadTimeDays ?? 7,
    },
  });
}

export async function updateSupplier(
  organizationId: string,
  id: string,
  input: Partial<SupplierInput>,
) {
  const existing = await prisma.supplier.findFirst({
    where: { id, organizationId },
  });
  if (!existing) throw new AppError("Supplier not found.", 404, "NOT_FOUND");
  return prisma.supplier.update({ where: { id }, data: input });
}

export async function setPreferredVendor(
  organizationId: string,
  productId: string,
  vendorId: string,
) {
  await prisma.$transaction(async tx => {
    await tx.vendorMedicine.updateMany({
      where: { organizationId, productId, isPreferred: true },
      data: { isPreferred: false },
    });
    await tx.vendorMedicine.upsert({
      where: { organizationId_vendorId_productId: { organizationId, vendorId, productId } },
      create: { organizationId, vendorId, productId, isPreferred: true },
      update: { isPreferred: true },
    });
  });
  return { preferredVendorId: vendorId };
}