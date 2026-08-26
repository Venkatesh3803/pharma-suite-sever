import { prisma } from "../../lib/prisma";

export type RiskLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface StockoutRisk {
    product: {
        id: string;
        brand: string;
        genericName: string | null;
        strength: string | null;
        packSize: string | null;
        barcode: string | null;
    };
    branch: { id: string; name: string } | null;
    availableQty: number;
    averageDailySales: number;
    daysUntilStockout: number | null; // null when no sales history
    riskLevel: RiskLevel;
}

function classify(days: number | null): RiskLevel {
    if (days === null) return "LOW";
    if (days <= 3) return "CRITICAL";
    if (days <= 7) return "HIGH";
    if (days <= 15) return "MEDIUM";
    return "LOW";
}

export async function computeStockoutRisks(params: {
    organizationId: string;
    branchId?: string;
    analysisDays?: number;
    minAvailable?: number;
    limit?: number;
}): Promise<StockoutRisk[]> {
    const { organizationId, branchId, analysisDays = 30, minAvailable = 15, limit = 100 } = params;
    const since = new Date();
    since.setDate(since.getDate() - analysisDays);

    const branchFilter = branchId ? { branchId } : {};

    const batches = await prisma.batch.findMany({
        where: {
            organizationId,
            ...branchFilter,
            quantity: { gt: 0, lte: minAvailable }
        },
        include: { product: true, branch: true },
        orderBy: { quantity: "asc" },
        take: 500
    });

    // Aggregate available quantity per (productId, branchId)
    const aggregate = new Map<string, { batch: (typeof batches)[number]; qty: number }>();
    for (const batch of batches) {
        const key = `${batch.productId}:${batch.branchId}`;
        const current = aggregate.get(key);
        if (current) current.qty += batch.quantity;
        else aggregate.set(key, { batch, qty: batch.quantity });
    }

    const risks: StockoutRisk[] = [];
    for (const { batch, qty } of aggregate.values()) {
        const sinceDate = since;
        const salesAgg = await prisma.saleItem.aggregate({
            where: {
                sale: {
                    organizationId,
                    branchId: batch.branchId,
                    createdAt: { gte: sinceDate }
                },
                productId: batch.productId
            },
            _sum: { quantity: true }
        });
        const soldQty = salesAgg._sum.quantity ?? 0;
        const averageDailySales = soldQty / analysisDays;
        const daysUntilStockout = averageDailySales > 0 ? qty / averageDailySales : null;

        risks.push({
            product: {
                id: batch.product.id,
                brand: batch.product.brand,
                genericName: batch.product.genericName,
                strength: batch.product.strength,
                packSize: batch.product.packSize,
                barcode: batch.product.barcode
            },
            branch: { id: batch.branch.id, name: batch.branch.name },
            availableQty: qty,
            averageDailySales: Math.round(averageDailySales * 100) / 100,
            daysUntilStockout: daysUntilStockout === null ? null : Math.round(daysUntilStockout * 10) / 10,
            riskLevel: classify(daysUntilStockout)
        });
    }

    // sort CRITICAL first
    const order: Record<RiskLevel, number> = {
        CRITICAL: 0,
        HIGH: 1,
        MEDIUM: 2,
        LOW: 3
    };
    return risks.sort((a, b) => order[a.riskLevel] - order[b.riskLevel]).slice(0, limit);
}

export async function computeDailySales(productId: string, days: number, now?: Date) {
    const since = new Date(now ?? new Date());
    since.setDate(since.getDate() - days);
    const agg = await prisma.saleItem.aggregate({
        where: { productId, sale: { createdAt: { gte: since } } },
        _sum: { quantity: true }
    });
    const sold = agg._sum.quantity ?? 0;
    return sold / days;
}
