import type { NextFunction, Request, Response } from "express";
import { listCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer, createSale } from "../services/customer.service";
import { ok } from "../utils/api";

export async function list(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await listCustomers({
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
        const data = await getCustomer(req.user!.organizationId, req.params.id);
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function create(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await createCustomer(req.user!.organizationId, req.body);
        return ok(res, data, "Customer created.", 201);
    } catch (e) {
        next(e);
    }
}

export async function update(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await updateCustomer(req.user!.organizationId, req.params.id, req.body);
        return ok(res, data, "Customer updated.");
    } catch (e) {
        next(e);
    }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
    try {
        await deleteCustomer(req.user!.organizationId, req.params.id);
        return ok(res, null, "Customer deleted.");
    } catch (e) {
        next(e);
    }
}

export async function sales(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await createSale(req.user!.organizationId, req.user!.userId, req.body);
        return ok(res, data, "Sale completed.", 201);
    } catch (e) {
        next(e);
    }
}
