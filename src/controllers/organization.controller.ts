import type { NextFunction, Request, Response } from "express";
import {
  getOrganization,
  updateOrganization,
} from "../services/organization.service.js";
import { ok } from "../utils/api.js";

export async function get(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getOrganization(req.user!.organizationId);
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await updateOrganization(
      req.user!.organizationId,
      req.user!.userId,
      req.body,
    );
    return ok(res, data, "Workspace updated.");
  } catch (e) {
    next(e);
  }
}
