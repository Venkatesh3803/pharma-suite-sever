import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { Permissions } from "../domain/permissions.js";
import { z } from "zod";
import { validateBody, validateQuery } from "../middleware/validate.js";
import * as ctrl from "../controllers/product.controller.js";

const router = Router();

const unitLevelSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1).optional(),
  factor: z.number().int().positive(),
});

const unitConfigSchema = z.object({
  baseUnit: z.string().min(1),
  baseUnitLabel: z.string().optional(),
  saleUnit: z.string().min(1),
  saleUnitFactor: z.number().int().positive(),
  levels: z.array(unitLevelSchema).max(5),
});

const productSchema = z.object({
  brand: z.string().min(1),
  genericName: z.string().optional(),
  manufacturer: z.string().optional(),
  strength: z.string().optional(),
  dosageForm: z.string().optional(),
  packSize: z.string().optional(),
  barcode: z.string().optional(),
  hsnCode: z.string().optional(),
  gstRate: z.number().optional(),
  prescriptionRequired: z.boolean().optional(),
  categoryId: z.string().optional(),
  unitConfig: unitConfigSchema.optional(),
});

const categorySchema = z.object({
  name: z.string().min(1),
});

const querySchema = z.object({
  search: z.string().optional(),
  categoryId: z.string().optional(),
  prescriptionRequired: z.string().optional(),
  branchId: z.string().optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

router.use(authenticate);

router.get("/categories", requirePermission(Permissions.PRODUCT_READ), ctrl.listCategories);
router.post("/categories", requirePermission(Permissions.PRODUCT_CREATE), validateBody(categorySchema), ctrl.createCategory);
router.get("/", requirePermission(Permissions.PRODUCT_READ), validateQuery(querySchema), ctrl.list);
router.get("/:id", requirePermission(Permissions.PRODUCT_READ), ctrl.getOne);
router.post("/", requirePermission(Permissions.PRODUCT_CREATE), validateBody(productSchema), ctrl.create);
router.patch("/:id", requirePermission(Permissions.PRODUCT_UPDATE), validateBody(productSchema.partial()), ctrl.update);
router.delete("/:id", requirePermission(Permissions.PRODUCT_UPDATE), ctrl.remove);

export default router;