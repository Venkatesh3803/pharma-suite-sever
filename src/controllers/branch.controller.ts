import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { ok, fail } from "../utils/api";
import { assertBranchLimit } from "../services/subscription.service";

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

        const existing = await prisma.branch.findFirst({
            where: { organizationId: req.user!.organizationId, name: name.trim() },
        });
        if (existing) {
            return fail(res, "A branch with this name already exists.", 409, "DUPLICATE_RECORD");
        }

        const branch = await prisma.branch.create({
            data: {
                organizationId: req.user!.organizationId,
                name: name.trim(),
                code:
                    code && typeof code === "string"
                        ? code.trim().toUpperCase()
                        : `BR${Math.floor(1000 + Math.random() * 9000)}`,
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

        return ok(res, branch, "Branch created.", 201);
    } catch (e) {
        next(e);
    }
}
