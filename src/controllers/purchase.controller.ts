import type { NextFunction, Request, Response } from "express";
import {
  createPurchase,
  updatePurchase,
  listPurchases,
  getPurchase,
  updatePurchaseStatus,
  receivePurchase,
  createReturn,
  listReturns,
} from "../services/purchase.service";
import {
  purchaseSummary,
  vendorPerformance,
  vendorPriceHistory,
} from "../services/purchase-analytics.service";
import { ok } from "../utils/api";
import { generatePurchasePdf } from "../services/purchase-pdf.service";

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await createPurchase(req.user!.organizationId, req.user!.userId, req.body);
    return ok(res, data, "Purchase created.", 201);
  } catch (e) {
    next(e);
  }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await updatePurchase(
      req.user!.organizationId,
      req.user!.userId,
      req.params.id,
      req.body,
    );
    return ok(res, data, "Purchase order updated.");
  } catch (e) {
    next(e);
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listPurchases({
      organizationId: req.user!.organizationId,
      branchId: (req.query.branchId as string) || req.user?.branchId,
      supplierId: req.query.supplierId as string,
      status: req.query.status as string,
      search: req.query.search as string,
      page: Number(req.query.page ?? 1),
      pageSize: Number(req.query.pageSize ?? 20),
    });
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function getOne(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getPurchase(req.user!.organizationId, req.params.id);
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function pdf(req: Request, res: Response, next: NextFunction) {
  try {
    const mode: "inline" | "attachment" = req.query.mode === "inline" ? "inline" : "attachment";
    const { buffer, filename } = await generatePurchasePdf(
      req.user!.organizationId,
      req.params.id,
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `${mode}; filename="${filename}"`,
    );
    res.setHeader("Content-Length", buffer.length);
    return res.end(buffer);
  } catch (e) {
    next(e);
  }
}

export async function submit(req: Request, res: Response, next: NextFunction) {
  try {
    await updatePurchaseStatus(req.user!.organizationId, req.params.id, "SUBMITTED", req.user!.userId);
    return ok(res, null, "Purchase submitted.");
  } catch (e) {
    next(e);
  }
}

export async function approve(req: Request, res: Response, next: NextFunction) {
  try {
    await updatePurchaseStatus(req.user!.organizationId, req.params.id, "APPROVED", req.user!.userId);
    return ok(res, null, "Purchase approved.");
  } catch (e) {
    next(e);
  }
}

export async function cancel(req: Request, res: Response, next: NextFunction) {
  try {
    await updatePurchaseStatus(req.user!.organizationId, req.params.id, "CANCELLED", req.user!.userId);
    return ok(res, null, "Purchase cancelled.");
  } catch (e) {
    next(e);
  }
}

export async function receive(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await receivePurchase(
      req.user!.organizationId,
      req.params.id,
      req.user!.userId,
      req.body?.branchId || req.user?.branchId,
      req.body?.items,
    );
    return ok(res, data, "Purchase received and inventory updated.", 200);
  } catch (e) {
    next(e);
  }
}

export async function returnGoods(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await createReturn(
      req.user!.organizationId,
      req.params.id,
      req.user!.userId,
      req.body.items,
    );
    return ok(res, data, "Purchase return recorded and stock updated.", 201);
  } catch (e) {
    next(e);
  }
}

export async function returns(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listReturns({
      organizationId: req.user!.organizationId,
      branchId: (req.query.branchId as string) || req.user?.branchId,
      page: Number(req.query.page ?? 1),
      pageSize: Number(req.query.pageSize ?? 20),
    });
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function summary(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await purchaseSummary({
      organizationId: req.user!.organizationId,
      branchId: (req.query.branchId as string) || req.user?.branchId,
    });
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function vendorPerf(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await vendorPerformance(
      req.user!.organizationId,
      req.params.vendorId,
    );
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function priceHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await vendorPriceHistory({
      organizationId: req.user!.organizationId,
      vendorId: req.params.vendorId,
      productId: req.query.productId as string | undefined,
      limit: Number(req.query.limit ?? 50),
    });
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}