import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import {
  ensureChartOfAccounts,
  listAccounts,
  createJournal,
  trialBalance,
  profitAndLoss,
  balanceSheet,
  getLedger,
  financeOverview,
  DEFAULT_ACCOUNTS,
} from "../src/services/finance.service";
import { AppError } from "../src/domain/errors";
import { createSale } from "../src/services/sale.service";
import { createSupplier } from "../src/services/supplier.service";

let org: { id: string };
let user: { id: string };
let branch: { id: string };
let cashAcc: { id: string };
let revenueAcc: { id: string };
let rentAcc: { id: string };

async function destroyOrg(orgId: string) {
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } });
  await prisma.account.deleteMany({ where: { organizationId: orgId } });
  await prisma.sale.deleteMany({ where: { organizationId: orgId } });
  await prisma.inventoryMovement.deleteMany({ where: { organizationId: orgId } });
  await prisma.batch.deleteMany({ where: { organizationId: orgId } });
  await prisma.supplier.deleteMany({ where: { organizationId: orgId } });
  await prisma.product.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.branch.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
}

describe("Double-entry accounting module", () => {
  beforeAll(async () => {
    const code = `FIN-${Date.now()}`;
    org = { id: (await prisma.organization.create({ data: { name: "Finance Org", code } })).id };
    branch = { id: (await prisma.branch.create({ data: { organizationId: org.id, name: "Main", code: "F1" } })).id };
    const hash = await (await import("bcryptjs")).hash("Password123", 10);
    user = {
      id: (
        await prisma.user.create({
          data: { organizationId: org.id, email: `fin-owner-${code}@test.local`, fullName: "Owner", passwordHash: hash, role: "OWNER" },
        })
      ).id,
    };

    await ensureChartOfAccounts(org.id);
    const accounts = await listAccounts(org.id);
    cashAcc = accounts.find(a => a.code === "1010")!;
    revenueAcc = accounts.find(a => a.code === "4000")!;
    rentAcc = accounts.find(a => a.code === "5200")!;
  });

  afterAll(async () => {
    await destroyOrg(org.id);
  });

  it("seeds the standard chart of accounts for a workspace", async () => {
    const accounts = await listAccounts(org.id);
    expect(accounts.length).toBe(DEFAULT_ACCOUNTS.length);
    expect(accounts.map(a => a.code)).toContain("1010");
    expect(accounts.map(a => a.code)).toContain("2000");
    expect(accounts.map(a => a.code)).toContain("4000");
  });

  it("posts a balanced journal entry and reflects it in the trial balance", async () => {
    await createJournal(org.id, user.id, {
      description: "Monthly rent",
      lines: [
        { accountId: rentAcc.id, debit: 1000 },
        { accountId: cashAcc.id, credit: 1000 },
      ],
    });

    const tb = await trialBalance(org.id);
    const cash = tb.rows.find(r => r.id === cashAcc.id)!;
    const rent = tb.rows.find(r => r.id === rentAcc.id)!;
    expect(cash.balance).toBe(-1000);
    expect(rent.balance).toBe(1000);
    expect(tb.totalDebit).toBeCloseTo(tb.totalCredit, 5);
  });

  it("rejects an unbalanced journal entry", async () => {
    await expect(
      createJournal(org.id, user.id, {
        description: "Bad entry",
        lines: [
          { accountId: cashAcc.id, debit: 100 },
          { accountId: revenueAcc.id, credit: 50 },
        ],
      }),
    ).rejects.toThrow(AppError);
  });

  it("computes a P&L from revenue and expense activity", async () => {
    // Revenue 5000 + existing rent 1000 expense.
    await createJournal(org.id, user.id, {
      description: "Walk-in sale revenue",
      lines: [
        { accountId: cashAcc.id, debit: 5000 },
        { accountId: revenueAcc.id, credit: 5000 },
      ],
    });

    const pnl = await profitAndLoss(org.id);
    expect(pnl.totalRevenue).toBe(5000);
    expect(pnl.totalExpenses).toBe(1000);
    expect(pnl.netProfit).toBe(4000);
  });

  it("produces a balanced balance sheet (assets = liabilities + equity)", async () => {
    const bs = await balanceSheet(org.id);
    expect(bs.totalAssets).toBeCloseTo(bs.totalLiabilities + bs.totalEquity, 5);
    expect(bs.balanced).toBe(true);
    // Cash went up by net 5000 - 1000 = 4000 (plus COGS/inventory in auto-posting may vary).
    expect(bs.assets.some(a => a.name === "Cash on Hand")).toBe(true);
  });

  it("computes a ledger with a running balance", async () => {
    const ledger = await getLedger(org.id, cashAcc.id);
    const last = ledger.rows[ledger.rows.length - 1];
    expect(last.runningBalance).toBeCloseTo(ledger.balance, 5);
    expect(ledger.rows.length).toBeGreaterThanOrEqual(2);
  });

  it("returns a finance overview with month metrics", async () => {
    const overview = await financeOverview(org.id);
    expect(overview.month.totalRevenue).toBe(5000);
    expect(overview.recent.length).toBeGreaterThan(0);
  });

  it("auto-posts a sale into the ledger", async () => {
    await createSupplier(org.id, { name: "Fin Supplier" });
    const product = await prisma.product.create({
      data: { organizationId: org.id, brand: "Fin Med", genericName: "Fin Med", gstRate: 12, prescriptionRequired: false },
    });
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 300);
    await prisma.batch.create({
      data: {
        organizationId: org.id,
        branchId: branch.id,
        productId: product.id,
        supplierId: (await prisma.supplier.findFirst({ where: { organizationId: org.id } }))?.id ?? null,
        batchNumber: "FIN-B1",
        expiryDate: expiry,
        purchasePrice: 20,
        mrp: 36,
        sellingPrice: 30,
        quantity: 50,
        openingQuantity: 50,
      },
    });

    await createSale(org.id, user.id, {
      branchId: branch.id,
      paymentMode: "CASH",
      items: [{ productId: product.id, quantity: 10 }],
    });

    const entries = await prisma.journalEntry.findMany({
      where: { organizationId: org.id, description: { contains: "Sales INV" } },
      include: { lines: { include: { account: true } } },
    });
    expect(entries.length).toBe(1);
    const saleEntry = entries[0];
    const debit = saleEntry.lines.find(l => Number(l.debit) > 0)!;
    const creditRev = saleEntry.lines.find(l => l.account.code === "4000")!;
    expect(debit.account.code).toBe("1010"); // cash
    expect(Number(creditRev.credit)).toBeCloseTo(300, 5); // 10 * 30

    const cogs = await prisma.journalEntry.findFirst({
      where: { organizationId: org.id, description: { contains: "COGS for" } },
    });
    expect(cogs).not.toBeNull();
  });
});