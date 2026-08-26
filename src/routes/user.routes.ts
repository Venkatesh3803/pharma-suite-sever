import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth";
import { Permissions } from "../domain/permissions";
import { validateBody } from "../middleware/validate";
import { z } from "zod";
import * as ctrl from "../controllers/user.controller";

const router = Router();
router.use(authenticate);

const createUserSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
  role: z
    .enum(["SUPER_ADMIN", "OWNER", "MANAGER", "PHARMACIST", "STAFF"])
    .default("STAFF"),
  branchId: z.string().optional(),
});

const updateUserSchema = z.object({
  fullName: z.string().min(1).optional(),
  phone: z.string().optional(),
  role: z
    .enum(["SUPER_ADMIN", "OWNER", "MANAGER", "PHARMACIST", "STAFF"])
    .optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "SUSPENDED"]).optional(),
  branchId: z.string().nullable().optional(),
  password: z.string().min(6).optional(),
});

router.get("/", requirePermission(Permissions.USERS_MANAGE), ctrl.list);
router.post(
  "/",
  requirePermission(Permissions.USERS_MANAGE),
  validateBody(createUserSchema),
  ctrl.create,
);
router.patch(
  "/:id",
  requirePermission(Permissions.USERS_MANAGE),
  validateBody(updateUserSchema),
  ctrl.update,
);

export default router;
