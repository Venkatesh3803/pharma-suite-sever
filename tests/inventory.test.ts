import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import { AppError } from "../src/domain/errors";
import { consumeStockUsingFEFO, allocateStockUsingFEFO, sellableStock } from "../src/services/intelligence/fefo.service";
import {
  toBaseUnits,
  fromBaseUnits,
  formatBaseUnits,
  parseUnitConfig,
  type UnitConfig,
} from "../src/services/units.service";
import { expiryStatus } from "../src/services/intelligence/inventory-status.service";
import { adjustBatchStock, applyStockCount, getMedicineInventory, listInventoryItems, addOpeningBatch } from "../src/services/inventory.service";
import { createProduct, createCategory, listCategories } from "../src/services/product.service";
import { priceVariance } from "../src/services/intelligence/movement-analytics.service";
import { inventoryValue } from "../src/services/intelligence/inventory-analytics.service";
import { detectDeadStock } from "../src/services/intelligence/deadstock.service";

const DOLO_UNITS: UnitConfig = {
  baseUnit: "tablet",
  baseUnitLabel: "tablet",
  saleUnit: "strip",
  saleUnitFactor: 10,
  levels: [
    { name: "box", factor: 100, label: "box" },
    { name: "strip", factor: 10, label: "strip" },
  ],
};

let org: { id: string };
let branch: { id: string };
let user: { id: string };
let supplier: { id: string };
let pFefo: { id: string };
let pAdjust: { id: string };
let pCount: { id: string };
let pDead: { id: string };
let pVal: { id: string };

async function makeProduct(organizationId: string, brand: string) {
  return prisma.product.create({
    data: {
      organizationId,
      brand,
      genericName: brand,
      gstRate: 12,
      prescriptionRequired: true,
      unitConfig: DOLO_UNITS as never,
    },
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
  return prisma.batch.create({
    data: {
      organizationId: org.id,
      branchId: branch.id,
      productId: params.productId,
      supplierId: supplier.id,
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

async function destroyOrg(id: string) {
  await prisma.inventoryMovement.deleteMany({ where: { organizationId: id } });
  await prisma.saleItem.deleteMany({ where: { sale: { organizationId: id } } });
  await prisma.sale.deleteMany({ where: { organizationId: id } });
  await prisma.purchaseReceiptItem.deleteMany({ where: { receipt: { organizationId: id } } });
  await prisma.purchaseReceipt.deleteMany({ where: { organizationId: id } });
  await prisma.vendorMedicine.deleteMany({ where: { organizationId: id } });
  await prisma.purchaseItem.deleteMany({ where: { purchase: { organizationId: id } } });
  await prisma.purchase.deleteMany({ where: { organizationId: id } });
  await prisma.auditLog.deleteMany({ where: { organizationId: id } });
  await prisma.batch.deleteMany({ where: { organizationId: id } });
  await prisma.customer.deleteMany({ where: { organizationId: id } });
  await prisma.supplier.deleteMany({ where: { organizationId: id } });
  await prisma.product.deleteMany({ where: { organizationId: id } });
  await prisma.productCategory.deleteMany({ where: { organizationId: id } });
  await prisma.branch.deleteMany({ where: { organizationId: id } });
  await prisma.organization.delete({ where: { id } });
}

describe("Inventory module business rules", () => {
  beforeAll(async () => {
    const code = `INV-${Date.now()}`;
    org = { id: (await prisma.organization.create({ data: { name: "Inv Org", code } })).id };
    branch = { id: (await prisma.branch.create({ data: { organizationId: org.id, name: "Main", code: "M1" } })).id };
    const hash = await (await import("bcryptjs")).hash("Password123", 10);
    user = {
      id: (
        await prisma.user.create({
          data: { organizationId: org.id, email: `inv-owner-${code}@test.local`, fullName: "Owner", passwordHash: hash, role: "OWNER" },
        })
      ).id,
    };
    supplier = { id: (await prisma.supplier.create({ data: { organizationId: org.id, name: "S", leadTimeDays: 5 } })).id };

    pFefo = await makeProduct(org.id, "FEFO Med");
    pAdjust = await makeProduct(org.id, "Adjust Med");
    pCount = await makeProduct(org.id, "Count Med");
    pDead = await makeProduct(org.id, "Dead Med");
    pVal = await makeProduct(org.id, "Value Med");
  });

  afterAll(async () => {
    await destroyOrg(org.id);
  });

  it("units: converts box/strip/tablet parts into a canonical base quantity", () => {
    const base = toBaseUnits(DOLO_UNITS, [
      { level: "box", quantity: 2 },
      { level: "strip", quantity: 3 },
      { level: "tablet", quantity: 4 },
    ]);
    expect(base).toBe(234);

    const breakdown = fromBaseUnits(DOLO_UNITS, 234);
    expect(breakdown.levels).toEqual([
      { name: "box", label: "box", quantity: 2, factor: 100 },
      { name: "strip", label: "strip", quantity: 3, factor: 10 },
    ]);
    expect(breakdown.remainder).toBe(4);
    expect(formatBaseUnits(DOLO_UNITS, 234)).toBe("2 boxes, 3 strips, 4 tablets");
  });

  it("units: rejects fractional quantities and unknown levels", () => {
    expect(() => toBaseUnits(DOLO_UNITS, [{ level: "strip", quantity: 2.5 }])).toThrow(AppError);
    expect(() => toBaseUnits(DOLO_UNITS, [{ level: "ampoule", quantity: 2 }])).toThrow(AppError);
    expect(() => toBaseUnits(DOLO_UNITS, [{ level: "strip", quantity: -1 }])).toThrow(AppError);
  });

  it("units: parseUnitConfig defaults safely for an empty product config", () => {
    const cfg = parseUnitConfig({});
    expect(cfg.baseUnit).toBe("unit");
    expect(cfg.saleUnitFactor).toBe(1);
    expect(toBaseUnits(cfg, [{ level: "unit", quantity: 7 }])).toBe(7);
  });

  it("expiry: classifies EXPIRED, 30/60/90-day windows and HEALTHY", () => {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const d = (n: number) => {
      const x = new Date(base);
      x.setDate(x.getDate() + n);
      return x;
    };
    expect(expiryStatus(d(-1), base)).toBe("EXPIRED");
    expect(expiryStatus(d(0), base)).toBe("EXPIRING_30_DAYS");
    expect(expiryStatus(d(15), base)).toBe("EXPIRING_30_DAYS");
    expect(expiryStatus(d(45), base)).toBe("EXPIRING_60_DAYS");
    expect(expiryStatus(d(75), base)).toBe("EXPIRING_90_DAYS");
    expect(expiryStatus(d(120), base)).toBe("HEALTHY");
  });

  it("FEFO: consumes earliest valid batch first, skipping expired", async () => {
    await makeBatch({ productId: pFefo.id, batchNumber: "F-EARLY", expiryDays: 40, qty: 30, cost: 10 });
    await makeBatch({ productId: pFefo.id, batchNumber: "F-LATE", expiryDays: 120, qty: 50, cost: 10 });
    await makeBatch({ productId: pFefo.id, batchNumber: "F-EXPIRED", expiryDays: -5, qty: 20, cost: 10 });

    const allocated = await allocateStockUsingFEFO(prisma, {
      organizationId: org.id,
      branchId: branch.id,
      productId: pFefo.id,
      quantity: 45,
    });
    expect(allocated.map(a => a.batchNumber)).toEqual(["F-EARLY", "F-LATE"]);
    expect(allocated.reduce((s, a) => s + a.quantity, 0)).toBe(45);
    expect(allocated.some(a => a.batchNumber === "F-EXPIRED")).toBe(false);

    const sellable = await sellableStock({ organizationId: org.id, productId: pFefo.id, branchId: branch.id });
    expect(sellable).toBe(80); // 30 + 50; expired 20 excluded
  });

  it("FEFO: atomic consumption deducts balances and records movements", async () => {
    await prisma.$transaction(async tx => {
      await consumeStockUsingFEFO(tx, {
        organizationId: org.id,
        branchId: branch.id,
        productId: pFefo.id,
        quantity: 10,
        movementType: "SALE",
        referenceType: "SALE",
        referenceId: "test-sale",
        userId: user.id,
      });
    });

    const early = await prisma.batch.findFirst({ where: { batchNumber: "F-EARLY" } });
    expect(early!.quantity).toBe(20);

    const movement = await prisma.inventoryMovement.findFirst({
      where: { referenceId: "test-sale", type: "SALE" },
    });
    expect(movement).toBeDefined();
    expect(movement!.quantity).toBe(-10);
    expect(movement!.beforeQty).toBe(30);
    expect(movement!.afterQty).toBe(20);
  });

  it("FEFO: insufficient stock rejects allocation and does not consume expired stock", async () => {
    await expect(
      allocateStockUsingFEFO(prisma, {
        organizationId: org.id,
        branchId: branch.id,
        productId: pFefo.id,
        quantity: 9999,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
  });

  it("FEFO: expired stock cannot be consumed even when sellable stock is exhausted", async () => {
    await expect(
      allocateStockUsingFEFO(prisma, {
        organizationId: org.id,
        branchId: branch.id,
        productId: pFefo.id,
        quantity: 71, // 20 sellable (after previous consumption) + expired 20 = 40 total
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
  });

  it("adjustment: increase works, decrease works, negative prevented, movement + audit recorded", async () => {
    const batch = await makeBatch({ productId: pAdjust.id, batchNumber: "A-1", expiryDays: 200, qty: 100, cost: 5, sell: 10 });

    await adjustBatchStock({
      organizationId: org.id,
      branchId: branch.id,
      batchId: batch.id,
      productId: pAdjust.id,
      quantity: 25,
      reason: "OPENING_BALANCE",
      userId: user.id,
    });
    expect((await prisma.batch.findUnique({ where: { id: batch.id } }))!.quantity).toBe(125);

    await adjustBatchStock({
      organizationId: org.id,
      branchId: branch.id,
      batchId: batch.id,
      productId: pAdjust.id,
      quantity: -10,
      reason: "DAMAGE",
      note: "Damaged strips",
      userId: user.id,
    });
    expect((await prisma.batch.findUnique({ where: { id: batch.id } }))!.quantity).toBe(115);

    await expect(
      adjustBatchStock({
        organizationId: org.id,
        branchId: branch.id,
        batchId: batch.id,
        productId: pAdjust.id,
        quantity: -500,
        reason: "DATA_CORRECTION",
        userId: user.id,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    // No zero/negative stock and no silent clamp.
    const after = await prisma.batch.findUnique({ where: { id: batch.id } });
    expect(after!.quantity).toBe(115);

    const movements = await prisma.inventoryMovement.findMany({ where: { batchId: batch.id, type: "ADJUSTMENT" } });
    expect(movements.length).toBe(2);
    const audit = await prisma.auditLog.findMany({ where: { entityId: batch.id, action: "STOCK_ADJUSTED" } });
    expect(audit.length).toBe(2);
  });

  it("stock count: applies difference as controlled adjustment, never overwrites expected", async () => {
    const batch = await makeBatch({ productId: pCount.id, batchNumber: "C-1", expiryDays: 300, qty: 120, cost: 5, sell: 10 });
    const result = await applyStockCount({
      organizationId: org.id,
      branchId: branch.id,
      userId: user.id,
      counts: [{ batchId: batch.id, productId: pCount.id, physicalQuantity: 115 }],
    });
    expect(result.results[0]).toMatchObject({ expected: 120, physical: 115, difference: -5, applied: true });
    expect((await prisma.batch.findUnique({ where: { id: batch.id } }))!.quantity).toBe(115);
  });

  it("valuation: values each batch at its own purchase cost", async () => {
    await makeBatch({ productId: pVal.id, batchNumber: "V-1", expiryDays: 100, qty: 10, cost: 18, sell: 30 });
    await makeBatch({ productId: pVal.id, batchNumber: "V-2", expiryDays: 150, qty: 5, cost: 21, sell: 32 });
    const val = await inventoryValue({ organizationId: org.id, branchId: branch.id });
    // pFefo has 20 sellable (cost 10) + pAdjust 115 (cost 5) + pCount 115 (cost 5) + pVal 15
    // pVal portion = 10*18 + 5*21 = 180 + 105 = 285
    const pValBatchSum = await prisma.batch.aggregate({
      where: { productId: pVal.id, quantity: { gt: 0 } },
      _sum: { purchasePrice: true, quantity: true },
    });
    expect(Number(pValBatchSum._sum.purchasePrice ?? 0)).toBe(39);
    expect(val.totalUnits).toBeGreaterThanOrEqual(15);
    expect(val.costValue).toBeGreaterThan(285);
  });

  it("price variance: previous vs current purchase price", () => {
    const v = priceVariance(21, 18);
    expect(v.difference).toBe(3);
    expect(v.variancePct).toBe(16.67);
  });

  it("dead stock: based on lack of outbound sales, purchases do not reset last-sale", async () => {
    await makeBatch({ productId: pDead.id, batchNumber: "D-1", expiryDays: 400, qty: 40, cost: 30, sell: 60 });
    // A purchase movement must NOT make this product "active".
    await prisma.inventoryMovement.create({
      data: {
        organizationId: org.id,
        branchId: branch.id,
        productId: pDead.id,
        batchId: null,
        type: "PURCHASE",
        quantity: 10,
        beforeQty: 0,
        afterQty: 10,
        unitCost: 30,
        referenceType: "PURCHASE",
        userId: user.id,
      },
    });
    const dead = await detectDeadStock({ organizationId: org.id, branchId: branch.id, inactiveDays: 60 });
    const mine = dead.items.find(d => d.productId === pDead.id);
    expect(mine).toBeDefined();
    expect(mine!.stock).toBe(40);
    expect(mine!.daysInactive).toBeGreaterThanOrEqual(60);
  });

  it("medicine detail: aggregates sellable/expired/value and sorts batches by nearest expiry", async () => {
    const detail = await getMedicineInventory({ organizationId: org.id, medicineId: pVal.id, branchId: branch.id });
    expect(detail.batches.length).toBe(2);
    expect(detail.batches[0].batchNumber).toBe("V-1"); // nearest expiry first
    expect(detail.summary.sellableStock).toBe(15);
    expect(detail.summary.inventoryValue).toBe(285);
    expect(detail.priceHistory.length).toBe(2);
    expect(detail.intelligence.reorderSuggestion).toBeGreaterThanOrEqual(0);
  });

  it("inventory list: search + stock status filter works", async () => {
    const all = await listInventoryItems({ organizationId: org.id, branchId: branch.id, page: 1, pageSize: 50 });
    expect(all.total).toBeGreaterThanOrEqual(5);

    const searched = await listInventoryItems({
      organizationId: org.id,
      branchId: branch.id,
      search: "Adjust Med",
      page: 1,
      pageSize: 50,
    });
    expect(searched.items.some(i => i.brand === "Adjust Med")).toBe(true);
    expect(searched.items.every(i => i.brand === "Adjust Med")).toBe(true);
  });

  it("authorization: cross-organization batch adjustment is blocked", async () => {
    const other = { id: (await prisma.organization.create({ data: { name: "Other", code: `OTH-${Date.now()}` } })).id };
    const otherBranch = { id: (await prisma.branch.create({ data: { organizationId: other.id, name: "B", code: "B1" } })).id };
    try {
      await expect(
        adjustBatchStock({
          organizationId: other.id,
          branchId: otherBranch.id,
          batchId: (await prisma.batch.findFirst({ where: { productId: pAdjust.id } }))!.id,
          productId: pAdjust.id,
          quantity: -1,
          reason: "OTHER",
          userId: user.id,
        }),
      ).rejects.toBeInstanceOf(AppError);
    } finally {
      await prisma.branch.delete({ where: { id: otherBranch.id } });
      await prisma.organization.delete({ where: { id: other.id } });
    }
  });
});

describe("Inventory creation flow (new org)", () => {
  beforeAll(async () => {
    const code = `NEW-${Date.now()}`;
    org = { id: (await prisma.organization.create({ data: { name: "New Org", code } })).id };
    branch = { id: (await prisma.branch.create({ data: { organizationId: org.id, name: "Main", code: "M1" } })).id };
    const hash = await (await import("bcryptjs")).hash("Password123", 10);
    user = {
      id: (
        await prisma.user.create({
          data: { organizationId: org.id, email: `new-owner-${code}@test.local`, fullName: "Owner", passwordHash: hash, role: "OWNER" },
        })
      ).id,
    };
    supplier = { id: (await prisma.supplier.create({ data: { organizationId: org.id, name: "S", leadTimeDays: 5 } })).id };
  });

  afterAll(async () => {
    await destroyOrg(org.id);
  });

  it("createProduct persists a full unitConfig (box/strip/tablet)", async () => {
    const p = await createProduct(org.id, {
      brand: "Fresh Tablet",
      genericName: "Fresh",
      gstRate: 12,
      categoryId: (await createCategory(org.id, "Vitamins")).id,
      unitConfig: {
        baseUnit: "tablet",
        baseUnitLabel: "tablet",
        saleUnit: "strip",
        saleUnitFactor: 10,
        levels: [
          { name: "strip", label: "strip", factor: 10 },
          { name: "box", label: "box", factor: 100 },
        ],
      },
    });
    const uc = parseUnitConfig(p.unitConfig as Record<string, unknown>);
    expect(uc.baseUnit).toBe("tablet");
    expect(uc.saleUnit).toBe("strip");
    expect(uc.saleUnitFactor).toBe(10);
    expect(uc.levels).toEqual([
      { name: "box", factor: 100, label: "box" },
      { name: "strip", factor: 10, label: "strip" },
    ]);
  });

  it("createCategory is idempotent on case-insensitive name", async () => {
    const a = await createCategory(org.id, "Cardiac");
    const b = await createCategory(org.id, "cardiac");
    expect(b.id).toBe(a.id);
    expect((await listCategories(org.id)).some(c => c.name === "Cardiac")).toBe(true);
  });

  it("addOpeningBatch creates the first batch with stock and OPENING_STOCK movement", async () => {
    const p = await createProduct(org.id, { brand: "Opening Med", unitConfig: { baseUnit: "tablet", saleUnit: "tablet", saleUnitFactor: 1, levels: [] } });
    const result = await addOpeningBatch({
      organizationId: org.id,
      branchId: branch.id,
      productId: p.id,
      quantity: 60,
      batchNumber: "OPEN-001",
      expiryDate: "2027-06-30",
      purchasePrice: 5,
      mrp: 10,
      sellingPrice: 9,
      supplierId: supplier.id,
      userId: user.id,
      note: "opening stock",
    });
    expect(result.created).toBe(true);
    expect(result.batch.quantity).toBe(60);
    expect(Number(result.batch.purchasePrice)).toBe(5);

    const movements = await prisma.inventoryMovement.findMany({ where: { productId: p.id } });
    expect(movements.length).toBe(1);
    expect(movements[0].type).toBe("OPENING_STOCK");
    expect(movements[0].afterQty).toBe(60);
  });

  it("addOpeningBatch tops up an existing batch instead of creating a duplicate", async () => {
    const p = await createProduct(org.id, { brand: "Topup Med", unitConfig: { baseUnit: "tablet", saleUnit: "tablet", saleUnitFactor: 1, levels: [] } });
    await addOpeningBatch({
      organizationId: org.id,
      branchId: branch.id,
      productId: p.id,
      quantity: 10,
      batchNumber: "TP-1",
      userId: user.id,
    });
    const second = await addOpeningBatch({
      organizationId: org.id,
      branchId: branch.id,
      productId: p.id,
      quantity: 5,
      batchNumber: "TP-1",
      userId: user.id,
    });
    expect(second.created).toBe(false);
    const batch = await prisma.batch.findFirst({ where: { productId: p.id, batchNumber: "TP-1" } });
    expect(batch!.quantity).toBe(15);
    const movements = await prisma.inventoryMovement.findMany({ where: { productId: p.id } });
    expect(movements.filter(m => m.type === "OPENING_STOCK").length).toBe(2);
    expect(movements.map(m => m.afterQty)).toEqual([10, 15]);
  });

  it("addOpeningBatch rejects zero/negative quantity", async () => {
    const p = await createProduct(org.id, { brand: "Bad Qty Med", unitConfig: { baseUnit: "tablet", saleUnit: "tablet", saleUnitFactor: 1, levels: [] } });
    await expect(
      addOpeningBatch({ organizationId: org.id, branchId: branch.id, productId: p.id, quantity: 0, userId: user.id }),
    ).rejects.toBeInstanceOf(AppError);
  });
});