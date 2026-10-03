import type { Response, NextFunction, Request } from "express";
import { AppError, isAppError, NotFoundError } from "../domain/errors.js";

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (isAppError(err)) {
    res.status(err.statusCode).json({
      success: false,
      data: null,
      message: err.message,
      code: err.code,
    });
    return;
  }

  // Prisma known errors
  const prismaErr = err as { code?: string; meta?: { target?: string } };
  if (prismaErr?.code === "P2002") {
    res.status(409).json({
      success: false,
      data: null,
      message: "A record with this value already exists.",
      code: "DUPLICATE_RECORD",
    });
    return;
  }
  if (prismaErr?.code === "P2025") {
    res.status(404).json({
      success: false,
      data: null,
      message: "Record not found.",
      code: "NOT_FOUND",
    });
    return;
  }

  if (err instanceof SyntaxError) {
    res.status(400).json({
      success: false,
      data: null,
      message: "Invalid request payload.",
      code: "INVALID_JSON",
    });
    return;
  }

  console.error("Unhandled error:", err);
  res.status(500).json({
    success: false,
    data: null,
    message: "Internal server error.",
    code: "INTERNAL_ERROR",
  });
};

export const notFoundHandler = (req: Request, res: Response): void => {
  const err = new NotFoundError(`Route ${req.method} ${req.path} not found.`);
  res.status(err.statusCode).json({
    success: false,
    data: null,
    message: err.message,
    code: err.code,
  });
};

// Kept AppError import referenced for tree-shaking safety
void AppError;