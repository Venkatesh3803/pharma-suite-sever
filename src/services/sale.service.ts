import { prisma } from "../lib/prisma";
import { AppError } from "../domain/errors";
import { addStock, removeStock } from "./stock.service";
import { parseUnitConfig } from "./units.service";
import { postSaleEntry } from "./finance.service";

export interface SaleItemInput {
  productId: string;
  quantity: number;
}

export interface PosLookupRow {
  productId: string;
  brand: string;
  genericName: string | null;
  strength: string | null;
  dosageForm: string | null;
  packSize: string | null;
  barcode: string | null;
  gstRate: number;
  saleUnit: string;
  saleUnitFactor: number;
  baseUnit: string;
  sellableBase: number;
  stockSaleUnits: number;
  stockDisplay: string;
  pricePerSaleUnit: number;
  unitPriceBase: number;
  lowStock: boolean;
}

export async function posLookup(params: {
  organizationId: string;
  branchId: string;
  search: string;
  limit: number;
}): Promise<PosLookupRow[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { organizationId, branchId, limit } = params;
  const q = params.search.trim();
  if (!q) return [];

  const products = await prisma.product.findMany({
    where: {
      organizationId,
      deletedAt: null,
      OR: [
        { brand: { contains: q, mode: "insensitive" as const } },
        { genericName: { contains: q, mode: "insensitive" as const } },
        { manufacturer: { contains: q, mode: "insensitive" as const } },
        { barcode: { contains: q, mode: "insensitive" as const } },
        { batches: { some: { branchId, batchNumber: { contains: q, mode: "insensitive" as const } } } },
      ],
    },
    include: {
      batches: {
        where: { branchId, quantity: { gt: 0 }, expiryDate: { gte: today } },
        orderBy: [{ expiryDate: "asc" }, { createdAt: "asc" }],
      },
    },
    orderBy: { brand: "asc" },
    take: limit,
  });

  return products.map(p => {
    const config = parseUnitConfig(p.unitConfig);
    const batches = p.batches;
    const sellableBase = batches.reduce((acc, b) => acc + b.quantity, 0);
    const fefo = batches[0];
    const unitPriceBase = fefo ? Number(fefo.sellingPrice) : 0;
    const pricePerSaleUnit = unitPriceBase * config.saleUnitFactor;
    const stockSaleUnits =
      config.saleUnitFactor > 1 ? Math.floor(sellableBase / config.saleUnitFactor) : sellableBase;
    return {
      productId: p.id,
      brand: p.brand,
      genericName: p.genericName,
      strength: p.strength,
      dosageForm: p.dosageForm,
      packSize: p.packSize,
      barcode: p.barcode,
      gstRate: Number(p.gstRate),
      saleUnit: config.saleUnit,
      saleUnitFactor: config.saleUnitFactor,
      baseUnit: config.baseUnit,
      sellableBase,
      stockSaleUnits,
      stockDisplay: formatStock(config, sellableBase, stockSaleUnits),
      pricePerSaleUnit,
      unitPriceBase,
      lowStock: stockSaleUnits < 5,
    };
  });
}

function formatStock(config: { baseUnit: string; saleUnit: string; saleUnitFactor: number }, base: number, saleUnits: number): string {
  return config.saleUnitFactor > 1 ? `${saleUnits} ${config.saleUnit} (${base} ${config.baseUnit})` : `${base} ${config.baseUnit}`;
}

export interface CreateSaleInput {
  branchId: string;
  customerId?: string;
  paymentMode?: "CASH" | "UPI" | "CARD" | "BANK_TRANSFER" | "CREDIT";
  discount?: number;
  items: SaleItemInput[];
  clientSaleId?: string;
}

export interface ReturnItemInput {
  saleItemId: string;
  quantity: number;
  reason?: string;
}

/**
 * Atomically generates the next invoice number using an upsert counter.
 * Guarantees uniqueness even under concurrent requests.
 */
async function nextInvoiceNo(tx: any, organizationId: string) {
  const year = new Date().getFullYear();
  const counter = await tx.invoiceCounter.upsert({
    where: { organizationId_year: { organizationId, year } },
    create: { organizationId, year, sequence: 1 },
    update: { sequence: { increment: 1 } },
  });
  return `INV-${year}-${String(counter.sequence).padStart(4, "0")}`;
}

/**
 * Create a sale: pick batches via FEFO per product, deduct stock, create
 * Sale/SaleItems + InventoryMovement + AuditLog in one transaction.
 */
export async function createSale(
  organizationId: string,
  userId: string,
  input: CreateSaleInput,
) {
  if (!input.items.length) {
    throw new AppError("Sale must have at least one item.", 400, "VALIDATION");
  }

  // Idempotent replay guard: an offline client retries with the same
  // clientSaleId — if the previous attempt already landed, return it.
  if (input.clientSaleId) {
    const existing = await prisma.sale.findUnique({
      where: { clientSaleId: input.clientSaleId },
    });
    if (existing) {
      return {
        sale: existing,
        totals: {
          subtotal: Number(existing.subtotal),
          discount: Number(existing.discount),
          tax: Number(existing.tax),
          total: Number(existing.total),
        },
      };
    }
  }

  if (input.clientSaleId) {
    const existing = await prisma.sale.findUnique({
      where: { clientSaleId: input.clientSaleId },
    });
    if (existing) {
      return {
        sale: existing,
        totals: {
          subtotal: Number(existing.subtotal),
          discount: Number(existing.discount),
          tax: Number(existing.tax),
          total: Number(existing.total),
        },
      };
    }
  }

  // Validate branch belongs to organization
  const branch = await prisma.branch.findFirst({
    where: { id: input.branchId, organizationId, isActive: true },
  });
  if (!branch) {
    throw new AppError("Branch not found in this workspace.", 404, "NOT_FOUND");
  }

  // Validate customer belongs to organization (if provided)
  if (input.customerId) {
    const customer = await prisma.customer.findFirst({
      where: { id: input.customerId, organizationId },
    });
    if (!customer) {
      throw new AppError("Customer not found in this workspace.", 404, "NOT_FOUND");
    }
  }

  return prisma.$transaction(async tx => {
    const invoiceNo = await nextInvoiceNo(tx, organizationId);
    const itemsWithFefo: {
      productId: string;
      quantity: number;
      allocations: {
        batchId: string;
        qty: number;
        unitPrice: number;
        unitCost: number;
      }[];
    }[] = [];

    let accSubtotal = 0;
    let accTax = 0;
    let accCogs = 0;

    for (const item of input.items) {
      const product = await tx.product.findFirst({
        where: { id: item.productId, organizationId },
      });
      if (!product) {
        throw new AppError("Product not found in this workspace.", 404, "NOT_FOUND");
      }
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const batches = await tx.batch.findMany({
        where: {
          organizationId,
          branchId: input.branchId,
          productId: item.productId,
          quantity: { gt: 0 },
          expiryDate: { gte: today },
        },
        orderBy: [{ expiryDate: "asc" }, { createdAt: "asc" }],
      });
      let remaining = item.quantity;
      const allocations: {
        batchId: string;
        qty: number;
        unitPrice: number;
        unitCost: number;
      }[] = [];
      const gstRate = Number(product.gstRate);
      for (const batch of batches) {
        if (remaining <= 0) break;
        const take = Math.min(batch.quantity, remaining);
        const unitPrice = Number(batch.sellingPrice);
        const unitCost = Number(batch.purchasePrice);
        accSubtotal += unitPrice * take;
        accTax += (unitPrice * take * gstRate) / 100;
        allocations.push({ batchId: batch.id, qty: take, unitPrice, unitCost });
        remaining -= take;
      }
      if (remaining > 0) {
        throw new AppError(
          `Insufficient stock for ${product.brand}. Short by ${remaining} units.`,
          400,
          "INSUFFICIENT_STOCK",
        );
      }
      itemsWithFefo.push({
        productId: item.productId,
        quantity: item.quantity,
        allocations,
      });
    }

    // Fetch all product GST rates upfront to avoid N+1 queries
    const productIds = itemsWithFefo.map(item => item.productId);
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, gstRate: true },
    });
    const gstRateMap = new Map(products.map(p => [p.id, Number(p.gstRate)]));

    const discountPct = Math.max(0, Math.min(100, Number(input.discount ?? 0)));
    const subtotal = accSubtotal;
    const discountAmount = (subtotal * discountPct) / 100;
    // Tax is calculated on the DISCOUNTED subtotal (correct GST treatment)
    const taxableAmount = subtotal - discountAmount;
    const tax = (taxableAmount * accTax) / accSubtotal; // proportionally apply tax
    const total = taxableAmount + tax;

    const sale = await tx.sale.create({
      data: {
        invoiceNo,
        clientSaleId: input.clientSaleId,
        organizationId,
        branchId: input.branchId,
        customerId: input.customerId,
        paymentMode: input.paymentMode ?? "CASH",
        status: input.paymentMode === "CREDIT" ? "DUE" : "PAID",
        subtotal,
        discount: discountAmount,
        tax,
        total,
        createdById: userId,
      },
    });

    for (const item of itemsWithFefo) {
      const productGst = gstRateMap.get(item.productId) ?? 0;
      for (const alloc of item.allocations) {
        // Atomic batch update with concurrency guard: only decrement if sufficient stock remains
        const updatedBatch = await tx.batch.updateMany({
          where: { id: alloc.batchId, quantity: { gte: alloc.qty } },
          data: { quantity: { decrement: alloc.qty } },
        });
        if (updatedBatch.count === 0) {
          throw new AppError(
            `Insufficient stock in batch (concurrent modification).`,
            409,
            "INSUFFICIENT_STOCK",
          );
        }
        // Fetch the updated batch for audit trail
        const updated = await tx.batch.findUniqueOrThrow({ where: { id: alloc.batchId } });
        const beforeQty = updated.quantity + alloc.qty;
        const afterQty = updated.quantity;

        await tx.inventoryMovement.create({
          data: {
            organizationId,
            branchId: input.branchId,
            productId: item.productId,
            batchId: alloc.batchId,
            type: "SALE",
            quantity: -alloc.qty,
            beforeQty,
            afterQty,
            unitCost: alloc.unitCost,
            referenceType: "SALE",
            referenceId: sale.id,
            userId,
          },
        });
        await tx.saleItem.create({
          data: {
            saleId: sale.id,
            productId: item.productId,
            batchId: alloc.batchId,
            quantity: alloc.qty,
            unitPrice: alloc.unitPrice,
            unitCost: alloc.unitCost,
            gstRate: productGst,
            total: alloc.unitPrice * alloc.qty,
          },
        });
        accCogs += alloc.unitCost * alloc.qty;
      }
    }

    await postSaleEntry(
      tx,
      organizationId,
      userId,
      new Date(),
      sale.invoiceNo,
      {
        total: Number(sale.total),
        tax: Number(sale.tax),
        paymentMode: sale.paymentMode,
      },
      accCogs,
    );

    await tx.auditLog.create({
      data: {
        organizationId,
        branchId: input.branchId,
        userId,
        action: "SALE_CREATED",
        entityType: "Sale",
        entityId: sale.id,
        metadata: { invoiceNo: sale.invoiceNo },
      },
    });

    return {
      sale,
      totals: { subtotal, discount: discountAmount, tax, total },
    };
  });
}

export async function listSales(params: {
  organizationId: string;
  branchId?: string;
  customerId?: string;
  status?: string;
  search?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}) {
  const { organizationId } = params;
  const where = {
    organizationId,
    ...(params.branchId ? { branchId: params.branchId } : {}),
    ...(params.customerId ? { customerId: params.customerId } : {}),
    ...(params.status ? { status: params.status as never } : {}),
    ...(params.from || params.to
      ? {
          createdAt: {
            ...(params.from ? { gte: new Date(params.from) } : {}),
            ...(params.to ? { lt: new Date(new Date(params.to).getTime() + 86400000) } : {}),
          },
        }
      : {}),
    ...(params.search
      ? {
          OR: [
            { invoiceNo: { contains: params.search, mode: "insensitive" as const } },
            { customer: { name: { contains: params.search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.sale.findMany({
      where,
      include: {
        customer: true,
        branch: true,
        createdBy: { select: { fullName: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.sale.count({ where }),
  ]);
  return { items, total };
}

export async function getSale(organizationId: string, id: string) {
  const sale = await prisma.sale.findFirst({
    where: { id, organizationId },
    include: {
      customer: true,
      branch: true,
      createdBy: { select: { fullName: true } },
      items: { include: { product: true, batch: true } },
    },
  });
  if (!sale) throw new AppError("Sale not found.", 404, "NOT_FOUND");
  return sale;
}

/**
 * Return stock from a sale. Adds stock back to the originating batches
 * (concurrency-safe), records SALE_RETURN movements and an audit event, and
 * marks the sale PARTIAL_RETURN / RETURNED. Original sale record is untouched.
 */
export async function returnSale(
  organizationId: string,
  saleId: string,
  userId: string,
  items: ReturnItemInput[],
) {
  if (!items.length) throw new AppError("Return must have at least one item.", 400, "VALIDATION");

  return prisma.$transaction(async tx => {
    const sale = await tx.sale.findFirst({
      where: { id: saleId, organizationId },
      include: { items: true },
    });
    if (!sale) throw new AppError("Sale not found.", 404, "NOT_FOUND");
    if (!["PAID", "DUE", "PARTIAL_RETURN"].includes(sale.status)) {
      throw new AppError("This sale cannot be returned.", 400, "VALIDATION");
    }

    const results: {
      saleItemId: string;
      productId: string;
      batchId: string | null;
      returned: number;
      refund: number;
    }[] = [];

    for (const it of items) {
      if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
        throw new AppError("Return quantity must be a positive integer.", 400, "VALIDATION");
      }
      const saleItem = sale.items.find(si => si.id === it.saleItemId);
      if (!saleItem) {
        throw new AppError("Sale item not found on this sale.", 404, "NOT_FOUND");
      }
      const remaining = saleItem.quantity - saleItem.returnedQty;
      if (it.quantity > remaining) {
        throw new AppError(
          `Only ${remaining} units of this item are still returnable.`,
          400,
          "OVER_RETURN",
        );
      }
      if (!saleItem.batchId) {
        throw new AppError("Cannot return an item without a linked batch.", 400, "VALIDATION");
      }
      const unitPrice = Number(saleItem.unitPrice);

      const result = await addStock(tx, {
        organizationId,
        branchId: sale.branchId,
        productId: saleItem.productId,
        batchId: saleItem.batchId,
        delta: it.quantity,
        type: "SALE_RETURN",
        referenceType: "SALE",
        referenceId: sale.id,
        note: it.reason,
        userId,
        unitCost: Number(saleItem.unitCost ?? 0),
      });
      void result;

      await tx.saleItem.update({
        where: { id: saleItem.id },
        data: { returnedQty: saleItem.returnedQty + it.quantity },
      });

      results.push({
        saleItemId: saleItem.id,
        productId: saleItem.productId,
        batchId: saleItem.batchId,
        returned: it.quantity,
        refund: unitPrice * it.quantity,
      });
    }

    // Calculate total returned across all items (previously returned + newly returned)
    const soldSum = sale.items.reduce((acc, i) => acc + i.quantity, 0);
    const previouslyReturnedSum = sale.items.reduce((acc, i) => acc + i.returnedQty, 0);
    const newlyReturnedSum = results.reduce((acc, r) => acc + r.returned, 0);
    const returnedSum = previouslyReturnedSum + newlyReturnedSum;
    const status =
      returnedSum >= soldSum
        ? "RETURNED"
        : returnedSum > 0
          ? "PARTIAL_RETURN"
          : sale.status;

    await tx.sale.update({ where: { id: sale.id }, data: { status } });

    const totalRefund = results.reduce((acc, r) => acc + r.refund, 0);

    await tx.auditLog.create({
      data: {
        organizationId,
        branchId: sale.branchId,
        userId,
        action: "SALE_RETURNED",
        entityType: "Sale",
        entityId: sale.id,
        metadata: { invoiceNo: sale.invoiceNo, refund: totalRefund, status },
      },
    });

    return { applied: true, results, totalRefund, status };
  });
}

export async function listSaleReturns(params: {
  organizationId: string;
  branchId?: string;
  page: number;
  pageSize: number;
}) {
  const where = {
    organizationId: params.organizationId,
    type: "SALE_RETURN" as const,
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

export async function salesSummary(params: {
  organizationId: string;
  branchId?: string;
}) {
  const { organizationId, branchId } = params;
  const whereBase = { organizationId, ...(branchId ? { branchId } : {}) };
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const monthStart = new Date(todayStart);
  monthStart.setDate(1);

  const [today, yesterday, month, paymentAgg, returns, recent, topAgg] = await Promise.all([
    prisma.sale.aggregate({
      where: { ...whereBase, createdAt: { gte: todayStart } },
      _sum: { total: true },
      _count: { _all: true },
    }),
    prisma.sale.aggregate({
      where: { ...whereBase, createdAt: { gte: yesterdayStart, lt: todayStart } },
      _sum: { total: true },
      _count: { _all: true },
    }),
    prisma.sale.aggregate({
      where: { ...whereBase, createdAt: { gte: monthStart } },
      _sum: { total: true },
      _count: { _all: true },
    }),
    prisma.sale.groupBy({
      by: ["paymentMode"],
      where: { ...whereBase, createdAt: { gte: monthStart } },
      _sum: { total: true },
      _count: { _all: true },
    }),
    prisma.inventoryMovement.findMany({
      where: { ...whereBase, type: "SALE_RETURN" },
      orderBy: { createdAt: "desc" },
      include: { product: { select: { brand: true } } },
      take: 20,
    }),
    prisma.sale.findMany({
      where: whereBase,
      include: {
        customer: { select: { name: true } },
        branch: { select: { name: true } },
        createdBy: { select: { fullName: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.saleItem.groupBy({
      by: ["productId"],
      where: { sale: { ...whereBase, createdAt: { gte: monthStart } } },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 6,
    }),
  ]);

  const productIds = topAgg.map(t => t.productId);
  const products = productIds.length
    ? await prisma.product.findMany({ where: { id: { in: productIds } } })
    : [];
  const productMap = new Map(products.map(p => [p.id, p]));

  const todayTotal = Number(today._sum.total ?? 0);
  const yesterdayTotal = Number(yesterday._sum.total ?? 0);
  const monthTotal = Number(month._sum.total ?? 0);

  return {
    todaySales: todayTotal,
    todayInvoices: today._count._all,
    todayChangePct:
      yesterdayTotal > 0 ? ((todayTotal - yesterdayTotal) / yesterdayTotal) * 100 : null,
    monthSales: monthTotal,
    monthInvoices: month._count._all,
    avgTicket: month._count._all > 0 ? monthTotal / month._count._all : 0,
    paymentMix: paymentAgg.map(p => ({
      mode: p.paymentMode,
      total: Number(p._sum.total ?? 0),
      count: p._count._all,
    })),
    returns: {
      total: returns.length,
      value: returns.reduce((acc, r) => acc + Number(r.quantity) * Number(r.unitCost ?? 0), 0),
      recent: returns.map(r => ({
        id: r.id,
        brand: r.product?.brand ?? "Product",
        quantity: r.quantity,
        note: r.note,
        createdAt: r.createdAt,
      })),
    },
    recentSales: recent.map(s => ({
      id: s.id,
      invoiceNo: s.invoiceNo,
      customerName: s.customer?.name ?? "Walk-in Customer",
      branchName: s.branch?.name ?? null,
      total: Number(s.total),
      status: s.status,
      paymentMode: s.paymentMode,
      actor: s.createdBy?.fullName ?? null,
      createdAt: s.createdAt,
    })),
    topProducts: topAgg.map(t => ({
      productId: t.productId,
      quantity: t._sum.quantity ?? 0,
      brand: productMap.get(t.productId)?.brand ?? "Product",
      genericName: productMap.get(t.productId)?.genericName ?? null,
    })),
  };
}