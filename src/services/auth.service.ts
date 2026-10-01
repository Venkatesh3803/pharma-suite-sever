import bcrypt from "bcryptjs";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { AppError } from "../domain/errors";
import { prisma } from "../lib/prisma";
import { sendOtpEmail } from "../services/email/email.service";
import { signAccessToken, signRefreshToken, verifyRefreshToken, type TokenPayload } from "../utils/jwt";
import { permissionsForRole } from "../domain/permissions";

const REFRESH_COOKIE = "pharmasuite_refresh";
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const ACCESS_COOKIE = "pharmasuite_access";
const ACCESS_MAX_AGE = 60 * 60 * 1000;
const RESET_COOKIE = "pharmasuite_reset";
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_HASH_COST = 10;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const HOURLY_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const HOURLY_LIMIT_MAX = 5;

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export function refreshCookieName(): string {
    return REFRESH_COOKIE;
}

export function refreshCookieOptions() {
    return {
        httpOnly: true,
        sameSite: "strict" as const,
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: REFRESH_MAX_AGE
    };
}

export function clearRefreshCookieOptions() {
    const { maxAge: _ignored, ...rest } = refreshCookieOptions();
    return rest;
}

export function accessCookieName(): string {
    return ACCESS_COOKIE;
}

export function accessCookieOptions() {
    return {
        httpOnly: true,
        sameSite: "strict" as const,
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: ACCESS_MAX_AGE
    };
}

export function clearAccessCookieOptions() {
    const { maxAge: _ignored, ...rest } = accessCookieOptions();
    return rest;
}

export function resetCookieName(): string {
    return RESET_COOKIE;
}

export function resetCookieOptions() {
    return {
        httpOnly: true,
        sameSite: "strict" as const,
        secure: process.env.NODE_ENV === "production",
        path: "/api/auth/reset-password",
        maxAge: RESET_TOKEN_TTL_MS
    };
}

export function clearResetCookieOptions() {
    const { maxAge: _ignored, ...rest } = resetCookieOptions();
    return rest;
}

type AuditAction =
    | "LOGIN"
    | "LOGIN_FAILED"
    | "LOGOUT"
    | "USER_CREATED"
    | "PASSWORD_RESET"
    | "PASSWORD_RESET_REQUESTED"
    | "PASSWORD_RESET_COMPLETED"
    | "TOKEN_REFRESH"
    | "OTP_VERIFIED"
    | "OTP_VERIFY_FAILED";

/**
 * bcrypt silently truncates inputs at 72 bytes; two JWTs for the same user
 * share their first 72 chars (header + userId prefix), so bcrypt(token)
 * matches *any* same-user token. Pre-hash with SHA-256 so every bit counts.
 */
function hashRefreshToken(token: string): Promise<string> {
    return bcrypt.hash(createHash("sha256").update(token, "utf8").digest("hex"), 10);
}

async function refreshTokenMatches(token: string, storedHash: string): Promise<boolean> {
    const prehashed = createHash("sha256").update(token, "utf8").digest("hex");
    if (await bcrypt.compare(prehashed, storedHash)) return true;
    // Legacy fallback for hashes written before pre-hashing (one rotation
    // upgrades them). Remove after all sessions have rotated (~7d).
    return bcrypt.compare(token, storedHash);
}

/** Fire-and-forget auth audit: never fails the request it describes. */
async function logAuthEvent(
    action: AuditAction,
    organizationId: string,
    userId: string | null,
    metadata: { [key: string]: string } = {}
): Promise<void> {
    try {
        await prisma.auditLog.create({
            data: { organizationId, userId, action, metadata }
        });
    } catch (err) {
        // Report to monitoring (extend with your APM: Sentry, DataDog, etc.)
        reportAuthAuditFailure(action, organizationId, userId, err);
    }
}

/**
 * Hook for monitoring systems (Sentry, DataDog, custom).
 * Replace with your actual error reporting implementation.
 */
function reportAuthAuditFailure(
    action: AuditAction,
    organizationId: string,
    userId: string | null,
    error: unknown
): void {
    const payload = {
        event: "AUTH_AUDIT_FAILURE",
        action,
        organizationId,
        userId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
    };
    // TODO: Integrate with your monitoring (e.g., Sentry.captureException, DataDog, etc.)
    // Example: Sentry.captureException(new Error("AUTH_AUDIT_FAILURE"), { extra: payload });
    console.error("[AUTH_AUDIT] Failed to record event:", payload);
}

function payloadForUser(user: { id: string; organizationId: string; branchId: string | null; role: string; tokenVersion: number }): TokenPayload {
    return {
        userId: user.id,
        organizationId: user.organizationId,
        branchId: user.branchId ?? undefined,
        role: user.role,
        tv: user.tokenVersion
    };
}

export interface AuthUserDTO {
    id: string;
    fullName: string;
    email: string;
    phone: string | null;
    role: string;
    organizationId: string;
    branchId: string | null;
    organizationName: string;
    branchName: string | null;
    permissions: string[];
}

async function toAuthUser(user: {
    id: string;
    fullName: string;
    email: string;
    phone: string | null;
    role: string;
    organizationId: string;
    branchId: string | null;
    organization: { name: string };
    branch: { name: string } | null;
}): Promise<AuthUserDTO> {
    return {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        organizationId: user.organizationId,
        branchId: user.branchId,
        organizationName: user.organization.name,
        branchName: user.branch?.name ?? null,
        permissions: permissionsForRole(user.role as any),
    };
}

export async function loginUser(username: string, password: string) {
    const email = username.toLowerCase().trim();
    const user = await prisma.user.findFirst({
        where: { email, deletedAt: null },
        include: { organization: true, branch: true }
    });
    if (!user) {
        void logAuthEvent("LOGIN_FAILED", "unknown", null, { email, reason: "user_not_found" });
        throw new AppError("Invalid email or password.", 401, "INVALID_CREDENTIALS");
    }

    // Check for account lockout
    if (user.lockoutUntil && user.lockoutUntil > new Date()) {
        const remainingMs = user.lockoutUntil.getTime() - Date.now();
        const remainingMin = Math.ceil(remainingMs / 60000);
        void logAuthEvent("LOGIN_FAILED", user.organizationId, user.id, { reason: "account_locked" });
        throw new AppError(`Account temporarily locked. Try again in ${remainingMin} minutes.`, 429, "ACCOUNT_LOCKED");
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
        const attempts = user.failedLoginAttempts + 1;
        const isLocked = attempts >= MAX_FAILED_LOGIN_ATTEMPTS;
        const lockoutUntil = isLocked ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null;

        await prisma.user.update({
            where: { id: user.id },
            data: {
                failedLoginAttempts: attempts,
                lockoutUntil,
            }
        });

        void logAuthEvent("LOGIN_FAILED", user.organizationId, user.id, { reason: "invalid_password", attempts: String(attempts), locked: String(isLocked) });

        if (isLocked) {
            throw new AppError(`Too many failed attempts. Account locked for 15 minutes.`, 429, "ACCOUNT_LOCKED");
        }
        throw new AppError("Invalid email or password.", 401, "INVALID_CREDENTIALS");
    }

    // Check if account is locked due to status
    if (user.status !== "ACTIVE") {
        void logAuthEvent("LOGIN_FAILED", user.organizationId, user.id, { reason: `account_${user.status.toLowerCase()}` });
        throw new AppError("Account not active.", 403, "ACCOUNT_INACTIVE");
    }

    // Successful login - reset failed attempts and lockout
    const payload = payloadForUser(user);
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);
    const refreshTokenHash = await hashRefreshToken(refreshToken);
    await prisma.user.update({
        where: { id: user.id },
        data: { refreshTokenHash, lastLoginAt: new Date(), failedLoginAttempts: 0, lockoutUntil: null }
    });

    void logAuthEvent("LOGIN", user.organizationId, user.id, { method: "password" });

    return {
        authUser: await toAuthUser(user),
        accessToken,
        refreshToken
    };
}

export async function logoutUser(userId: string) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, organizationId: true }
    });
    await prisma.user.update({
        where: { id: userId },
        data: { refreshTokenHash: null }
    });
    if (user) void logAuthEvent("LOGOUT", user.organizationId, user.id, {});
    return { id: userId };
}

export interface RegisterInput {
    fullName: string;
    email: string;
    password: string;
    phone?: string;
    workspaceName: string;
    workspaceCode: string;
    gstin?: string;
    address?: string;
    state?: string;
}

export async function registerUser(input: RegisterInput) {
    const email = input.email.toLowerCase().trim();
    const workspaceCode = input.workspaceCode.toUpperCase().trim();

    // Friendly pre-check (the @unique constraint + P2002 handler remain the
    // race-safe backstop).
    const taken = await prisma.organization.findUnique({ where: { code: workspaceCode } });
    if (taken) {
        throw new AppError("This workspace code is already taken. Please choose another.", 409, "WORKSPACE_CODE_TAKEN");
    }

    const passwordHash = await bcrypt.hash(input.password, 12);
    const trialStartsAt = new Date();
    const trialEndsAt = new Date(trialStartsAt.getTime() + 14 * 24 * 60 * 60 * 1000);

    // Atomic: org + branch + subscription + owner + session succeed together
    // or leave no orphan rows behind.
    const { user, accessToken, refreshToken } = await prisma.$transaction(async tx => {
        const org = await tx.organization.create({
            data: {
                name: input.workspaceName.trim(),
                code: workspaceCode,
                gstin: input.gstin,
                address: input.address,
                currency: "INR",
                timezone: "Asia/Kolkata",
                isActive: true,
                settings: {}
            }
        });

        const branch = await tx.branch.create({
            data: {
                organizationId: org.id,
                name: "Main Branch",
                code: "MB01",
                phone: input.phone,
                address: input.address,
                city: input.state,
                state: input.state
            }
        });

        await tx.subscription.create({
            data: {
                organizationId: org.id,
                tier: "TRIAL_14_DAYS",
                status: "TRIALING",
                billingCycle: "MONTHLY",
                trialStartsAt,
                trialEndsAt,
                currentPeriodStart: trialStartsAt,
                currentPeriodEnd: trialEndsAt
            }
        });

        const created = await tx.user.create({
            data: {
                organizationId: org.id,
                email,
                fullName: input.fullName.trim(),
                passwordHash,
                role: "OWNER",
                phone: input.phone,
                status: "ACTIVE",
                branchId: branch.id
            },
            include: { organization: true, branch: true }
        });

        const payload = payloadForUser(created);
        const accessToken = signAccessToken(payload);
        const newRefreshToken = signRefreshToken(payload);
        await tx.user.update({
            where: { id: created.id },
            data: { refreshTokenHash: await hashRefreshToken(newRefreshToken) }
        });

        return { user: created, accessToken, refreshToken: newRefreshToken };
    });

    void logAuthEvent("USER_CREATED", user.organizationId, user.id, { method: "workspace_register" });

    return {
        authUser: await toAuthUser(user),
        accessToken,
        refreshToken
    };
}

export async function refreshSession(refreshToken: string) {
    let payload: TokenPayload;
    try {
        payload = verifyRefreshToken<TokenPayload>(refreshToken);
    } catch {
        throw new AppError("Invalid refresh token.", 401, "UNAUTHORIZED");
    }

    const user = await prisma.user.findFirst({
        where: { id: payload.userId, deletedAt: null },
        include: { organization: true, branch: true }
    });
    if (!user || !user.refreshTokenHash) {
        // No live session: either logged out, or a rotated (reused) token
        // presented after rotation. Treat as expired without side effects.
        throw new AppError("Session expired.", 401, "UNAUTHORIZED");
    }
    if (user.status !== "ACTIVE" || payload.tv !== user.tokenVersion) {
        // Role/status/version changed since the token was minted — revoke family.
        await prisma.user.update({
            where: { id: user.id },
            data: { refreshTokenHash: null }
        });
        throw new AppError("Session expired.", 401, "UNAUTHORIZED");
    }
    const matches = await refreshTokenMatches(refreshToken, user.refreshTokenHash);
    if (!matches) {
        // Reuse detected: a validly-signed but stale refresh token was
        // presented, meaning the live token was already rotated (or stolen).
        // Revoke the whole family so the attacker cannot keep racing.
        await prisma.user.update({
            where: { id: user.id },
            data: { refreshTokenHash: null }
        });
        void logAuthEvent("LOGOUT", user.organizationId, user.id, { reason: "refresh_reuse_detected" });
        throw new AppError("Session expired.", 401, "UNAUTHORIZED");
    }

    const p = payloadForUser(user);
    const accessToken = signAccessToken(p);
    const newRefresh = signRefreshToken(p);
    await prisma.user.update({
        where: { id: user.id },
        data: { refreshTokenHash: await hashRefreshToken(newRefresh) }
    });

    void logAuthEvent("TOKEN_REFRESH", user.organizationId, user.id, {});

    return { accessToken, refreshToken: newRefresh };
}

export async function getMe(userId: string) {
    const user = await prisma.user.findFirst({
        where: { id: userId, deletedAt: null },
        include: { organization: true, branch: true }
    });
    if (!user) throw new AppError("User not found.", 404, "NOT_FOUND");
    return toAuthUser(user);
}

function generateOtp(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function generateResetToken(): string {
    return randomBytes(32).toString("base64url");
}

function hashResetToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

async function invalidateOpenPasswordResets(userId: string): Promise<void> {
    await prisma.passwordReset.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: new Date() }
    });
}

async function enforceResetRequestLimits(userId: string): Promise<void> {
    const now = Date.now();

    const latest = await prisma.passwordReset.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" }
    });
    if (latest) {
        const waitMs = RESEND_COOLDOWN_MS - (now - latest.createdAt.getTime());
        if (waitMs > 0) {
            throw new AppError(`Please wait ${Math.ceil(waitMs / 1000)} seconds before requesting a new code.`, 429, "OTP_COOLDOWN");
        }
    }

    const hourAgo = new Date(now - HOURLY_LIMIT_WINDOW_MS);
    const recentCount = await prisma.passwordReset.count({
        where: { userId, createdAt: { gt: hourAgo } }
    });
    if (recentCount >= HOURLY_LIMIT_MAX) {
        throw new AppError("Too many verification code requests. Please try again later.", 429, "TOO_MANY_REQUESTS");
    }
}

export async function requestPasswordReset(email: string): Promise<{ email: string }> {
    const normalized = email.toLowerCase().trim();
    const user = await prisma.user.findFirst({
        where: { email: normalized, deletedAt: null }
    });

    // Anti-enumeration: the response is identical whether or not the account exists.
    if (!user || user.status !== "ACTIVE") {
        void logAuthEvent("PASSWORD_RESET_REQUESTED", "unknown", null, { email: normalized, result: "user_not_found_or_inactive" });
        return { email: normalized };
    }

    await enforceResetRequestLimits(user.id);

    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, OTP_HASH_COST);

    await invalidateOpenPasswordResets(user.id);

    const reset = await prisma.passwordReset.create({
        data: {
            userId: user.id,
            otpHash,
            expiresAt: new Date(Date.now() + OTP_TTL_MS)
        }
    });
    try {
        await sendOtpEmail({ to: { email: user.email, name: user.fullName }, otp });
        void logAuthEvent("PASSWORD_RESET_REQUESTED", user.organizationId, user.id, { result: "otp_sent" });
    } catch (err) {
        await prisma.passwordReset.update({
            where: { id: reset.id },
            data: { usedAt: new Date() }
        });
        console.error("[PASSWORD_RESET] Failed to deliver OTP email:", err);
        void logAuthEvent("PASSWORD_RESET_REQUESTED", user.organizationId, user.id, { result: "email_failed" });
        throw new AppError("We couldn't send the verification code right now. Please try again in a moment.", 503, "EMAIL_DELIVERY_FAILED");
    }

    return { email: normalized };
}

export async function verifyPasswordResetOtp(email: string, otp: string): Promise<{ resetToken: string }> {
    const normalized = email.toLowerCase().trim();
    const user = await prisma.user.findFirst({
        where: { email: normalized, deletedAt: null }
    });
    if (!user || user.status !== "ACTIVE") {
        throw new AppError("Invalid or expired verification code.", 400, "INVALID_OTP");
    }

    const reset = await prisma.passwordReset.findFirst({
        where: {
            userId: user.id,
            usedAt: null,
            verifiedAt: null,
            expiresAt: { gt: new Date() }
        },
        orderBy: { createdAt: "desc" }
    });
    if (!reset) {
        throw new AppError("Invalid or expired verification code.", 400, "OTP_EXPIRED");
    }

    if (reset.attempts >= OTP_MAX_ATTEMPTS) {
        await prisma.passwordReset.update({
            where: { id: reset.id },
            data: { usedAt: new Date() }
        });
        throw new AppError("Too many invalid attempts. Please request a new code.", 400, "OTP_LIMIT_EXCEEDED");
    }

    const matches = await bcrypt.compare(otp, reset.otpHash);
    if (!matches) {
        const attempts = reset.attempts + 1;
        if (attempts >= OTP_MAX_ATTEMPTS) {
            await prisma.passwordReset.update({
                where: { id: reset.id },
                data: { attempts, usedAt: new Date() }
            });
        } else {
            await prisma.passwordReset.update({
                where: { id: reset.id },
                data: { attempts }
            });
        }
        void logAuthEvent("OTP_VERIFY_FAILED", user.organizationId, user.id, { reason: "invalid_otp" });
        throw new AppError("Invalid verification code.", 400, "INVALID_OTP");
    }

    const resetToken = generateResetToken();
    await prisma.passwordReset.update({
        where: { id: reset.id },
        data: {
            verifiedAt: new Date(),
            resetTokenHash: hashResetToken(resetToken),
            resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS)
        }
    });

    void logAuthEvent("OTP_VERIFIED", user.organizationId, user.id, {});

    return { resetToken };
}

export async function resetPassword(resetToken: string, newPassword: string) {
    const reset = await prisma.passwordReset.findFirst({
        where: {
            resetTokenHash: hashResetToken(resetToken),
            resetTokenUsedAt: null,
            resetTokenExpiresAt: { gt: new Date() }
        }
    });
    if (!reset) {
        throw new AppError("Reset token invalid or expired.", 400, "INVALID_RESET_TOKEN");
    }

    const user = await prisma.user.findFirst({
        where: { id: reset.userId, deletedAt: null }
    });
    if (!user) {
        throw new AppError("Reset token invalid or expired.", 400, "INVALID_RESET_TOKEN");
    }

    const sameAsCurrent = await bcrypt.compare(newPassword, user.passwordHash);
    if (sameAsCurrent) {
        throw new AppError("Same password cannot be updated. Please try another password.", 400, "SAME_PASSWORD");
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, refreshTokenHash: null, tokenVersion: { increment: 1 } }
    });

    await prisma.passwordReset.update({
        where: { id: reset.id },
        data: { resetTokenUsedAt: new Date(), usedAt: new Date() }
    });

    await prisma.auditLog.create({
        data: {
            organizationId: user.organizationId,
            userId: user.id,
            action: "PASSWORD_RESET",
            entityType: "User",
            entityId: user.id,
            metadata: {}
        }
    });

    void logAuthEvent("PASSWORD_RESET_COMPLETED", user.organizationId, user.id, {});

    return { id: user.id };
}
