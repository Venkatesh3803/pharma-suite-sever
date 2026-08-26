import type { NextFunction, Request, Response } from "express";
import { AppError } from "../domain/errors";
import { loginUser, logoutUser, refreshCookieName, refreshCookieOptions, refreshSession, getMe, registerUser, requestPasswordReset, verifyPasswordResetOtp, resetPassword as resetPasswordForUser } from "../services/auth.service";
import { ok } from "../utils/api";

export async function login(req: Request, res: Response, next: NextFunction) {
    try {
        const { username, password } = req.body as { username: string; password: string };
        const { authUser, accessToken, refreshToken } = await loginUser(username, password);
        res.cookie(refreshCookieName(), refreshToken, refreshCookieOptions());
        return ok(res, { user: authUser, accessToken }, "Logged in.", 200);
    } catch (e) {
        next(e);
    }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
    try {
        if (req.user?.userId) await logoutUser(req.user.userId);
        res.clearCookie(refreshCookieName(), { path: "/" });
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
        res.cookie(refreshCookieName(), refreshToken, refreshCookieOptions());
        return ok(res, { accessToken }, "Token refreshed.", 200);
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
        res.cookie(refreshCookieName(), refreshToken, refreshCookieOptions());
        return ok(res, { user: authUser, accessToken }, "Workspace created.", 201);
    } catch (e) {
        next(e);
    }
}

export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
    try {
        const { email } = req.body as { email: string };
        const result = await requestPasswordReset(email);
        return ok(
            res,
            result,
            "If an account exists for this email, a verification code has been sent.",
            200,
        );
    } catch (e) {
        next(e);
    }
}

export async function verifyOtp(req: Request, res: Response, next: NextFunction) {
    try {
        const { email, otp } = req.body as { email: string; otp: string };
        const result = await verifyPasswordResetOtp(email, otp);
        return ok(res, result, "Verification code verified.", 200);
    } catch (e) {
        next(e);
    }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
    try {
        const { resetToken, newPassword } = req.body as { resetToken: string; newPassword: string };
        const result = await resetPasswordForUser(resetToken, newPassword);
        return ok(res, result, "Password updated. Please sign in again.", 200);
    } catch (e) {
        next(e);
    }
}
