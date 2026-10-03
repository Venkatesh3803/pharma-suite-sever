import { prisma } from "../lib/prisma.js";
import { AppError } from "../domain/errors.js";
import { createSale } from "./sale.service.js";

export { createSale };
export type { SaleItemInput, CreateSaleInput } from "./sale.service.js";

export interface CustomerInput {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
}

export async function listCustomers(params: {
  organizationId: string;
  search?: string;
  page: number;
  pageSize: number;
}) {
  const { organizationId } = params;
  const where = {
    organizationId,
    ...(params.search
      ? {
          OR: [
            { name: { contains: params.search, mode: "insensitive" as const } },
            { phone: { contains: params.search } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.customer.count({ where }),
  ]);
  return { items, total };
}

export async function getCustomer(organizationId: string, id: string) {
  const customer = await prisma.customer.findFirst({
    where: { id, organizationId },
    include: {
      sales: {
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { items: { include: { product: true } } },
      },
      prescriptions: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!customer) throw new AppError("Customer not found.", 404, "NOT_FOUND");

  // Frequently purchased products
  const freq = await prisma.saleItem.groupBy({
    by: ["productId"],
    where: { sale: { customerId: customer.id } },
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: 8,
  });
  const productIds = freq.map(f => f.productId);
  const products = productIds.length
    ? await prisma.product.findMany({ where: { id: { in: productIds } } })
    : [];
  const productMap = new Map(products.map(p => [p.id, p]));

  const frequentlyPurchased = freq
    .map(f => ({
      productId: f.productId,
      totalQuantity: f._sum.quantity ?? 0,
      product: productMap.get(f.productId) ?? null,
    }))
    .filter(f => f.product);

  return {
    ...customer,
    frequentlyPurchased,
    lastPurchase: customer.sales[0] ?? null,
    purchaseFrequency: customer.sales.length,
  };
}

export async function createCustomer(
  organizationId: string,
  input: CustomerInput,
) {
  return prisma.customer.create({
    data: { ...input, organizationId },
  });
}

export async function updateCustomer(
  organizationId: string,
  id: string,
  input: Partial<CustomerInput>,
) {
  const existing = await prisma.customer.findFirst({
    where: { id, organizationId },
  });
  if (!existing) throw new AppError("Customer not found.", 404, "NOT_FOUND");
  return prisma.customer.update({ where: { id }, data: input });
}

export async function deleteCustomer(organizationId: string, id: string) {
  const existing = await prisma.customer.findFirst({
    where: { id, organizationId },
  });
  if (!existing) throw new AppError("Customer not found.", 404, "NOT_FOUND");
  await prisma.customer.delete({ where: { id } });
  return { id };
}