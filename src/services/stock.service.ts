import { Prisma, PrismaClient } from "@prisma/client";
import { AppError } from "../domain/errors.js";

/**
 * Atomic, concurrency-safe stock mutations.
 *
 * Batch balances are changed ONLY through conditional update statements
 * (compare-and-swap) so that two concurrent operators can never silently
 * overwrite each other, and a decrease can never drive a batch negative.
 *
 *   User A reads 100, User B reads 100
 *   A: UPDATE ... WHERE quantity >= 30  → ok, 70
 *   B: UPDATE ... WHERE quantity >= 30  → 0 rows, throws → rolled back
 *
 * Every mutation ALSO writes an immutable InventoryMovement row.
 */

export type TxClient = Prisma.TransactionClient;
export type DbClient = PrismaClient | Prisma.TransactionClient;

export interface StockMutation {
  organizationId: string;
  branchId: string;
  productId: string;
  batchId: string;
  /** Signed delta in base units (positive = in, negative = out). */
  delta: number;
  type:
    | "PURCHASE"
    | "SALE"
    | "SALE_RETURN"
    | "PURCHASE_RETURN"
    | "ADJUSTMENT"
    | "TRANSFER_IN"
    | "TRANSFER_OUT"
    | "OPENING_STOCK"
    | "EXPIRED"
    | "DAMAGED";
  referenceType?: string;
  referenceId?: string;
  note?: string;
  userId?: string;
  unitCost?: number;
}

/**
 * Applies a positive (inbound) stock change atomically. Returns the
 * before/after quantities for the movement record.
 * Uses atomic increment to avoid race conditions.
 */
export async function addStock(
  tx: TxClient,
  params: StockMutation,
): Promise<{ beforeQty: number; afterQty: number }> {
  if (!Number.isInteger(params.delta) || params.delta <= 0) {
    throw new AppError("Inbound quantity must be a positive integer.", 400, "VALIDATION");
  }

  // Atomic increment using conditional update to avoid race conditions
  const result = await tx.batch.update({
    where: { id: params.batchId },
    data: { quantity: { increment: params.delta } },
    select: { quantity: true },
  });

  if (!result) throw new AppError("Batch not found.", 404, "NOT_FOUND");

  const afterQty = result.quantity;
  const beforeQty = afterQty - params.delta;

  await createMovement(tx, { ...params, beforeQty, afterQty });
  return { beforeQty, afterQty };
}

/**
 * Applies a negative (outbound) stock change atomically. The conditional
 * update prevents both negative balances and lost updates. Returns the
 * before/after quantities for the movement record.
 */
export async function removeStock(
  tx: TxClient,
  params: StockMutation,
): Promise<{ beforeQty: number; afterQty: number }> {
  if (!Number.isInteger(params.delta) || params.delta >= 0) {
    throw new AppError("Outbound quantity must be a negative integer.", 400, "VALIDATION");
  }
  const remove = Math.abs(params.delta);

  const result = await tx.batch.updateMany({
    where: { id: params.batchId, quantity: { gte: remove } },
    data: { quantity: { decrement: remove } },
  });
  if (result.count !== 1) {
    const batch = await tx.batch.findUnique({ where: { id: params.batchId } });
    const onHand = batch?.quantity ?? 0;
    throw new AppError(
      `Cannot remove ${remove} ${params.organizationId ? "units" : "units"}: batch has only ${onHand} on hand.`,
      400,
      "INSUFFICIENT_STOCK",
    );
  }

  const after = await tx.batch.findUnique({
    where: { id: params.batchId },
    select: { quantity: true },
  });
  const afterQty = after?.quantity ?? 0;
  const beforeQty = afterQty + remove;
  await createMovement(tx, { ...params, beforeQty, afterQty });
  return { beforeQty, afterQty };
}

async function createMovement(
  tx: TxClient,
  m: StockMutation & { beforeQty: number; afterQty: number },
) {
  await tx.inventoryMovement.create({
    data: {
      organizationId: m.organizationId,
      branchId: m.branchId,
      productId: m.productId,
      batchId: m.batchId,
      type: m.type,
      quantity: m.delta,
      beforeQty: m.beforeQty,
      afterQty: m.afterQty,
      unitCost: m.unitCost ?? 0,
      referenceType: m.referenceType,
      referenceId: m.referenceId,
      note: m.note,
      userId: m.userId,
    },
  });
}
