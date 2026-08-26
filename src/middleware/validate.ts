import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";
import { formatZodError } from "../domain/errors";

export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        success: false,
        data: null,
        message: formatZodError(result.error),
        code: "VALIDATION_ERROR",
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json({
        success: false,
        data: null,
        message: formatZodError(result.error),
        code: "VALIDATION_ERROR",
      });
      return;
    }
    (req as Request & { cleanQuery: unknown }).cleanQuery = result.data;
    next();
  };
}