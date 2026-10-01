import type { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { AppError } from "../domain/errors";

function allowedOrigins(): string[] {
    return config.corsOrigin
        .split(",")
        .map(o => o.trim().replace(/\/$/, ""))
        .filter(Boolean);
}

/**
 * Lightweight CSRF guard for cookie-authenticated mutations (e.g. /refresh).
 * SameSite=strict already blocks cross-site sends; this adds defense-in-depth
 * by rejecting cross-origin Origin/Referer headers when present.
 * Requests without Origin/Referer (non-browser clients) are allowed through.
 */
export function verifyCookieRequestOrigin(req: Request, _res: Response, next: NextFunction): void {
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    if (!origin && !referer) {
        next();
        return;
    }
    const allowed = allowedOrigins();
    const check = (value: string): boolean => {
        try {
            const url = new URL(value);
            const normalized = `${url.protocol}//${url.host}`;
            return allowed.includes(normalized) || allowed.includes(value.replace(/\/$/, ""));
        } catch {
            return false;
        }
    };
    if (origin && check(origin)) {
        next();
        return;
    }
    if (!origin && referer && check(referer)) {
        next();
        return;
    }
    next(new AppError("Cross-origin request rejected.", 403, "FORBIDDEN"));
}
