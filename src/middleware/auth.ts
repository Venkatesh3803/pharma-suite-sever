import type { NextFunction, Request, Response } from "express";
import { AppError } from "../domain/errors";
import { permissionsForRole, type Permission } from "../domain/permissions";
import { prisma } from "../lib/prisma";
import { signAccessToken, verifyToken } from "../utils/jwt";
import type { TokenPayload } from "../utils/jwt";

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
      authPermissions?: Permission[];
      organizationId?: string;
      branchId?: string;
    }
  }
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) {
    next(new AppError("Authentication required.", 401, "UNAUTHORIZED"));
    return;
  }

  try {
    const payload = verifyToken<TokenPayload>(token);
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
    });
    if (!user || user.status !== "ACTIVE") {
      next(new AppError("Account is not active.", 401, "UNAUTHORIZED"));
      return;
    }
    if (user.refreshTokenHash === null && payload.userId === user.id) {
      // noop: access tokens remain valid while refresh token exists
    }

    const exactPermissions = permissionsForRole(user.role);
    const claimOverrides = (user.permissionClaims ?? []) as Permission[];
    req.authPermissions = [...exactPermissions, ...claimOverrides];
    req.user = {
      userId: user.id,
      organizationId: user.organizationId,
      branchId: user.branchId ?? undefined,
      role: user.role,
    };
    req.organizationId = user.organizationId;
    req.branchId = user.branchId ?? undefined;
    next();
  } catch {
    next(new AppError("Session expired or invalid.", 401, "UNAUTHORIZED"));
  }
}

export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const granted = req.authPermissions ?? [];
    const ok = permissions.some(p => granted.includes(p));
    if (!ok) {
      next(new AppError("You don't have permission to do this.", 403, "FORBIDDEN"));
      return;
    }
    next();
  };
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      next(new AppError("You don't have permission to do this.", 403, "FORBIDDEN"));
      return;
    }
    next();
  };
}

export { signAccessToken };