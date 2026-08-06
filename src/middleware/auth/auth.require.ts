import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken, type TokenPayload } from "../../utils/jwt";
import { AppError } from "../../utils/app-errors";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

/**
 * Protects a route: requires `Authorization: Bearer <accessToken>`.
 * On success, attaches the decoded payload to req.user.
 */
export const requireAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!token) {
    return next(new AppError("Authentication required.", 401));
  }

  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    next(new AppError("Session expired or invalid. Please log in again.", 401));
  }
};

/**
 * Optional role guard, use after requireAuth: requireRole("Owner", "Admin")
 */
export const requireRole =
  (...allowedRoles: string[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return next(new AppError("You don't have permission to do this.", 403));
    }
    next();
  };
