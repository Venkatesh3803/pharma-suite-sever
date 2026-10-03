import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { Permissions } from "../domain/permissions.js";
import * as ctrl from "../controllers/branch.controller.js";

const router = Router();
router.use(authenticate);
router.get("/", requirePermission(Permissions.SETTINGS_MANAGE), ctrl.list);
router.post("/", requirePermission(Permissions.SETTINGS_MANAGE), ctrl.create);

export default router;
