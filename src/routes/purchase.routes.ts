import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth";
import { Permissions } from "../domain/permissions";
import { validateBody, validateQuery } from "../middleware/validate";
import { z } from "zod";
import * as ctrl from "../controllers/purchase.controller";

const router = Router();
router.use(authenticate);

const itemSchema = z
    .object({
        productId: z.string().min(1),
        quantity: z.number().int().positive(),
        freeQuantity: z.number().int().nonnegative().optional(),
        purchasePrice: z.number().nonnegative(),
        mrp: z.number().nonnegative(),
        sellingPrice: z.number().nonnegative().optional(),
        gstRate: z.number().nonnegative().optional(),
        discount: z.number().min(0).max(100).optional(),
        batchNumber: z.string().optional(),
        expiryDate: z.string().optional()
    })
    .superRefine((val, ctx) => {
        if (val.sellingPrice !== undefined && val.sellingPrice > val.mrp) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["sellingPrice"],
                message: "Selling price cannot be greater than MRP."
            });
        }
    });

const purchaseSchema = z.object({
    branchId: z.string().min(1),
    supplierId: z.string().min(1),
    expectedDelivery: z.string().optional(),
    notes: z.string().optional(),
    supplierInvoiceNumber: z.string().optional(),
    invoiceDate: z.string().optional(),
    items: z.array(itemSchema).min(1)
});

const receiptItemSchema = z.object({
    purchaseItemId: z.string().min(1),
    productId: z.string().min(1),
    quantity: z.number().int().positive(),
    freeQuantity: z.number().int().nonnegative().optional(),
    batchNumber: z.string().min(1),
    expiryDate: z.string().min(1),
    purchasePrice: z.number().nonnegative().optional(),
    mrp: z.number().nonnegative().optional(),
    sellingPrice: z.number().nonnegative().optional()
});

const receiveSchema = z.object({
    branchId: z.string().optional(),
    items: z.array(receiptItemSchema).optional()
});

const returnItemSchema = z.object({
    batchId: z.string().min(1),
    quantity: z.number().int().positive(),
    reason: z.string().optional(),
    note: z.string().optional()
});

const returnSchema = z.object({
    items: z.array(returnItemSchema).min(1)
});

const querySchema = z.object({
    branchId: z.string().optional(),
    supplierId: z.string().optional(),
    status: z.string().optional(),
    search: z.string().optional(),
    page: z.string().optional(),
    pageSize: z.string().optional()
});

router.get("/", requirePermission(Permissions.PURCHASE_READ), validateQuery(querySchema), ctrl.list);
router.get("/summary", requirePermission(Permissions.PURCHASE_READ), validateQuery(querySchema), ctrl.summary);
router.get("/returns", requirePermission(Permissions.PURCHASE_READ), validateQuery(querySchema), ctrl.returns);
router.get("/:id", requirePermission(Permissions.PURCHASE_READ), ctrl.getOne);
router.get("/:id/pdf", requirePermission(Permissions.PURCHASE_READ), ctrl.pdf);
router.post("/", requirePermission(Permissions.PURCHASE_CREATE), validateBody(purchaseSchema), ctrl.create);
router.put("/:id", requirePermission(Permissions.PURCHASE_CREATE), validateBody(purchaseSchema), ctrl.update);
router.post("/:id/submit", requirePermission(Permissions.PURCHASE_CREATE), ctrl.submit);
router.post("/:id/approve", requirePermission(Permissions.PURCHASE_APPROVE), ctrl.approve);
router.post("/:id/cancel", requirePermission(Permissions.PURCHASE_READ), ctrl.cancel);
router.post("/:id/receive", requirePermission(Permissions.PURCHASE_RECEIVE), validateBody(receiveSchema), ctrl.receive);
router.post("/:id/return", requirePermission(Permissions.PURCHASE_RETURN), validateBody(returnSchema), ctrl.returnGoods);

export default router;