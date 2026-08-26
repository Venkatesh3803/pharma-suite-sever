import bcrypt from "bcryptjs";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { AppError } from "../domain/errors";
import { prisma } from "../lib/prisma";
import { sendOtpEmail } from "../services/email/email.service";
import { signAccessToken, signRefreshToken, verifyToken, type TokenPayload } from "../utils/jwt";
import { permissionsForRole } from "../domain/permissions";

const REFRESH_COOKIE = "pharmasuite_refresh";
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_HASH_COST = 10;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const HOURLY_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const HOURLY_LIMIT_MAX = 5;

export function refreshCookieName(): string {
    return REFRESH_COOKIE;
}

export function refreshCookieOptions() {
    return {
        httpOnly: true,
        sameSite: "lax" as const,
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: REFRESH_MAX_AGE
    };
}

function payloadForUser(user: { id: string; organizationId: string; branchId: string | null; role: string }): TokenPayload {
    return {
        userId: user.id,
        organizationId: user.organizationId,
        branchId: user.branchId ?? undefined,
        role: user.role
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
    const user = await prisma.user.findFirst({
        where: { email: username.toLowerCase().trim(), deletedAt: null },
        include: { organization: true, branch: true }
    });
    if (!user) throw new AppError("Invalid email or password.", 401, "INVALID_CREDENTIALS");
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new AppError("Invalid email or password.", 401, "INVALID_CREDENTIALS");
    if (user.status !== "ACTIVE") throw new AppError("Account not active.", 403, "ACCOUNT_INACTIVE");

    const payload = payloadForUser(user);
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);
    const refreshTokenHash = await bcrypt.hash(refreshToken, 10);
    await prisma.user.update({
        where: { id: user.id },
        data: { refreshTokenHash, lastLoginAt: new Date() }
    });

    return {
        authUser: await toAuthUser(user),
        accessToken,
        refreshToken
    };
}

export async function logoutUser(userId: string) {
    await prisma.user.update({
        where: { id: userId },
        data: { refreshTokenHash: null }
    });
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
    const org = await prisma.organization.create({
        data: {
            name: input.workspaceName,
            code: input.workspaceCode,
            gstin: input.gstin,
            address: input.address,
            currency: "INR",
            timezone: "Asia/Kolkata",
            isActive: true,
            settings: {}
        }
    });

    const branch = await prisma.branch.create({
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

    const trialStartsAt = new Date();
    const trialEndsAt = new Date(trialStartsAt.getTime() + 14 * 24 * 60 * 60 * 1000);
    await prisma.subscription.create({
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

    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await prisma.user.create({
        data: {
            organizationId: org.id,
            email,
            fullName: input.fullName,
            passwordHash,
            role: "OWNER",
            phone: input.phone,
            status: "ACTIVE",
            branchId: branch.id
        },
        include: { organization: true, branch: true }
    });

    const payload = payloadForUser(user);
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);
    await prisma.user.update({
        where: { id: user.id },
        data: { refreshTokenHash: await bcrypt.hash(refreshToken, 10) }
    });

    return {
        authUser: await toAuthUser(user),
        accessToken,
        refreshToken
    };
}

export async function refreshSession(refreshToken: string) {
    let payload: TokenPayload;
    try {
        payload = verifyToken<TokenPayload>(refreshToken);
    } catch {
        throw new AppError("Invalid refresh token.", 401, "UNAUTHORIZED");
    }

    const user = await prisma.user.findFirst({
        where: { id: payload.userId, deletedAt: null },
        include: { organization: true, branch: true }
    });
    if (!user || !user.refreshTokenHash) {
        throw new AppError("Session expired.", 401, "UNAUTHORIZED");
    }
    const matches = await bcrypt.compare(refreshToken, user.refreshTokenHash);
    if (!matches) {
        await prisma.user.update({
            where: { id: user.id },
            data: { refreshTokenHash: null }
        });
        throw new AppError("Session expired.", 401, "UNAUTHORIZED");
    }

    const p = payloadForUser(user);
    const accessToken = signAccessToken(p);
    const newRefresh = signRefreshToken(p);
    await prisma.user.update({
        where: { id: user.id },
        data: { refreshTokenHash: await bcrypt.hash(newRefresh, 10) }
    });

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
    } catch (err) {
        await prisma.passwordReset.update({
            where: { id: reset.id },
            data: { usedAt: new Date() }
        });
        console.error("[PASSWORD_RESET] Failed to deliver OTP email:", err);
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
        data: { passwordHash, refreshTokenHash: null }
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

    return { id: user.id };
}
