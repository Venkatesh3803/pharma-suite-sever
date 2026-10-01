import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { config } from "../src/config";

const app = createApp();
const PASSWORD = "TestPass123";

let createdOrgIds: string[] = [];

async function makeUser(overrides: { status?: "ACTIVE" | "INACTIVE" | "SUSPENDED" } = {}) {
    const code = `sec-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const org = await prisma.organization.create({ data: { name: "Security Test Org", code } });
    createdOrgIds.push(org.id);
    const user = await prisma.user.create({
        data: {
            organizationId: org.id,
            email: `sec-${code}@test.local`,
            fullName: "Security Tester",
            passwordHash: await bcrypt.hash(PASSWORD, 10),
            role: "OWNER",
            status: overrides.status ?? "ACTIVE",
        },
    });
    return { orgId: org.id, userId: user.id, email: user.email };
}

async function destroyOrg(orgId: string) {
    createdOrgIds = createdOrgIds.filter(id => id !== orgId);
    const users = await prisma.user.findMany({ where: { organizationId: orgId }, select: { id: true } });
    await prisma.passwordReset.deleteMany({ where: { userId: { in: users.map(u => u.id) } } });
    await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.branch.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
}

afterAll(async () => {
    for (const id of [...createdOrgIds]) {
        try {
            await destroyOrg(id);
        } catch {
            // ignore cleanup errors
        }
    }
    await prisma.$disconnect();
});

async function loginCookies(email: string, password = PASSWORD): Promise<string[]> {
    const res = await request(app).post("/api/auth/login").send({ username: email, password });
    expect(res.status).toBe(200);
    return (res.headers["set-cookie"] as string[] | undefined) ?? [];
}

describe("password reset over HTTP (cookie transport)", () => {
    it("verify-otp sets an HttpOnly cookie and never returns the token", async () => {
        const { orgId, userId, email } = await makeUser();
        await prisma.passwordReset.create({
            data: {
                userId,
                otpHash: await bcrypt.hash("482916", 10),
                expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            },
        });

        const res = await request(app).post("/api/auth/verify-otp").send({ email, otp: "482916" });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ verified: true });
        expect(JSON.stringify(res.body)).not.toContain("resetToken");
        const cookies = (res.headers["set-cookie"] as string[] | undefined) ?? [];
        const reset = cookies.find(c => c.startsWith("pharmasuite_reset="));
        expect(reset).toBeTruthy();
        expect(reset).toMatch(/HttpOnly/i);
        await destroyOrg(orgId);
    });

    it("reset-password consumes the cookie and the new password works", async () => {
        const { orgId, userId, email } = await makeUser();
        await prisma.passwordReset.create({
            data: {
                userId,
                otpHash: await bcrypt.hash("770031", 10),
                expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            },
        });
        const agent = request.agent(app);
        await agent.post("/api/auth/verify-otp").send({ email, otp: "770031" });

        const reset = await agent
            .post("/api/auth/reset-password")
            .send({ newPassword: "BrandNewPass1", confirmPassword: "BrandNewPass1" });
        expect(reset.status).toBe(200);

        const login = await request(app).post("/api/auth/login").send({ username: email, password: "BrandNewPass1" });
        expect(login.status).toBe(200);
        await destroyOrg(orgId);
    });

    it("reset-password without any token is a JSON 400", async () => {
        const res = await request(app)
            .post("/api/auth/reset-password")
            .send({ newPassword: "BrandNewPass1", confirmPassword: "BrandNewPass1" });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ success: false, data: null, code: "INVALID_RESET_TOKEN" });
    });
});

describe("token confusion and tampering", () => {
    it("a refresh token cannot be used as an access token", async () => {
        const { orgId, email } = await makeUser();
        const cookies = await loginCookies(email);
        const refresh = cookies.find(c => c.startsWith("pharmasuite_refresh="))!.split(";")[0].split("=")[1];
        const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${refresh}`);
        expect(res.status).toBe(401);
        await destroyOrg(orgId);
    });

    it("an access token cannot be used as a refresh cookie", async () => {
        const { orgId, userId } = await makeUser();
        const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        const access = jwt.sign(
            { userId: user.id, organizationId: user.organizationId, role: user.role, tv: user.tokenVersion, typ: "access" },
            config.jwtAccessSecret,
            { expiresIn: "1h" },
        );
        const res = await request(app).post("/api/auth/refresh").set("Cookie", `pharmasuite_refresh=${access}`).send({});
        expect(res.status).toBe(401);
        await destroyOrg(orgId);
    });

    it("a tampered access token is rejected", async () => {
        const { orgId, userId } = await makeUser();
        const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        // Create a valid access token manually (no longer returned in body)
        const token = jwt.sign(
            { userId: user.id, organizationId: user.organizationId, role: user.role, tv: user.tokenVersion, typ: "access" },
            config.jwtAccessSecret,
            { expiresIn: "1h" },
        );
        const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
        const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${tampered}`);
        expect(res.status).toBe(401);
        await destroyOrg(orgId);
    });

    it("a typ-less (legacy) refresh token is rejected on refresh", async () => {
        const { orgId, userId } = await makeUser();
        const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        const legacy = jwt.sign(
            { userId: user.id, organizationId: user.organizationId, role: user.role, tv: user.tokenVersion },
            config.jwtRefreshSecret,
            { expiresIn: "7d" },
        );
        await prisma.user.update({ where: { id: userId }, data: { refreshTokenHash: await bcrypt.hash(legacy, 10) } });
        const res = await request(app).post("/api/auth/refresh").set("Cookie", `pharmasuite_refresh=${legacy}`).send({});
        expect(res.status).toBe(401);
        await destroyOrg(orgId);
    });

    it("bumping tokenVersion kills outstanding access tokens", async () => {
        const { orgId, userId } = await makeUser();
        const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        const token = jwt.sign(
            { userId: user.id, organizationId: user.organizationId, role: user.role, tv: user.tokenVersion, typ: "access" },
            config.jwtAccessSecret,
            { expiresIn: "1h" },
        );
        await prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
        const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(401);
        await destroyOrg(orgId);
    });

    it("suspended users fail closed even with a live token", async () => {
        const { orgId, userId } = await makeUser();
        const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        const token = jwt.sign(
            { userId: user.id, organizationId: user.organizationId, role: user.role, tv: user.tokenVersion, typ: "access" },
            config.jwtAccessSecret,
            { expiresIn: "1h" },
        );
        await prisma.user.update({ where: { id: userId }, data: { status: "SUSPENDED" } });
        const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(401);
        await destroyOrg(orgId);
    });
});

describe("rate-limit envelope", () => {
    it("forgot-password throttles with the standard JSON shape", async () => {
        let last: request.Response | null = null;
        for (let i = 0; i < 6; i++) {
            last = await request(app).post("/api/auth/forgot-password").send({ email: "ghost-throttle@test.local" });
        }
        expect(last!.status).toBe(429);
        expect(last!.body).toMatchObject({ success: false, data: null, code: "TOO_MANY_REQUESTS" });
    });
});
