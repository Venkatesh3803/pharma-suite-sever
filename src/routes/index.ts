import { Router } from "express";
import authanticationRoutes from "./authantication";

const router = Router();

router.use("/", authanticationRoutes);

export default router;
