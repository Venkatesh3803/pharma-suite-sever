import type { NextFunction, Request, Response } from "express";
import {
  listUsers,
  createUser,
  updateUser,
} from "../services/user.service";
import { ok } from "../utils/api";

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listUsers(req.user!.organizationId);
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await createUser(
      req.user!.organizationId,
      req.user!.userId,
      req.authPermissions ?? [],
      req.body,
    );
    return ok(res, data, "User created.", 201);
  } catch (e) {
    next(e);
  }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await updateUser(
      req.user!.organizationId,
      req.user!.userId,
      req.authPermissions ?? [],
      req.params.id,
      req.body,
    );
    return ok(res, data, "User updated.");
  } catch (e) {
    next(e);
  }
}
