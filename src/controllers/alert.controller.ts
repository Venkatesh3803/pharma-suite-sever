import type { NextFunction, Request, Response } from "express";
import { listAlerts, markAlertRead, markAllRead, dismissAlert, unreadAlertCount } from "../services/alert.service.js";
import { ok } from "../utils/api.js";

export async function list(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await listAlerts({
            organizationId: req.user!.organizationId,
            branchId: (req.query.branchId as string) || req.user?.branchId,
            type: req.query.type as string,
            severity: req.query.severity as string,
            status: (req.query.status as string) || "ACTIVE",
            userId: req.user!.userId,
            page: Number(req.query.page ?? 1),
            pageSize: Number(req.query.pageSize ?? 20)
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function read(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await markAlertRead(req.user!.organizationId, req.params.id, req.user!.userId, true);
        return ok(res, data, "Alert marked as read.");
    } catch (e) {
        next(e);
    }
}

export async function readAll(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await markAllRead(req.user!.organizationId, req.user!.userId, (req.query.branchId as string) || req.user?.branchId);
        return ok(res, data, "All alerts marked as read.");
    } catch (e) {
        next(e);
    }
}

export async function dismiss(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await dismissAlert(req.user!.organizationId, req.params.id);
        return ok(res, data, "Alert dismissed.");
    } catch (e) {
        next(e);
    }
}

export async function count(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await unreadAlertCount(req.user!.organizationId, req.user!.userId);
        return ok(res, { unread: data });
    } catch (e) {
        next(e);
    }
}
