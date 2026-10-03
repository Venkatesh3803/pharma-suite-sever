import type { NextFunction, Request, Response } from "express";
import { listSuppliers, getSupplier, createSupplier, updateSupplier } from "../services/supplier.service.js";
import { vendorPerformance, vendorPriceHistory } from "../services/purchase-analytics.service.js";
import { ok } from "../utils/api.js";

export async function list(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await listSuppliers({
            organizationId: req.user!.organizationId,
            search: req.query.search as string,
            page: Number(req.query.page ?? 1),
            pageSize: Number(req.query.pageSize ?? 20)
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function getOne(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await getSupplier(req.user!.organizationId, req.params.id);
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function create(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await createSupplier(req.user!.organizationId, req.body);
        return ok(res, data, "Supplier created.", 201);
    } catch (e) {
        next(e);
    }
}

export async function update(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await updateSupplier(req.user!.organizationId, req.params.id, req.body);
        return ok(res, data, "Supplier updated.");
    } catch (e) {
        next(e);
    }
}

export async function performance(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await vendorPerformance(req.user!.organizationId, req.params.id);
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function priceHistory(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await vendorPriceHistory({
            organizationId: req.user!.organizationId,
            vendorId: req.params.id,
            productId: req.query.productId as string | undefined,
            limit: Number(req.query.limit ?? 50),
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}
