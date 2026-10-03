import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { ok, fail } from "../utils/api";
import { assertBranchLimit } from "../services/subscription.service";
import { Prisma } from "@prisma/client";

export async function list(req: Request, res: Response, next: NextFunction) {
    try {
        const branches = await prisma.branch.findMany({
            where: { organizationId: req.user!.organizationId, isActive: true },
            select: {
                id: true,
                name: true,
                code: true,
                city: true,
                state: true,
                isActive: true
            },
            orderBy: { name: "asc" }
        });
        return ok(res, branches);
    } catch (e) {
        next(e);
    }
}

export async function create(req: Request, res: Response, next: NextFunction) {
    try {
        const { name, code, city, state, phone, address } = req.body ?? {};
        if (!name || typeof name !== "string" || !name.trim()) {
            return fail(res, "Branch name is required.", 400, "VALIDATION");
        }

        await assertBranchLimit(req.user!.organizationId);

        const trimmedName = name.trim();
        const existingName = await prisma.branch.findFirst({
            where: { organizationId: req.user!.organizationId, name: trimmedName },
        });
        if (existingName) {
            return fail(res, "A branch with this name already exists.", 409, "DUPLICATE_RECORD");
        }

        let finalCode: string;
        if (code && typeof code === "string" && code.trim()) {
            const trimmedCode = code.trim().toUpperCase();
            const existingCode = await prisma.branch.findFirst({
                where: { organizationId: req.user!.organizationId, code: trimmedCode },
            });
            if (existingCode) {
                return fail(res, "A branch with this code already exists.", 409, "DUPLICATE_RECORD");
            }
            finalCode = trimmedCode;
        } else {
            finalCode = `BR${Math.floor(1000 + Math.random() * 9000)}`;
        }

        const branch = await prisma.branch.create({
            data: {
                organizationId: req.user!.organizationId,
                name: trimmedName,
                code: finalCode,
                city: typeof city === "string" ? city.trim() : undefined,
                state: typeof state === "string" ? state.trim() : undefined,
                phone: typeof phone === "string" ? phone.trim() : undefined,
                address: typeof address === "string" ? address.trim() : undefined,
                isActive: true,
            },
            select: {
                id: true,
                name: true,
                code: true,
                city: true,
                state: true,
                isActive: true
            },
        });

        await prisma.auditLog.create({
            data: {
                organizationId: req.user!.organizationId,
                userId: req.user!.userId,
                action: "BRANCH_CREATED" as any,
                entityType: "Branch",
                entityId: branch.id,
                metadata: { name: branch.name, code: branch.code },
            },
        });

        return ok(res, branch, "Branch created.", 201);
    } catch (e) {
        next(e);
    }
}
