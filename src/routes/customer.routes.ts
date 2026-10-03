import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { Permissions } from "../domain/permissions.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { z } from "zod";
import * as ctrl from "../controllers/customer.controller.js";

const router = Router();
router.use(authenticate);

const customerSchema = z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    address: z.string().optional(),
    notes: z.string().optional()
});

const saleSchema = z.object({
    branchId: z.string().min(1),
    customerId: z.string().optional(),
    paymentMode: z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER", "CREDIT"]).optional(),
    discount: z.number().min(0).max(100).optional(),
    items: z
        .array(
            z.object({
                productId: z.string().min(1),
                quantity: z.number().int().positive()
            })
        )
        .min(1)
});

const querySchema = z.object({
    search: z.string().optional(),
    page: z.string().optional(),
    pageSize: z.string().optional()
});

router.get("/", requirePermission(Permissions.CUSTOMER_READ), validateQuery(querySchema), ctrl.list);
router.get("/:id", requirePermission(Permissions.CUSTOMER_READ), ctrl.getOne);
router.post("/", requirePermission(Permissions.CUSTOMER_CREATE), validateBody(customerSchema), ctrl.create);
router.patch("/:id", requirePermission(Permissions.CUSTOMER_CREATE), validateBody(customerSchema.partial()), ctrl.update);
router.delete("/:id", requirePermission(Permissions.SETTINGS_MANAGE), ctrl.remove);
router.post("/sales", requirePermission(Permissions.SALE_CREATE), validateBody(saleSchema), ctrl.sales);

export default router;
