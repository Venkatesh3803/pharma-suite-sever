import type { NextFunction, Request, Response } from "express";
import {
  adminUpdateSubscription,
  listPendingPayments,
  listSubscriptions,
  verifyPayment,
} from "../services/subscription.service.js";
import { ok } from "../utils/api.js";

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listSubscriptions();
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function pending(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listPendingPayments();
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function verify(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await verifyPayment(req.user!.userId, req.body);
    return ok(res, data, "Payment verification processed.");
  } catch (e) {
    next(e);
  }
}

export async function updateStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await adminUpdateSubscription(req.user!.userId, req.params.id, req.body);
    return ok(res, data, "Subscription updated.");
  } catch (e) {
    next(e);
  }
}
