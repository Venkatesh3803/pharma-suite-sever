import { prisma } from "../../lib/prisma";
import { removeStock, type TxClient } from "../stock.service";
import { AppError } from "../../domain/errors";

export interface FefoResult {
  batchId: string;
  productId: string;
  batchNumber: string;
  expiryDate: Date;
  quantity: number;
}

/**
 * First Expired, First Out selection.
 * Returns batches ordered by earliest expiry (valid, non-expired only).
 */
export async function selectFefoBatches(params: {
  organizationId: string;
  branchId: string;
  productId: string;
  quantity: number;
}): Promise<FefoResult[]> {
  const { organizationId, branchId, productId, quantity } = params;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const batches = await prisma.batch.findMany({
    where: {
      organizationId,
      branchId,
      productId,
      quantity: { gt: 0 },
      expiryDate: { gte: today },
    },
    orderBy: [{ expiryDate: "asc" }, { createdAt: "asc" }],
  });

  const selected: FefoResult[] = [];
  let remaining = quantity;

  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = Math.min(batch.quantity, remaining);
    selected.push({
      batchId: batch.id,
      productId: batch.productId,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      quantity: take,
    });
    remaining -= take;
  }

  return selected;
}

/**
 * Returns true if the quantity requested can be fully satisfied from
 * valid (non-expired) batches.
 */
export async function fefoCanFulfill(params: {
  organizationId: string;
  branchId: string;
  productId: string;
  quantity: number;
}): Promise<boolean> {
  const selected = await selectFefoBatches(params);
  const total = selected.reduce((sum, b) => sum + b.quantity, 0);
  return total >= params.quantity;
}

/**
 * FEFO allocation within an existing transaction.
 * Returns allocations covering `quantity` base units; throws
 * INSUFFICIENT_STOCK (rolling back the transaction) when valid stock is
 * insufficient. Expired batches are never selected.
 */
export async function allocateStockUsingFEFO(
  tx: TxClient,
  params: {
    organizationId: string;
    branchId: string;
    productId: string;
    quantity: number;
  },
): Promise<FefoResult[]> {
  const { organizationId, branchId, productId, quantity } = params;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const batches = await tx.batch.findMany({
    where: {
      organizationId,
      branchId,
      productId,
      quantity: { gt: 0 },
      expiryDate: { gte: today },
    },
    orderBy: [{ expiryDate: "asc" }, { createdAt: "asc" }],
  });

  const selected: FefoResult[] = [];
  let remaining = quantity;

  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = Math.min(batch.quantity, remaining);
    selected.push({
      batchId: batch.id,
      productId: batch.productId,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      quantity: take,
    });
    remaining -= take;
  }

  if (remaining > 0) {
    throw new AppError(
      `Insufficient stock. Requested ${quantity} units, only ${quantity - remaining} available.`,
      400,
      "INSUFFICIENT_STOCK",
    );
  }

  return selected;
}

/**
 * FEFO consumption: allocate across batches and atomically deduct each batch
 * balance (conditional updates prevent lost updates / negative stock), writing
 * one InventoryMovement per batch.
 *
 * This is the reusable contract the future Sales/POS module should call instead
 * of manipulating batch quantities directly.
 */
export async function consumeStockUsingFEFO(
  tx: TxClient,
  params: {
    organizationId: string;
    branchId: string;
    productId: string;
    quantity: number;
    movementType:
      | "SALE"
      | "PURCHASE_RETURN"
      | "TRANSFER_OUT"
      | "DAMAGED"
      | "EXPIRED"
      | "ADJUSTMENT";
    referenceType?: string;
    referenceId?: string;
    note?: string;
    userId?: string;
  },
): Promise<FefoResult[]> {
  const allocations = await allocateStockUsingFEFO(tx, params);

  for (const alloc of allocations) {
    await removeStock(tx, {
      organizationId: params.organizationId,
      branchId: params.branchId,
      productId: params.productId,
      batchId: alloc.batchId,
      delta: -alloc.quantity,
      type: params.movementType,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      note: params.note,
      userId: params.userId,
    });
  }

  return allocations;
}

/**
 * Total sellable (non-expired) stock for a medicine at a branch, in base units.
 */
export async function sellableStock(params: {
  organizationId: string;
  productId: string;
  branchId?: string;
}): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const agg = await prisma.batch.aggregate({
    where: {
      organizationId: params.organizationId,
      productId: params.productId,
      ...(params.branchId ? { branchId: params.branchId } : {}),
      quantity: { gt: 0 },
      expiryDate: { gte: today },
    },
    _sum: { quantity: true },
  });
  return agg._sum.quantity ?? 0;
}