import { prisma } from "../lib/prisma.js";
import { AppError } from "../domain/errors.js";

const RECEIVED_STATUSES = ["RECEIVED", "PARTIALLY_RECEIVED", "COMPLETED"] as const;
const OPEN_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED"] as const;

export async function purchaseSummary(params: {
  organizationId: string;
  branchId?: string;
}) {
  const { organizationId, branchId } = params;
  const whereBase = {
    organizationId,
    ...(branchId ? { branchId } : {}),
  };
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const startOfPrevMonth = new Date(startOfMonth);
  startOfPrevMonth.setMonth(startOfPrevMonth.getMonth() - 1);

  const [thisMonth, prevMonth, totalAgg, statusAgg, returnsCount, priceSeries] =
    await Promise.all([
      prisma.purchase.aggregate({
        where: { ...whereBase, createdAt: { gte: startOfMonth }, status: { not: "CANCELLED" } },
        _sum: { total: true },
        _count: { _all: true },
      }),
      prisma.purchase.aggregate({
        where: {
          ...whereBase,
          createdAt: { gte: startOfPrevMonth, lt: startOfMonth },
          status: { not: "CANCELLED" },
        },
        _sum: { total: true },
        _count: { _all: true },
      }),
      prisma.purchase.aggregate({
        where: { ...whereBase, status: { not: "CANCELLED" } },
        _sum: { total: true },
        _count: { _all: true },
      }),
      prisma.purchase.groupBy({
        by: ["status"],
        where: whereBase,
        _count: { _all: true },
      }),
      prisma.inventoryMovement.count({
        where: { ...whereBase, type: "PURCHASE_RETURN" },
      }),
      prisma.batch.findMany({
        where: { ...whereBase, supplierId: { not: null }, quantity: { gt: 0 } },
        select: {
          productId: true,
          purchasePrice: true,
          supplierId: true,
          receivedAt: true,
          createdAt: true,
        },
        orderBy: { receivedAt: "desc" },
      }),
    ]);

  const monthTotal = Number(thisMonth._sum.total ?? 0);
  const prevMonthTotal = Number(prevMonth._sum.total ?? 0);
  const monthChangePct =
    prevMonthTotal > 0 ? ((monthTotal - prevMonthTotal) / prevMonthTotal) * 100 : null;

  const statusMap = new Map(statusAgg.map(s => [s.status, s._count._all]));
  const openOrders = OPEN_STATUSES.reduce((acc, s) => acc + (statusMap.get(s) ?? 0), 0);
  const receivedOrders = RECEIVED_STATUSES.reduce(
    (acc, s) => acc + (statusMap.get(s) ?? 0),
    0,
  );

  // Price increase alerts: compare the two most recent received lots per product.
  const priceMap = new Map<string, number[]>();
  for (const b of priceSeries) {
    if (!priceMap.has(b.productId)) priceMap.set(b.productId, []);
    const arr = priceMap.get(b.productId)!;
    if (arr.length < 2) arr.push(Number(b.purchasePrice));
  }
  let priceIncreases = 0;
  for (const [, prices] of priceMap) {
    if (prices.length === 2 && prices[0] > prices[1]) priceIncreases += 1;
  }

  // Low stock (reorder suggestions) from batches at/below their reorder level.
  const lowStock = await prisma.batch.findMany({
    where: {
      ...whereBase,
      quantity: { lte: prisma.batch.fields.reorderLevel },
    },
    include: { product: { select: { id: true, brand: true, genericName: true, unitConfig: true } } },
    orderBy: { quantity: "asc" },
    take: 20,
  });

  return {
    thisMonthValue: monthTotal,
    thisMonthOrders: thisMonth._count._all,
    monthChangePct,
    totalPurchaseValue: Number(totalAgg._sum.total ?? 0),
    totalOrders: totalAgg._count._all,
    openOrders,
    receivedOrders,
    cancelledOrders: statusMap.get("CANCELLED") ?? 0,
    returnsCount,
    priceIncreases,
    lowStock: lowStock.map(b => ({
      productId: b.productId,
      brand: b.product.brand,
      genericName: b.product.genericName,
      batchNumber: b.batchNumber,
      onHand: b.quantity,
      reorderLevel: b.reorderLevel,
      unitConfig: b.product.unitConfig,
    })),
  };
}

export async function vendorPerformance(organizationId: string, vendorId: string) {
  const supplier = await prisma.supplier.findFirst({
    where: { id: vendorId, organizationId },
  });
  if (!supplier) throw new AppError("Supplier not found.", 404, "NOT_FOUND");

  const purchases = await prisma.purchase.findMany({
    where: { organizationId, supplierId: vendorId, status: { not: "CANCELLED" } },
    select: {
      id: true,
      total: true,
      status: true,
      createdAt: true,
      receivedAt: true,
      expectedDelivery: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const totalValue = purchases.reduce((acc, p) => acc + Number(p.total), 0);
  const received = purchases.filter(p =>
    (RECEIVED_STATUSES as readonly string[]).includes(p.status),
  );
  let leadDays = 0;
  let onTime = 0;
  for (const p of received) {
    const receivedAt = p.receivedAt ?? p.createdAt;
    const lead = (receivedAt.getTime() - p.createdAt.getTime()) / 86400000;
    leadDays += Math.max(0, lead);
    if (!p.expectedDelivery || receivedAt <= p.expectedDelivery) onTime += 1;
  }

  const purchaseIds = purchases.map(p => p.id);
  const returnCount = await prisma.inventoryMovement.count({
    where: { organizationId, type: "PURCHASE_RETURN", referenceId: { in: purchaseIds } },
  });

  return {
    vendor: { id: supplier.id, name: supplier.name, code: supplier.code },
    totalOrders: purchases.length,
    receivedOrders: received.length,
    totalValue,
    avgOrderValue: purchases.length ? totalValue / purchases.length : 0,
    avgLeadTimeDays: received.length ? leadDays / received.length : null,
    onTimeRate: received.length ? (onTime / received.length) * 100 : null,
    returnCount,
    lastPurchase: purchases[0]?.createdAt ?? null,
  };
}

export async function vendorPriceHistory(params: {
  organizationId: string;
  vendorId: string;
  productId?: string;
  limit?: number;
}) {
  const { organizationId, vendorId, productId, limit } = params;
  const where = {
    organizationId,
    supplierId: vendorId,
    ...(productId ? { productId } : {}),
  };
  const batches = await prisma.batch.findMany({
    where,
    include: { product: { select: { id: true, brand: true, genericName: true, strength: true, unitConfig: true } } },
    orderBy: { receivedAt: "desc" },
    take: limit ?? 50,
  });

  const rows = batches.map(b => ({
    productId: b.productId,
    brand: b.product.brand,
    genericName: b.product.genericName,
    strength: b.product.strength,
    batchNumber: b.batchNumber,
    date: b.receivedAt ?? b.createdAt,
    purchasePrice: Number(b.purchasePrice),
    mrp: Number(b.mrp),
  }));

  const prices = rows.map(r => r.purchasePrice);
  const latest = prices[0] ?? null;
  const previous = prices[1] ?? null;
  const changePct =
    latest !== null && previous !== null && previous !== 0
      ? ((latest - previous) / previous) * 100
      : null;

  return {
    rows,
    summary: {
      samples: prices.length,
      latest,
      previous,
      changePct,
      lowest: prices.length ? Math.min(...prices) : null,
      highest: prices.length ? Math.max(...prices) : null,
      average: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
    },
  };
}