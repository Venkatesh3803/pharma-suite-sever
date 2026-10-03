import { prisma } from "../../lib/prisma.js";
import { computeDailySales } from "./stockout.service.js";
import type { RiskLevel } from "./stockout.service.js";

export interface ReorderRecommendation {
  product: {
    id: string;
    brand: string;
    genericName: string | null;
    strength: string | null;
    packSize: string | null;
  };
  supplier: { id: string; name: string } | null;
  branch: { id: string; name: string } | null;
  availableQty: number;
  averageDailySales: number;
  supplierLeadTime: number;
  safetyStock: number;
  openPurchaseQty: number;
  recommendedQuantity: number;
  estimatedStockoutDate: Date | null;
  riskLevel: RiskLevel;
  reason: string;
}

export async function buildReorderRecommendations(params: {
  organizationId: string;
  branchId?: string;
  analysisDays?: number;
  safetyStock?: number;
}): Promise<ReorderRecommendation[]> {
  const {
    organizationId,
    branchId,
    analysisDays = 30,
    safetyStock = 15,
  } = params;

  const branchFilter = branchId ? { branchId } : {};

  const batches = await prisma.batch.findMany({
    where: { organizationId, ...branchFilter, quantity: { gt: 0 } },
    include: { product: true, branch: true, supplier: true },
    take: 1000,
  });

  // aggregate per product+branch
  const agg = new Map<
    string,
    {
      qty: number;
      batch: (typeof batches)[number];
    }
  >();
  for (const batch of batches) {
    const key = `${batch.productId}:${batch.branchId}`;
    const current = agg.get(key);
    if (current) current.qty += batch.quantity;
    else agg.set(key, { qty: batch.quantity, batch });
  }

  const recommendations: ReorderRecommendation[] = [];

  for (const { qty, batch } of agg.values()) {
    const averageDailySales = await computeDailySales(
      batch.productId,
      analysisDays,
    );
    if (averageDailySales <= 0) continue;

    const supplierLeadTime = batch.supplier?.leadTimeDays ?? 7;

    // Open purchase orders for this product at this branch (not yet received)
    const openPOs = await prisma.purchaseItem.findMany({
      where: {
        productId: batch.productId,
        purchase: {
          organizationId,
          branchId: batch.branchId,
          status: { in: ["DRAFT", "SUBMITTED", "APPROVED"] },
        },
      },
      select: {
        quantity: true,
        receivedQty: true,
      },
    });
    const openPurchaseQty = openPOs.reduce(
      (sum, p) => sum + Math.max(0, p.quantity - p.receivedQty),
      0,
    );

    const required =
      averageDailySales * supplierLeadTime + safetyStock - qty - openPurchaseQty;
    const recommendedQuantity = Math.max(0, Math.ceil(required));

    const daysUntilStockout =
      averageDailySales > 0 ? qty / averageDailySales : null;
    const riskLevel: RiskLevel =
      daysUntilStockout === null
        ? "LOW"
        : daysUntilStockout <= 3
          ? "CRITICAL"
          : daysUntilStockout <= 7
            ? "HIGH"
            : daysUntilStockout <= 15
              ? "MEDIUM"
              : "LOW";

    if (recommendedQuantity <= 0 && riskLevel === "LOW") continue;

    const estimatedStockoutDate =
      daysUntilStockout === null
        ? null
        : new Date(Date.now() + daysUntilStockout * 86400000);

    recommendations.push({
      product: {
        id: batch.product.id,
        brand: batch.product.brand,
        genericName: batch.product.genericName,
        strength: batch.product.strength,
        packSize: batch.product.packSize,
      },
      supplier: batch.supplier
        ? { id: batch.supplier.id, name: batch.supplier.name }
        : null,
      branch: { id: batch.branch.id, name: batch.branch.name },
      availableQty: qty,
      averageDailySales: Math.round(averageDailySales * 100) / 100,
      supplierLeadTime,
      safetyStock,
      openPurchaseQty,
      recommendedQuantity,
      estimatedStockoutDate,
      riskLevel,
      reason: `Avg daily sales ${averageDailySales.toFixed(1)}, lead time ${supplierLeadTime}d, available ${qty}, open PO ${openPurchaseQty}.`,
    });
  }

  const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
  return recommendations
    .sort((a, b) => order[a.riskLevel] - order[b.riskLevel])
    .slice(0, 100);
}