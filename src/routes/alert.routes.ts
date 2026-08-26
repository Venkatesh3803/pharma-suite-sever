import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth";
import { Permissions } from "../domain/permissions";
import { validateQuery } from "../middleware/validate";
import { z } from "zod";
import * as ctrl from "../controllers/alert.controller";

const router = Router();
router.use(authenticate);

const querySchema = z.object({
  branchId: z.string().optional(),
  type: z.string().optional(),
  severity: z.string().optional(),
  status: z.string().optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

router.get("/", requirePermission(Permissions.ALERTS_MANAGE), validateQuery(querySchema), ctrl.list);
router.get("/count", requirePermission(Permissions.ALERTS_MANAGE), ctrl.count);
router.post("/read-all", requirePermission(Permissions.ALERTS_MANAGE), validateQuery(querySchema), ctrl.readAll);
router.post("/:id/read", requirePermission(Permissions.ALERTS_MANAGE), ctrl.read);
router.post("/:id/dismiss", requirePermission(Permissions.ALERTS_MANAGE), ctrl.dismiss);

export default router;