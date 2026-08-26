import type { NextFunction, Request, Response } from "express";
import {
  createSale,
  listSales,
  getSale,
  returnSale,
  listSaleReturns,
  salesSummary,
  posLookup as posLookupService,
} from "../services/sale.service";
import { ok } from "../utils/api";

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await createSale(req.user!.organizationId, req.user!.userId, req.body);
    return ok(res, data, "Sale completed.", 201);
  } catch (e) {
    next(e);
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listSales({
      organizationId: req.user!.organizationId,
      branchId: (req.query.branchId as string) || req.user?.branchId,
      customerId: req.query.customerId as string,
      status: req.query.status as string,
      search: req.query.search as string,
      from: req.query.from as string,
      to: req.query.to as string,
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
    const data = await getSale(req.user!.organizationId, req.params.id);
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function returnGoods(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await returnSale(
      req.user!.organizationId,
      req.params.id,
      req.user!.userId,
      req.body.items,
    );
    return ok(res, data, "Sale return recorded and stock restored.", 201);
  } catch (e) {
    next(e);
  }
}

export async function returns(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listSaleReturns({
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
    const data = await salesSummary({
      organizationId: req.user!.organizationId,
      branchId: (req.query.branchId as string) || req.user?.branchId,
    });
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function posLookup(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await posLookupService({
      organizationId: req.user!.organizationId,
      branchId: (req.query.branchId as string) || req.user?.branchId || "",
      search: (req.query.search as string) ?? "",
      limit: Number(req.query.pageSize ?? 25),
    });
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}