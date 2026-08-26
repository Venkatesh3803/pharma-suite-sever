import type { NextFunction, Request, Response } from "express";
import {
    listProducts,
    getProduct,
    createProduct,
    updateProduct,
    deleteProduct,
    listCategories as listCategoriesSvc,
    createCategory as createCategorySvc,
} from "../services/product.service";
import { ok } from "../utils/api";

export async function listCategories(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await listCategoriesSvc(req.user!.organizationId);
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function createCategory(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await createCategorySvc(req.user!.organizationId, req.body.name);
        return ok(res, data, "Category created.", 201);
    } catch (e) {
        next(e);
    }
}

export async function list(req: Request, res: Response, next: NextFunction) {
    try {
        const org = req.user!.organizationId;
        const q = (req as Request & { cleanQuery?: Record<string, string> }).cleanQuery ?? req.query;
        const data = await listProducts({
            organizationId: org,
            search: q.search as string,
            categoryId: q.categoryId as string,
            prescriptionRequired: q.prescriptionRequired === "true" ? true : q.prescriptionRequired === "false" ? false : undefined,
            page: Number(q.page ?? 1),
            pageSize: Number(q.pageSize ?? 20)
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function getOne(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await getProduct(req.user!.organizationId, req.params.id);
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function create(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await createProduct(req.user!.organizationId, req.body);
        return ok(res, data, "Product created.", 201);
    } catch (e) {
        next(e);
    }
}

export async function update(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await updateProduct(req.user!.organizationId, req.params.id, req.body);
        return ok(res, data, "Product updated.");
    } catch (e) {
        next(e);
    }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
    try {
        await deleteProduct(req.user!.organizationId, req.params.id);
        return ok(res, null, "Product deleted.");
    } catch (e) {
        next(e);
    }
}
