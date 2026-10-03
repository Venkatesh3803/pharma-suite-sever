import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { checkFeatureAccess } from "../middleware/feature-access.js";
import { Permissions } from "../domain/permissions.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { z } from "zod";
import * as ctrl from "../controllers/sale.controller.js";

const router = Router();
router.use(authenticate);

const itemSchema = z.object({
    productId: z.string().min(1),
    quantity: z.number().int().positive()
});

const saleSchema = z.object({
    branchId: z.string().min(1),
    customerId: z.string().optional(),
    paymentMode: z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER", "CREDIT"]).optional(),
    discount: z.number().min(0).max(100).optional(),
    items: z.array(itemSchema).min(1),
    clientSaleId: z.string().max(100).optional()
});

const returnItemSchema = z.object({
    saleItemId: z.string().min(1),
    quantity: z.number().int().positive(),
    reason: z.string().optional()
});

const returnSchema = z.object({
    items: z.array(returnItemSchema).min(1)
});

const querySchema = z.object({
    branchId: z.string().optional(),
    customerId: z.string().optional(),
    status: z.string().optional(),
    search: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    page: z.string().optional(),
    pageSize: z.string().optional()
});

router.get("/", requirePermission(Permissions.SALE_READ), validateQuery(querySchema), ctrl.list);
router.get("/pos-lookup", requirePermission(Permissions.SALE_READ), validateQuery(querySchema), ctrl.posLookup);
router.get("/summary", requirePermission(Permissions.SALE_READ), validateQuery(querySchema), ctrl.summary);
router.get("/returns", requirePermission(Permissions.SALE_READ), validateQuery(querySchema), ctrl.returns);
router.get("/:id", requirePermission(Permissions.SALE_READ), ctrl.getOne);
router.post("/", requirePermission(Permissions.SALE_CREATE), checkFeatureAccess(), validateBody(saleSchema), ctrl.create);
router.post("/:id/return", requirePermission(Permissions.SALE_RETURN), validateBody(returnSchema), ctrl.returnGoods);

export default router;