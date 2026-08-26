import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth";
import { Permissions } from "../domain/permissions";
import { dashboard } from "../controllers/dashboard.controller";

const router = Router();

router.get("/", authenticate, requirePermission(Permissions.DASHBOARD_READ), dashboard);

export default router;
