import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import * as ctrl from "../controllers/admin-subscription.controller";

const router = Router();

// SuperAdmin-only panel for manual offline payment verification and
// subscription lifecycle overrides.
router.use(authenticate);
router.use(requireRole("SUPER_ADMIN"));

const verifyPaymentSchema = z.object({
  paymentRecordId: z.string().min(1),
  action: z.enum(["APPROVE", "REJECT"]),
});

const updateStatusSchema = z.object({
  status: z.enum(["TRIALING", "PENDING_VERIFICATION", "ACTIVE", "PAST_DUE", "EXPIRED", "CANCELLED"]).optional(),
  tier: z.enum(["TRIAL_14_DAYS", "BASIC", "STANDARD", "PREMIUM"]).optional(),
  billingCycle: z.enum(["MONTHLY", "ANNUAL"]).optional(),
  trialEndsAt: z.coerce.date().optional(),
  currentPeriodStart: z.coerce.date().optional(),
  currentPeriodEnd: z.coerce.date().optional(),
  note: z.string().trim().max(500).optional(),
});

router.get("/", ctrl.list);
router.get("/pending", ctrl.pending);
router.post("/verify-payment", validateBody(verifyPaymentSchema), ctrl.verify);
router.patch("/:id/status", validateBody(updateStatusSchema), ctrl.updateStatus);

export default router;
