import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth";
import { Permissions } from "../domain/permissions";
import * as ctrl from "../controllers/branch.controller";

const router = Router();
router.use(authenticate);
router.get("/", requirePermission(Permissions.INVENTORY_READ), ctrl.list);
router.post("/", requirePermission(Permissions.INVENTORY_CREATE), ctrl.create);

export default router;
