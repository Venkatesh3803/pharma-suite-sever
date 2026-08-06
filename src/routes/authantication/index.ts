import express from "express";
import registerWorkspaceRoutes from "./register-workspace.route";

const router = express.Router();

router.use("/auth", registerWorkspaceRoutes);

export default router;
