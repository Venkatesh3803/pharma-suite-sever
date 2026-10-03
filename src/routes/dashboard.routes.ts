import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { Permissions } from "../domain/permissions.js";
import { dashboard } from "../controllers/dashboard.controller.js";

const router = Router();

router.get("/", authenticate, requirePermission(Permissions.DASHBOARD_READ), dashboard);

export default router;
