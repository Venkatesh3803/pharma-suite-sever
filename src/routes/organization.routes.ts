import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth";
import { Permissions } from "../domain/permissions";
import { validateBody } from "../middleware/validate";
import { z } from "zod";
import * as ctrl from "../controllers/organization.controller";

const router = Router();
router.use(authenticate);

const organizationSchema = z.object({
  name: z.string().min(1).optional(),
  gstin: z.string().optional(),
  address: z.string().optional(),
  settings: z.record(z.unknown()).optional(),
});

router.get("/", requirePermission(Permissions.SETTINGS_MANAGE), ctrl.get);
router.patch(
  "/",
  requirePermission(Permissions.SETTINGS_MANAGE),
  validateBody(organizationSchema),
  ctrl.update,
);

export default router;
