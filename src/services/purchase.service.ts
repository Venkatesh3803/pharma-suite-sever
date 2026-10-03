import { prisma } from "../lib/prisma";
import { AppError } from "../domain/errors";
import { removeStock } from "./stock.service";
import type { TxClient } from "./stock.service";
import { postPurchaseEntry } from "./finance.service";

export interface PurchaseItemInput {
  productId: string;
  quantity: number;
  freeQuantity?: number;
  purchasePrice: number;
  mrp: number;
  sellingPrice?: number;
  gstRate?: number;
  discount?: number;
  batchNumber?: string;
  expiryDate?: string; // ISO date
}

export interface CreatePurchaseInput {
  branchId: string;
  supplierId: string;
  expectedDelivery?: string;
  notes?: string;
  supplierInvoiceNumber?: string;
  invoiceDate?: string;
  items: PurchaseItemInput[];
}

export interface ReceiptBatchInput {
  purchaseItemId: string;
  productId: string;
  quantity: number;
  freeQuantity?: number;
  batchNumber: string;
  expiryDate: string; // ISO date
  purchasePrice?: number;
  mrp?: number;
  sellingPrice?: number;
}

export interface ReturnItemInput {
  batchId: string;
  quantity: number;
  reason?: string;
  note?: string;
}

async function nextPoNumber(tx: any, organizationId: string) {
  const year = new Date().getFullYear();
  const counter = await tx.purchaseCounter.upsert({
    where: { organizationId_year: { organizationId, year } },
    create: { organizationId, year, sequence: 1 },
    update: { sequence: { increment: 1 } },
  });
  return `PO-${year}-${String(counter.sequence).padStart(4, "0")}`;
}

async function nextReceiptNumber(tx: any, organizationId: string) {
  const year = new Date().getFullYear();
  const counter = await tx.receiptCounter.upsert({
    where: { organizationId_year: { organizationId, year } },
    create: { organizationId, year, sequence: 1 },
    update: { sequence: { increment: 1 } },
  });
  return `GRN-${year}-${String(counter.sequence).padStart(4, "0")}`;
}

function validatePurchaseItems(input: CreatePurchaseInput): void {
  if (!input.items.length) {
    throw new AppError("Purchase must have at least one item.", 400, "VALIDATION");
  }

  for (const item of input.items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new AppError("Item quantity must be a positive integer.", 400, "VALIDATION");
    }
    if (item.purchasePrice < 0) {
      throw new AppError("Purchase price cannot be negative.", 400, "VALIDATION");
    }
    if (item.mrp < 0) {
      throw new AppError("MRP cannot be negative.", 400, "VALIDATION");
    }
    if (item.sellingPrice !== undefined) {
      if (item.sellingPrice < 0) {
        throw new AppError("Selling price cannot be negative.", 400, "VALIDATION");
      }
      if (item.sellingPrice > item.mrp) {
        throw new AppError("Selling price cannot be greater than MRP.", 400, "VALIDATION");
      }
    }
    if (item.discount !== undefined && (item.discount < 0 || item.discount > 100)) {
      throw new AppError("Discount must be between 0 and 100%.", 400, "VALIDATION");
    }
    if (item.gstRate !== undefined && item.gstRate < 0) {
      throw new AppError("GST rate cannot be negative.", 400, "VALIDATION");
    }
  }
}

function buildPurchaseItemRows(items: PurchaseItemInput[]) {
  let subtotal = 0;
  let tax = 0;
  let discount = 0;

  const rows = items.map(item => {
    const qDiscountPct = item.discount ?? 0;
    const qGst = item.gstRate ?? 0;
    const lineSubtotal = item.purchasePrice * item.quantity;
    const discountAmount = (lineSubtotal * qDiscountPct) / 100;
    const beforeGst = lineSubtotal - discountAmount;
    const itemTax = (beforeGst * qGst) / 100;
    subtotal += lineSubtotal;
    discount += discountAmount;
    tax += itemTax;
    return {
      productId: item.productId,
      batchNumber: item.batchNumber,
      quantity: item.quantity,
      freeQuantity: item.freeQuantity ?? 0,
      purchasePrice: item.purchasePrice,
      mrp: item.mrp,
      sellingPrice: item.sellingPrice,
      gstRate: qGst,
      discount: qDiscountPct,
      total: beforeGst + itemTax,
      receivedQty: 0,
      expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
    };
  });

  return { rows, subtotal, discount, tax, total: subtotal - discount + tax };
}

export async function createPurchase(
  organizationId: string,
  userId: string,
  input: CreatePurchaseInput,
) {
  validatePurchaseItems(input);
  const { rows, subtotal, discount, tax, total } = buildPurchaseItemRows(input.items);

  return prisma.$transaction(async tx => {
    const poNumber = await nextPoNumber(tx, organizationId);
    const purchase = await tx.purchase.create({
      data: {
        poNumber,
        organizationId,
        branchId: input.branchId,
        supplierId: input.supplierId,
        status: "DRAFT",
        subtotal,
        discount,
        tax,
        total,
        notes: input.notes,
        supplierInvoiceNumber: input.supplierInvoiceNumber,
        invoiceDate: input.invoiceDate ? new Date(input.invoiceDate) : null,
        expectedDelivery: input.expectedDelivery
          ? new Date(input.expectedDelivery)
          : null,
        createdById: userId,
        items: { create: rows },
      },
      include: { items: true },
    });

    await tx.auditLog.create({
      data: {
        organizationId,
        branchId: input.branchId,
        userId,
        action: "PURCHASE_CREATED",
        entityType: "Purchase",
        entityId: purchase.id,
        metadata: { poNumber },
      },
    });

    return purchase;
  });
}

/**
 * Update a purchase order. Editing is intentionally restricted to DRAFT
 * orders only: once a PO is submitted, approved, received or cancelled it is
 * locked so pricing/quantities cannot be silently changed after the fact.
 * Existing line items are replaced by the submitted set and all totals are
 * recomputed.
 */
export async function updatePurchase(
  organizationId: string,
  userId: string,
  purchaseId: string,
  input: CreatePurchaseInput,
) {
  validatePurchaseItems(input);
  const { rows, subtotal, discount, tax, total } = buildPurchaseItemRows(input.items);

  return prisma.$transaction(async tx => {
    const existing = await tx.purchase.findFirst({
      where: { id: purchaseId, organizationId },
      include: { items: true },
    });
    if (!existing) throw new AppError("Purchase not found.", 404, "NOT_FOUND");
    if (existing.status !== "DRAFT") {
      throw new AppError(
        "Only draft purchase orders can be edited. This order has moved past draft and is locked.",
        400,
        "VALIDATION",
      );
    }

    const hasStock = await tx.inventoryMovement.count({
      where: { organizationId, referenceType: "PURCHASE", referenceId: purchaseId },
    });
    if (hasStock > 0) {
      throw new AppError(
        "Cannot edit a purchase order that has already received stock.",
        400,
        "VALIDATION",
      );
    }

    const purchase = await tx.purchase.update({
      where: { id: purchaseId },
      data: {
        branchId: input.branchId,
        supplierId: input.supplierId,
        subtotal,
        discount,
        tax,
        total,
        notes: input.notes,
        supplierInvoiceNumber: input.supplierInvoiceNumber,
        invoiceDate: input.invoiceDate ? new Date(input.invoiceDate) : null,
        expectedDelivery: input.expectedDelivery
          ? new Date(input.expectedDelivery)
          : null,
        items: { deleteMany: {}, create: rows },
      },
      include: { items: true },
    });

    await tx.auditLog.create({
      data: {
        organizationId,
        branchId: input.branchId,
        userId,
        action: "PURCHASE_UPDATED",
        entityType: "Purchase",
        entityId: purchase.id,
        metadata: { poNumber: purchase.poNumber },
      },
    });

    return purchase;
  });
}

export async function updatePurchaseStatus(
  organizationId: string,
  purchaseId: string,
  status: "SUBMITTED" | "APPROVED" | "CANCELLED",
  userId: string,
) {
  const purchase = await prisma.purchase.findFirst({
    where: { id: purchaseId, organizationId },
  });
  if (!purchase) throw new AppError("Purchase not found.", 404, "NOT_FOUND");

  if (status === "CANCELLED") {
    const hasStock = await prisma.inventoryMovement.count({
      where: { organizationId, referenceType: "PURCHASE", referenceId: purchaseId },
    });
    if (hasStock > 0) {
      throw new AppError(
        "Cannot cancel a purchase that has already received stock. Use returns/corrections instead.",
        400,
        "VALIDATION",
      );
    }
  }

  const result = await prisma.purchase.updateMany({
    where: { id: purchaseId, organizationId },
    data: {
      status,
      ...(status === "APPROVED"
        ? { approvedById: userId, approvedAt: new Date() }
        : {}),
    },
  });

  if (result.count === 0) throw new AppError("Purchase not found.", 404, "NOT_FOUND");

  await prisma.auditLog.create({
    data: {
      organizationId,
      branchId: purchase.branchId,
      userId,
      action: `PURCHASE_${status}`,
      entityType: "Purchase",
      entityId: purchaseId,
      metadata: { poNumber: purchase.poNumber },
    },
  });

  return { applied: result.count > 0 };
}

/**
 * Receive goods for a purchase order. Creates an immutable PurchaseReceipt,
 * upserts batches (one per batch row), increases batch stock, records
 * PURCHASE stock movements, updates PO received quantities/status and the
 * vendor-medicine price snapshot — all inside a single transaction.
 *
 * If `items` is omitted, the whole remaining quantity of every PO line is
 * received (simple full-receive convenience path).
 */
export async function receivePurchase(
  organizationId: string,
  purchaseId: string,
  userId: string,
  branchId?: string,
  items?: ReceiptBatchInput[],
) {
  return prisma.$transaction(async tx => {
    const purchase = await tx.purchase.findFirst({
      where: { id: purchaseId, organizationId },
      include: { items: true, branch: true, supplier: true },
    });
    if (!purchase) throw new AppError("Purchase not found.", 404, "NOT_FOUND");
    if (purchase.status === "RECEIVED" || purchase.status === "COMPLETED") {
      throw new AppError("Purchase already received.", 400, "ALREADY_RECEIVED");
    }

    // Validate branch: if explicitly provided, it must belong to the organization
    // and match the purchase's branch. If not provided, use purchase's branch.
    let effectiveBranchId = purchase.branchId;
    if (branchId) {
      const targetBranch = await tx.branch.findFirst({
        where: { id: branchId, organizationId, isActive: true },
      });
      if (!targetBranch) {
        throw new AppError("Branch not found in this workspace.", 404, "NOT_FOUND");
      }
      if (branchId !== purchase.branchId) {
        throw new AppError("Receipt branch must match the purchase order's branch.", 400, "VALIDATION");
      }
      effectiveBranchId = branchId;
    }

    const pendingItems = purchase.items.filter(
      i => i.receivedQty < i.quantity,
    );
    if (pendingItems.length === 0) {
      throw new AppError("Purchase has no pending items to receive.", 400, "VALIDATION");
    }

    // Build rows: either explicit multi-batch rows or one row per remaining item.
    const rows: {
      purchaseItemId: string;
      productId: string;
      quantity: number;
      freeQuantity: number;
      batchNumber: string;
      expiryDate: Date;
      purchasePrice: number;
      mrp: number;
      sellingPrice: number;
    }[] = [];

    if (!items || items.length === 0) {
      for (const item of pendingItems) {
        const remaining = item.quantity - item.receivedQty;
        rows.push({
          purchaseItemId: item.id,
          productId: item.productId,
          quantity: remaining,
          freeQuantity: 0,
          batchNumber: item.batchNumber ?? `B-${item.id.slice(0, 8)}`,
          expiryDate: item.expiryDate ?? new Date(),
          purchasePrice: Number(item.purchasePrice),
          mrp: Number(item.mrp),
          sellingPrice: Number(item.sellingPrice) || Number(item.mrp) * 0.8,
        });
      }
    } else {
      for (const r of items) {
        const item = purchase.items.find(pi => pi.id === r.purchaseItemId);
        if (!item) {
          throw new AppError("Receipt references a PO item that does not exist.", 400, "VALIDATION");
        }
        if (item.productId !== r.productId) {
          throw new AppError("Receipt product does not match the PO item.", 400, "VALIDATION");
        }
        if (!Number.isInteger(r.quantity) || r.quantity <= 0) {
          throw new AppError("Received quantity must be a positive integer.", 400, "VALIDATION");
        }
        if (!r.batchNumber || !r.batchNumber.trim()) {
          throw new AppError("A batch number is required when receiving.", 400, "VALIDATION");
        }
        const expiry = new Date(r.expiryDate);
        if (Number.isNaN(expiry.getTime())) {
          throw new AppError("A valid expiry date is required when receiving.", 400, "VALIDATION");
        }
        rows.push({
          purchaseItemId: item.id,
          productId: item.productId,
          quantity: r.quantity,
          freeQuantity: r.freeQuantity ?? 0,
          batchNumber: r.batchNumber.trim(),
          expiryDate: expiry,
          purchasePrice: r.purchasePrice ?? Number(item.purchasePrice),
          mrp: r.mrp ?? Number(item.mrp),
          sellingPrice:
            r.sellingPrice ??
            (Number(item.sellingPrice) || Number(item.mrp) * 0.8),
        });
      }
    }

    // Validate per-item received totals never exceed ordered commercial qty.
    for (const item of purchase.items) {
      const sumCommercial = rows
        .filter(r => r.purchaseItemId === item.id)
        .reduce((acc, r) => acc + r.quantity, 0);
      if (item.receivedQty + sumCommercial > item.quantity) {
        const over = item.receivedQty + sumCommercial - item.quantity;
        throw new AppError(
          `Cannot receive ${sumCommercial} more for an item ordered ${item.quantity} (already received ${item.receivedQty}). Over by ${over} units.`,
          400,
          "OVERRECEIVE",
        );
      }
    }

    const receiptNumber = await nextReceiptNumber(tx, organizationId);
    const receipt = await tx.purchaseReceipt.create({
      data: {
        organizationId,
        purchaseId,
        branchId: effectiveBranchId,
        supplierId: purchase.supplierId,
        receiptNumber,
        receivedById: userId,
      },
      include: { items: true },
    });

    const itemReceivedMap = new Map<string, number>(
      purchase.items.map(i => [i.id, i.receivedQty]),
    );

    for (const r of rows) {
      const totalQty = r.quantity + r.freeQuantity;
      const batch = await upsertBatch(tx, {
        organizationId,
        branchId: effectiveBranchId,
        productId: r.productId,
        batchNumber: r.batchNumber,
        expiryDate: r.expiryDate,
        purchasePrice: r.purchasePrice,
        mrp: r.mrp,
        sellingPrice: r.sellingPrice,
        supplierId: purchase.supplierId,
      });

      // Atomic batch quantity increment with concurrency guard
      const updatedBatch = await tx.batch.update({
        where: { id: batch.batch.id },
        data: { quantity: { increment: totalQty } },
      });
      const beforeQty = updatedBatch.quantity - totalQty;
      const afterQty = updatedBatch.quantity;
      await tx.inventoryMovement.create({
        data: {
          organizationId,
          branchId: effectiveBranchId,
          productId: r.productId,
          batchId: batch.batch.id,
          type: "PURCHASE",
          quantity: totalQty,
          beforeQty,
          afterQty,
          unitCost: r.purchasePrice,
          referenceType: "PURCHASE",
          referenceId: purchaseId,
          userId,
        },
      });
      await tx.purchaseReceiptItem.create({
        data: {
          receiptId: receipt.id,
          purchaseItemId: r.purchaseItemId,
          productId: r.productId,
          quantity: r.quantity,
          freeQuantity: r.freeQuantity,
          batchNumber: r.batchNumber,
          expiryDate: r.expiryDate,
          purchasePrice: r.purchasePrice,
          mrp: r.mrp,
          sellingPrice: r.sellingPrice,
        },
      });

      itemReceivedMap.set(
        r.purchaseItemId,
        (itemReceivedMap.get(r.purchaseItemId) ?? 0) + r.quantity,
      );

      // Vendor medicine price snapshot (historical truth stays on the batch).
      await tx.vendorMedicine.upsert({
        where: {
          organizationId_vendorId_productId: {
            organizationId,
            vendorId: purchase.supplierId,
            productId: r.productId,
          },
        },
        create: {
          organizationId,
          vendorId: purchase.supplierId,
          productId: r.productId,
          lastPurchasePrice: r.purchasePrice,
          lastPurchaseDate: new Date(),
        },
        update: {
          lastPurchasePrice: r.purchasePrice,
          lastPurchaseDate: new Date(),
        },
      });
    }

    for (const [purchaseItemId, receivedQty] of itemReceivedMap) {
      await tx.purchaseItem.update({
        where: { id: purchaseItemId },
        data: { receivedQty },
      });
    }

    const receivedSum = await tx.purchaseItem.aggregate({
      where: { purchaseId: purchase.id },
      _sum: { receivedQty: true, quantity: true },
    });
    const status =
      Number(receivedSum?._sum.receivedQty ?? 0) >= Number(receivedSum?._sum.quantity ?? 0)
        ? "RECEIVED"
        : "PARTIALLY_RECEIVED";

    await tx.purchase.update({
      where: { id: purchase.id },
      data: { status, receivedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        organizationId,
        branchId: effectiveBranchId,
        userId,
        action: "PURCHASE_RECEIVED",
        entityType: "Purchase",
        entityId: purchase.id,
        metadata: { poNumber: purchase.poNumber, status, receiptNumber },
      },
    });

    // Auto-post the GRN: inventory + GST input debit, supplier payable credit.
    let receivedValue = 0;
    let receivedTax = 0;
    for (const r of rows) {
      const poItem = purchase.items.find(i => i.id === r.purchaseItemId);
      const gstRate = Number(poItem?.gstRate ?? 0);
      const base = r.purchasePrice * (r.quantity + r.freeQuantity);
      receivedValue += base;
      receivedTax += (base * gstRate) / 100;
    }
    await postPurchaseEntry(
      tx,
      organizationId,
      userId,
      new Date(),
      purchase.poNumber,
      receiptNumber,
      receivedValue,
      receivedTax,
    );

    return { purchase: await tx.purchase.findUnique({
      where: { id: purchase.id },
      include: { items: true, branch: true, supplier: true },
    }), receipt, status };
  });
}

/**
 * Return stock to a vendor for a received purchase. Decreases the target
 * batch (concurrency-safe), records a PURCHASE_RETURN movement and an audit
 * event. The original purchase and receipt history remain untouched.
 */
export async function createReturn(
  organizationId: string,
  purchaseId: string,
  userId: string,
  items: ReturnItemInput[],
) {
  if (!items.length) throw new AppError("Return must have at least one item.", 400, "VALIDATION");

  return prisma.$transaction(async tx => {
    const purchase = await tx.purchase.findFirst({
      where: { id: purchaseId, organizationId },
    });
    if (!purchase) throw new AppError("Purchase not found.", 404, "NOT_FOUND");
    if (!["RECEIVED", "PARTIALLY_RECEIVED", "COMPLETED"].includes(purchase.status)) {
      throw new AppError("Only received purchases can be returned.", 400, "VALIDATION");
    }

    const results: { batchId: string; batchNumber: string; returned: number; remaining: number }[] = [];

    for (const it of items) {
      if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
        throw new AppError("Return quantity must be a positive integer.", 400, "VALIDATION");
      }
      const batch = await tx.batch.findFirst({
        where: { id: it.batchId, organizationId, branchId: purchase.branchId },
      });
      if (!batch) throw new AppError("Batch not found.", 404, "NOT_FOUND");
      if (batch.quantity < it.quantity) {
        throw new AppError(
          `Only ${batch.quantity} units from batch ${batch.batchNumber} are currently available for return.`,
          400,
          "INSUFFICIENT_STOCK",
        );
      }
      const { beforeQty, afterQty } = await removeStock(tx, {
        organizationId,
        branchId: purchase.branchId,
        productId: batch.productId,
        batchId: batch.id,
        delta: -it.quantity,
        type: "PURCHASE_RETURN",
        referenceType: "PURCHASE",
        referenceId: purchaseId,
        note: it.note || it.reason,
        userId,
        unitCost: Number(batch.purchasePrice),
      });
      results.push({
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        returned: it.quantity,
        remaining: afterQty,
      });
      void beforeQty;
    }

    await tx.auditLog.create({
      data: {
        organizationId,
        branchId: purchase.branchId,
        userId,
        action: "PURCHASE_RETURNED",
        entityType: "Purchase",
        entityId: purchase.id,
        metadata: { poNumber: purchase.poNumber, items: results },
      },
    });

    return { applied: true, results };
  });
}

export async function listReturns(params: {
  organizationId: string;
  branchId?: string;
  page: number;
  pageSize: number;
}) {
  const where = {
    organizationId: params.organizationId,
    type: "PURCHASE_RETURN" as const,
    ...(params.branchId ? { branchId: params.branchId } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.inventoryMovement.findMany({
      where,
      include: {
        product: true,
        batch: true,
        branch: true,
        user: { select: { fullName: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.inventoryMovement.count({ where }),
  ]);
  return { items, total };
}

export async function listPurchases(params: {
  organizationId: string;
  branchId?: string;
  supplierId?: string;
  status?: string;
  search?: string;
  page: number;
  pageSize: number;
}) {
  const { organizationId } = params;
  const where = {
    organizationId,
    ...(params.branchId ? { branchId: params.branchId } : {}),
    ...(params.supplierId ? { supplierId: params.supplierId } : {}),
    ...(params.status ? { status: params.status as never } : {}),
    ...(params.search
      ? {
          OR: [
            { poNumber: { contains: params.search, mode: "insensitive" as const } },
            {
              supplierInvoiceNumber: {
                contains: params.search,
                mode: "insensitive" as const,
              },
            },
            { supplier: { name: { contains: params.search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.purchase.findMany({
      where,
      include: { supplier: true, branch: true },
      orderBy: { createdAt: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.purchase.count({ where }),
  ]);
  return { items, total };
}

export async function getPurchase(organizationId: string, id: string) {
  const purchase = await prisma.purchase.findFirst({
    where: { id, organizationId },
    include: {
      supplier: true,
      branch: true,
      items: { include: { product: true, receiptItems: true } },
      receipts: {
        include: {
          receivedBy: { select: { fullName: true } },
          items: { include: { product: true } },
        },
        orderBy: { receivedAt: "desc" },
      },
      createdBy: { select: { fullName: true } },
    },
  });
  if (!purchase) throw new AppError("Purchase not found.", 404, "NOT_FOUND");
  return purchase;
}

async function upsertBatch(
  tx: TxClient,
  data: {
    organizationId: string;
    branchId: string;
    productId: string;
    batchNumber: string;
    expiryDate: Date;
    purchasePrice: number;
    mrp: number;
    sellingPrice: number;
    supplierId: string;
  },
) {
  // Try to find existing batch first
  const existing = await tx.batch.findFirst({
    where: {
      organizationId: data.organizationId,
      branchId: data.branchId,
      productId: data.productId,
      batchNumber: data.batchNumber,
    },
  });
  if (existing) {
    return { batch: existing, created: false };
  }
  try {
    const batch = await tx.batch.create({ data });
    return { batch, created: true };
  } catch (e: any) {
    // Handle race condition: another request created the same batch
    if (e.code === "P2002") {
      const existing = await tx.batch.findFirstOrThrow({
        where: {
          organizationId: data.organizationId,
          branchId: data.branchId,
          productId: data.productId,
          batchNumber: data.batchNumber,
        },
      });
      return { batch: existing, created: false };
    }
    throw e;
  }
}