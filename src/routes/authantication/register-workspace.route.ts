import { Router } from "express";
import { login, logout, refresh, registerWorkspace } from "../../controllers";
import { requireAuth } from "../../middleware";

const router = Router();

router.post("/register", registerWorkspace);
router.post("/login", login);
router.post("/refresh", refresh);
router.post("/logout", requireAuth, logout);

export default router;
