import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import { AppError } from "../src/domain/errors";
import {
  createPurchase,
  receivePurchase,
  updatePurchaseStatus,
  createReturn,
  listReturns,
} from "../src/services/purchase.service";
import {
  createSupplier,
  listSuppliers,
} from "../src/services/supplier.service";
import { vendorPriceHistory, vendorPerformance } from "../src/services/purchase-analytics.service";

let org: { id: string };
let branch: { id: string };
let user: { id: string };
let supplier: { id: string };
let supplier2: { id: string };
let product: { id: string };

async function destroyOrg(orgId: string) {
  await prisma.inventoryMovement.deleteMany({ where: { organizationId: orgId } });
  await prisma.purchaseReceiptItem.deleteMany({ where: { receipt: { organizationId: orgId } } });
  await prisma.purchaseReceipt.deleteMany({ where: { organizationId: orgId } });
  await prisma.vendorMedicine.deleteMany({ where: { organizationId: orgId } });
  await prisma.purchaseItem.deleteMany({ where: { purchase: { organizationId: orgId } } });
  await prisma.purchase.deleteMany({ where: { organizationId: orgId } });
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.batch.deleteMany({ where: { organizationId: orgId } });
  await prisma.supplier.deleteMany({ where: { organizationId: orgId } });
  await prisma.product.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.branch.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
}

describe("Vendor + Purchase management module", () => {
  beforeAll(async () => {
    const code = `PUR-${Date.now()}`;
    org = { id: (await prisma.organization.create({ data: { name: "Purchase Org", code } })).id };
    branch = { id: (await prisma.branch.create({ data: { organizationId: org.id, name: "Main", code: "P1" } })).id };
    const hash = await (await import("bcryptjs")).hash("Password123", 10);
    user = {
      id: (
        await prisma.user.create({
          data: { organizationId: org.id, email: `pur-owner-${code}@test.local`, fullName: "Owner", passwordHash: hash, role: "OWNER" },
        })
      ).id,
    };
    supplier = { id: (await createSupplier(org.id, { name: "Alpha Meds", phone: "+91 9000000001" })).id };
    supplier2 = { id: (await createSupplier(org.id, { name: "Beta Pharma", phone: "+91 9000000002", leadTimeDays: 3 })).id };
    product = { id: (await prisma.product.create({ data: { organizationId: org.id, brand: "Pur Med", genericName: "Pur Med", gstRate: 12, prescriptionRequired: false } })).id };
  });

  afterAll(async () => {
    await destroyOrg(org.id);
  });

  it("assigns sequential vendor codes (VEN-XXXX) per organization", async () => {
    const list = await listSuppliers({ organizationId: org.id, page: 1, pageSize: 10 });
    const codes = list.items.map(s => s.code).sort();
    expect(codes).toEqual(["VEN-0001", "VEN-0002"]);
  });

  it("creates a DRAFT purchase with calculated totals and per-line free quantity", async () => {
    const po = await createPurchase(org.id, user.id, {
      branchId: branch.id,
      supplierId: supplier.id,
      items: [
        { productId: product.id, quantity: 100, freeQuantity: 10, purchasePrice: 50, mrp: 75, gstRate: 12, discount: 5 },
      ],
    });
    expect(po.status).toBe("DRAFT");
    expect(po.items[0].receivedQty).toBe(0);
    expect(po.items[0].freeQuantity).toBe(10);
    expect(Number(po.subtotal)).toBe(5000);
    expect(Number(po.discount)).toBe(500);
    expect(Number(po.tax)).toBe(540);
    expect(Number(po.total)).toBe(5040);
    expect(po.poNumber).toMatch(/^PO-\d{4}-0001$/);
  });

  it("submits and approves a purchase", async () => {
    const po = await createPurchase(org.id, user.id, {
      branchId: branch.id,
      supplierId: supplier2.id,
      items: [{ productId: product.id, quantity: 10, purchasePrice: 20, mrp: 30 }],
    });
    await updatePurchaseStatus(org.id, po.id, "SUBMITTED", user.id);
    const approved = await updatePurchaseStatus(org.id, po.id, "APPROVED", user.id);
    expect(approved.applied).toBe(true);
    const latest = await prisma.purchase.findUnique({ where: { id: po.id } });
    expect(latest?.status).toBe("APPROVED");
  });

  it("rejects cancelling a purchase once stock has been received", async () => {
    const po = await createPurchase(org.id, user.id, {
      branchId: branch.id,
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 5, purchasePrice: 10, mrp: 15 }],
    });
    await receivePurchase(org.id, po.id, user.id, branch.id);
    await expect(
      updatePurchaseStatus(org.id, po.id, "CANCELLED", user.id),
    ).rejects.toThrow(AppError);
  });

  it("receives part of an order across multiple batches with free stock", async () => {
    const po = await createPurchase(org.id, user.id, {
      branchId: branch.id,
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 100, freeQuantity: 10, purchasePrice: 50, mrp: 75 }],
    });
    const itemId = po.items[0].id;
    const result = await receivePurchase(org.id, po.id, user.id, branch.id, [
      { purchaseItemId: itemId, productId: product.id, quantity: 50, freeQuantity: 10, batchNumber: "PUR-A1", expiryDate: "2027-12-31", purchasePrice: 50, mrp: 75 },
      { purchaseItemId: itemId, productId: product.id, quantity: 10, batchNumber: "PUR-B1", expiryDate: "2028-06-30", purchasePrice: 51, mrp: 76 },
    ]);

    expect(result.status).toBe("PARTIALLY_RECEIVED");
    expect(result.receipt).toBeTruthy();
    expect(result.receipt.receiptNumber).toMatch(/^GRN-\d{4}-\d{4}$/);

    const batchA = await prisma.batch.findFirst({ where: { batchNumber: "PUR-A1" } });
    const batchB = await prisma.batch.findFirst({ where: { batchNumber: "PUR-B1" } });
    expect(batchA?.quantity).toBe(60); // 50 commercial + 10 free
    expect(batchB?.quantity).toBe(10);

    const movements = await prisma.inventoryMovement.findMany({
      where: { referenceType: "PURCHASE", referenceId: po.id },
    });
    expect(movements).toHaveLength(2);
    expect(movements.map(m => m.quantity).sort((a, b) => a - b)).toEqual([10, 60]);

    const receipts = await prisma.purchaseReceipt.count({ where: { purchaseId: po.id } });
    expect(receipts).toBe(1);
    const receiptItems = await prisma.purchaseReceiptItem.findMany({
      where: { receipt: { purchaseId: po.id } },
    });
    expect(receiptItems).toHaveLength(2);
    expect(receiptItems.find(r => r.batchNumber === "PUR-A1")?.freeQuantity).toBe(10);
  });

  it("receives the remaining quantity and marks the order RECEIVED", async () => {
    const po = await prisma.purchase.findFirst({
      where: { items: { every: { productId: product.id } } },
      orderBy: { createdAt: "desc" },
      include: { items: true },
    });
    if (!po) throw new Error("expected PO");
    const item = po.items[0];
    const result = await receivePurchase(org.id, po.id, user.id, branch.id, [
      { purchaseItemId: item.id, productId: product.id, quantity: item.quantity - item.receivedQty, batchNumber: "PUR-A1", expiryDate: "2027-12-31" },
    ]);
    expect(result.status).toBe("RECEIVED");
    const updated = await prisma.purchaseItem.findUnique({ where: { id: item.id } });
    expect(updated?.receivedQty).toBe(item.quantity);
  });

  it("blocks receiving beyond the ordered quantity", async () => {
    const po = await createPurchase(org.id, user.id, {
      branchId: branch.id,
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 3, purchasePrice: 10, mrp: 15 }],
    });
    const itemId = po.items[0].id;
    await expect(
      receivePurchase(org.id, po.id, user.id, branch.id, [
        { purchaseItemId: itemId, productId: product.id, quantity: 4, batchNumber: "PUR-OVER", expiryDate: "2027-12-31" },
      ]),
    ).rejects.toThrow(AppError);
  });

  it("records a return that decreases batch stock and creates a PURCHASE_RETURN movement", async () => {
    const po = await createPurchase(org.id, user.id, {
      branchId: branch.id,
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 5, purchasePrice: 10, mrp: 15 }],
    });
    await receivePurchase(org.id, po.id, user.id, branch.id);
    const batch = await prisma.batch.findFirst({
      where: { purchase: { some: { id: po.id } } },
    }).catch(() => null);
    const b = batch ?? (await prisma.batch.findFirst({ where: { productId: product.id, branchId: branch.id, batchNumber: { startsWith: "B-" } } }));

    const result = await createReturn(org.id, po.id, user.id, [
      { batchId: b!.id, quantity: 2, reason: "damaged" },
    ]);
    expect(result.results[0].returned).toBe(2);
    const after = await prisma.batch.findUnique({ where: { id: b!.id } });
    expect(after?.quantity).toBe(3);

    const returns = await listReturns({ organizationId: org.id, page: 1, pageSize: 10 });
    const row = returns.items.find(m => m.referenceId === po.id);
    expect(row?.type).toBe("PURCHASE_RETURN");
    expect(row?.quantity).toBe(-2);
  });

  it("rejects returning more stock than the batch holds", async () => {
    const po = await createPurchase(org.id, user.id, {
      branchId: branch.id,
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 2, purchasePrice: 10, mrp: 15 }],
    });
    await receivePurchase(org.id, po.id, user.id, branch.id);
    const b = await prisma.batch.findFirst({ where: { productId: product.id, branchId: branch.id, batchNumber: { startsWith: "B-" } } });
    await expect(
      createReturn(org.id, po.id, user.id, [{ batchId: b!.id, quantity: 999 }]),
    ).rejects.toThrow(AppError);
  });

  it("exposes vendor performance and price history aggregates", async () => {
    const perf = await vendorPerformance(org.id, supplier.id);
    expect(perf.totalOrders).toBeGreaterThan(0);
    expect(perf.totalValue).toBeGreaterThan(0);
    expect(typeof perf.onTimeRate).toBe("number");

    const history = await vendorPriceHistory({ organizationId: org.id, vendorId: supplier.id, productId: product.id });
    expect(history.rows.length).toBeGreaterThan(0);
    expect(history.summary.samples).toBeGreaterThan(0);
    expect(history.rows[0].purchasePrice).toBeGreaterThan(0);
  });

  it("upserts a vendor-medicine snapshot when goods are received", async () => {
    const vm = await prisma.vendorMedicine.findFirst({
      where: { organizationId: org.id, vendorId: supplier.id, productId: product.id },
    });
    expect(vm).toBeTruthy();
    expect(Number(vm?.lastPurchasePrice ?? 0)).toBeGreaterThan(0);
    expect(vm?.lastPurchaseDate).toBeTruthy();
  });
});