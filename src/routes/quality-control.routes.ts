import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth";
import { checkFeatureAccess } from "../middleware/feature-access";
import { Permissions } from "../domain/permissions";
import { validateBody, validateQuery } from "../middleware/validate";
import { z } from "zod";
import * as ctrl from "../controllers/quality-control.controller";

const router = Router();
router.use(authenticate);
router.use(checkFeatureAccess("STANDARD"));

const listQuerySchema = z.object({
  branchId: z.string().optional(),
  batchId: z.string().optional(),
  status: z.string().optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

const createSchema = z.object({
  batchId: z.string().min(1),
  branchId: z.string().optional(),
  checkType: z.enum([
    "RECEIPT_INSPECTION",
    "STORAGE_CONDITION",
    "EXPIRY_VERIFICATION",
    "LABEL_VERIFICATION",
    "ROUTINE_INSPECTION",
  ]),
  temperatureC: z.coerce.number().min(-99).max(99).optional(),
  condition: z.string().max(200).optional(),
  passedItems: z.array(z.string().max(200)).max(20).optional(),
  failedItems: z.array(z.string().max(200)).max(20).optional(),
  notes: z.string().max(1000).optional(),
  decision: z.enum(["PENDING", "PASSED", "FAILED", "QUARANTINE"]).optional(),
});

const updateSchema = z.object({
  status: z.enum(["PASSED", "FAILED", "RELEASED", "DISPOSED"]),
  decisionNote: z.string().max(1000).optional(),
});

// Static routes before dynamic.
router.get("/pending", requirePermission(Permissions.QUALITY_CONTROL_READ), validateQuery(listQuerySchema), ctrl.pending);
router.get("/", requirePermission(Permissions.QUALITY_CONTROL_READ), validateQuery(listQuerySchema), ctrl.list);
router.post("/", requirePermission(Permissions.QUALITY_CONTROL_MANAGE), validateBody(createSchema), ctrl.create);
router.patch("/:id", requirePermission(Permissions.QUALITY_CONTROL_MANAGE), validateBody(updateSchema), ctrl.updateStatus);

export default router;
