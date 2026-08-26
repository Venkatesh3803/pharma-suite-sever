import type { NextFunction, Request, Response } from "express";
import { buildDashboard } from "../services/dashboard.service";
import { ok } from "../utils/api";

export async function dashboard(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user?.organizationId) {
            return next(new Error("Unauthorized"));
        }
        const data = await buildDashboard({
            organizationId: req.user.organizationId,
            branchId: (req.query.branchId as string) || req.user.branchId,
            userId: req.user.userId
        });
        return ok(res, data, null);
    } catch (e) {
        next(e);
    }
}
