import { prisma } from "../lib/prisma.js";
import { Prisma } from "@prisma/client";
import { inventoryValue, lowStockItems, expiredStockUnits } from "./intelligence/inventory-analytics.service.js";
import { buildExpiryOverview } from "./intelligence/expiry.service.js";
import { computeStockoutRisks } from "./intelligence/stockout.service.js";
import { deadStockSummary } from "./intelligence/deadstock.service.js";
import { buildReorderRecommendations } from "./intelligence/reorder.service.js";
import { unreadAlertCount } from "./alert.service.js";

async function cogsForPeriod(
  organizationId: string,
  branchId: string | undefined,
  since: Date,
  until?: Date,
): Promise<number> {
  const rows = await prisma.$queryRaw<{ cogs: number }[]>`
    SELECT COALESCE(SUM(si."unitCost" * si.quantity), 0)::float8 AS cogs
    FROM "SaleItem" si
    JOIN "Sale" s ON s.id = si."saleId"
    WHERE s."organizationId" = ${organizationId}
      AND s."createdAt" >= ${since}
      ${until ? Prisma.sql`AND s."createdAt" < ${until}` : Prisma.empty}
      ${branchId ? Prisma.sql`AND s."branchId" = ${branchId}` : Prisma.empty}
  `;
  return Number(rows[0]?.cogs ?? 0);
}

export async function buildDashboard(params: {
  organizationId: string;
  branchId?: string;
  userId: string;
}) {
  const { organizationId, branchId, userId } = params;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(todayStart);
  monthStart.setDate(1);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);

  const branchFilter = branchId ? { branchId } : {};

  const [
    todaySales,
    yesterdaySales,
    monthSales,
    inventory,
    lowStock,
    expiredStock,
    expiryOverview,
    stockoutRisks,
    deadStock,
    reorder,
    alerts,
    salesCountToday,
  ] = await Promise.all([
    prisma.sale.aggregate({
      where: { organizationId, ...branchFilter, createdAt: { gte: todayStart } },
      _sum: { total: true, subtotal: true, tax: true },
      _count: true,
    }),
    prisma.sale.aggregate({
      where: {
        organizationId,
        ...branchFilter,
        createdAt: { gte: yesterdayStart, lt: todayStart },
      },
      _sum: { total: true },
      _count: true,
    }),
    prisma.sale.aggregate({
      where: { organizationId, ...branchFilter, createdAt: { gte: monthStart } },
      _sum: { total: true, subtotal: true, tax: true },
      _count: true,
    }),
    inventoryValue({ organizationId, branchId }),
    lowStockItems({ organizationId, branchId, limit: 500 }),
    expiredStockUnits({ organizationId, branchId }),
    buildExpiryOverview({ organizationId, branchId }),
    computeStockoutRisks({ organizationId, branchId, limit: 50 }),
    deadStockSummary({ organizationId, branchId, inactiveDays: 60 }),
    buildReorderRecommendations({ organizationId, branchId }),
    unreadAlertCount(organizationId, userId),
    prisma.sale.count({
      where: {
        organizationId,
        ...branchFilter,
        createdAt: { gte: todayStart },
      },
    }),
  ]);

  const todayTotal = Number(todaySales._sum.total ?? 0);
  const yesterdayTotal = Number(yesterdaySales._sum.total ?? 0);
  const todayChangePct =
    yesterdayTotal > 0
      ? ((todayTotal - yesterdayTotal) / yesterdayTotal) * 100
      : null;

  const monthTotal = Number(monthSales._sum.total ?? 0);
  const todayCogs = await cogsForPeriod(
    organizationId,
    branchId,
    todayStart,
    new Date(todayStart.getTime() + 86400000),
  );
  const monthCogs = await cogsForPeriod(organizationId, branchId, monthStart);
  const todayProfit = todayTotal - todayCogs;
  const grossProfit = monthTotal - monthCogs;
  const grossMargin = monthTotal > 0 ? (grossProfit / monthTotal) * 100 : 0;

  return {
    kpis: {
      todaySales: {
        value: todayTotal,
        changePct: todayChangePct,
        invoices: salesCountToday,
      },
      todayProfit: {
        value: todayProfit,
        margin: todayTotal > 0 ? (todayProfit / todayTotal) * 100 : 0,
      },
      monthSales: {
        value: monthTotal,
        count: monthSales._count,
      },
      grossProfit,
      grossMargin,
      inventoryValue: inventory,
      lowStock: { count: lowStock.count },
      expiryRisk: {
        expiring30: {
          batches: expiryOverview.find(b => b.bucket === "0-30")?.batchCount ?? 0,
          inventoryValue:
            expiryOverview.find(b => b.bucket === "0-30")?.inventoryValue ?? 0,
        },
        expired: expiredStock,
      },
      deadStock: {
        count: deadStock.count,
        trappedCapital: deadStock.trappedCapital,
      },
    },
    sections: {
      inventoryHealth: {
        totalUnits: inventory.totalUnits,
        totalValue: inventory.retailValue,
        costValue: inventory.costValue,
        lowStockItems: lowStock.items.slice(0, 10),
      },
      expiryOverview,
      stockoutRisks: stockoutRisks.slice(0, 15),
      deadStock: { ...deadStock },
    },
    actions: {
      recommendedPurchases: reorder.slice(0, 12),
    },
    alerts: {
      unread: alerts,
    },
    recentActivity: await recentActivity(organizationId, branchId),
  };
}

async function recentActivity(organizationId: string, branchId?: string) {
  const branchFilter = branchId ? { branchId } : {};
  const [sales, purchases, customers, movements] = await Promise.all([
    prisma.sale.findMany({
      where: { organizationId, ...branchFilter },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { createdBy: { select: { fullName: true } } },
    }),
    prisma.purchase.findMany({
      where: { organizationId, ...branchFilter },
      orderBy: { createdAt: "desc" },
      take: 6,
      include: { supplier: { select: { name: true } } },
    }),
    prisma.customer.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: 4,
    }),
    prisma.inventoryMovement.findMany({
      where: { organizationId, ...branchFilter },
      orderBy: { createdAt: "desc" },
      take: 6,
      include: { product: { select: { brand: true } } },
    }),
  ]);
  return {
    sales: sales.map(s => ({
      id: s.id,
      invoiceNo: s.invoiceNo,
      total: Number(s.total),
      actor: s.createdBy?.fullName ?? null,
      createdAt: s.createdAt,
      action: "SALE" as const,
    })),
    purchases: purchases.map(p => ({
      id: p.id,
      poNumber: p.poNumber,
      supplier: p.supplier.name,
      status: p.status,
      total: Number(p.total),
      createdAt: p.createdAt,
      action: "PURCHASE" as const,
    })),
    customers: customers.map(c => ({
      id: c.id,
      name: c.name,
      createdAt: c.createdAt,
      action: "CUSTOMER" as const,
    })),
    movements: movements.map(m => ({
      id: m.id,
      type: m.type,
      product: m.product.brand,
      quantity: m.quantity,
      createdAt: m.createdAt,
      action: "MOVEMENT" as const,
    })),
  };
}