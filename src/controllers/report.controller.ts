import type { NextFunction, Request, Response } from "express";
import { salesReport, reportTopProducts, inventoryReport, purchaseReport, grossMarginReport } from "../services/report.service.js";
import { ok } from "../utils/api.js";

function toDate(v?: string): Date | undefined {
    return v ? new Date(v) : undefined;
}

export async function sales(req: Request, res: Response, next: NextFunction) {
    try {
        const groupBy = (req.query.groupBy as string) || "day";
        const data = await salesReport({
            organizationId: req.user!.organizationId,
            branchId: (req.query.branchId as string) || req.user?.branchId,
            from: toDate(req.query.from as string),
            to: toDate(req.query.to as string),
            groupBy: groupBy as "day" | "week" | "month",
            productId: req.query.productId as string
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function topProducts(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await reportTopProducts({
            organizationId: req.user!.organizationId,
            branchId: (req.query.branchId as string) || req.user?.branchId,
            from: toDate(req.query.from as string),
            to: toDate(req.query.to as string),
            limit: Number(req.query.limit ?? 10)
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function inventory(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await inventoryReport({
            organizationId: req.user!.organizationId,
            branchId: (req.query.branchId as string) || req.user?.branchId
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function purchases(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await purchaseReport({
            organizationId: req.user!.organizationId,
            branchId: (req.query.branchId as string) || req.user?.branchId,
            supplierId: req.query.supplierId as string,
            from: toDate(req.query.from as string),
            to: toDate(req.query.to as string)
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function margins(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await grossMarginReport({
            organizationId: req.user!.organizationId,
            branchId: (req.query.branchId as string) || req.user?.branchId,
            from: toDate(req.query.from as string),
            to: toDate(req.query.to as string)
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}
