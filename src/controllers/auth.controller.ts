import type { NextFunction, Request, Response } from "express";
import { AppError } from "../domain/errors.js";
import {
    loginUser,
    logoutUser,
    refreshCookieName,
    refreshCookieOptions,
    clearRefreshCookieOptions,
    accessCookieName,
    accessCookieOptions,
    clearAccessCookieOptions,
    resetCookieName,
    resetCookieOptions,
    clearResetCookieOptions,
    refreshSession,
    getMe,
    registerUser,
    requestPasswordReset,
    verifyPasswordResetOtp,
    resetPassword as resetPasswordForUser
} from "../services/auth.service.js";
import { ok } from "../utils/api.js";

export async function login(req: Request, res: Response, next: NextFunction) {
    try {
        const { username, password } = req.body as { username: string; password: string };
        const { authUser, accessToken, refreshToken } = await loginUser(username, password);
        res.cookie(accessCookieName(), accessToken, accessCookieOptions());
        res.cookie(refreshCookieName(), refreshToken, refreshCookieOptions());
        return ok(res, { user: authUser }, "Logged in.", 200);
    } catch (e) {
        next(e);
    }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
    try {
        if (req.user?.userId) await logoutUser(req.user.userId);
        res.clearCookie(accessCookieName(), clearAccessCookieOptions());
        res.clearCookie(refreshCookieName(), clearRefreshCookieOptions());
        return ok(res, null, "Logged out.", 200);
    } catch (e) {
        next(e);
    }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
    try {
        const token = req.cookies?.[refreshCookieName()];
        if (!token) throw new AppError("No refresh token provided.", 401, "UNAUTHORIZED");
        const { accessToken, refreshToken } = await refreshSession(token);
        res.cookie(accessCookieName(), accessToken, accessCookieOptions());
        res.cookie(refreshCookieName(), refreshToken, refreshCookieOptions());
        return ok(res, null, "Token refreshed.", 200);
    } catch (e) {
        next(e);
    }
}

export async function me(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user?.userId) throw new AppError("Unauthorized.", 401, "UNAUTHORIZED");
        const user = await getMe(req.user.userId);
        return ok(res, { user }, null, 200);
    } catch (e) {
        next(e);
    }
}

export async function register(req: Request, res: Response, next: NextFunction) {
    try {
        const { authUser, accessToken, refreshToken } = await registerUser(req.body);
        res.cookie(accessCookieName(), accessToken, accessCookieOptions());
        res.cookie(refreshCookieName(), refreshToken, refreshCookieOptions());
        return ok(res, { user: authUser }, "Workspace created.", 201);
    } catch (e) {
        next(e);
    }
}

export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
    try {
        const { email } = req.body as { email: string };
        const result = await requestPasswordReset(email);
        return ok(res, result, "If an account exists for this email, a verification code has been sent.", 200);
    } catch (e) {
        next(e);
    }
}

export async function verifyOtp(req: Request, res: Response, next: NextFunction) {
    try {
        const { email, otp } = req.body as { email: string; otp: string };
        const { resetToken } = await verifyPasswordResetOtp(email, otp);
        // Reset token travels in an HttpOnly cookie, never in JS-visible storage.
        res.cookie(resetCookieName(), resetToken, resetCookieOptions());
        return ok(res, { verified: true }, "Verification code verified.", 200);
    } catch (e) {
        next(e);
    }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
    try {
        const body = req.body as { resetToken?: string; newPassword: string };
        const resetToken = req.cookies?.[resetCookieName()] ?? body.resetToken;
        if (!resetToken) throw new AppError("Reset token invalid or expired.", 400, "INVALID_RESET_TOKEN");
        const result = await resetPasswordForUser(resetToken, body.newPassword);
        res.clearCookie(resetCookieName(), clearResetCookieOptions());
        return ok(res, result, "Password updated. Please sign in again.", 200);
    } catch (e) {
        next(e);
    }
}
