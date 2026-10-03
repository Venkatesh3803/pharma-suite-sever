import type { NextFunction, Request, Response } from "express";
import { getMySubscription, selectPlan as selectPlanService } from "../services/subscription.service.js";
import { ok } from "../utils/api.js";

export async function me(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getMySubscription(req.user!.organizationId);
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function selectPlan(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await selectPlanService(req.user!.organizationId, req.user!.userId, req.body);
    return ok(res, data, "Plan selection submitted.", 200);
  } catch (e) {
    next(e);
  }
}
