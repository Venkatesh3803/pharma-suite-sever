import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { AppError } from "../src/domain/errors";
import { selectFefoBatches, fefoCanFulfill } from "../src/services/intelligence/fefo.service";
import { computeStockoutRisks } from "../src/services/intelligence/stockout.service";
import { buildReorderRecommendations } from "../src/services/intelligence/reorder.service";
import { detectDeadStock } from "../src/services/intelligence/deadstock.service";
import { createPurchase, receivePurchase } from "../src/services/purchase.service";
import { createSale } from "../src/services/customer.service";
import { getProduct } from "../src/services/product.service";

let org: { id: string };
let branch: { id: string };
let user: { id: string };
let supplier: { id: string };
let pFefo: { id: string };
let pStock: { id: string };
let pReorder: { id: string };
let pDead: { id: string };
let pSale: { id: string };
let orgB: { id: string };
let pOrgB: { id: string };

async function destroyOrg(orgId: string) {
    await prisma.inventoryMovement.deleteMany({ where: { organizationId: orgId } });
    await prisma.saleItem.deleteMany({ where: { sale: { organizationId: orgId } } });
    await prisma.sale.deleteMany({ where: { organizationId: orgId } });
    await prisma.purchaseReceiptItem.deleteMany({ where: { receipt: { organizationId: orgId } } });
    await prisma.purchaseReceipt.deleteMany({ where: { organizationId: orgId } });
    await prisma.vendorMedicine.deleteMany({ where: { organizationId: orgId } });
    await prisma.purchaseItem.deleteMany({ where: { purchase: { organizationId: orgId } } });
    await prisma.purchase.deleteMany({ where: { organizationId: orgId } });
    await prisma.prescription.deleteMany({ where: { organizationId: orgId } });
    await prisma.alert.deleteMany({ where: { organizationId: orgId } });
    await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
    await prisma.batch.deleteMany({ where: { organizationId: orgId } });
    await prisma.customer.deleteMany({ where: { organizationId: orgId } });
    await prisma.supplier.deleteMany({ where: { organizationId: orgId } });
    await prisma.product.deleteMany({ where: { organizationId: orgId } });
    await prisma.productCategory.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.branch.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
}

async function makeProduct(organizationId: string, brand: string): Promise<{ id: string }> {
    return prisma.product.create({
        data: {
            organizationId,
            brand,
            genericName: brand,
            gstRate: 12,
            prescriptionRequired: true
        }
    });
}

async function makeBatch(params: {
    orgId: string;
    branchId: string;
    productId: string;
    supplierId: string;
    batchNumber: string;
    expiryDays: number;
    qty: number;
    cost: number;
    sell: number;
}) {
    const expiry = new Date();
    expiry.setHours(0, 0, 0, 0);
    expiry.setDate(expiry.getDate() + params.expiryDays);
    return prisma.batch.create({
        data: {
            organizationId: params.orgId,
            branchId: params.branchId,
            productId: params.productId,
            supplierId: params.supplierId,
            batchNumber: params.batchNumber,
            expiryDate: expiry,
            purchasePrice: params.cost,
            mrp: params.sell * 1.2,
            sellingPrice: params.sell,
            quantity: params.qty,
            openingQuantity: params.qty
        }
    });
}

// seed N days of direct sale history for a product (so analytics have data)
async function seedSales(orgId: string, branchId: string, userId: string, productId: string, unitsPerDay: number, days: number) {
    for (let d = days - 1; d >= 0; d--) {
        if (d % 2 === 1) continue; // ~half the days
        const at = new Date();
        at.setHours(0, 0, 0, 0);
        at.setDate(at.getDate() - d);
        const sale = await prisma.sale.create({
            data: {
                invoiceNo: `TST-${Date.now()}-${d}`,
                organizationId: orgId,
                branchId,
                customerId: null,
                status: "PAID",
                paymentMode: "CASH",
                subtotal: 100,
                tax: 12,
                total: 112,
                createdById: userId,
                createdAt: at
            }
        });
        await prisma.saleItem.create({
            data: {
                saleId: sale.id,
                productId,
                quantity: unitsPerDay,
                unitPrice: 10,
                unitCost: 7,
                gstRate: 12,
                total: unitsPerDay * 10
            }
        });
    }
}

describe("PharmaSuite backend business logic", () => {
    beforeAll(async () => {
        const code = `TST-${Date.now()}`;
        org = await (async () => {
            const o = await prisma.organization.create({ data: { name: "Test Org", code } });
            return { id: o.id };
        })();
        branch = await (async () => {
            const b = await prisma.branch.create({
                data: { organizationId: org.id, name: "Main", code: "M1" }
            });
            return { id: b.id };
        })();
        const hash = await (await import("bcryptjs")).hash("Password123", 10);
        user = await (async () => {
            const u = await prisma.user.create({
                data: {
                    organizationId: org.id,
                    email: `owner-${code}@test.local`,
                    fullName: "Test Owner",
                    passwordHash: hash,
                    role: "OWNER"
                }
            });
            return { id: u.id };
        })();
        supplier = await (async () => {
            const s = await prisma.supplier.create({
                data: { organizationId: org.id, name: "Test Supplier", leadTimeDays: 5 }
            });
            return { id: s.id };
        })();

        pFefo = await makeProduct(org.id, "FEFO Med");
        pStock = await makeProduct(org.id, "Stockout Med");
        pReorder = await makeProduct(org.id, "Reorder Med");
        pDead = await makeProduct(org.id, "Dead Med");
        pSale = await makeProduct(org.id, "Sale Med");

        // Batches spanning expiry buckets (+ an expired one) for FEFO.
        await makeBatch({
            orgId: org.id,
            branchId: branch.id,
            productId: pFefo.id,
            supplierId: supplier.id,
            batchNumber: "F1",
            expiryDays: 20,
            qty: 30,
            cost: 10,
            sell: 20
        });
        await makeBatch({
            orgId: org.id,
            branchId: branch.id,
            productId: pFefo.id,
            supplierId: supplier.id,
            batchNumber: "F4",
            expiryDays: 40,
            qty: 50,
            cost: 10,
            sell: 20
        });
        await makeBatch({
            orgId: org.id,
            branchId: branch.id,
            productId: pFefo.id,
            supplierId: supplier.id,
            batchNumber: "F2",
            expiryDays: 90,
            qty: 100,
            cost: 10,
            sell: 20
        });
        await makeBatch({
            orgId: org.id,
            branchId: branch.id,
            productId: pFefo.id,
            supplierId: supplier.id,
            batchNumber: "F0",
            expiryDays: -10,
            qty: 20,
            cost: 8,
            sell: 15
        });

        // Stockout med: low quantity + solid 30-day sales history.
        await makeBatch({
            orgId: org.id,
            branchId: branch.id,
            productId: pStock.id,
            supplierId: supplier.id,
            batchNumber: "S1",
            expiryDays: 120,
            qty: 12,
            cost: 5,
            sell: 12
        });
        await seedSales(org.id, branch.id, user.id, pStock.id, 10, 30); // avg 10/day (sold on ~15 days of 30)

        // Reorder med: 20 units, avg ~10/day, lead time 5, safety 15.
        await makeBatch({
            orgId: org.id,
            branchId: branch.id,
            productId: pReorder.id,
            supplierId: supplier.id,
            batchNumber: "R1",
            expiryDays: 200,
            qty: 20,
            cost: 20,
            sell: 40
        });
        await seedSales(org.id, branch.id, user.id, pReorder.id, 20, 30); // avg 10/day

        // Dead stock med: stocked, never sold (past 60 days).
        await makeBatch({
            orgId: org.id,
            branchId: branch.id,
            productId: pDead.id,
            supplierId: supplier.id,
            batchNumber: "D1",
            expiryDays: 400,
            qty: 50,
            cost: 30,
            sell: 60
        });

        // Sale med: enough for a successful sale + insufficient-stock rollback test.
        await makeBatch({
            orgId: org.id,
            branchId: branch.id,
            productId: pSale.id,
            supplierId: supplier.id,
            batchNumber: "T1",
            expiryDays: 150,
            qty: 10,
            cost: 5,
            sell: 12
        });

        // Second org + its own product for tenant isolation checks.
        orgB = await (async () => {
            const o = await prisma.organization.create({ data: { name: "Org B", code: `TSTB-${Date.now()}` } });
            return { id: o.id };
        })();
        pOrgB = await makeProduct(orgB.id, "Other Org Med");
    });

    afterAll(async () => {
        await destroyOrg(org.id);
        await destroyOrg(orgB.id);
    });

    it("FEFO: picks the earliest valid (non-expired) batches first", async () => {
        const selected = await selectFefoBatches({
            organizationId: org.id,
            branchId: branch.id,
            productId: pFefo.id,
            quantity: 60
        });
        expect(selected.map(b => b.batchNumber)).toEqual(["F1", "F4"]);
        expect(selected.reduce((s, b) => s + b.quantity, 0)).toBe(60);
        expect(selected.some(b => b.batchNumber === "F0")).toBe(false);
    });

    it("FEFO: expired batches are never recommended for a normal sale", async () => {
        const ok = await fefoCanFulfill({
            organizationId: org.id,
            branchId: branch.id,
            productId: pFefo.id,
            quantity: 180
        });
        expect(ok).toBe(true); // 30+50+100 = 180 valid units
        const over = await fefoCanFulfill({
            organizationId: org.id,
            branchId: branch.id,
            productId: pFefo.id,
            quantity: 200
        });
        expect(over).toBe(false); // expired 20 units ignored
    });

    it("stockout: computes average daily sales and classifies risk", async () => {
        const risks = await computeStockoutRisks({
            organizationId: org.id,
            branchId: branch.id,
            minAvailable: 100
        });
        const mine = risks.find(r => r.product.id === pStock.id);
        expect(mine).toBeDefined();
        expect(mine!.availableQty).toBe(12);
        // ~10/day → ~1.2 days left → CRITICAL
        expect(mine!.riskLevel).toBe("CRITICAL");
        expect(mine!.averageDailySales).toBeGreaterThan(0);
        expect(mine!.daysUntilStockout).toBeLessThan(3);
    });

    it("reorder: recommended qty accounts for lead time, demand, safety stock and open POs", async () => {
        // open PO for 30 units reduces the recommended order
        await prisma.purchase.create({
            data: {
                poNumber: `TSTPO-${Date.now()}`,
                organizationId: org.id,
                branchId: branch.id,
                supplierId: supplier.id,
                status: "APPROVED",
                subtotal: 100,
                discount: 0,
                tax: 12,
                total: 112,
                createdById: user.id,
                orderDate: new Date(),
                items: { create: { productId: pReorder.id, quantity: 30, purchasePrice: 20, mrp: 40, total: 600, receivedQty: 0 } }
            }
        });
        const recs = await buildReorderRecommendations({ organizationId: org.id, branchId: branch.id });
        const mine = recs.find(r => r.product.id === pReorder.id);
        expect(mine).toBeDefined();
        expect(mine!.openPurchaseQty).toBe(30);
        expect(mine!.supplierLeadTime).toBe(5);
        // 10*5 + 15 - 20 - 30 = 15
        expect(mine!.recommendedQuantity).toBe(15);
        expect(mine!.riskLevel).not.toBe("LOW");
    });

    it("dead stock: products with no sales in 60+ days are detected with trapped capital", async () => {
        const dead = await detectDeadStock({ organizationId: org.id, branchId: branch.id, inactiveDays: 60 });
        const mine = dead.items.find(d => d.productId === pDead.id);
        expect(mine).toBeDefined();
        expect(mine!.stock).toBe(50);
        expect(mine!.daysInactive).toBeGreaterThanOrEqual(60);
        expect(dead.trappedCapital).toBeGreaterThan(0);
    });

    it("purchases: receiving updates batch, creates movement and marks PO received", async () => {
        const purchase = await createPurchase(org.id, user.id, {
            branchId: branch.id,
            supplierId: supplier.id,
            items: [
                {
                    productId: pSale.id,
                    quantity: 25,
                    purchasePrice: 5,
                    mrp: 12,
                    sellingPrice: 12,
                    gstRate: 12,
                    batchNumber: "NEW-B-1",
                    expiryDate: "2027-10-01"
                }
            ]
        });
        const received = await receivePurchase(org.id, purchase.id, user.id);
        expect(received.status).toBe("RECEIVED");

        const batch = await prisma.batch.findFirst({
            where: { batchNumber: "NEW-B-1", organizationId: org.id, branchId: branch.id, productId: pSale.id }
        });
        expect(batch).toBeDefined();
        expect(batch!.quantity).toBe(25);

        const movement = await prisma.inventoryMovement.findFirst({
            where: { type: "PURCHASE", referenceId: purchase.id }
        });
        expect(movement).toBeDefined();
        expect(movement!.afterQty).toBe(25);

        await expect(receivePurchase(org.id, purchase.id, user.id)).rejects.toBeInstanceOf(AppError);
    });

    it("sales: FEFO deduction works and insufficient stock rolls back the transaction", async () => {
        // consume all 10 + 25 (from purchase test) = 35 units sold earlier? The purchase added 25; we now sell 30 total (10 in T1 + 20 in NEW-B-1)
        const before = await prisma.sale.count({ where: { organizationId: org.id } });

        const okSale = await createSale(org.id, user.id, {
            branchId: branch.id,
            items: [{ productId: pSale.id, quantity: 30 }]
        });
        expect(okSale.sale).toBeDefined();

        await expect(
            createSale(org.id, user.id, {
                branchId: branch.id,
                items: [{ productId: pSale.id, quantity: 36 }] // exceeds the 35 on hand -> rollback
            })
        ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

        const after = await prisma.sale.count({ where: { organizationId: org.id } });
        // only the successful sale was recorded, the failed one rolled back
        expect(after).toBe(before + 1);
    });

    it("authorization: cross-organization access is blocked at the service layer", async () => {
        await expect(getProduct(org.id, pOrgB.id)).rejects.toBeInstanceOf(AppError);

        const list = await prisma.purchase.findMany({
            where: { organizationId: org.id },
            select: { poNumber: true }
        });
        const porgBWithOrgA = await prisma.purchase.findFirst({
            where: { organizationId: org.id, poNumber: `OTHER-${Date.now()}` }
        });
        expect(porgBWithOrgA).toBeNull();
        expect(Array.isArray(list)).toBe(true);
    });
});
