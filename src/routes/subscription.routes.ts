import { Router } from "express";
import { z } from "zod";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { Permissions } from "../domain/permissions.js";
import { validateBody } from "../middleware/validate.js";
import * as ctrl from "../controllers/subscription.controller.js";

const router = Router();
router.use(authenticate);

const selectPlanSchema = z.object({
  tier: z.enum(["TRIAL_14_DAYS", "BASIC", "STANDARD", "PREMIUM"]),
  billingCycle: z.enum(["MONTHLY", "ANNUAL"]).optional(),
  paymentMode: z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER", "CREDIT"]).optional(),
  transactionRef: z.string().trim().min(1).max(120).optional(),
  proofUrl: z.string().trim().max(500).optional(),
});

router.get("/me", requirePermission(Permissions.SUBSCRIPTION_READ), ctrl.me);
router.post(
  "/select-plan",
  requirePermission(Permissions.SUBSCRIPTION_MANAGE),
  validateBody(selectPlanSchema),
  ctrl.selectPlan,
);

export default router;
