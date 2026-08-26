import { prisma } from "../../lib/prisma";

export interface DeadStockItem {
  productId: string;
  productBrand: string;
  genericName: string | null;
  strength: string | null;
  product: {
    id: string;
    brand: string;
    genericName: string | null;
    strength: string | null;
    packSize: string | null;
  };
  branch: { id: string; name: string };
  batchNumber: string;
  expiryDate: Date;
  stock: number;
  lastSaleDate: Date | null;
  daysInactive: number;
  inventoryValue: number;
}

export async function detectDeadStock(params: {
  organizationId: string;
  branchId?: string;
  inactiveDays?: number;
  page?: number;
  pageSize?: number;
}): Promise<{ items: DeadStockItem[]; total: number; trappedCapital: number }> {
  const {
    organizationId,
    branchId,
    inactiveDays = 60,
    page = 1,
    pageSize = 50,
  } = params;

  const inactiveSince = new Date();
  inactiveSince.setDate(inactiveSince.getDate() - inactiveDays);

  const branchFilter = branchId ? { branchId } : {};

  // Find products that have NO sales in the inactive window
  const soldProducts = await prisma.saleItem.findMany({
    where: {
      sale: {
        organizationId,
        createdAt: { gte: inactiveSince },
      },
    },
    distinct: ["productId"],
    select: { productId: true },
  });
  const soldProductIds = new Set(soldProducts.map(s => s.productId));

  const where = {
    organizationId,
    ...branchFilter,
    quantity: { gt: 0 },
  };
  const batches = await prisma.batch.findMany({
    where,
    include: { product: true, branch: true },
    orderBy: { expiryDate: "asc" },
  });

  const dead: DeadStockItem[] = [];

  for (const batch of batches) {
    if (soldProductIds.has(batch.productId)) continue;

    // Find last sale date ever for this product
    const lastSale = await prisma.saleItem.findFirst({
      where: { productId: batch.productId },
      orderBy: { sale: { createdAt: "desc" } },
      select: { sale: { select: { createdAt: true } } },
    });
    const lastSaleDate = lastSale?.sale.createdAt ?? null;
    const daysInactive =
      lastSaleDate === null
        ? inactiveDays + 1
        : Math.floor(
            (Date.now() - lastSaleDate.getTime()) / 86400000,
          );

    dead.push({
      productId: batch.productId,
      productBrand: batch.product.brand,
      genericName: batch.product.genericName,
      strength: batch.product.strength,
      product: {
        id: batch.product.id,
        brand: batch.product.brand,
        genericName: batch.product.genericName,
        strength: batch.product.strength,
        packSize: batch.product.packSize,
      },
      branch: { id: batch.branch.id, name: batch.branch.name },
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      stock: batch.quantity,
      lastSaleDate,
      daysInactive,
      inventoryValue: Number(batch.sellingPrice) * batch.quantity,
    });
  }

  dead.sort((a, b) => b.inventoryValue - a.inventoryValue);
  const total = dead.length;
  const trappedCapital = dead.reduce((sum, d) => sum + d.inventoryValue, 0);

  return {
    items: dead.slice((page - 1) * pageSize, page * pageSize),
    total,
    trappedCapital,
  };
}

export async function deadStockSummary(params: {
  organizationId: string;
  branchId?: string;
  inactiveDays?: number;
}) {
  const full = await detectDeadStock({ ...params, pageSize: 100000 });
  return {
    count: full.total,
    trappedCapital: full.trappedCapital,
    averageDaysInactive: full.items.length
      ? Math.round(
          full.items.reduce((sum, d) => sum + d.daysInactive, 0) /
            full.items.length,
        )
      : 0,
  };
}