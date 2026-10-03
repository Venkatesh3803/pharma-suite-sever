import { prisma } from "../lib/prisma";
import { AppError } from "../domain/errors";
import { Prisma } from "@prisma/client";
import {
  inventoryConfig,
  resolveLowStockThreshold,
  type ExpiryStatus,
  type MovementStatus,
  type StockStatus,
} from "../config/inventory";
import { daysBetween, expiryStatus, stockStatus } from "./intelligence/inventory-status.service";
import { removeStock, addStock } from "./stock.service";
import { parseUnitConfig, formatBaseUnits } from "./units.service";
import {
  classifyProductMovement,
  getSalesVelocity,
  getPurchasePriceHistory,
  priceVariance,
  type SalesVelocity,
} from "./intelligence/movement-analytics.service";
import { sellableStock } from "./intelligence/fefo.service";

export interface AdjustmentInput {
  organizationId: string;
  productId: string;
  branchId: string;
  quantity: number; // +/- delta in base units
  reason: string;
  note?: string;
  userId: string;
}

/**
 * Applies a stock adjustment against the most appropriate batch (FEFO for -)
 * and records an immutable InventoryMovement + AuditLog.
 * Runs inside a transaction.
 */
export async function adjustStock(input: AdjustmentInput) {
  const { organizationId, productId, branchId, quantity, reason, note, userId } = input;

  if (quantity === 0) throw new AppError("Quantity delta cannot be zero.", 400, "VALIDATION");

  return prisma.$transaction(async tx => {
    const prod = await tx.product.findFirst({
      where: { id: productId, organizationId, deletedAt: null },
    });
    if (!prod) throw new AppError("Product not found.", 404, "NOT_FOUND");

    // Validate branch belongs to organization
    const targetBranch = await tx.branch.findFirst({
      where: { id: branchId, organizationId, isActive: true },
    });
    if (!targetBranch) {
      throw new AppError("Branch not found in this workspace.", 404, "NOT_FOUND");
    }

    if (quantity > 0) {
      // Positive adjustment: add to the EARLIEST expiry batch (FEFO consistency)
      const candidate = await tx.batch.findFirst({
        where: { productId, branchId, quantity: { gt: 0 }, expiryDate: { gte: new Date() } },
        orderBy: { expiryDate: "asc" }, // Earliest expiry first (FEFO)
      });
      if (candidate) {
        await addStock(tx, {
          organizationId,
          branchId,
          productId,
          batchId: candidate.id,
          delta: quantity,
          type: "ADJUSTMENT",
          referenceType: "ADJUSTMENT",
          note: reason ?? note,
          userId,
          unitCost: Number(candidate.purchasePrice),
        });
      }
      await tx.auditLog.create({
        data: {
          organizationId,
          branchId,
          userId,
          action: "STOCK_ADJUSTED",
          entityType: "Product",
          entityId: productId,
          metadata: { quantity, reason },
        },
      });
      return { applied: true, organizationId };
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const batches = await tx.batch.findMany({
      where: {
        productId,
        branchId,
        quantity: { gt: 0 },
        expiryDate: { gte: today },
      },
      orderBy: { expiryDate: "asc" },
    });

    let remaining = -quantity;
    for (const batch of batches) {
      if (remaining <= 0) break;
      const take = Math.min(batch.quantity, remaining);
      await removeStock(tx, {
        organizationId,
        branchId,
        productId,
        batchId: batch.id,
        delta: -take,
        type: "ADJUSTMENT",
        referenceType: "ADJUSTMENT",
        note: reason,
        userId,
        unitCost: Number(batch.purchasePrice),
      });
      remaining -= take;
    }

    if (remaining > 0) {
      throw new AppError(
        `Not enough stock to adjust by ${quantity}. Short by ${remaining} units.`,
        400,
        "INSUFFICIENT_STOCK",
      );
    }
    await tx.auditLog.create({
      data: {
        organizationId,
        branchId,
        userId,
        action: "STOCK_ADJUSTED",
        entityType: "Product",
        entityId: productId,
        metadata: { quantity, reason },
      },
    });
    return { applied: true, organizationId };
  });
}

export const ADJUSTMENT_REASONS = [
  "PHYSICAL_COUNT",
  "DAMAGE",
  "LOSS",
  "EXPIRY",
  "DATA_CORRECTION",
  "OPENING_BALANCE",
  "OTHER",
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export interface BatchAdjustmentInput {
  organizationId: string;
  branchId: string;
  batchId: string;
  productId: string;
  quantity: number; // +/- delta in base units
  reason: AdjustmentReason;
  note?: string;
  userId: string;
}

/**
 * Batch-level stock adjustment. Negative adjustments are rejected when they
 * would drive the batch below zero (never clamped silently). Produces a stock
 * movement + audit record in one transaction.
 */
export async function adjustBatchStock(input: BatchAdjustmentInput) {
  const { organizationId, branchId, batchId, productId, quantity, reason, note, userId } = input;

  if (quantity === 0) throw new AppError("Quantity delta cannot be zero.", 400, "VALIDATION");

  return prisma.$transaction(async tx => {
    const batch = await tx.batch.findFirst({
      where: { id: batchId, organizationId, branchId, productId },
    });
    if (!batch) throw new AppError("Batch not found in this workspace.", 404, "NOT_FOUND");

    // Validate branch belongs to organization
    const targetBranch = await tx.branch.findFirst({
      where: { id: branchId, organizationId, isActive: true },
    });
    if (!targetBranch) {
      throw new AppError("Branch not found in this workspace.", 404, "NOT_FOUND");
    }

    if (quantity > 0) {
      await addStock(tx, {
        organizationId,
        branchId,
        productId,
        batchId,
        delta: quantity,
        type: "ADJUSTMENT",
        referenceType: "ADJUSTMENT",
        note: `${reason}${note ? ` — ${note}` : ""}`,
        userId,
        unitCost: Number(batch.purchasePrice),
      });
    } else {
      // Prevent adjustments on expired batches
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (batch.expiryDate < today) {
        throw new AppError("Cannot adjust stock for expired batch.", 400, "VALIDATION");
      }
      await removeStock(tx, {
        organizationId,
        branchId,
        productId,
        batchId,
        delta: quantity,
        type: "ADJUSTMENT",
        referenceType: "ADJUSTMENT",
        note: `${reason}${note ? ` — ${note}` : ""}`,
        userId,
        unitCost: Number(batch.purchasePrice),
      });
    }

    await tx.auditLog.create({
      data: {
        organizationId,
        branchId,
        userId,
        action: "STOCK_ADJUSTED",
        entityType: "Batch",
        entityId: batch.id,
        metadata: { productId, quantity, reason, note },
      },
    });

    return { applied: true, batchId };
  });
}

export interface StockCountInput {
  organizationId: string;
  branchId: string;
  userId: string;
  counts: {
    batchId: string;
    productId: string;
    physicalQuantity: number; // base units counted
  }[];
}

/**
 * Physical stock count. Expected quantities are NEVER overwritten directly;
 * the difference is applied as a controlled adjustment + movement + audit.
 */
export async function applyStockCount(input: StockCountInput) {
  const { organizationId, branchId, userId, counts } = input;

  // Validate branch belongs to organization
  const targetBranch = await prisma.branch.findFirst({
    where: { id: branchId, organizationId, isActive: true },
  });
  if (!targetBranch) {
    throw new AppError("Branch not found in this workspace.", 404, "NOT_FOUND");
  }

  return prisma.$transaction(async tx => {
    const results: {
      batchId: string;
      batchNumber: string;
      expected: number;
      physical: number;
      difference: number;
      applied: boolean;
      message?: string;
    }[] = [];

    for (const count of counts) {
      const batch = await tx.batch.findFirst({
        where: {
          id: count.batchId,
          organizationId,
          branchId,
          productId: count.productId,
        },
      });
      if (!batch) throw new AppError("Batch not found in this workspace.", 404, "NOT_FOUND");

      if (!Number.isInteger(count.physicalQuantity) || count.physicalQuantity < 0) {
        throw new AppError(
          `Physical quantity must be a non-negative integer for batch ${batch.batchNumber}.`,
          400,
          "VALIDATION",
        );
      }

      const expected = batch.quantity;
      const difference = count.physicalQuantity - expected;

      if (difference !== 0) {
        if (difference > 0) {
          await addStock(tx, {
            organizationId,
            branchId,
            productId: count.productId,
            batchId: batch.id,
            delta: difference,
            type: "ADJUSTMENT",
            referenceType: "STOCK_COUNT",
            note: `PHYSICAL_COUNT — expected ${expected}, counted ${count.physicalQuantity}`,
            userId,
            unitCost: Number(batch.purchasePrice),
          });
        } else {
          // Never allow the physical count to drive the batch negative.
          await removeStock(tx, {
            organizationId,
            branchId,
            productId: count.productId,
            batchId: batch.id,
            delta: difference,
            type: "ADJUSTMENT",
            referenceType: "STOCK_COUNT",
            note: `PHYSICAL_COUNT — expected ${expected}, counted ${count.physicalQuantity}`,
            userId,
            unitCost: Number(batch.purchasePrice),
          });
        }
      }

      await tx.auditLog.create({
        data: {
          organizationId,
          branchId,
          userId,
          action: "STOCK_ADJUSTED",
          entityType: "Batch",
          entityId: batch.id,
          metadata: { productId: count.productId, expected, physical: count.physicalQuantity, difference },
        },
      });

      results.push({
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        expected,
        physical: count.physicalQuantity,
        difference,
        applied: difference !== 0,
        message:
          difference === 0
            ? "Count matched, no adjustment needed."
            : `Adjusted by ${difference > 0 ? "+" : ""}${difference} units.`,
      });
    }

    return { results, appliedCount: results.filter(r => r.applied).length };
  });
}

export interface OpeningBatchInput {
  organizationId: string;
  branchId: string;
  productId: string;
  quantity: number;
  batchNumber?: string;
  expiryDate?: string | Date;
  purchasePrice?: number;
  mrp?: number;
  sellingPrice?: number;
  supplierId?: string;
  userId: string;
  note?: string;
}

/**
 * Adds opening stock by creating (or topping up) a batch. This is the
 * "create inventory" path for a brand-new org where no supplier/PO ceremony
 * exists yet: it upserts the batch, credits quantity and writes an
 * OPENING_STOCK movement + audit trail.
 */
export async function addOpeningBatch(input: OpeningBatchInput) {
  const {
    organizationId,
    branchId,
    productId,
    quantity,
    batchNumber,
    expiryDate,
    purchasePrice,
    mrp,
    sellingPrice,
    supplierId,
    userId,
    note,
  } = input;

  if (quantity <= 0) {
    throw new AppError("Quantity must be positive.", 400, "VALIDATION");
  }

  // Validate expiry date is not in the past
  if (expiryDate) {
    const exp = new Date(expiryDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (exp < today) {
      throw new AppError("Expiry date cannot be in the past.", 400, "VALIDATION");
    }
  }

  // Validate branch belongs to organization
  const targetBranch = await prisma.branch.findFirst({
    where: { id: branchId, organizationId, isActive: true },
  });
  if (!targetBranch) {
    throw new AppError("Branch not found in this workspace.", 404, "NOT_FOUND");
  }

  const product = await prisma.product.findFirst({
    where: { id: productId, organizationId, deletedAt: null },
  });
  if (!product) throw new AppError("Product not found.", 404, "NOT_FOUND");

  const batchId = batchNumber ?? `OB-${Date.now().toString(36).toUpperCase()}`;

  return prisma.$transaction(async tx => {
    // Use upsert for atomic upsert with race condition handling
    const batch = await tx.batch.upsert({
      where: {
        organizationId_branchId_productId_batchNumber: {
          organizationId,
          branchId,
          productId,
          batchNumber: batchId,
        },
      },
      create: {
        organizationId,
        branchId,
        productId,
        batchNumber: batchId,
        quantity,
        expiryDate: expiryDate ? new Date(expiryDate) : new Date(),
        purchasePrice: new Prisma.Decimal(purchasePrice ?? 0),
        mrp: new Prisma.Decimal(mrp ?? 0),
        sellingPrice: new Prisma.Decimal(sellingPrice ?? (mrp ?? 0) * 0.8),
        supplierId: supplierId ?? null,
      },
      update: {
        quantity: { increment: quantity },
        ...(purchasePrice !== undefined ? { purchasePrice: new Prisma.Decimal(purchasePrice) } : {}),
        ...(mrp !== undefined ? { mrp: new Prisma.Decimal(mrp) } : {}),
        ...(sellingPrice !== undefined ? { sellingPrice: new Prisma.Decimal(sellingPrice) } : {}),
        ...(expiryDate ? { expiryDate: new Date(expiryDate) } : {}),
        ...(supplierId ? { supplierId } : {}),
      },
    });

    const beforeQty = batch.quantity - quantity;
    const afterQty = batch.quantity;
    const created = beforeQty === 0; // If beforeQty is 0, it was newly created

    await tx.inventoryMovement.create({
      data: {
        organizationId,
        branchId,
        productId,
        batchId: batch.id,
        type: "OPENING_STOCK",
        quantity,
        beforeQty,
        afterQty,
        unitCost: purchasePrice ?? Number(batch.purchasePrice),
        referenceType: "OPENING_BALANCE",
        userId,
        note: note ?? null,
      },
    });

    await tx.auditLog.create({
      data: {
        organizationId,
        branchId,
        userId,
        action: "BATCH_CREATED",
        entityType: "Batch",
        entityId: batch.id,
        metadata: { productId, batchNumber: batchId, quantity },
      },
    });

    return { batch, created, beforeQty, afterQty };
  });
}

/* ---------------------------------------------------------------------------
 * Read models
 * ------------------------------------------------------------------------- */

export interface InventoryListItem {
  productId: string;
  brand: string;
  genericName: string | null;
  manufacturer: string | null;
  strength: string | null;
  dosageForm: string | null;
  packSize: string | null;
  category: { id: string; name: string } | null;
  barcode: string | null;
  unitConfig: Record<string, unknown>;
  /** Sellable (non-expired) base units across valid batches. */
  sellableStock: number;
  /** Expired base units still on hand. */
  expiredStock: number;
  totalStock: number;
  batchCount: number;
  nearestExpiry: Date | null;
  nearestExpiryStatus: ExpiryStatus;
  inventoryValue: number;
  stockStatus: StockStatus;
  movementStatus: MovementStatus;
  averageDailySales: number;
  daysOfCover: number | null;
  stockDisplay: string;
}

export interface InventoryListFilters {
  organizationId: string;
  branchId?: string;
  search?: string;
  categoryId?: string;
  manufacturer?: string;
  supplierId?: string;
  stockStatus?: StockStatus;
  expiryRisk?: ExpiryStatus;
  movementStatus?: MovementStatus;
  page: number;
  pageSize: number;
}

export async function listInventoryItems(filters: InventoryListFilters) {
  const {
    organizationId,
    branchId,
    search,
    categoryId,
    manufacturer,
    supplierId,
    stockStatus: stockFilter,
    expiryRisk: expiryFilter,
    movementStatus: movementFilter,
    page,
    pageSize,
  } = filters;

  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  const lowStockThreshold = resolveLowStockThreshold(org?.settings);
  const branchFilter = branchId ? { branchId } : {};

  // Candidate products (DB-level text/category/manufacturer/supplier filters).
  const productWhere: Prisma.ProductWhereInput = {
    organizationId,
    deletedAt: null,
    ...(categoryId ? { categoryId } : {}),
    ...(manufacturer ? { manufacturer: { contains: manufacturer, mode: "insensitive" as const } } : {}),
    ...(supplierId ? { batches: { some: { supplierId, ...branchFilter } } } : {}),
    ...(search
      ? {
          OR: [
            { brand: { contains: search, mode: "insensitive" as const } },
            { genericName: { contains: search, mode: "insensitive" as const } },
            { manufacturer: { contains: search, mode: "insensitive" as const } },
            { barcode: { contains: search, mode: "insensitive" as const } },
            { batches: { some: { ...branchFilter, batchNumber: { contains: search, mode: "insensitive" as const } } } },
          ],
        }
      : {}),
  };

  const products = await prisma.product.findMany({
    where: productWhere,
    include: { category: true },
    orderBy: { brand: "asc" },
  });

  if (products.length === 0) return { items: [], total: 0, page, pageSize };

  const productIds = products.map(p => p.id);

  // All batches for the candidate products in one query.
  const batches = await prisma.batch.findMany({
    where: { organizationId, productId: { in: productIds }, ...branchFilter },
    include: { product: true },
  });

  // Sold units per product (30-day window) — outbound sales only.
  const since = new Date();
  since.setDate(since.getDate() - inventoryConfig.movement.analysisDays);
  const soldAgg = await prisma.saleItem.groupBy({
    by: ["productId"],
    where: { productId: { in: productIds }, sale: { organizationId, ...branchFilter, createdAt: { gte: since } } },
    _sum: { quantity: true },
  });
  const soldByProduct = new Map(soldAgg.map(s => [s.productId, s._sum.quantity ?? 0]));

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const items: InventoryListItem[] = [];

  for (const product of products) {
    const productBatches = batches.filter(b => b.productId === product.id);
    let sellable = 0;
    let expired = 0;
    let value = 0;
    let nearestExpiry: Date | null = null;
    let batchCount = 0;

    for (const batch of productBatches) {
      if (batch.quantity <= 0) continue;
      batchCount += 1;
      const status = expiryStatus(batch.expiryDate, today);
      if (status === "EXPIRED") {
        expired += batch.quantity;
      } else {
        sellable += batch.quantity;
        value += Number(batch.purchasePrice) * batch.quantity;
        if (!nearestExpiry || batch.expiryDate < nearestExpiry) {
          nearestExpiry = batch.expiryDate;
        }
      }
    }

    const soldUnits = soldByProduct.get(product.id) ?? 0;
    const averageDailySales = soldUnits / inventoryConfig.movement.analysisDays;
    const daysOfCover = averageDailySales > 0 ? sellable / averageDailySales : null;

    const stockStatusVal: StockStatus =
      sellable <= 0 && expired > 0
        ? "OUT_OF_STOCK"
        : stockStatus(sellable, lowStockThreshold);

    const movementClass: MovementStatus = await classifyMovement({
      organizationId,
      branchId,
      productId: product.id,
      availableUnits: sellable,
      soldUnits,
      averageDailySales,
    });

    const expiryRisk: ExpiryStatus = nearestExpiry
      ? expiryStatus(nearestExpiry, today)
      : "HEALTHY";

    if (stockFilter && stockStatusVal !== stockFilter) continue;
    if (expiryFilter && expiryRisk !== expiryFilter) continue;
    if (movementFilter && movementClass !== movementFilter) continue;

    const unitConfig = parseUnitConfig(product.unitConfig);
    items.push({
      productId: product.id,
      brand: product.brand,
      genericName: product.genericName,
      manufacturer: product.manufacturer,
      strength: product.strength,
      dosageForm: product.dosageForm,
      packSize: product.packSize,
      category: product.category ? { id: product.category.id, name: product.category.name } : null,
      barcode: product.barcode,
      unitConfig: product.unitConfig as Record<string, unknown>,
      sellableStock: sellable,
      expiredStock: expired,
      totalStock: sellable + expired,
      batchCount,
      nearestExpiry,
      nearestExpiryStatus: expiryRisk,
      inventoryValue: Math.round(value * 100) / 100,
      stockStatus: stockStatusVal,
      movementStatus: movementClass,
      averageDailySales: Math.round(averageDailySales * 100) / 100,
      daysOfCover: daysOfCover === null ? null : Math.round(daysOfCover * 10) / 10,
      stockDisplay: formatBaseUnits(unitConfig, sellable),
    });
  }

  items.sort((a, b) => a.brand.localeCompare(b.brand));
  const total = items.length;
  const paginated = items.slice((page - 1) * pageSize, page * pageSize);

  return { items: paginated, total, page, pageSize };
}

async function classifyMovement(params: {
  organizationId: string;
  branchId?: string;
  productId: string;
  availableUnits: number;
  soldUnits: number;
  averageDailySales: number;
}): Promise<MovementStatus> {
  const classification = await classifyProductMovement(params);
  return classification.status;
}

export async function getInventorySummary(params: {
  organizationId: string;
  branchId?: string;
}) {
  const { organizationId, branchId } = params;
  const branchFilter = branchId ? { branchId } : {};
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  const lowStockThreshold = resolveLowStockThreshold(org?.settings);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const batches = await prisma.batch.findMany({
    where: { organizationId, ...branchFilter, quantity: { gt: 0 } },
    include: { product: true },
  });

  let totalValue = 0;
  let lowStock = 0;
  let outOfStock = 0;
  let expiringSoon = 0;
  let expiredUnits = 0;
  let expiredValue = 0;
  let deadStock = 0;
  const productIds = new Set<string>();
  const expiringProducts = new Set<string>();
  const expiredProducts = new Set<string>();
  const lowStockProducts = new Set<string>();

  // Sellable per product for status classification.
  const sellableByProduct = new Map<string, number>();
  for (const batch of batches) {
    productIds.add(batch.productId);
    const status = expiryStatus(batch.expiryDate, today);
    if (status === "EXPIRED") {
      expiredUnits += batch.quantity;
      expiredValue += Number(batch.purchasePrice) * batch.quantity;
      expiredProducts.add(batch.productId);
      continue;
    }
    totalValue += Number(batch.purchasePrice) * batch.quantity;
    sellableByProduct.set(batch.productId, (sellableByProduct.get(batch.productId) ?? 0) + batch.quantity);
    if (status !== "HEALTHY") {
      expiringSoon += batch.quantity;
      expiringProducts.add(batch.productId);
    }
  }

  const products = productIds.size
    ? await prisma.product.findMany({ where: { id: { in: Array.from(productIds) } } })
    : [];

  for (const product of products) {
    const sellable = sellableByProduct.get(product.id) ?? 0;
    if (sellable <= 0) outOfStock += 1;
    else if (sellable <= lowStockThreshold) {
      lowStock += 1;
      lowStockProducts.add(product.id);
    }
  }

  // Dead stock count (products with no sale in N days AND stock on hand).
  const inactiveSince = new Date();
  inactiveSince.setDate(inactiveSince.getDate() - inventoryConfig.deadStockInactiveDays);
  const soldProducts = await prisma.saleItem.findMany({
    where: { sale: { organizationId, createdAt: { gte: inactiveSince } } },
    distinct: ["productId"],
    select: { productId: true },
  });
  const soldIds = new Set(soldProducts.map(s => s.productId));
  for (const productId of productIds) {
    if (!soldIds.has(productId) && (sellableByProduct.get(productId) ?? 0) > 0) {
      deadStock += 1;
    }
  }

  return {
    totalMedicines: products.length,
    inventoryValue: Math.round(totalValue * 100) / 100,
    lowStock: { count: lowStock, products: lowStockProducts.size },
    outOfStock,
    expiringSoon: { units: expiringSoon, products: expiringProducts.size },
    expired: { units: expiredUnits, value: Math.round(expiredValue * 100) / 100, products: expiredProducts.size },
    deadStock,
    lowStockThreshold,
  };
}

export interface MedicineInventoryDetail {
  product: {
    id: string;
    brand: string;
    genericName: string | null;
    manufacturer: string | null;
    strength: string | null;
    dosageForm: string | null;
    packSize: string | null;
    category: { id: string; name: string } | null;
    unitConfig: Record<string, unknown>;
  };
  branch: { id: string; name: string } | null;
  summary: {
    sellableStock: number;
    sellableDisplay: string;
    expiredStock: number;
    expiredDisplay: string;
    inventoryValue: number;
    nearestExpiry: Date | null;
    nearestExpiryStatus: ExpiryStatus;
    estimatedDaysOfCover: number | null;
    stockStatus: StockStatus;
    lowStockThreshold: number;
  };
  batches: BatchSummaryRow[];
  intelligence: {
    velocity: SalesVelocity;
    movementStatus: MovementStatus;
    daysOfCover: number | null;
    stockoutRisk: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
    reorderSuggestion: number;
    reorderReason: string | null;
    lastSaleDate: Date | null;
  };
  priceHistory: {
    batchId: string;
    batchNumber: string;
    purchasePrice: number;
    mrp: number;
    supplierName: string | null;
    receivedAt: Date;
  }[];
  priceVariance: { difference: number; variancePct: number | null } | null;
}

export interface BatchSummaryRow {
  id: string;
  batchNumber: string;
  expiryDate: Date;
  expiryStatus: ExpiryStatus;
  daysToExpiry: number;
  purchasePrice: number;
  mrp: number;
  sellingPrice: number;
  quantity: number;
  quantityDisplay: string;
  supplier: { id: string; name: string } | null;
  branch: { id: string; name: string } | null;
  status: "ACTIVE" | "EXPIRED" | "EMPTY";
}

export async function getMedicineInventory(params: {
  organizationId: string;
  medicineId: string;
  branchId?: string;
}) {
  const { organizationId, medicineId, branchId } = params;

  const product = await prisma.product.findFirst({
    where: { id: medicineId, organizationId, deletedAt: null },
    include: { category: true },
  });
  if (!product) throw new AppError("Medicine not found.", 404, "NOT_FOUND");

  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  const lowStockThreshold = resolveLowStockThreshold(org?.settings);
  const branchFilter = branchId ? { branchId } : {};

  const batches = await prisma.batch.findMany({
    where: { organizationId, productId: medicineId, ...branchFilter },
    include: { branch: true, supplier: true },
    orderBy: [{ expiryDate: "asc" }, { createdAt: "asc" }],
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const unitConfig = parseUnitConfig(product.unitConfig);

  let sellable = 0;
  let expired = 0;
  let value = 0;
  let nearestExpiry: Date | null = null;
  let nearestStatus: ExpiryStatus = "HEALTHY";

  const batchRows: BatchSummaryRow[] = batches.map(batch => {
    const status = expiryStatus(batch.expiryDate, today);
    if (batch.quantity <= 0) {
      return buildBatchRow(batch, unitConfig, status, "EMPTY");
    }
    if (status === "EXPIRED") {
      expired += batch.quantity;
      return buildBatchRow(batch, unitConfig, status, "EXPIRED");
    }
    sellable += batch.quantity;
    value += Number(batch.purchasePrice) * batch.quantity;
    if (!nearestExpiry || batch.expiryDate < nearestExpiry) {
      nearestExpiry = batch.expiryDate;
      nearestStatus = status;
    }
    return buildBatchRow(batch, unitConfig, status, "ACTIVE");
  });

  // Sort batches by nearest expiry first.
  batchRows.sort((a, b) => {
    if (a.status === "EXPIRED" && b.status !== "EXPIRED") return 1;
    if (b.status === "EXPIRED" && a.status !== "EXPIRED") return -1;
    return a.expiryDate.getTime() - b.expiryDate.getTime();
  });

  const velocity = await getSalesVelocity({ organizationId, productId: medicineId, branchId });
  const movement = await classifyProductMovement({
    organizationId,
    productId: medicineId,
    branchId,
    availableUnits: sellable,
  });
  const daysOfCover = velocity.averageDailySales > 0 ? sellable / velocity.averageDailySales : null;

  const stockoutRisk =
    daysOfCover === null
      ? ("LOW" as const)
      : daysOfCover <= 3
        ? ("CRITICAL" as const)
        : daysOfCover <= 7
          ? ("HIGH" as const)
          : daysOfCover <= 15
            ? ("MEDIUM" as const)
            : ("LOW" as const);

  // Reorder suggestion with an explainable reason.
  const leadTime = batches[0]?.supplier?.leadTimeDays ?? inventoryConfig.reorder.defaultLeadTimeDays;
  const safetyStock = inventoryConfig.reorder.defaultSafetyStock;
  const openPo = await openPurchaseQty({ organizationId, branchId, productId: medicineId });
  const required = velocity.averageDailySales * leadTime + safetyStock - sellable - openPo;
  const reorderSuggestion = Math.max(0, Math.ceil(required));
  const reorderReason =
    velocity.averageDailySales <= 0
      ? null
      : `Avg daily sales ${velocity.averageDailySales.toFixed(1)}, supplier lead time ${leadTime}d. ` +
        `Sellable ${sellable}, open PO ${openPo}. ${required > 0 ? `Reorder ${reorderSuggestion} to maintain ${leadTime} days + safety ${safetyStock}.` : "Stock covers lead time."}`;

  const history = await getPurchasePriceHistory({ organizationId, productId: medicineId, branchId, limit: 25 });
  const priceHistory = history.map(h => ({
    batchId: h.batchId,
    batchNumber: h.batchNumber,
    purchasePrice: h.purchasePrice,
    mrp: h.mrp,
    supplierName: h.supplierName,
    receivedAt: h.receivedAt,
  }));
  const priceVarianceResult =
    history.length >= 2
      ? priceVariance(history[0].purchasePrice, history[1].purchasePrice)
      : null;

  const branch =
    batches.length > 0 && batches[0].branch
      ? { id: batches[0].branch.id, name: batches[0].branch.name }
      : branchId
        ? await prisma.branch.findUnique({ where: { id: branchId } }).then(b => (b ? { id: b.id, name: b.name } : null))
        : null;

  const detail: MedicineInventoryDetail = {
    product: {
      id: product.id,
      brand: product.brand,
      genericName: product.genericName,
      manufacturer: product.manufacturer,
      strength: product.strength,
      dosageForm: product.dosageForm,
      packSize: product.packSize,
      category: product.category ? { id: product.category.id, name: product.category.name } : null,
      unitConfig: product.unitConfig as Record<string, unknown>,
    },
    branch,
    summary: {
      sellableStock: sellable,
      sellableDisplay: formatBaseUnits(unitConfig, sellable),
      expiredStock: expired,
      expiredDisplay: formatBaseUnits(unitConfig, expired),
      inventoryValue: Math.round(value * 100) / 100,
      nearestExpiry,
      nearestExpiryStatus: nearestStatus,
      estimatedDaysOfCover: daysOfCover === null ? null : Math.round(daysOfCover * 10) / 10,
      stockStatus: sellable <= 0 ? "OUT_OF_STOCK" : stockStatus(sellable, lowStockThreshold),
      lowStockThreshold,
    },
    batches: batchRows,
    intelligence: {
      velocity,
      movementStatus: movement.status,
      daysOfCover: daysOfCover === null ? null : Math.round(daysOfCover * 10) / 10,
      stockoutRisk,
      reorderSuggestion,
      reorderReason,
      lastSaleDate: velocity.lastSaleDate,
    },
    priceHistory,
    priceVariance: priceVarianceResult,
  };

  return detail;
}

function buildBatchRow(
  batch: {
    id: string;
    batchNumber: string;
    expiryDate: Date;
    purchasePrice: import("@prisma/client").Prisma.Decimal;
    mrp: import("@prisma/client").Prisma.Decimal;
    sellingPrice: import("@prisma/client").Prisma.Decimal;
    quantity: number;
    supplier: { id: string; name: string } | null;
    branch: { id: string; name: string } | null;
  },
  unitConfig: ReturnType<typeof parseUnitConfig>,
  expiryStatusVal: ExpiryStatus,
  status: BatchSummaryRow["status"],
): BatchSummaryRow {
  return {
    id: batch.id,
    batchNumber: batch.batchNumber,
    expiryDate: batch.expiryDate,
    expiryStatus: expiryStatusVal,
    daysToExpiry: daysBetween(new Date(), batch.expiryDate),
    purchasePrice: Number(batch.purchasePrice),
    mrp: Number(batch.mrp),
    sellingPrice: Number(batch.sellingPrice),
    quantity: batch.quantity,
    quantityDisplay: formatBaseUnits(unitConfig, batch.quantity),
    supplier: batch.supplier ? { id: batch.supplier.id, name: batch.supplier.name } : null,
    branch: batch.branch ? { id: batch.branch.id, name: batch.branch.name } : null,
    status,
  };
}

export async function getMedicineBatches(params: {
  organizationId: string;
  medicineId: string;
  branchId?: string;
}) {
  const detail = await getMedicineInventory(params);
  return { items: detail.batches, total: detail.batches.length };
}

export async function getMedicineMovements(params: {
  organizationId: string;
  medicineId: string;
  branchId?: string;
  type?: string;
  page?: number;
  pageSize?: number;
}) {
  const { organizationId, medicineId, branchId, type, page = 1, pageSize = 20 } = params;
  const where: Prisma.InventoryMovementWhereInput = {
    organizationId,
    productId: medicineId,
    ...(branchId ? { branchId } : {}),
    ...(type ? { type: type as never } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.inventoryMovement.findMany({
      where,
      include: { batch: true, user: { select: { fullName: true } }, branch: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.inventoryMovement.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

async function openPurchaseQty(params: {
  organizationId: string;
  branchId?: string;
  productId: string;
}): Promise<number> {
  const items = await prisma.purchaseItem.findMany({
    where: {
      productId: params.productId,
      purchase: {
        organizationId: params.organizationId,
        ...(params.branchId ? { branchId: params.branchId } : {}),
        status: { in: ["DRAFT", "SUBMITTED", "APPROVED"] },
      },
    },
    select: { quantity: true, receivedQty: true },
  });
  return items.reduce((sum, p) => sum + Math.max(0, p.quantity - p.receivedQty), 0);
}

/** Re-exported convenience for tests/controllers. */
export async function getSellableStock(params: {
  organizationId: string;
  productId: string;
  branchId?: string;
}) {
  return sellableStock(params);
}
