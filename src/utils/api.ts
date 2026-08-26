import type { NextFunction, Request, Response } from "express";

export function ok(res: Response, data: unknown, message: string | null = null, status = 200) {
  return res.status(status).json({ success: true, data, message });
}

export function fail(res: Response, message: string, status = 400, code?: string) {
  return res.status(status).json({ success: false, data: null, message, code });
}