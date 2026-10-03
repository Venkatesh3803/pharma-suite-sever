import type { NextFunction, Request, Response } from "express";
import { AppError } from "../domain/errors.js";
import {
  createQualityCheck,
  listPendingBatches,
  listQualityChecks,
  updateQualityCheckStatus,
} from "../services/quality-control.service.js";
import { ok } from "../utils/api.js";

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listQualityChecks({
      organizationId: req.user!.organizationId,
      branchId: req.query.branchId as string | undefined,
      batchId: req.query.batchId as string | undefined,
      status: req.query.status as string | undefined,
      page: Number(req.query.page ?? 1),
      pageSize: Number(req.query.pageSize ?? 20),
    });
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function pending(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listPendingBatches({
      organizationId: req.user!.organizationId,
      branchId: req.query.branchId as string | undefined,
    });
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await createQualityCheck({
      organizationId: req.user!.organizationId,
      branchId: req.body.branchId as string | undefined,
      batchId: req.body.batchId as string,
      checkType: req.body.checkType as never,
      temperatureC: req.body.temperatureC as string | null | undefined,
      condition: req.body.condition as string | undefined,
      passedItems: req.body.passedItems as string[] | undefined,
      failedItems: req.body.failedItems as string[] | undefined,
      notes: req.body.notes as string | undefined,
      decision: req.body.decision as string | undefined,
      conductedById: req.user!.userId,
    });
    return ok(res, data, "Quality check recorded.", 201);
  } catch (e) {
    next(e);
  }
}

export async function updateStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const status = req.body.status as string;
    if (!["PASSED", "FAILED", "RELEASED", "DISPOSED"].includes(status)) {
      return next(new AppError("Invalid status.", 400, "VALIDATION"));
    }
    const data = await updateQualityCheckStatus({
      organizationId: req.user!.organizationId,
      id: req.params.id,
      status: status as never,
      decisionNote: req.body.decisionNote as string | undefined,
      conductedById: req.user!.userId,
    });
    return ok(res, data, "Quality check updated.");
  } catch (e) {
    next(e);
  }
}
