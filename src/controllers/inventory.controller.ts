import type { NextFunction, Request, Response } from "express";
import { AppError } from "../domain/errors";
import { inventoryValue, lowStockItems, expiredStockUnits } from "../services/intelligence/inventory-analytics.service";
import { buildExpiryOverview, listExpiringItems } from "../services/intelligence/expiry.service";
import { computeStockoutRisks } from "../services/intelligence/stockout.service";
import { detectDeadStock, deadStockSummary } from "../services/intelligence/deadstock.service";
import { buildReorderRecommendations } from "../services/intelligence/reorder.service";
import {
  adjustStock,
  adjustBatchStock,
  applyStockCount,
  addOpeningBatch,
  listInventoryItems,
  getInventorySummary,
  getMedicineInventory,
  getMedicineBatches,
  getMedicineMovements,
} from "../services/inventory.service";
import { prisma } from "../lib/prisma";
import { ok } from "../utils/api";

export async function overview(req: Request, res: Response, next: NextFunction) {
    try {
        const org = req.user!.organizationId;
        const branchId = (req.query.branchId as string) || req.user?.branchId;
        const [value, low, expired, expiryOverview, stockout, dead, reorder] = await Promise.all([
            inventoryValue({ organizationId: org, branchId }),
            lowStockItems({ organizationId: org, branchId }),
            expiredStockUnits({ organizationId: org, branchId }),
            buildExpiryOverview({ organizationId: org, branchId }),
            computeStockoutRisks({ organizationId: org, branchId }),
            deadStockSummary({ organizationId: org, branchId }),
            buildReorderRecommendations({ organizationId: org, branchId })
        ]);
        return ok(res, {
            inventoryValue: value,
            lowStock: low,
            expiredStock: expired,
            expiryOverview,
            stockoutRisks: stockout.slice(0, 20),
            deadStock: dead,
            recommendedPurchases: reorder.slice(0, 20)
        });
    } catch (e) {
        next(e);
    }
}

export async function summary(req: Request, res: Response, next: NextFunction) {
    try {
        const branchId = (req.query.branchId as string) || req.user?.branchId;
        const data = await getInventorySummary({
            organizationId: req.user!.organizationId,
            branchId,
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function list(req: Request, res: Response, next: NextFunction) {
    try {
        const q = (req as Request & { cleanQuery?: Record<string, string | undefined> }).cleanQuery ?? (req.query as Record<string, string | undefined>);
        const branchId = (q.branchId as string) || req.user?.branchId;
        const data = await listInventoryItems({
            organizationId: req.user!.organizationId,
            branchId,
            search: q.search,
            categoryId: q.categoryId,
            manufacturer: q.manufacturer,
            supplierId: q.supplierId,
            stockStatus: (q.stockStatus as never) || undefined,
            expiryRisk: (q.expiryRisk as never) || undefined,
            movementStatus: (q.movementStatus as never) || undefined,
            page: Number(q.page ?? 1),
            pageSize: Number(q.pageSize ?? 20),
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function detail(req: Request, res: Response, next: NextFunction) {
    try {
        const branchId = (req.query.branchId as string) || req.user?.branchId;
        const data = await getMedicineInventory({
            organizationId: req.user!.organizationId,
            medicineId: req.params.medicineId,
            branchId,
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function medicineBatches(req: Request, res: Response, next: NextFunction) {
    try {
        const branchId = (req.query.branchId as string) || req.user?.branchId;
        const data = await getMedicineBatches({
            organizationId: req.user!.organizationId,
            medicineId: req.params.medicineId,
            branchId,
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function medicineMovements(req: Request, res: Response, next: NextFunction) {
    try {
        const q = (req.query as Record<string, string | undefined>);
        const data = await getMedicineMovements({
            organizationId: req.user!.organizationId,
            medicineId: req.params.medicineId,
            branchId: q.branchId || req.user?.branchId,
            type: q.type,
            page: Number(q.page ?? 1),
            pageSize: Number(q.pageSize ?? 20),
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function batches(req: Request, res: Response, next: NextFunction) {
    try {
        const org = req.user!.organizationId;
        const branchId = (req.query.branchId as string) || req.user?.branchId;
        const page = Number(req.query.page ?? 1);
        const pageSize = Number(req.query.pageSize ?? 20);
        const search = req.query.search as string;
        const where = {
            organizationId: org,
            ...(branchId ? { branchId } : {}),
            ...(search
                ? {
                      OR: [
                          { batchNumber: { contains: search, mode: "insensitive" as const } },
                          { product: { brand: { contains: search, mode: "insensitive" as const } } }
                      ]
                  }
                : {})
        };
        const [items, total] = await Promise.all([
            prisma.batch.findMany({
                where,
                include: { product: true, branch: true, supplier: true },
                orderBy: { expiryDate: "asc" },
                skip: (page - 1) * pageSize,
                take: pageSize
            }),
            prisma.batch.count({ where })
        ]);
        return ok(res, { items, total });
    } catch (e) {
        next(e);
    }
}

export async function movements(req: Request, res: Response, next: NextFunction) {
    try {
        const org = req.user!.organizationId;
        const q = req.query as Record<string, string | undefined>;
        const branchId = q.branchId || req.user?.branchId;
        const page = Number(q.page ?? 1);
        const pageSize = Number(q.pageSize ?? 20);
        const where = {
            organizationId: org,
            ...(branchId ? { branchId } : {}),
            ...(q.type ? { type: q.type as never } : {}),
            ...(q.userId ? { userId: q.userId } : {}),
            ...(q.productId ? { productId: q.productId } : {}),
            ...(q.search
                ? {
                      OR: [
                          { product: { brand: { contains: q.search, mode: "insensitive" as const } } },
                          { batch: { batchNumber: { contains: q.search, mode: "insensitive" as const } } },
                      ],
                  }
                : {}),
            ...(q.from || q.to
                ? {
                      createdAt: {
                          ...(q.from ? { gte: new Date(q.from) } : {}),
                          ...(q.to ? { lte: new Date(q.to) } : {}),
                      },
                  }
                : {}),
        };
        const [items, total] = await Promise.all([
            prisma.inventoryMovement.findMany({
                where,
                include: { product: true, branch: true, batch: true, user: { select: { fullName: true } } },
                orderBy: { createdAt: "desc" },
                skip: (page - 1) * pageSize,
                take: pageSize
            }),
            prisma.inventoryMovement.count({ where })
        ]);
        return ok(res, { items, total });
    } catch (e) {
        next(e);
    }
}

export async function expiry(req: Request, res: Response, next: NextFunction) {
    try {
        const org = req.user!.organizationId;
        const branchId = (req.query.branchId as string) || req.user?.branchId;
        const days = Number(req.query.days ?? 180);
        const data = await listExpiringItems({
            organizationId: org,
            branchId,
            days,
            page: Number(req.query.page ?? 1),
            pageSize: Number(req.query.pageSize ?? 20)
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function lowStock(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await lowStockItems({
            organizationId: req.user!.organizationId,
            branchId: (req.query.branchId as string) || req.user?.branchId
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function stockoutRisks(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await computeStockoutRisks({
            organizationId: req.user!.organizationId,
            branchId: (req.query.branchId as string) || req.user?.branchId,
            limit: Number(req.query.limit ?? 50)
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function deadStock(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await detectDeadStock({
            organizationId: req.user!.organizationId,
            branchId: (req.query.branchId as string) || req.user?.branchId,
            inactiveDays: Number(req.query.inactiveDays ?? 60),
            page: Number(req.query.page ?? 1),
            pageSize: Number(req.query.pageSize ?? 50)
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function reorder(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await buildReorderRecommendations({
            organizationId: req.user!.organizationId,
            branchId: (req.query.branchId as string) || req.user?.branchId
        });
        return ok(res, data);
    } catch (e) {
        next(e);
    }
}

export async function adjust(req: Request, res: Response, next: NextFunction) {
    try {
        const { productId, quantity, reason, note } = req.body as {
            productId: string;
            quantity: number;
            reason: string;
            note?: string;
        };
        const branchId = (req.body.branchId as string | undefined) ?? req.user?.branchId;
        if (!branchId) {
            return next(new AppError("A branch is required to adjust stock.", 400, "VALIDATION"));
        }
        const result = await adjustStock({
            organizationId: req.user!.organizationId,
            productId,
            branchId,
            quantity,
            reason,
            note,
            userId: req.user!.userId
        });
        return ok(res, result, "Stock adjusted.");
    } catch (e) {
        next(e);
    }
}

export async function adjustBatch(req: Request, res: Response, next: NextFunction) {
    try {
        const { batchId, productId, quantity, reason, note } = req.body as {
            batchId: string;
            productId: string;
            quantity: number;
            reason: "PHYSICAL_COUNT" | "DAMAGE" | "LOSS" | "EXPIRY" | "DATA_CORRECTION" | "OPENING_BALANCE" | "OTHER";
            note?: string;
        };
        const branchId = (req.body.branchId as string | undefined) ?? req.user?.branchId;
        if (!branchId) {
            return next(new AppError("A branch is required to adjust stock.", 400, "VALIDATION"));
        }
        const result = await adjustBatchStock({
            organizationId: req.user!.organizationId,
            branchId,
            batchId,
            productId,
            quantity,
            reason,
            note,
            userId: req.user!.userId,
        });
        return ok(res, result, "Batch stock adjusted.");
    } catch (e) {
        next(e);
    }
}

export async function stockCount(req: Request, res: Response, next: NextFunction) {
    try {
        const branchId = (req.body.branchId as string | undefined) ?? req.user?.branchId;
        if (!branchId) {
            return next(new AppError("A branch is required for a stock count.", 400, "VALIDATION"));
        }
        const counts = (req.body.counts as {
            batchId: string;
            productId: string;
            physicalQuantity: number;
        }[]).map(c => ({
            batchId: c.batchId,
            productId: c.productId,
            physicalQuantity: Number(c.physicalQuantity),
        }));
        const result = await applyStockCount({
            organizationId: req.user!.organizationId,
            branchId,
            userId: req.user!.userId,
            counts,
        });
        return ok(res, result, "Stock count applied.");
    } catch (e) {
        next(e);
    }
}

export async function createBatch(req: Request, res: Response, next: NextFunction) {
    try {
        const branchId = (req.body.branchId as string | undefined) ?? req.user?.branchId;
        if (!branchId) {
            return next(new AppError("A branch is required.", 400, "VALIDATION"));
        }
        const result = await addOpeningBatch({
            organizationId: req.user!.organizationId,
            branchId,
            productId: req.body.productId,
            quantity: Number(req.body.quantity),
            batchNumber: req.body.batchNumber,
            expiryDate: req.body.expiryDate,
            purchasePrice: req.body.purchasePrice !== undefined ? Number(req.body.purchasePrice) : undefined,
            mrp: req.body.mrp !== undefined ? Number(req.body.mrp) : undefined,
            sellingPrice: req.body.sellingPrice !== undefined ? Number(req.body.sellingPrice) : undefined,
            supplierId: req.body.supplierId,
            userId: req.user!.userId,
            note: req.body.note,
        });
        return ok(res, result, result.created ? "Batch created with opening stock." : "Stock added to existing batch.", 201);
    } catch (e) {
        next(e);
    }
}