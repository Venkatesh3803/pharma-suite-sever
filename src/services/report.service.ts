import { prisma } from "../lib/prisma.js";
import { Prisma } from "@prisma/client";

export interface SalesReportParams {
  organizationId: string;
  branchId?: string;
  from?: Date;
  to?: Date;
  groupBy: "day" | "week" | "month";
  productId?: string;
}

export interface ReportTotals {
  revenue: number;
  subtotal: number;
  tax: number;
  discount: number;
  unitsSold: number;
  invoices: number;
  cost?: number;
  grossProfit?: number;
  grossMargin?: number;
}

export async function salesReport(
  params: SalesReportParams,
): Promise<{ series: { key: string; revenue: number; invoices: number; units: number }[]; totals: ReportTotals }> {
  const { organizationId, branchId, from, to, groupBy } = params;
  const branchFilter = branchId ? { branchId } : {};
  const dateFilter = {
    ...(from ? { gte: from } : {}),
    ...(to ? { lte: to } : {}),
  };

  const sales = await prisma.sale.findMany({
    where: {
      organizationId,
      ...branchFilter,
      ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
      ...(params.productId
        ? { items: { some: { productId: params.productId } } }
        : {}),
    },
    include: { items: true },
    orderBy: { createdAt: "asc" },
  });

  // build series buckets
  const buckets = new Map<string, { key: string; revenue: number; invoices: number; units: number }>();
  const keyOf = (date: Date): string => {
    if (groupBy === "month") {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    }
    if (groupBy === "week") {
      // ISO week start (Monday)
      const d = new Date(date);
      const day = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - day);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };

  let totalRevenue = 0;
  let totalSubtotal = 0;
  let totalTax = 0;
  let totalDiscount = 0;
  let totalUnits = 0;

  for (const sale of sales) {
    const key = keyOf(sale.createdAt);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, revenue: 0, invoices: 0, units: 0 };
      buckets.set(key, bucket);
    }
    const revenue = Number(sale.total);
    bucket.revenue += revenue;
    bucket.invoices += 1;
    const units = sale.items.reduce((s, i) => s + i.quantity, 0);
    bucket.units += units;

    totalRevenue += revenue;
    totalSubtotal += Number(sale.subtotal);
    totalTax += Number(sale.tax);
    totalDiscount += Number(sale.discount);
    totalUnits += units;
  }

  return {
    series: Array.from(buckets.values()),
    totals: {
      revenue: totalRevenue,
      subtotal: totalSubtotal,
      tax: totalTax,
      discount: totalDiscount,
      unitsSold: totalUnits,
      invoices: sales.length,
    },
  };
}

export async function reportTopProducts(params: {
  organizationId: string;
  branchId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}) {
  const { organizationId, branchId, from, to, limit = 10 } = params;
  const dateRange =
    from || to
      ? {
          createdAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {};
  const grouped = await prisma.saleItem.groupBy({
    by: ["productId"],
    where: {
      sale: {
        organizationId,
        ...(branchId ? { branchId } : {}),
        ...dateRange,
      },
    },
    _sum: { quantity: true, total: true },
    orderBy: { _sum: { total: "desc" } },
    take: limit,
  });
  const ids = grouped.map(g => g.productId);
  const products = ids.length
    ? await prisma.product.findMany({ where: { id: { in: ids } } })
    : [];
  const map = new Map(products.map(p => [p.id, p]));
  return grouped.map(g => ({
    productId: g.productId,
    brand: map.get(g.productId)?.brand ?? "Unknown",
    genericName: map.get(g.productId)?.genericName ?? null,
    quantity: g._sum.quantity ?? 0,
    revenue: Number(g._sum.total ?? 0),
  }));
}

export async function inventoryReport(params: {
  organizationId: string;
  branchId?: string;
}) {
  const { organizationId, branchId } = params;
  const branchFilter = branchId ? { branchId } : {};
  const batches = await prisma.batch.findMany({
    where: { organizationId, ...branchFilter, quantity: { gt: 0 } },
    include: { product: true, branch: true },
  });
  const valuation = batches.reduce(
    (acc, b) => {
      acc.cost += Number(b.purchasePrice) * b.quantity;
      acc.retail += Number(b.sellingPrice) * b.quantity;
      acc.mrp += Number(b.mrp) * b.quantity;
      acc.units += b.quantity;
      return acc;
    },
    { cost: 0, retail: 0, mrp: 0, units: 0 },
  );
  return {
    valuation: {
      units: valuation.units,
      costValue: valuation.cost,
      retailValue: valuation.retail,
      mrpValue: valuation.mrp,
    },
    branches: await prisma.$queryRawUnsafe(
      `SELECT b.name, COUNT(bt.id)::int as batches, SUM(bt.quantity)::int as units,
        COALESCE(SUM(bt."sellingPrice" * bt.quantity),0)::float8 as value
       FROM "Batch" bt
       JOIN "Branch" b ON b.id = bt."branchId"
       WHERE bt."organizationId" = $1 AND bt.quantity > 0
       GROUP BY b.name, b.id
       ORDER BY value DESC`,
      organizationId,
    ),
  };
}

export async function purchaseReport(params: {
  organizationId: string;
  branchId?: string;
  supplierId?: string;
  from?: Date;
  to?: Date;
}) {
  const { organizationId, branchId, supplierId, from, to } = params;
  const where = {
    organizationId,
    ...(branchId ? { branchId } : {}),
    ...(supplierId ? { supplierId } : {}),
    ...(from || to
      ? { orderDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
  };
  const agg = await prisma.purchase.aggregate({
    where,
    _sum: { total: true },
    _count: true,
    _avg: { total: true },
  });
  const bySupplier = await prisma.purchase.groupBy({
    by: ["supplierId"],
    where,
    _sum: { total: true },
    _count: true,
    orderBy: { _sum: { total: "desc" } },
    take: 10,
  });
  const supplierIds = bySupplier.map(s => s.supplierId);
  const suppliers = supplierIds.length
    ? await prisma.supplier.findMany({ where: { id: { in: supplierIds } } })
    : [];
  const supplierMap = new Map(suppliers.map(s => [s.id, s]));
  return {
    totals: {
      total: Number(agg._sum.total ?? 0),
      count: agg._count,
      average: Number(agg._avg.total ?? 0),
    },
    bySupplier: bySupplier.map(s => ({
      supplierId: s.supplierId,
      name: supplierMap.get(s.supplierId)?.name ?? "Unknown",
      total: Number(s._sum.total ?? 0),
      count: s._count,
    })),
  };
}

export async function grossMarginReport(params: {
  organizationId: string;
  branchId?: string;
  from?: Date;
  to?: Date;
}) {
  const { organizationId, branchId, from, to } = params;
  const branchFilter = branchId ? { branchId } : {};
  const where = {
    organizationId,
    ...branchFilter,
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };
  const salesAgg = await prisma.sale.aggregate({
    where,
    _sum: { total: true, subtotal: true, tax: true },
    _count: true,
  });
  const revenue = Number(salesAgg._sum.total ?? 0);
  const tax = Number(salesAgg._sum.tax ?? 0);

  // Real COGS = Σ(unitCost × quantity) for sold lines in the period.
  const conds: Prisma.Sql[] = [];
  if (branchId) conds.push(Prisma.sql`AND s."branchId" = ${branchId}`);
  if (from) conds.push(Prisma.sql`AND s."createdAt" >= ${from}`);
  if (to) conds.push(Prisma.sql`AND s."createdAt" <= ${to}`);
  const cond = conds.length ? Prisma.join(conds) : Prisma.empty;
  const cogsRows = await prisma.$queryRaw<{ cogs: number }[]>`
    SELECT COALESCE(SUM(si."unitCost" * si.quantity), 0)::float8 AS cogs
    FROM "SaleItem" si
    JOIN "Sale" s ON s.id = si."saleId"
    WHERE s."organizationId" = ${organizationId}
    ${cond}
  `;
  const cogs = Number(cogsRows[0]?.cogs ?? 0);

  return {
    revenue,
    tax,
    invoices: salesAgg._count,
    estimatedCogs: cogs,
    grossProfit: revenue - cogs,
    grossMargin: revenue > 0 ? ((revenue - cogs) / revenue) * 100 : 0,
  };
}