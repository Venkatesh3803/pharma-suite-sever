import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth";
import { Permissions } from "../domain/permissions";
import { validateBody, validateQuery } from "../middleware/validate";
import { z } from "zod";
import * as ctrl from "../controllers/supplier.controller";

const router = Router();
router.use(authenticate);

const supplierSchema = z.object({
  name: z.string().min(1),
  contactPerson: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  gstin: z.string().optional(),
  address: z.string().optional(),
  paymentTerms: z.string().optional(),
  leadTimeDays: z.number().int().positive().optional(),
});

const querySchema = z.object({
  search: z.string().optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

router.get("/", requirePermission(Permissions.SUPPLIER_READ), validateQuery(querySchema), ctrl.list);
router.get("/:id", requirePermission(Permissions.SUPPLIER_READ), ctrl.getOne);
router.get("/:id/performance", requirePermission(Permissions.SUPPLIER_READ), ctrl.performance);
router.get("/:id/price-history", requirePermission(Permissions.SUPPLIER_READ), validateQuery(querySchema), ctrl.priceHistory);
router.post("/", requirePermission(Permissions.SUPPLIER_CREATE), validateBody(supplierSchema), ctrl.create);
router.patch("/:id", requirePermission(Permissions.SUPPLIER_UPDATE), validateBody(supplierSchema.partial()), ctrl.update);

export default router;