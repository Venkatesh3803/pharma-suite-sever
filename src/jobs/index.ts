import { prisma } from "../lib/prisma.js";
import { buildExpiryOverview } from "../services/intelligence/expiry.service.js";
import { computeStockoutRisks } from "../services/intelligence/stockout.service.js";
import { detectDeadStock } from "../services/intelligence/deadstock.service.js";
import { buildReorderRecommendations } from "../services/intelligence/reorder.service.js";
import { createAlertsBulk } from "../services/alert.service.js";
import { inventoryValue } from "../services/intelligence/inventory-analytics.service.js";

/**
 * Runs all daily intelligence jobs for every active organization and
 * generates in-app alerts. Safe to run repeatedly (dedup via createAlertsBulk).
 */
export async function runDailyJobs() {
    const organizations = await prisma.organization.findMany({
        where: { isActive: true },
        include: { branches: { where: { isActive: true } } }
    });

    const results: { org: string; created: number }[] = [];

    for (const org of organizations) {
        const orgAlerts: Parameters<typeof createAlertsBulk>[1] = [];
        const branches = org.branches.length ? org.branches : [undefined as never];

        for (const branch of branches) {
            const branchId: string | undefined = branch ? branch.id : undefined;
            const common = { organizationId: org.id, branchId };

            // Expiry intelligence
            const expiry = await buildExpiryOverview({ organizationId: org.id, branchId });
            for (const bucket of expiry) {
                if (bucket.severity === "CRITICAL") {
                    if (bucket.bucket === "EXPIRED" && bucket.batchCount > 0) {
                        orgAlerts.push({
                            type: "EXPIRY",
                            severity: "CRITICAL",
                            title: "Expired stock on shelf",
                            message: `${bucket.batchCount} batches worth ₹${bucket.inventoryValue.toLocaleString("en-IN")} have expired.`,
                            branchId,
                            entityType: "Batch",
                            metadata: { bucket: bucket.bucket }
                        });
                    } else if (bucket.bucket === "0-30" && bucket.batchCount > 0) {
                        orgAlerts.push({
                            type: "EXPIRY",
                            severity: "CRITICAL",
                            title: "Inventory expiring within 30 days",
                            message: `₹${bucket.inventoryValue.toLocaleString("en-IN")} worth of ${bucket.productCount} products expires within 30 days.`,
                            branchId,
                            entityType: "Batch",
                            metadata: { bucket: "0-30" }
                        });
                    }
                }
            }

            // Stockout risks
            const risks = await computeStockoutRisks({
                organizationId: org.id,
                branchId,
                limit: 100
            });
            for (const risk of risks.slice(0, 20)) {
                if (risk.riskLevel === "CRITICAL") {
                    orgAlerts.push({
                        type: "STOCKOUT_RISK",
                        severity: "CRITICAL",
                        title: `${risk.product.brand} may stock out`,
                        message: `${risk.product.brand} (${risk.availableQty} units left) may stock out in ${risk.daysUntilStockout} days.`,
                        branchId,
                        entityType: "Product",
                        entityId: risk.product.id,
                        metadata: { risk }
                    });
                }
            }

            // Dead stock
            const dead = await detectDeadStock({
                organizationId: org.id,
                branchId,
                inactiveDays: 60,
                pageSize: 400
            });
            if (dead.trappedCapital > 0) {
                orgAlerts.push({
                    type: "DEAD_STOCK",
                    severity: "HIGH",
                    title: "Capital trapped in dead stock",
                    message: `₹${dead.trappedCapital.toLocaleString("en-IN")} of inventory hasn't moved in 60+ days across ${dead.total} items.`,
                    branchId,
                    entityType: "Product",
                    metadata: { trappedCapital: dead.trappedCapital }
                });
            }

            // Reorder recommendations (pending purchases)
            const reorder = await buildReorderRecommendations({
                organizationId: org.id,
                branchId
            });
            const critical = reorder.filter(r => r.riskLevel === "CRITICAL");
            if (critical.length) {
                orgAlerts.push({
                    type: "PENDING_PURCHASE",
                    severity: "HIGH",
                    title: `${critical.length} products need reordering`,
                    message: `Recommended purchases are ready for ${critical.length} products that may stock out soon.`,
                    branchId,
                    entityType: "Product",
                    metadata: { count: critical.length }
                });
            }

            void common;
        }

        const created = await createAlertsBulk(org.id, orgAlerts);
        results.push({ org: org.name, created: created.created });
        void inventoryValue({ organizationId: org.id });
    }

    return results;
}
