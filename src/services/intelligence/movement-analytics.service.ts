import { prisma } from "../../lib/prisma.js";
import { inventoryConfig } from "../../config/inventory.js";
import type { MovementStatus } from "../../config/inventory.js";
import { daysBetween, movementStatusForProduct } from "./inventory-status.service.js";

export interface SalesVelocity {
  averageDailySales: number;
  averageWeeklySales: number;
  averageMonthlySales: number;
  soldUnits30Days: number;
  lastSaleDate: Date | null;
  daysSinceLastSale: number | null;
}

/**
 * Sales velocity computed ONLY from outbound sales (Sale/SaleItem). Purchases,
 * adjustments and transfers are never treated as sales.
 */
export async function getSalesVelocity(params: {
  organizationId: string;
  productId: string;
  branchId?: string;
  now?: Date;
}): Promise<SalesVelocity> {
  const now = params.now ?? new Date();
  const since30 = new Date(now);
  since30.setDate(since30.getDate() - 30);
  const since7 = new Date(now);
  since7.setDate(since7.getDate() - 7);

  const branchFilter = params.branchId ? { branchId: params.branchId } : {};

  const [sum30, sum7, last] = await Promise.all([
    prisma.saleItem.aggregate({
      where: {
        productId: params.productId,
        sale: { organizationId: params.organizationId, ...branchFilter, createdAt: { gte: since30 } },
      },
      _sum: { quantity: true },
    }),
    prisma.saleItem.aggregate({
      where: {
        productId: params.productId,
        sale: { organizationId: params.organizationId, ...branchFilter, createdAt: { gte: since7 } },
      },
      _sum: { quantity: true },
    }),
    prisma.saleItem.findFirst({
      where: { productId: params.productId, sale: { organizationId: params.organizationId, ...branchFilter } },
      orderBy: { sale: { createdAt: "desc" } },
      select: { sale: { select: { createdAt: true } } },
    }),
  ]);

  const sold30 = sum30._sum.quantity ?? 0;
  const sold7 = sum7._sum.quantity ?? 0;
  const lastSaleDate = last?.sale.createdAt ?? null;

  return {
    averageDailySales: sold30 / 30,
    averageWeeklySales: sold7 / 7,
    averageMonthlySales: sold30,
    soldUnits30Days: sold30,
    lastSaleDate,
    daysSinceLastSale: lastSaleDate === null ? null : daysBetween(lastSaleDate, now),
  };
}

export interface MovementClassification {
  status: MovementStatus;
  averageDailySales: number;
  soldUnits30Days: number;
  daysSinceLastSale: number | null;
}

/** Combines velocity + centralized thresholds into a single status. */
export async function classifyProductMovement(params: {
  organizationId: string;
  productId: string;
  branchId?: string;
  availableUnits: number;
}): Promise<MovementClassification> {
  const velocity = await getSalesVelocity(params);
  const status = movementStatusForProduct({
    averageDailySales: velocity.averageDailySales,
    daysSinceLastSale: velocity.daysSinceLastSale,
    availableUnits: params.availableUnits,
    soldUnitsInWindow: velocity.soldUnits30Days,
  });
  return {
    status,
    averageDailySales: velocity.averageDailySales,
    soldUnits30Days: velocity.soldUnits30Days,
    daysSinceLastSale: velocity.daysSinceLastSale,
  };
}

export interface PricePoint {
  batchId: string;
  batchNumber: string;
  purchasePrice: number;
  mrp: number;
  supplierId: string | null;
  supplierName: string | null;
  receivedAt: Date;
}

/**
 * Purchase price history for a medicine, derived from its batches (the batch
 * remains the historical source of the actual purchase price).
 */
export async function getPurchasePriceHistory(params: {
  organizationId: string;
  productId: string;
  branchId?: string;
  limit?: number;
}): Promise<PricePoint[]> {
  const batches = await prisma.batch.findMany({
    where: {
      organizationId: params.organizationId,
      productId: params.productId,
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
    include: { supplier: { select: { id: true, name: true } } },
    orderBy: { receivedAt: "desc" },
    take: params.limit ?? 25,
  });
  return batches.map(b => ({
    batchId: b.id,
    batchNumber: b.batchNumber,
    purchasePrice: Number(b.purchasePrice),
    mrp: Number(b.mrp),
    supplierId: b.supplier?.id ?? null,
    supplierName: b.supplier?.name ?? null,
    receivedAt: b.receivedAt,
  }));
}

/** Variance between the two most recent purchase prices (per unit). */
export function priceVariance(current: number, previous: number): {
  difference: number;
  variancePct: number | null;
} {
  if (previous === 0) {
    return { difference: current - previous, variancePct: null };
  }
  return {
    difference: Math.round((current - previous) * 100) / 100,
    variancePct: Math.round(((current - previous) / previous) * 10000) / 100,
  };
}

/** Convenience export so callers keep thresholds centralized. */
export { inventoryConfig };
