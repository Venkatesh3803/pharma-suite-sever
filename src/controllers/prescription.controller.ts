import type { NextFunction, Request, Response } from "express";
import fs from "node:fs";
import { AppError } from "../domain/errors";
import { uploadPrescription, listPrescriptions, getPrescription, updatePrescriptionStatus } from "../services/prescription.service";
import { ok } from "../utils/api";

export async function list(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await listPrescriptions({
            organizationId: req.user!.organizationId,
            customerId: req.query.customerId as string,
            search: req.query.search as string,
            status: req.query.status as string,
            page: Number(req.query.page ?? 1),
            pageSize: Number(req.query.pageSize ?? 20)
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function create(req: Request, res: Response, next: NextFunction) {
    try {
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) {
            return next(new AppError("Prescription file is required.", 400, "VALIDATION"));
        }
        const data = await uploadPrescription({
            organizationId: req.user!.organizationId,
            branchId: (req.body.branchId as string) || req.user?.branchId,
            customerId: req.body.customerId as string,
            doctorName: req.body.doctorName as string,
            prescriptionDate: req.body.prescriptionDate as string,
            notes: req.body.notes as string,
            uploadedById: req.user!.userId,
            file: {
                originalname: file.originalname,
                filename: file.filename,
                path: file.path,
                mimetype: file.mimetype,
                size: file.size
            }
        });
        return ok(res, data, "Prescription uploaded.", 201);
    } catch (e) {
        next(e);
    }
}

export async function download(req: Request, res: Response, next: NextFunction) {
    try {
        const { prescription, absPath } = await getPrescription(req.user!.organizationId, req.params.id);
        if (!fs.existsSync(absPath)) {
            return next(new AppError("Prescription file not found.", 404, "NOT_FOUND"));
        }
        const p = prescription as { fileName: string; mimeType?: string };
        res.setHeader("Content-Type", p.mimeType || "application/octet-stream");
        res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(p.fileName)}"`);
        res.sendFile(absPath);
    } catch (e) {
        next(e);
    }
}

export async function updateStatus(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await updatePrescriptionStatus(req.user!.organizationId, req.params.id, req.body.status as "ACTIVE" | "COMPLETED" | "CANCELLED");
        return ok(res, data, "Prescription updated.");
    } catch (e) {
        next(e);
    }
}
