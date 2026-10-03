import type { NextFunction, Request, Response } from "express";
import { AppError } from "../domain/errors.js";
import { permissionsForRole, type Permission } from "../domain/permissions.js";
import { prisma } from "../lib/prisma.js";
import { signAccessToken, verifyAccessToken } from "../utils/jwt.js";
import type { TokenPayload } from "../utils/jwt.js";

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
      authPermissions?: Permission[];
      organizationId?: string;
      branchId?: string;
      authViaCookie?: boolean;
    }
  }
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  // Cookie-only authentication. Bearer tokens no longer accepted.
  const cookieToken = req.cookies?.["pharmasuite_access"] as string | undefined;
  if (!cookieToken) {
    next(new AppError("Authentication required.", 401, "UNAUTHORIZED"));
    return;
  }

  try {
    const payload = verifyAccessToken<TokenPayload>(cookieToken);
    // Selective fetch: secrets (passwordHash, refreshTokenHash) must never
    // sit in memory on every request; only authz-relevant columns load.
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        organizationId: true,
        branchId: true,
        role: true,
        status: true,
        deletedAt: true,
        tokenVersion: true,
        permissionClaims: true,
      },
    });
    if (!user || user.status !== "ACTIVE" || user.deletedAt !== null) {
      next(new AppError("Account is not active.", 401, "UNAUTHORIZED"));
      return;
    }
    if (payload.tv !== user.tokenVersion) {
      next(new AppError("Session expired or invalid.", 401, "UNAUTHORIZED"));
      return;
    }

    const exactPermissions = permissionsForRole(user.role);
    const claimOverrides = (user.permissionClaims ?? []) as Permission[];
    req.authPermissions = [...exactPermissions, ...claimOverrides];
    req.user = {
      userId: user.id,
      organizationId: user.organizationId,
      branchId: user.branchId ?? undefined,
      role: user.role,
      tv: user.tokenVersion,
    };
    req.organizationId = user.organizationId;
    req.branchId = user.branchId ?? undefined;
    req.authViaCookie = true;
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