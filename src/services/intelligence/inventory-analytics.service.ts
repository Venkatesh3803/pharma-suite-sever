import { prisma } from "../../lib/prisma";

export async function inventoryValue(params: {
  organizationId: string;
  branchId?: string;
}) {
  const { organizationId, branchId } = params;
  const batches = await prisma.batch.findMany({
    where: {
      organizationId,
      ...(branchId ? { branchId } : {}),
      quantity: { gt: 0 },
    },
    select: {
      quantity: true,
      purchasePrice: true,
      sellingPrice: true,
      mrp: true,
    },
  });

  const costValue = batches.reduce(
    (sum, b) => sum + Number(b.purchasePrice) * b.quantity,
    0,
  );
  const retailValue = batches.reduce(
    (sum, b) => sum + Number(b.sellingPrice) * b.quantity,
    0,
  );
  const mrpValue = batches.reduce(
    (sum, b) => sum + Number(b.mrp) * b.quantity,
    0,
  );
  const totalUnits = batches.reduce((sum, b) => sum + b.quantity, 0);

  return {
    costValue,
    retailValue,
    mrpValue,
    totalUnits,
    batchCount: batches.length,
  };
}

export async function lowStockItems(params: {
  organizationId: string;
  branchId?: string;
  limit?: number;
}) {
  const { organizationId, branchId, limit = 1000 } = params;
  const batches = await prisma.batch.findMany({
    where: {
      organizationId,
      ...(branchId ? { branchId } : {}),
      quantity: { gt: 0, lte: 15 },
    },
    include: { product: true, branch: true },
    orderBy: { quantity: "asc" },
    take: limit,
  });
  return {
    count: batches.length,
    items: batches.map(b => ({
      id: b.id,
      productId: b.productId,
      productBrand: b.product.brand,
      genericName: b.product.genericName,
      strength: b.product.strength,
      batchNumber: b.batchNumber,
      quantity: b.quantity,
      expiryDate: b.expiryDate,
      branch: { id: b.branch.id, name: b.branch.name },
    })),
  };
}

/** Sum of quantities on-hand that are already expired. */
export async function expiredStockUnits(params: {
  organizationId: string;
  branchId?: string;
}) {
  const { organizationId, branchId } = params;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const batches = await prisma.batch.findMany({
    where: {
      organizationId,
      ...(branchId ? { branchId } : {}),
      quantity: { gt: 0 },
      expiryDate: { lt: today },
    },
  });
  return {
    batches: batches.length,
    units: batches.reduce((s, b) => s + b.quantity, 0),
    costValue: batches.reduce(
      (s, b) => s + Number(b.purchasePrice) * b.quantity,
      0,
    ),
  };
}