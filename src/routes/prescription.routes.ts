import { Router } from "express";
import type { RequestHandler } from "express";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { checkFeatureAccess } from "../middleware/feature-access.js";
import { Permissions } from "../domain/permissions.js";
import { validateQuery } from "../middleware/validate.js";
import multer from "multer";
import { z } from "zod";
import * as ctrl from "../controllers/prescription.controller.js";

const router = Router();
router.use(authenticate);
router.use(checkFeatureAccess("STANDARD"));

const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, "tmp/"),
        filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`)
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const ok = file.mimetype === "application/pdf" || file.mimetype.startsWith("image/");
        if (ok) cb(null, true);
        else cb(new Error("Only PDF or image files are allowed."));
    }
});

const singleUpload = upload.single("file") as unknown as RequestHandler;

const querySchema = z.object({
    customerId: z.string().optional(),
    search: z.string().optional(),
    status: z.string().optional(),
    page: z.string().optional(),
    pageSize: z.string().optional()
});

router.get("/", requirePermission(Permissions.PRESCRIPTION_READ), validateQuery(querySchema), ctrl.list);
router.get("/:id/download", requirePermission(Permissions.PRESCRIPTION_READ), ctrl.download);
router.post("/", requirePermission(Permissions.PRESCRIPTION_CREATE), singleUpload, ctrl.create);
router.patch("/:id/status", requirePermission(Permissions.PRESCRIPTION_CREATE), ctrl.updateStatus);

export default router;
