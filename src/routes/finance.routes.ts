import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { Permissions } from "../domain/permissions.js";
import * as ctrl from "../controllers/finance.controller.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { z } from "zod";

const router = Router();
router.use(authenticate);

const dateWindowSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

const accountSchema = z.object({
  code: z.string().trim().min(1).max(10),
  name: z.string().trim().min(1).max(120),
  type: z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]),
  openingBalance: z.number().optional(),
});

const accountUpdateSchema = accountSchema.partial();

const journalLineSchema = z.object({
  accountId: z.string().min(1),
  debit: z.number().min(0).optional(),
  credit: z.number().min(0).optional(),
  narration: z.string().max(255).optional(),
});

const journalSchema = z.object({
  entryDate: z.string().optional(),
  description: z.string().trim().min(1).max(255),
  lines: z.array(journalLineSchema).min(2).max(100),
});

// Chart of accounts
router.get(
  "/accounts",
  requirePermission(Permissions.FINANCE_READ),
  ctrl.accountList,
);
router.post(
  "/accounts",
  requirePermission(Permissions.FINANCE_WRITE),
  validateBody(accountSchema),
  ctrl.accountCreate,
);
router.patch(
  "/accounts/:id",
  requirePermission(Permissions.FINANCE_WRITE),
  validateBody(accountUpdateSchema),
  ctrl.accountUpdate,
);

// Journal entries
router.get(
  "/journal",
  requirePermission(Permissions.FINANCE_READ),
  validateQuery(dateWindowSchema.extend({ page: z.string().optional(), limit: z.string().optional() })),
  ctrl.journalList,
);
router.post(
  "/journal",
  requirePermission(Permissions.FINANCE_WRITE),
  validateBody(journalSchema),
  ctrl.journalCreate,
);
router.post(
  "/journal/:id/void",
  requirePermission(Permissions.FINANCE_WRITE),
  ctrl.journalVoid,
);

// Ledger
router.get(
  "/ledger/:accountId",
  requirePermission(Permissions.FINANCE_READ),
  validateQuery(dateWindowSchema),
  ctrl.ledger,
);

// Statements
router.get(
  "/trial-balance",
  requirePermission(Permissions.FINANCE_READ),
  ctrl.trialBalanceHandler,
);
router.get(
  "/pnl",
  requirePermission(Permissions.FINANCE_READ),
  validateQuery(dateWindowSchema),
  ctrl.pnlHandler,
);
router.get(
  "/balance-sheet",
  requirePermission(Permissions.FINANCE_READ),
  validateQuery(z.object({ asOf: z.string().optional() })),
  ctrl.balanceSheetHandler,
);
router.get(
  "/overview",
  requirePermission(Permissions.FINANCE_READ),
  ctrl.overview,
);
router.get(
  "/trend",
  requirePermission(Permissions.FINANCE_READ),
  ctrl.trend,
);

export default router;