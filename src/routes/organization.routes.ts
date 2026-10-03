import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth";
import { Permissions } from "../domain/permissions";
import { validateBody } from "../middleware/validate";
import { z } from "zod";
import * as ctrl from "../controllers/organization.controller";

const router = Router();
router.use(authenticate);

// Indian GSTIN: 15 chars, format: 2 digits (state) + 10 chars (PAN) + 1 entity code + 1 checksum + 1 default 'Z'
const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i;

const settingsSchema = z.object({
  lowStockThreshold: z.number().int().min(0).optional(),
}).passthrough();

const organizationSchema = z.object({
  name: z.string().min(1).optional(),
  gstin: z
    .string()
    .optional()
    .refine(v => !v || gstinRegex.test(v), "Invalid GSTIN format. Must be 15 characters (e.g., 29AABCP1234F1Z5)."),
  address: z.string().optional(),
  settings: settingsSchema.optional(),
});

router.get("/", requirePermission(Permissions.SETTINGS_MANAGE), ctrl.get);
router.patch(
  "/",
  requirePermission(Permissions.SETTINGS_MANAGE),
  validateBody(organizationSchema),
  ctrl.update,
);

export default router;
