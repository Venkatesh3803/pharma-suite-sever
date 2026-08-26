import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import {
  createSale,
  listSales,
  getSale,
  returnSale,
  salesSummary,
  listSaleReturns,
} from "../src/services/sale.service";
import { createSupplier } from "../src/services/supplier.service";

let org: { id: string };
let orgB: { id: string };
let branch: { id: string };
let user: { id: string };
let product: { id: string };
let productB: { id: string };

async function destroyOrg(orgId: string) {
  await prisma.inventoryMovement.deleteMany({ where: { organizationId: orgId } });
  await prisma.saleItem.deleteMany({ where: { sale: { organizationId: orgId } } });
  await prisma.sale.deleteMany({ where: { organizationId: orgId } });
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.batch.deleteMany({ where: { organizationId: orgId } });
  await prisma.supplier.deleteMany({ where: { organizationId: orgId } });
  await prisma.product.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.branch.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
}

async function makeProduct(organizationId: string, brand: string) {
  return prisma.product.create({
    data: { organizationId, brand, genericName: brand, gstRate: 12, prescriptionRequired: false },
  });
}

async function makeBatch(params: {
  productId: string;
  batchNumber: string;
  expiryDays: number;
  qty: number;
  cost: number;
  sell?: number;
}) {
  const expiry = new Date();
  expiry.setHours(0, 0, 0, 0);
  expiry.setDate(expiry.getDate() + params.expiryDays);
  const supplier = await prisma.supplier.findFirst({ where: { organizationId: org.id } });
  return prisma.batch.create({
    data: {
      organizationId: org.id,
      branchId: branch.id,
      productId: params.productId,
      supplierId: supplier?.id ?? null,
      batchNumber: params.batchNumber,
      expiryDate: expiry,
      purchasePrice: params.cost,
      mrp: (params.sell ?? params.cost * 2) * 1.2,
      sellingPrice: params.sell ?? params.cost * 2,
      quantity: params.qty,
      openingQuantity: params.qty,
    },
  });
}

describe("Sales module", () => {
  beforeAll(async () => {
    const code = `SAL-${Date.now()}`;
    org = { id: (await prisma.organization.create({ data: { name: "Sales Org", code } })).id };
    const codeB = `SALB-${Date.now()}`;
    orgB = { id: (await prisma.organization.create({ data: { name: "Sales Org B", code: codeB } })).id };
    branch = { id: (await prisma.branch.create({ data: { organizationId: org.id, name: "Main", code: "S1" } })).id };
    const hash = await (await import("bcryptjs")).hash("Password123", 10);
    user = {
      id: (
        await prisma.user.create({
          data: { organizationId: org.id, email: `sal-owner-${code}@test.local`, fullName: "Owner", passwordHash: hash, role: "OWNER" },
        })
      ).id,
    };
    await createSupplier(org.id, { name: "Sales Supplier" });
    product = await makeProduct(org.id, "Sales Med");
    productB = await makeProduct(orgB.id, "Other Org Med");
    await makeBatch({ productId: product.id, batchNumber: "SL-A1", expiryDays: 300, qty: 40, cost: 20, sell: 30 });
    await makeBatch({ productId: product.id, batchNumber: "SL-B1", expiryDays: 100, qty: 60, cost: 18, sell: 28 });
  });

  afterAll(async () => {
    await destroyOrg(org.id);
    await destroyOrg(orgB.id);
  });

  it("creates a PAID sale using FEFO (older expiry first) with correct totals", async () => {
    const result = await createSale(org.id, user.id, {
      branchId: branch.id,
      paymentMode: "CASH",
      items: [{ productId: product.id, quantity: 70 }],
    });
    expect(result.sale.status).toBe("PAID");
    expect(result.sale.invoiceNo).toMatch(/^INV-\d{4}-0001$/);
    // 60 units from B1 (28) + 10 from A1 (30)
    expect(Number(result.totals.subtotal)).toBe(60 * 28 + 10 * 30);
    expect(Number(result.totals.tax)).toBeCloseTo((60 * 28 + 10 * 30) * 0.12, 5);

    const a1 = await prisma.batch.findFirst({ where: { batchNumber: "SL-A1" } });
    const b1 = await prisma.batch.findFirst({ where: { batchNumber: "SL-B1" } });
    expect(a1?.quantity).toBe(30);
    expect(b1?.quantity).toBe(0);

    const movements = await prisma.inventoryMovement.findMany({
      where: { referenceType: "SALE", referenceId: result.sale.id },
    });
    expect(movements.reduce((acc, m) => acc + m.quantity, 0)).toBe(-70);

    const items = await prisma.saleItem.findMany({ where: { saleId: result.sale.id } });
    expect(items.length).toBe(2);
    expect(items.reduce((acc, i) => acc + i.quantity, 0)).toBe(70);
  });

  it("sets DUE status for CREDIT payment", async () => {
    const result = await createSale(org.id, user.id, {
      branchId: branch.id,
      paymentMode: "CREDIT",
      items: [{ productId: product.id, quantity: 5 }],
    });
    expect(result.sale.status).toBe("DUE");
  });

  it("rejects sales when stock is insufficient and rolls back", async () => {
    const before = await prisma.sale.count({ where: { organizationId: org.id } });
    await expect(
      createSale(org.id, user.id, {
        branchId: branch.id,
        items: [{ productId: product.id, quantity: 9999 }],
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    const after = await prisma.sale.count({ where: { organizationId: org.id } });
    expect(after).toBe(before);
  });

  it("lists and filters sales", async () => {
    const all = await listSales({ organizationId: org.id, page: 1, pageSize: 10 });
    expect(all.total).toBeGreaterThanOrEqual(2);
    const cash = await listSales({ organizationId: org.id, status: "PAID", page: 1, pageSize: 10 });
    expect(cash.items.every(s => s.status === "PAID")).toBe(true);
    const due = await listSales({ organizationId: org.id, status: "DUE", page: 1, pageSize: 10 });
    expect(due.items.length).toBe(1);
  });

  it("gets a single sale with items", async () => {
    const list = await listSales({ organizationId: org.id, page: 1, pageSize: 1 });
    const sale = await getSale(org.id, list.items[0].id);
    expect(sale.items.length).toBeGreaterThan(0);
    expect(sale.items[0].product).toBeTruthy();
  });

  it("records a partial return: restores stock, creates SALE_RETURN movement", async () => {
    const result = await createSale(org.id, user.id, {
      branchId: branch.id,
      items: [{ productId: product.id, quantity: 10 }],
    });
    const saleId = result.sale.id;
    const saleItems = await prisma.saleItem.findMany({ where: { saleId } });
    const a1Before = (await prisma.batch.findFirst({ where: { batchNumber: "SL-A1" } }))?.quantity ?? 0;

    const returned = await returnSale(org.id, saleId, user.id, [
      { saleItemId: saleItems[0].id, quantity: 4, reason: "customer returned" },
    ]);
    expect(returned.status).toBe("PARTIAL_RETURN");
    expect(returned.totalRefund).toBe(Number(saleItems[0].unitPrice) * 4);

    const a1After = (await prisma.batch.findFirst({ where: { batchNumber: "SL-A1" } }))?.quantity ?? 0;
    expect(a1After).toBe(a1Before + 4);

    const movement = await prisma.inventoryMovement.findFirst({
      where: { referenceId: saleId, type: "SALE_RETURN" },
    });
    expect(movement?.quantity).toBe(4);

    const updatedItem = await prisma.saleItem.findUnique({ where: { id: saleItems[0].id } });
    expect(updatedItem?.returnedQty).toBe(4);
  });

  it("marks the sale RETURNED when every unit is returned", async () => {
    const result = await createSale(org.id, user.id, {
      branchId: branch.id,
      items: [{ productId: product.id, quantity: 3 }],
    });
    const saleId = result.sale.id;
    const saleItems = await prisma.saleItem.findMany({ where: { saleId } });
    await returnSale(org.id, saleId, user.id, [
      { saleItemId: saleItems[0].id, quantity: 3 },
    ]);
    const sale = await prisma.sale.findUnique({ where: { id: saleId } });
    expect(sale?.status).toBe("RETURNED");

    // further returns are blocked
    await expect(
      returnSale(org.id, saleId, user.id, [{ saleItemId: saleItems[0].id, quantity: 1 }]),
    ).rejects.toThrow();
  });

  it("blocks returning more than what was sold", async () => {
    const result = await createSale(org.id, user.id, {
      branchId: branch.id,
      items: [{ productId: product.id, quantity: 5 }],
    });
    const saleItems = await prisma.saleItem.findMany({ where: { saleId: result.sale.id } });
    await expect(
      returnSale(org.id, result.sale.id, user.id, [
        { saleItemId: saleItems[0].id, quantity: 6 },
      ]),
    ).rejects.toMatchObject({ code: "OVER_RETURN" });
  });

  it("exposes a sales summary with KPIs, payment mix and top products", async () => {
    const summary = await salesSummary({ organizationId: org.id });
    expect(summary.todayInvoices).toBeGreaterThanOrEqual(4);
    expect(summary.todaySales).toBeGreaterThan(0);
    expect(summary.monthInvoices).toBe(summary.todayInvoices);
    expect(Array.isArray(summary.paymentMix)).toBe(true);
    expect(summary.paymentMix.some(p => p.mode === "CASH")).toBe(true);
    expect(summary.topProducts[0].brand).toBe("Sales Med");

    const returns = await listSaleReturns({ organizationId: org.id, page: 1, pageSize: 10 });
    expect(returns.items.length).toBeGreaterThanOrEqual(2);
  });

  it("isolates sales across organizations", async () => {
    await expect(getSale(org.id, productB.id)).rejects.toThrow();
    const otherList = await listSales({ organizationId: orgB.id, page: 1, pageSize: 10 });
    expect(otherList.total).toBe(0);
  });
});