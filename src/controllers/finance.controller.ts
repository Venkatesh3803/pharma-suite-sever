import type { NextFunction, Request, Response } from "express";
import {
  balanceSheet,
  createAccount,
  createJournal,
  financeOverview,
  financeTrend,
  getLedger,
  listAccounts,
  listJournal,
  profitAndLoss,
  trialBalance,
  updateAccount,
  voidJournal,
} from "../services/finance.service.js";
import { ok } from "../utils/api.js";

export async function overview(req: Request, res: Response, next: NextFunction) {
  try {
    return ok(res, await financeOverview(req.user!.organizationId));
  } catch (e) {
    next(e);
  }
}

export async function trend(req: Request, res: Response, next: NextFunction) {
  try {
    return ok(res, await financeTrend(req.user!.organizationId));
  } catch (e) {
    next(e);
  }
}

export async function accountList(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    return ok(res, await listAccounts(req.user!.organizationId));
  } catch (e) {
    next(e);
  }
}

export async function accountCreate(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await createAccount(req.user!.organizationId, req.body);
    return ok(res, data, "Account created.", 201);
  } catch (e) {
    next(e);
  }
}

export async function accountUpdate(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await updateAccount(
      req.user!.organizationId,
      req.params.id,
      req.body,
    );
    return ok(res, data, "Account updated.");
  } catch (e) {
    next(e);
  }
}

export async function ledger(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getLedger(
      req.user!.organizationId,
      req.params.accountId,
      req.query.from as string | undefined,
      req.query.to as string | undefined,
    );
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function journalList(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listJournal({
      organizationId: req.user!.organizationId,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      page: Number(req.query.page ?? 1),
      limit: Number(req.query.limit ?? 25),
    });
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function journalCreate(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await createJournal(req.user!.organizationId, req.user!.userId, req.body);
    return ok(res, data, "Journal entry posted.", 201);
  } catch (e) {
    next(e);
  }
}

export async function journalVoid(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await voidJournal(
      req.user!.organizationId,
      req.params.id,
      req.user!.userId,
    );
    return ok(res, data, "Journal entry voided.");
  } catch (e) {
    next(e);
  }
}

export async function trialBalanceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    return ok(res, await trialBalance(req.user!.organizationId));
  } catch (e) {
    next(e);
  }
}

export async function pnlHandler(req: Request, res: Response, next: NextFunction) {
  try {
    return ok(
      res,
      await profitAndLoss(
        req.user!.organizationId,
        req.query.from as string | undefined,
        req.query.to as string | undefined,
      ),
    );
  } catch (e) {
    next(e);
  }
}

export async function balanceSheetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    return ok(
      res,
      await balanceSheet(
        req.user!.organizationId,
        req.query.asOf as string | undefined,
      ),
    );
  } catch (e) {
    next(e);
  }
}