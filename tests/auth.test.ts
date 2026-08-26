import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import { AppError } from "../src/domain/errors";
import { loginUser, requestPasswordReset, verifyPasswordResetOtp, resetPassword } from "../src/services/auth.service";
import {
    forgotPasswordValidator,
    resetPasswordValidator,
    verifyOtpValidator,
} from "../src/validators/auth.validator";

const { sendOtpEmailMock } = vi.hoisted(() => ({ sendOtpEmailMock: vi.fn() }));

vi.mock("../src/services/email/email.service", () => ({
    sendOtpEmail: sendOtpEmailMock,
}));

const OTP_ATTEMPTS = 5;

let createdOrgIds: string[] = [];

async function makeUser(overrides: { status?: "ACTIVE" | "INACTIVE" | "SUSPENDED" } = {}) {
    const code = `aut-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const org = await prisma.organization.create({
        data: { name: "Auth Test Org", code },
    });
    createdOrgIds.push(org.id);
    const passwordHash = await bcrypt.hash("OldPassword123", 10);
    const user = await prisma.user.create({
        data: {
            organizationId: org.id,
            email: `auth-${code}@test.local`,
            fullName: "Auth Tester",
            passwordHash,
            role: "OWNER",
            status: overrides.status ?? "ACTIVE",
        },
    });
    return { orgId: org.id, userId: user.id, email: user.email, passwordHash };
}

async function destroyOrg(orgId: string) {
    createdOrgIds = createdOrgIds.filter(id => id !== orgId);
    const users = await prisma.user.findMany({
        where: { organizationId: orgId },
        select: { id: true },
    });
    await prisma.passwordReset.deleteMany({
        where: { userId: { in: users.map(u => u.id) } },
    });
    await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.branch.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
}

function lastOtp(): string {
    const calls = sendOtpEmailMock.mock.calls as { to: { email: string }; otp: string }[][];
    const last = calls[calls.length - 1];
    return last?.[0]?.otp ?? "";
}

function lastOtpRecipient(): string {
    const calls = sendOtpEmailMock.mock.calls as { to: { email: string } }[][];
    const last = calls[calls.length - 1];
    return last?.[0]?.to?.email ?? "";
}

async function completeOtp(userId: string, email: string): Promise<{ resetToken: string }> {
    await requestPasswordReset(email);
    const otp = lastOtp();
    await prisma.passwordReset.updateMany({
        where: { userId },
        data: { expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
    });
    return verifyPasswordResetOtp(email, otp);
}

beforeAll(async () => {
    sendOtpEmailMock.mockResolvedValue({ sent: true, channel: "brevo" });
});

afterAll(async () => {
    for (const id of createdOrgIds) {
        try {
            await destroyOrg(id);
        } catch {
            // ignore cleanup errors
        }
    }
    await prisma.$disconnect();
});

beforeEach(() => {
    sendOtpEmailMock.mockReset();
    sendOtpEmailMock.mockResolvedValue({ sent: true, channel: "brevo" });
});

describe("OTP security", () => {
    it("generates exactly 6 digits and stores a bcrypt hash, not the plaintext", async () => {
        const { orgId, userId, email } = await makeUser();
        const result = await requestPasswordReset(email);
        expect(result.email).toBe(email);
        const otp = lastOtp();
        expect(otp).toMatch(/^\d{6}$/);

        const reset = await prisma.passwordReset.findFirstOrThrow({ where: { userId } });
        expect(reset.otpHash).not.toBe(otp);
        expect(await bcrypt.compare(otp, reset.otpHash)).toBe(true);
        await destroyOrg(orgId);
    });

    it("expired OTP cannot be verified", async () => {
        const { orgId, userId, email } = await makeUser();
        await requestPasswordReset(email);
        const otp = lastOtp();
        await prisma.passwordReset.updateMany({
            where: { userId },
            data: { expiresAt: new Date(Date.now() - 1000) },
        });
        await expect(verifyPasswordResetOtp(email, otp)).rejects.toMatchObject({
            code: "OTP_EXPIRED",
        });
        await destroyOrg(orgId);
    });

    it("a successfully verified OTP cannot be reused", async () => {
        const { orgId, userId, email } = await makeUser();
        await requestPasswordReset(email);
        const otp = lastOtp();
        await verifyPasswordResetOtp(email, otp);
        await expect(verifyPasswordResetOtp(email, otp)).rejects.toMatchObject({
            code: "OTP_EXPIRED",
        });
        expect(userId).toBeTruthy();
        await destroyOrg(orgId);
    });

    it("an incorrect OTP increments the attempt counter", async () => {
        const { orgId, userId, email } = await makeUser();
        await requestPasswordReset(email);
        await expect(verifyPasswordResetOtp(email, "000000")).rejects.toMatchObject({
            code: "INVALID_OTP",
        });
        const reset = await prisma.passwordReset.findFirstOrThrow({ where: { userId } });
        expect(reset.attempts).toBe(1);
        await destroyOrg(orgId);
    });

    it("maximum attempts invalidates the OTP", async () => {
        const { orgId, userId, email } = await makeUser();
        await requestPasswordReset(email);
        const otp = lastOtp();
        for (let i = 0; i < OTP_ATTEMPTS; i++) {
            await expect(verifyPasswordResetOtp(email, "111111")).rejects.toMatchObject({
                code: "INVALID_OTP",
            });
        }
        const reset = await prisma.passwordReset.findFirstOrThrow({ where: { userId } });
        expect(reset.attempts).toBe(OTP_ATTEMPTS);
        expect(reset.usedAt).not.toBeNull();
        await expect(verifyPasswordResetOtp(email, otp)).rejects.toMatchObject({
            code: "OTP_EXPIRED",
        });
        await destroyOrg(orgId);
    });
});

describe("Forgot password", () => {
    it("valid email requests an OTP and returns an enumeration-safe response", async () => {
        const { orgId, email } = await makeUser();
        const result = await requestPasswordReset(email);
        expect(result).toEqual({ email });
        expect(lastOtpRecipient()).toBe(email);
        await destroyOrg(orgId);
    });

    it("unknown email returns the same generic response and sends no email", async () => {
        const result = await requestPasswordReset("nobody@test.local");
        expect(result).toEqual({ email: "nobody@test.local" });
        expect(sendOtpEmailMock).not.toHaveBeenCalled();
    });

    it("does not reveal whether the account exists (identical shape)", async () => {
        const { orgId, email } = await makeUser();
        const known = await requestPasswordReset(email);
        const unknown = await requestPasswordReset("someone-else@test.local");
        expect(known.email).toBe(email);
        expect(unknown.email).toBe("someone-else@test.local");
        expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
        await destroyOrg(orgId);
    });

    it("enforces a 60 second resend cooldown", async () => {
        const { orgId, email } = await makeUser();
        await requestPasswordReset(email);
        await expect(requestPasswordReset(email)).rejects.toMatchObject({
            code: "OTP_COOLDOWN",
            statusCode: 429,
        });
        await destroyOrg(orgId);
    });

    it("enforces an hourly request limit", async () => {
        const { orgId, userId, email } = await makeUser();
        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
        for (let i = 0; i < 5; i++) {
            await prisma.passwordReset.create({
                data: {
                    userId,
                    otpHash: "unused",
                    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
                    createdAt: thirtyMinAgo,
                },
            });
        }
        await expect(requestPasswordReset(email)).rejects.toMatchObject({
            code: "TOO_MANY_REQUESTS",
            statusCode: 429,
        });
        await destroyOrg(orgId);
    });

    it("normalizes the email to lowercase and trims it", async () => {
        const { orgId, email } = await makeUser();
        const result = await requestPasswordReset(`  ${email.toUpperCase()}  `);
        expect(result.email).toBe(email);
        await destroyOrg(orgId);
    });

    it("delivery failure invalidates the OTP and returns a generic error", async () => {
        const { orgId, userId, email } = await makeUser();
        sendOtpEmailMock.mockRejectedValueOnce(new Error("brevo unavailable"));
        await expect(requestPasswordReset(email)).rejects.toMatchObject({
            code: "EMAIL_DELIVERY_FAILED",
            statusCode: 503,
        });
        const reset = await prisma.passwordReset.findFirstOrThrow({ where: { userId } });
        expect(reset.usedAt).not.toBeNull();
        await destroyOrg(orgId);
    });
});

describe("Reset password", () => {
    it("valid reset token updates and securely hashes the password", async () => {
        const { orgId, userId, email } = await makeUser();
        const { resetToken } = await completeOtp(userId, email);
        await resetPassword(resetToken, "NewPassword456");

        const updated = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        expect(updated.passwordHash).not.toBe("NewPassword456");
        expect(await bcrypt.compare("NewPassword456", updated.passwordHash)).toBe(true);
        expect(await bcrypt.compare("OldPassword123", updated.passwordHash)).toBe(false);

        const session = await loginUser(email, "NewPassword456");
        expect(session.accessToken).toBeTruthy();
        await destroyOrg(orgId);
    });

    it("rejects a reused (single-use) reset token", async () => {
        const { orgId, userId, email } = await makeUser();
        const { resetToken } = await completeOtp(userId, email);
        await resetPassword(resetToken, "NewPassword456");
        await expect(resetPassword(resetToken, "AnotherPassword789")).rejects.toMatchObject({
            code: "INVALID_RESET_TOKEN",
        });
        await destroyOrg(orgId);
    });

    it("rejects an expired reset token", async () => {
        const { orgId, userId, email } = await makeUser();
        const { resetToken } = await completeOtp(userId, email);
        await prisma.passwordReset.updateMany({
            where: { userId, resetTokenHash: { not: null } },
            data: { resetTokenExpiresAt: new Date(Date.now() - 1000) },
        });
        await expect(resetPassword(resetToken, "NewPassword456")).rejects.toMatchObject({
            code: "INVALID_RESET_TOKEN",
        });
        await destroyOrg(orgId);
    });

    it("rejects an invalid reset token", async () => {
        await expect(resetPassword("not-a-real-token", "NewPassword456")).rejects.toMatchObject({
            code: "INVALID_RESET_TOKEN",
        });
    });

    it("rejects reusing the current password", async () => {
        const { orgId, userId, email } = await makeUser();
        const { resetToken } = await completeOtp(userId, email);
        await expect(resetPassword(resetToken, "OldPassword123")).rejects.toMatchObject({
            code: "SAME_PASSWORD",
        });
        await destroyOrg(orgId);
    });

    it("invalidates existing sessions by clearing the refresh token hash", async () => {
        const { orgId, userId, email } = await makeUser();
        await prisma.user.update({
            where: { id: userId },
            data: { refreshTokenHash: await bcrypt.hash("some-refresh", 10) },
        });
        const { resetToken } = await completeOtp(userId, email);
        await resetPassword(resetToken, "NewPassword456");
        const updated = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        expect(updated.refreshTokenHash).toBeNull();
        await destroyOrg(orgId);
    });

    it("does not log in the user automatically", async () => {
        const { orgId, userId, email } = await makeUser();
        const { resetToken } = await completeOtp(userId, email);
        const result = await resetPassword(resetToken, "NewPassword456");
        expect(result).toEqual({ id: userId });
        await destroyOrg(orgId);
    });
});

describe("Security & privacy", () => {
    it("never returns the OTP in API responses", async () => {
        const { orgId, email } = await makeUser();
        const request = await requestPasswordReset(email);
        expect("otp" in request).toBe(false);
        await destroyOrg(orgId);
    });

    it("never logs the OTP", async () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            const { orgId, email } = await makeUser();
            await requestPasswordReset(email);
            const otp = lastOtp();
            const allLogs = [
                ...logSpy.mock.calls.map(c => c.join(" ")),
                ...errorSpy.mock.calls.map(c => c.join(" ")),
            ];
            for (const line of allLogs) {
                expect(line).not.toContain(otp);
            }
            await destroyOrg(orgId);
        } finally {
            logSpy.mockRestore();
            errorSpy.mockRestore();
        }
    });

    it("does not log the password", async () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            const { orgId, userId, email } = await makeUser();
            const { resetToken } = await completeOtp(userId, email);
            await resetPassword(resetToken, "SecretPassword999");
            const allLogs = [
                ...logSpy.mock.calls.map(c => c.join(" ")),
                ...errorSpy.mock.calls.map(c => c.join(" ")),
            ];
            for (const line of allLogs) {
                expect(line).not.toContain("SecretPassword999");
            }
            await destroyOrg(orgId);
        } finally {
            logSpy.mockRestore();
            errorSpy.mockRestore();
        }
    });

    it("blocked verification for an inactive account", async () => {
        const { orgId, email } = await makeUser({ status: "INACTIVE" });
        await requestPasswordReset(email);
        expect(sendOtpEmailMock).not.toHaveBeenCalled();
        await expect(verifyPasswordResetOtp(email, "123456")).rejects.toMatchObject({
            code: "INVALID_OTP",
        });
        await destroyOrg(orgId);
    });
});

describe("Validators", () => {
    it("forgotPasswordValidator accepts a valid email and rejects an invalid one", () => {
        expect(forgotPasswordValidator.safeParse({ email: "user@example.com" }).success).toBe(true);
        expect(forgotPasswordValidator.safeParse({ email: "not-an-email" }).success).toBe(false);
        expect(forgotPasswordValidator.safeParse({ email: "" }).success).toBe(false);
    });

    it("verifyOtpValidator requires exactly 6 digits", () => {
        expect(verifyOtpValidator.safeParse({ email: "user@example.com", otp: "123456" }).success).toBe(true);
        expect(verifyOtpValidator.safeParse({ email: "user@example.com", otp: "12345" }).success).toBe(false);
        expect(verifyOtpValidator.safeParse({ email: "user@example.com", otp: "abcdef" }).success).toBe(false);
    });

    it("resetPasswordValidator enforces password policy and confirmation", () => {
        const base = { resetToken: "token" };
        expect(resetPasswordValidator.safeParse({ ...base, newPassword: "LongEnough1", confirmPassword: "LongEnough1" }).success).toBe(true);
        expect(resetPasswordValidator.safeParse({ ...base, newPassword: "short", confirmPassword: "short" }).success).toBe(false);
        expect(resetPasswordValidator.safeParse({ ...base, newPassword: "       ", confirmPassword: "       " }).success).toBe(false);
        expect(resetPasswordValidator.safeParse({ ...base, newPassword: "LongEnough1", confirmPassword: "Different1" }).success).toBe(false);
    });
});
