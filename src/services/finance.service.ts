import type { AccountType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../domain/errors.js";
import type { DbClient, TxClient } from "./stock.service.js";

/**
 * Double-entry accounting engine.
 *
 * Every organization gets a standard chart of accounts (seeded lazily).
 * Manual journal entries must balance (debits == credits). Sales and
 * purchase receipts are auto-posted so the ledger stays in sync with the
 * pharmacy's operations without extra data entry.
 */

export const DEFAULT_ACCOUNTS: {
  code: string;
  name: string;
  type: AccountType;
}[] = [
  // Assets
  { code: "1010", name: "Cash on Hand", type: "ASSET" },
  { code: "1020", name: "Bank Account", type: "ASSET" },
  { code: "1100", name: "Customer Receivables", type: "ASSET" },
  { code: "1200", name: "Inventory", type: "ASSET" },
  { code: "1300", name: "GST Input Receivable", type: "ASSET" },
  { code: "1400", name: "Fixed Assets", type: "ASSET" },
  // Liabilities
  { code: "2000", name: "GST Payable", type: "LIABILITY" },
  { code: "2100", name: "Supplier Payables", type: "LIABILITY" },
  { code: "2200", name: "Short-term Loans", type: "LIABILITY" },
  // Equity
  { code: "3000", name: "Owner's Capital", type: "EQUITY" },
  { code: "3100", name: "Retained Earnings", type: "EQUITY" },
  // Revenue
  { code: "4000", name: "Sales Revenue", type: "REVENUE" },
  { code: "4100", name: "Other Income", type: "REVENUE" },
  // Expenses
  { code: "5000", name: "Cost of Goods Sold", type: "EXPENSE" },
  { code: "5100", name: "Salaries & Wages", type: "EXPENSE" },
  { code: "5200", name: "Rent & Utilities", type: "EXPENSE" },
  { code: "5300", name: "Operating Supplies", type: "EXPENSE" },
  { code: "5400", name: "Transport & Delivery", type: "EXPENSE" },
  { code: "5500", name: "Marketing & Advertising", type: "EXPENSE" },
  { code: "5600", name: "Taxes & Licenses", type: "EXPENSE" },
  { code: "5700", name: "Bank Charges", type: "EXPENSE" },
  { code: "5800", name: "Miscellaneous Expenses", type: "EXPENSE" },
];

const ACCOUNT_CODES = {
  cash: "1010",
  bank: "1020",
  receivables: "1100",
  inventory: "1200",
  gstInput: "1300",
  gstPayable: "2000",
  supplierPayables: "2100",
  salesRevenue: "4000",
  cogs: "5000",
} as const;

const DEBIT_NORMAL: AccountType[] = ["ASSET", "EXPENSE"];

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function isDebitNormal(type: AccountType): boolean {
  return DEBIT_NORMAL.includes(type);
}

/** Parts of a date rendered in a specific IANA time zone. */
function zonedParts(tz: string, date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
}

/** Offset (ms) between the given instant and its wall-clock time in `tz`. */
function tzOffsetMs(tz: string, date: Date): number {
  const parts = zonedParts(tz, date);
  const get = (t: string) => Number(parts.find(x => x.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return date.getTime() - asUtc;
}

/**
 * The UTC instant corresponding to local midnight on the first day of the
 * month containing `now`, in the given IANA time zone. Used so month windows
 * align with the workspace's calendar rather than UTC boundaries.
 */
function startOfMonthUtc(tz: string, now: Date): Date {
  const parts = zonedParts(tz, now);
  const y = Number(parts.find(x => x.type === "year")?.value ?? now.getUTCFullYear());
  const m = Number(parts.find(x => x.type === "month")?.value ?? 1);
  const guess = new Date(Date.UTC(y, m - 1, 1));
  return new Date(guess.getTime() - tzOffsetMs(tz, guess));
}

/** Create the standard chart of accounts for an organization if absent. */
export async function ensureChartOfAccounts(
  organizationId: string,
  client: DbClient = prisma,
): Promise<void> {
  const existing = await client.account.findFirst({
    where: { organizationId },
    select: { id: true },
  });
  if (existing) return;

  await client.account.createMany({
    data: DEFAULT_ACCOUNTS.map(a => ({
      organizationId,
      code: a.code,
      name: a.name,
      type: a.type,
    })),
  });
}

async function resolveAccountByCode(
  organizationId: string,
  code: string,
  client: DbClient,
): Promise<string> {
  const account = await client.account.findUnique({
    where: { organizationId_code: { organizationId, code } },
    select: { id: true },
  });
  if (!account) {
    throw new AppError(
      `Accounting account ${code} is not configured for this workspace.`,
      500,
      "ACCOUNT_MISSING",
    );
  }
  return account.id;
}

async function nextJournalRef(
  organizationId: string,
  client: DbClient,
): Promise<string> {
  const count = await client.journalEntry.count({ where: { organizationId } });
  return `JR-${new Date().getFullYear()}-${String(count + 1).padStart(5, "0")}`;
}

export interface JournalLineSpec {
  /** Account primary key (preferred for manual entries). */
  accountId?: string;
  /** Account code (used by auto-posting). */
  code?: string;
  debit?: number;
  credit?: number;
  narration?: string;
}

/**
 * Posts a balanced journal entry. When no reference number is supplied one
 * is generated. Writes inside an optional transaction so callers can post
 * atomically with the business event that produced the entry.
 */
export async function postJournal(
  organizationId: string,
  createdById: string | null,
  entryDate: Date,
  description: string,
  lines: JournalLineSpec[],
  opts: { tx?: DbClient; referenceNo?: string } = {},
): Promise<{ id: string; referenceNo: string }> {
  const db = opts.tx ?? prisma;
  await ensureChartOfAccounts(organizationId, db);

  const resolved: { accountId: string; debit: number; credit: number; narration?: string }[] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const line of lines) {
    const accountId =
      line.accountId ??
      (line.code ? await resolveAccountByCode(organizationId, line.code, db) : null);
    if (!accountId) {
      throw new AppError("Each journal line needs an account.", 400, "VALIDATION");
    }
    const debit = round2(line.debit ?? 0);
    const credit = round2(line.credit ?? 0);
    if (debit === 0 && credit === 0) continue;
    if (debit > 0 && credit > 0) {
      throw new AppError(
        "A journal line cannot carry both a debit and a credit.",
        400,
        "VALIDATION",
      );
    }
    totalDebit += debit;
    totalCredit += credit;
    resolved.push({ accountId, debit, credit, narration: line.narration });
  }

  if (resolved.length < 2) {
    throw new AppError("A journal entry needs at least two lines.", 400, "VALIDATION");
  }
  if (Math.abs(totalDebit - totalCredit) > 0.009) {
    throw new AppError(
      `Journal entry is not balanced (debits ${round2(totalDebit)} vs credits ${round2(totalCredit)}).`,
      400,
      "UNBALANCED_ENTRY",
    );
  }

  // Reference numbers are allocated inside a transaction-scoped advisory lock
  // so concurrent postings can never race and duplicate the same reference.
  let referenceNo = opts.referenceNo;
  if (!referenceNo) {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'jrnl:' + organizationId})::bigint)`;
    referenceNo = await nextJournalRef(organizationId, db);
  }
  const entry = await db.journalEntry.create({
    data: {
      organizationId,
      referenceNo,
      entryDate,
      description,
      status: "POSTED",
      createdById,
      lines: {
        create: resolved.map(l => ({
          accountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          narration: l.narration,
        })),
      },
    },
  });

  await db.auditLog.create({
    data: {
      organizationId,
      userId: createdById,
      action: "JOURNAL_POSTED",
      entityType: "JournalEntry",
      entityId: entry.id,
      metadata: { referenceNo, lines: resolved.length },
    },
  });

  return { id: entry.id, referenceNo };
}

/** Auto-posts a sale: cash/AR debit, sales revenue + GST credit, and COGS. */
export async function postSaleEntry(
  tx: TxClient,
  organizationId: string,
  userId: string,
  entryDate: Date,
  invoiceNo: string,
  amounts: { total: number; tax: number; paymentMode: string },
  cogs: number,
): Promise<void> {
  const debitCode =
    amounts.paymentMode === "CASH"
      ? ACCOUNT_CODES.cash
      : amounts.paymentMode === "CREDIT"
        ? ACCOUNT_CODES.receivables
        : ACCOUNT_CODES.bank;
  await postJournal(
    organizationId,
    userId,
    entryDate,
    `Sales ${invoiceNo}`,
    [
      { code: debitCode, debit: amounts.total },
      { code: ACCOUNT_CODES.salesRevenue, credit: amounts.total - amounts.tax },
      { code: ACCOUNT_CODES.gstPayable, credit: amounts.tax },
    ],
    { tx, referenceNo: `SALE-${invoiceNo}` },
  );

  if (cogs > 0) {
    await postJournal(
      organizationId,
      userId,
      entryDate,
      `COGS for ${invoiceNo}`,
      [
        { code: ACCOUNT_CODES.cogs, debit: cogs },
        { code: ACCOUNT_CODES.inventory, credit: cogs },
      ],
      { tx, referenceNo: `COGS-${invoiceNo}` },
    );
  }
}

/** Auto-posts a purchase receipt: inventory + GST input, supplier payable. */
export async function postPurchaseEntry(
  tx: TxClient,
  organizationId: string,
  userId: string,
  entryDate: Date,
  poNumber: string,
  receiptNumber: string,
  value: number,
  tax: number,
): Promise<void> {
  await postJournal(
    organizationId,
    userId,
    entryDate,
    `GRN for ${poNumber}`,
    [
      { code: ACCOUNT_CODES.inventory, debit: value },
      { code: ACCOUNT_CODES.gstInput, debit: tax },
      { code: ACCOUNT_CODES.supplierPayables, credit: value + tax },
    ],
    { tx, referenceNo: `PUR-${receiptNumber}` },
  );
}

export interface CreateJournalInput {
  entryDate?: string;
  description: string;
  lines: { accountId: string; debit?: number; credit?: number; narration?: string }[];
}

export async function listAccounts(organizationId: string) {
  await ensureChartOfAccounts(organizationId);
  return prisma.account.findMany({
    where: { organizationId },
    orderBy: { code: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      type: true,
      isActive: true,
      openingBalance: true,
      parentId: true,
      createdAt: true,
    },
  });
}

export async function createAccount(
  organizationId: string,
  input: { code: string; name: string; type: AccountType; openingBalance?: number },
) {
  const code = input.code.trim().toUpperCase();
  if (!code) throw new AppError("Account code is required.", 400, "VALIDATION");
  if (!input.name || !input.name.trim()) {
    throw new AppError("Account name is required.", 400, "VALIDATION");
  }
  const existing = await prisma.account.findUnique({
    where: { organizationId_code: { organizationId, code } },
  });
  if (existing) {
    throw new AppError(`Account code ${code} already exists.`, 409, "DUPLICATE");
  }
  return prisma.account.create({
    data: {
      organizationId,
      code,
      name: input.name.trim(),
      type: input.type,
      openingBalance: input.openingBalance ?? 0,
    },
  });
}

export async function updateAccount(
  organizationId: string,
  accountId: string,
  input: { name?: string; isActive?: boolean; openingBalance?: number },
) {
  const account = await prisma.account.findFirst({
    where: { id: accountId, organizationId },
  });
  if (!account) throw new AppError("Account not found.", 404, "NOT_FOUND");
  return prisma.account.update({
    where: { id: account.id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.openingBalance !== undefined
        ? { openingBalance: input.openingBalance }
        : {}),
    },
  });
}

export async function createJournal(
  organizationId: string,
  userId: string,
  input: CreateJournalInput,
) {
  if (!input.description || !input.description.trim()) {
    throw new AppError("A description is required.", 400, "VALIDATION");
  }
  const entryDate = input.entryDate ? new Date(input.entryDate) : new Date();
  if (Number.isNaN(entryDate.getTime())) {
    throw new AppError("Invalid entry date.", 400, "VALIDATION");
  }
  return prisma.$transaction(tx =>
    postJournal(organizationId, userId, entryDate, input.description.trim(), input.lines, { tx }),
  );
}

export async function voidJournal(
  organizationId: string,
  entryId: string,
  userId: string,
) {
  const entry = await prisma.journalEntry.findFirst({
    where: { id: entryId, organizationId },
  });
  if (!entry) throw new AppError("Journal entry not found.", 404, "NOT_FOUND");
  if (entry.status === "VOID") {
    throw new AppError("Journal entry is already void.", 400, "ALREADY_VOID");
  }
  await prisma.journalEntry.update({
    where: { id: entry.id },
    data: { status: "VOID" },
  });
  await prisma.auditLog.create({
    data: {
      organizationId,
      userId,
      action: "JOURNAL_VOIDED",
      entityType: "JournalEntry",
      entityId: entry.id,
      metadata: { referenceNo: entry.referenceNo },
    },
  });
  return { id: entry.id, status: "VOID" as const };
}

export async function listJournal(params: {
  organizationId: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}) {
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 25));
  const where = {
    organizationId: params.organizationId,
    ...(params.from || params.to
      ? {
          entryDate: {
            ...(params.from ? { gte: new Date(params.from) } : {}),
            ...(params.to ? { lte: new Date(params.to) } : {}),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.journalEntry.findMany({
      where,
      include: {
        lines: { include: { account: { select: { code: true, name: true } } } },
        createdBy: { select: { fullName: true } },
      },
      orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.journalEntry.count({ where }),
  ]);

  return {
    rows: rows.map(e => ({
      id: e.id,
      referenceNo: e.referenceNo,
      entryDate: e.entryDate,
      description: e.description,
      status: e.status,
      createdBy: e.createdBy?.fullName ?? null,
      lines: e.lines.map(l => ({
        accountCode: l.account.code,
        accountName: l.account.name,
        debit: Number(l.debit),
        credit: Number(l.credit),
        narration: l.narration,
      })),
    })),
    total,
    page,
    limit,
  };
}

export async function getLedger(
  organizationId: string,
  accountId: string,
  from?: string,
  to?: string,
) {
  const account = await prisma.account.findFirst({
    where: { id: accountId, organizationId },
  });
  if (!account) throw new AppError("Account not found.", 404, "NOT_FOUND");

  const lines = await prisma.journalEntryLine.findMany({
    where: {
      accountId,
      journalEntry: {
        organizationId,
        status: "POSTED",
        ...(from || to
          ? {
              entryDate: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
              },
            }
          : {}),
      },
    },
    include: {
      journalEntry: { select: { referenceNo: true, entryDate: true, description: true } },
    },
    orderBy: [{ journalEntry: { entryDate: "asc" } }, { id: "asc" }],
  });

  const debitNormal = isDebitNormal(account.type);
  let balance = Number(account.openingBalance);
  const rows = lines.map(l => {
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    balance = round2(debitNormal ? balance + debit - credit : balance + credit - debit);
    return {
      id: l.id,
      referenceNo: l.journalEntry.referenceNo,
      entryDate: l.journalEntry.entryDate,
      description: l.journalEntry.description,
      narration: l.narration,
      debit,
      credit,
      runningBalance: balance,
    };
  });

  return {
    account: {
      id: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      openingBalance: Number(account.openingBalance),
    },
    rows,
    balance,
  };
}

interface AccountTotals {
  accountId: string;
  debit: number;
  credit: number;
}

export async function trialBalance(organizationId: string) {
  await ensureChartOfAccounts(organizationId);
  const accounts = await prisma.account.findMany({
    where: { organizationId },
    orderBy: { code: "asc" },
  });
  const grouped = await prisma.journalEntryLine.groupBy({
    by: ["accountId"],
    where: { journalEntry: { organizationId, status: "POSTED" } },
    _sum: { debit: true, credit: true },
  });

  const totalsByAccount = new Map<string, AccountTotals>();
  for (const g of grouped) {
    totalsByAccount.set(g.accountId, {
      accountId: g.accountId,
      debit: Number(g._sum.debit ?? 0),
      credit: Number(g._sum.credit ?? 0),
    });
  }

  let totalDebit = 0;
  let totalCredit = 0;
  const rows = accounts.map(account => {
    const t = totalsByAccount.get(account.id) ?? { accountId: account.id, debit: 0, credit: 0 };
    const debitNormal = isDebitNormal(account.type);
    const balance = round2(
      debitNormal
        ? Number(account.openingBalance) + t.debit - t.credit
        : Number(account.openingBalance) + t.credit - t.debit,
    );
    const row = {
      id: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      openingBalance: Number(account.openingBalance),
      debit: t.debit,
      credit: t.credit,
      balance,
    };
    if (debitNormal) totalDebit += balance;
    else totalCredit += balance;
    return row;
  });

  return { rows, totalDebit: round2(totalDebit), totalCredit: round2(totalCredit) };
}

function dateWindow(from?: string, to?: string) {
  return {
    ...(from ? { gte: new Date(from) } : {}),
    ...(to ? { lte: new Date(to) } : {}),
  };
}

export async function profitAndLoss(
  organizationId: string,
  from?: string,
  to?: string,
) {
  await ensureChartOfAccounts(organizationId);
  const window = dateWindow(from, to);
  const accounts = await prisma.account.findMany({
    where: { organizationId, type: { in: ["REVENUE", "EXPENSE"] } },
    orderBy: { code: "asc" },
  });
  const grouped = await prisma.journalEntryLine.groupBy({
    by: ["accountId"],
    where: {
      journalEntry: { organizationId, status: "POSTED", ...(window.gte || window.lte ? { entryDate: window } : {}) },
    },
    _sum: { debit: true, credit: true },
  });
  const totals = new Map(grouped.map(g => [g.accountId, g._sum]));

  const revenue = accounts
    .filter(a => a.type === "REVENUE")
    .map(a => {
      const s = totals.get(a.id);
      const credit = round2(Number(a.openingBalance) + Number(s?.credit ?? 0) - Number(s?.debit ?? 0));
      return { id: a.id, code: a.code, name: a.name, amount: credit };
    });
  const expenses = accounts
    .filter(a => a.type === "EXPENSE")
    .map(a => {
      const s = totals.get(a.id);
      const debit = round2(Number(a.openingBalance) + Number(s?.debit ?? 0) - Number(s?.credit ?? 0));
      return { id: a.id, code: a.code, name: a.name, amount: debit };
    });

  const totalRevenue = round2(revenue.reduce((acc, r) => acc + r.amount, 0));
  const totalExpenses = round2(expenses.reduce((acc, e) => acc + e.amount, 0));
  const grossProfit = round2(
    totalRevenue -
      (expenses.find(e => e.code === "5000")?.amount ?? 0),
  );
  const netProfit = round2(totalRevenue - totalExpenses);

  return {
    revenue,
    expenses,
    totalRevenue,
    totalExpenses,
    grossProfit,
    netProfit,
  };
}

export async function balanceSheet(organizationId: string, asOf?: string) {
  await ensureChartOfAccounts(organizationId);
  const window = asOf ? { lte: new Date(asOf) } : {};
  const accounts = await prisma.account.findMany({
    where: { organizationId },
    orderBy: { code: "asc" },
  });
  const grouped = await prisma.journalEntryLine.groupBy({
    by: ["accountId"],
    where: {
      journalEntry: {
        organizationId,
        status: "POSTED",
        ...(window.lte ? { entryDate: window } : {}),
      },
    },
    _sum: { debit: true, credit: true },
  });
  const totals = new Map(grouped.map(g => [g.accountId, g._sum]));

  const sections = {
    ASSET: [] as { id: string; code: string; name: string; amount: number }[],
    LIABILITY: [] as { id: string; code: string; name: string; amount: number }[],
    EQUITY: [] as { id: string; code: string; name: string; amount: number }[],
  };

  for (const a of accounts) {
    if (a.type === "REVENUE" || a.type === "EXPENSE") continue;
    const s = totals.get(a.id);
    const debitNormal = isDebitNormal(a.type);
    const balance = round2(
      debitNormal
        ? Number(a.openingBalance) + Number(s?.debit ?? 0) - Number(s?.credit ?? 0)
        : Number(a.openingBalance) + Number(s?.credit ?? 0) - Number(s?.debit ?? 0),
    );
    if (balance === 0) continue;
    sections[a.type].push({ id: a.id, code: a.code, name: a.name, amount: balance });
  }

  // Current period profit (before the as-of date) flows into equity.
  const pnl = await profitAndLoss(organizationId, undefined, asOf);
  sections.EQUITY.push({
    id: "retained",
    code: "P&L",
    name: "Current Period Profit / Loss",
    amount: pnl.netProfit,
  });

  const totalsBySection = {
    ASSET: round2(sections.ASSET.reduce((acc, r) => acc + r.amount, 0)),
    LIABILITY: round2(sections.LIABILITY.reduce((acc, r) => acc + r.amount, 0)),
    EQUITY: round2(sections.EQUITY.reduce((acc, r) => acc + r.amount, 0)),
  };

  return {
    assets: sections.ASSET,
    liabilities: sections.LIABILITY,
    equity: sections.EQUITY,
    totalAssets: totalsBySection.ASSET,
    totalLiabilities: totalsBySection.LIABILITY,
    totalEquity: totalsBySection.EQUITY,
    balanced: Math.abs(totalsBySection.ASSET - (totalsBySection.LIABILITY + totalsBySection.EQUITY)) < 0.01,
  };
}

export async function financeOverview(organizationId: string) {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { timezone: true },
  });
  const tz = org?.timezone ?? "Asia/Kolkata";
  const now = new Date();
  const monthStart = startOfMonthUtc(tz, now);
  const pnl = await profitAndLoss(organizationId, monthStart.toISOString());
  const allTime = await profitAndLoss(organizationId);
  const tb = await trialBalance(organizationId);

  const receivable = tb.rows.find(r => r.code === ACCOUNT_CODES.receivables)?.balance ?? 0;
  const payable = tb.rows.find(r => r.code === ACCOUNT_CODES.supplierPayables)?.balance ?? 0;
  const cash = round2(
    (tb.rows.find(r => r.code === ACCOUNT_CODES.cash)?.balance ?? 0) +
      (tb.rows.find(r => r.code === ACCOUNT_CODES.bank)?.balance ?? 0),
  );

  const recent = await listJournal({ organizationId, limit: 5 });

  return {
    month: pnl,
    allTime: allTime.netProfit,
    receivable: round2(receivable),
    payable: round2(payable),
    cash,
    recent: recent.rows,
  };
}

export interface TrendPoint {
  month: string;
  revenue: number;
  expenses: number;
  net: number;
}

/**
 * Monthly revenue / expense / net series for the trailing N calendar months
 * (aligned to the workspace timezone). Used by the finance dashboard chart.
 */
export async function financeTrend(
  organizationId: string,
  months = 12,
): Promise<TrendPoint[]> {
  await ensureChartOfAccounts(organizationId);
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { timezone: true },
  });
  const tz = org?.timezone ?? "Asia/Kolkata";
  const now = new Date();

  const starts: Date[] = [];
  for (let i = months - 1; i >= 0; i--) {
    starts.push(startOfMonthUtc(tz, new Date(now.getFullYear(), now.getMonth() - i, 1)));
  }
  const oldest = starts[0];

  const accounts = await prisma.account.findMany({
    where: { organizationId, type: { in: ["REVENUE", "EXPENSE"] } },
    select: { id: true, type: true, openingBalance: true },
  });
  const openingByAccount = new Map(accounts.map(a => [a.id, Number(a.openingBalance)]));

  const lines = await prisma.journalEntryLine.findMany({
    where: {
      journalEntry: { organizationId, status: "POSTED", entryDate: { gte: oldest } },
    },
    select: {
      debit: true,
      credit: true,
      account: { select: { type: true } },
      journalEntry: { select: { entryDate: true } },
    },
  });

  const buckets = new Map<string, { revenue: number; expenses: number }>();
  const labels = starts.map(s => {
    const p = zonedParts(tz, s);
    const key = `${p.find(x => x.type === "year")?.value}-${p.find(x => x.type === "month")?.value}`;
    buckets.set(key, { revenue: 0, expenses: 0 });
    return key;
  });

  // Opening balances on revenue/expense heads apply to the first bucket.
  const firstKey = labels[0];
  if (firstKey) {
    const b = buckets.get(firstKey)!;
    for (const a of accounts) {
      const op = openingByAccount.get(a.id) ?? 0;
      if (op === 0) continue;
      if (a.type === "REVENUE") b.revenue += op;
      else b.expenses += op;
    }
  }

  for (const l of lines) {
    const p = zonedParts(tz, new Date(l.journalEntry.entryDate));
    const key = `${p.find(x => x.type === "year")?.value}-${p.find(x => x.type === "month")?.value}`;
    const b = buckets.get(key);
    if (!b) continue;
    if (l.account.type === "REVENUE") b.revenue += Number(l.credit) - Number(l.debit);
    else if (l.account.type === "EXPENSE") b.expenses += Number(l.debit) - Number(l.credit);
  }

  return labels.map(key => {
    const b = buckets.get(key)!;
    const revenue = round2(b.revenue);
    const expenses = round2(b.expenses);
    return { month: key, revenue, expenses, net: round2(revenue - expenses) };
  });
}