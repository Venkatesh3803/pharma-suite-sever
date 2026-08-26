import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth";
import { Permissions } from "../domain/permissions";
import * as ctrl from "../controllers/report.controller";
import { validateQuery } from "../middleware/validate";
import { z } from "zod";

const router = Router();
router.use(authenticate);

const querySchema = z.object({
  branchId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  groupBy: z.enum(["day", "week", "month"]).optional(),
  productId: z.string().optional(),
  supplierId: z.string().optional(),
  limit: z.string().optional(),
});

router.get(
  "/sales",
  requirePermission(Permissions.REPORTS_READ),
  validateQuery(querySchema),
  ctrl.sales,
);
router.get(
  "/top-products",
  requirePermission(Permissions.REPORTS_READ),
  validateQuery(querySchema),
  ctrl.topProducts,
);
router.get(
  "/inventory",
  requirePermission(Permissions.REPORTS_READ),
  validateQuery(querySchema),
  ctrl.inventory,
);
router.get(
  "/purchases",
  requirePermission(Permissions.REPORTS_READ),
  validateQuery(querySchema),
  ctrl.purchases,
);
router.get(
  "/margins",
  requirePermission(Permissions.REPORTS_READ),
  validateQuery(querySchema),
  ctrl.margins,
);

export default router;