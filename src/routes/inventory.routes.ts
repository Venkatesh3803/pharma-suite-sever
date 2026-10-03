import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { checkFeatureAccess } from "../middleware/feature-access.js";
import { Permissions } from "../domain/permissions.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { z } from "zod";
import * as ctrl from "../controllers/inventory.controller.js";

const router = Router();
router.use(authenticate);

const querySchema = z.object({
    branchId: z.string().optional(),
    search: z.string().optional(),
    categoryId: z.string().optional(),
    manufacturer: z.string().optional(),
    supplierId: z.string().optional(),
    stockStatus: z.enum(["HEALTHY", "LOW_STOCK", "OUT_OF_STOCK", "OVERSTOCKED"]).optional(),
    expiryRisk: z.enum(["EXPIRED", "EXPIRING_30_DAYS", "EXPIRING_60_DAYS", "EXPIRING_90_DAYS", "HEALTHY"]).optional(),
    movementStatus: z.enum(["FAST_MOVING", "NORMAL", "SLOW_MOVING", "DEAD_STOCK", "INSUFFICIENT_DATA"]).optional(),
    page: z.string().optional(),
    pageSize: z.string().optional(),
    days: z.string().optional(),
    inactiveDays: z.string().optional(),
    limit: z.string().optional(),
    type: z.string().optional(),
    userId: z.string().optional(),
    productId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional()
});

const adjustSchema = z.object({
    productId: z.string().min(1),
    branchId: z.string().optional(),
    quantity: z.number().int(),
    reason: z.string().min(3),
    note: z.string().optional()
});

const adjustBatchSchema = z.object({
    batchId: z.string().min(1),
    productId: z.string().min(1),
    branchId: z.string().optional(),
    quantity: z.number().int(),
    reason: z.enum(["PHYSICAL_COUNT", "DAMAGE", "LOSS", "EXPIRY", "DATA_CORRECTION", "OPENING_BALANCE", "OTHER"]),
    note: z.string().optional()
});

const stockCountSchema = z.object({
    branchId: z.string().optional(),
    counts: z
        .array(
            z.object({
                batchId: z.string().min(1),
                productId: z.string().min(1),
                physicalQuantity: z.number().int().min(0)
            })
        )
        .min(1)
});

const openingBatchSchema = z.object({
    productId: z.string().min(1),
    branchId: z.string().optional(),
    quantity: z.number().int().positive(),
    batchNumber: z.string().min(1).optional(),
    expiryDate: z.string().optional(),
    purchasePrice: z.number().nonnegative().optional(),
    mrp: z.number().nonnegative().optional(),
    sellingPrice: z.number().nonnegative().optional(),
    supplierId: z.string().optional(),
    note: z.string().optional()
});

// Static routes MUST be registered before the dynamic :medicineId route.
router.get("/summary", requirePermission(Permissions.INVENTORY_READ), validateQuery(querySchema), ctrl.summary);
router.get("/overview", requirePermission(Permissions.INVENTORY_READ), validateQuery(querySchema), ctrl.overview);
router.get("/expiry", requirePermission(Permissions.INVENTORY_READ), validateQuery(querySchema), ctrl.expiry);
router.get("/low-stock", requirePermission(Permissions.INVENTORY_READ), validateQuery(querySchema), ctrl.lowStock);
router.get("/stockout-risks", requirePermission(Permissions.INVENTORY_READ), validateQuery(querySchema), ctrl.stockoutRisks);
router.get("/dead-stock", checkFeatureAccess("STANDARD"), requirePermission(Permissions.INVENTORY_READ), validateQuery(querySchema), ctrl.deadStock);
router.get("/reorder", checkFeatureAccess("STANDARD"), requirePermission(Permissions.INVENTORY_READ), validateQuery(querySchema), ctrl.reorder);
router.get("/movements", requirePermission(Permissions.INVENTORY_READ), validateQuery(querySchema), ctrl.movements);
router.get("/batches", requirePermission(Permissions.INVENTORY_READ), validateQuery(querySchema), ctrl.batches);

// Medicine-scoped sub-resources.
router.get("/:medicineId/batches", requirePermission(Permissions.INVENTORY_READ), validateQuery(querySchema), ctrl.medicineBatches);
router.get("/:medicineId/movements", requirePermission(Permissions.INVENTORY_READ), validateQuery(querySchema), ctrl.medicineMovements);
router.get("/:medicineId", requirePermission(Permissions.INVENTORY_READ), validateQuery(querySchema), ctrl.detail);

// Main list (registered after static routes to avoid capture).
router.get("/", requirePermission(Permissions.INVENTORY_READ), validateQuery(querySchema), ctrl.list);

// Mutations.
router.post("/adjust", requirePermission(Permissions.INVENTORY_ADJUST), validateBody(adjustSchema), ctrl.adjust);
router.post("/adjust-batch", requirePermission(Permissions.INVENTORY_ADJUST), validateBody(adjustBatchSchema), ctrl.adjustBatch);
router.post("/stock-count", requirePermission(Permissions.INVENTORY_ADJUST), validateBody(stockCountSchema), ctrl.stockCount);
router.post("/batches", requirePermission(Permissions.INVENTORY_ADJUST), validateBody(openingBatchSchema), ctrl.createBatch);

export default router;