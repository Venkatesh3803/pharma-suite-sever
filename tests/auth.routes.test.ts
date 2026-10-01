import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";

const app = createApp();
const PASSWORD = "TestPass123";

let createdOrgIds: string[] = [];

async function makeUser(overrides: { status?: "ACTIVE" | "INACTIVE" | "SUSPENDED"; password?: string } = {}) {
    const code = `rt-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const org = await prisma.organization.create({ data: { name: "Route Test Org", code } });
    createdOrgIds.push(org.id);
    const user = await prisma.user.create({
        data: {
            organizationId: org.id,
            email: `route-${code}@test.local`,
            fullName: "Route Tester",
            passwordHash: await bcrypt.hash(overrides.password ?? PASSWORD, 10),
            role: "OWNER",
            status: overrides.status ?? "ACTIVE",
        },
    });
    return { orgId: org.id, email: user.email };
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

function setCookies(res: { headers: Record<string, unknown> }): string[] {
    return (res.headers["set-cookie"] as string[] | undefined) ?? [];
}

describe("POST /api/auth/register", () => {
    it("provisions a workspace, sets hardened cookies, and returns the session", async () => {
        const code = `WS${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296).toString(36).toUpperCase()}`.slice(0, 10);
        const res = await request(app).post("/api/auth/register").send({
            fullName: "New Owner",
            email: `owner-${code.toLowerCase()}@test.local`,
            password: "OwnerPass123",
            workspaceName: "New Workspace",
            workspaceCode: code,
        });
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.user.role).toBe("OWNER");
        expect(res.body.data.accessToken).toBeUndefined();

        const cookies = setCookies(res);
        const access = cookies.find(c => c.startsWith("pharmasuite_access="));
        const refresh = cookies.find(c => c.startsWith("pharmasuite_refresh="));
        expect(access).toMatch(/HttpOnly/i);
        expect(access).toMatch(/SameSite=Strict/i);
        expect(refresh).toMatch(/HttpOnly/i);
        expect(refresh).toMatch(/SameSite=Strict/i);

        const org = await prisma.organization.findUnique({ where: { code } });
        expect(org).toBeTruthy();
        if (org) {
            expect(res.body.data.user.organizationId).toBe(org.id);
            await destroyOrg(org.id);
        }
    });

    it("rejects a duplicate workspace code with a JSON envelope", async () => {
        const shortCode = `D${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
        const org = await prisma.organization.create({ data: { name: "Taken Org", code: shortCode } });
        createdOrgIds.push(org.id);
        const res = await request(app).post("/api/auth/register").send({
            fullName: "Clone",
            email: `clone-${Date.now()}@test.local`,
            password: "OwnerPass123",
            workspaceName: "Clone",
            workspaceCode: shortCode,
        });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ success: false, data: null, code: "WORKSPACE_CODE_TAKEN" });
        await destroyOrg(org.id);
    });

    it("rejects weak passwords and mismatched confirmation", async () => {
        const weak = await request(app).post("/api/auth/register").send({
            fullName: "Weak",
            email: "weak@test.local",
            password: "short",
            workspaceName: "Weak",
            workspaceCode: "WEAK1",
        });
        expect(weak.status).toBe(400);
        expect(weak.body.code).toBe("VALIDATION_ERROR");

        const mismatch = await request(app).post("/api/auth/register").send({
            fullName: "Mismatch",
            email: "mismatch@test.local",
            password: "GoodPass123",
            confirmPassword: "OtherPass123",
            workspaceName: "Mismatch",
            workspaceCode: "MMX1",
        });
        expect(mismatch.status).toBe(400);
        expect(mismatch.body.code).toBe("VALIDATION_ERROR");
    });
});

describe("POST /api/auth/login + session cookies", () => {
    it("logs in, sets cookies, and the cookie alone passes /me", async () => {
        const { orgId, email } = await makeUser();
        const agent = request.agent(app);
        const login = await agent.post("/api/auth/login").send({ username: email, password: PASSWORD });
        expect(login.status).toBe(200);
        expect(login.body.data.user).toBeTruthy();
        expect(login.body.data.accessToken).toBeUndefined();

        const me = await agent.get("/api/auth/me");
        expect(me.status).toBe(200);
        expect(me.body.data.user.email).toBe(email);
        await destroyOrg(orgId);
    });

    it("Bearer header is rejected (cookie-only auth); anonymous /me is a JSON 401", async () => {
        const { orgId, email } = await makeUser();
        const login = await request(app).post("/api/auth/login").send({ username: email, password: PASSWORD });
        // No accessToken in body anymore
        const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer dummy`);
        expect(me.status).toBe(401);
        expect(me.body.code).toBe("UNAUTHORIZED");

        const anon = await request(app).get("/api/auth/me");
        expect(anon.status).toBe(401);
        expect(anon.body).toMatchObject({ success: false, data: null, code: "UNAUTHORIZED" });
        await destroyOrg(orgId);
    });

    it("wrong password and unknown user return identical shapes", async () => {
        const { orgId, email } = await makeUser();
        const wrong = await request(app).post("/api/auth/login").send({ username: email, password: "WrongPass999" });
        const unknown = await request(app).post("/api/auth/login").send({ username: "nobody-here@test.local", password: "WrongPass999" });
        for (const res of [wrong, unknown]) {
            expect(res.status).toBe(401);
            expect(res.body).toMatchObject({ success: false, data: null, code: "INVALID_CREDENTIALS" });
        }
        expect(wrong.body.message).toBe(unknown.body.message);
        await destroyOrg(orgId);
    });

    it("inactive accounts cannot log in", async () => {
        const { orgId, email } = await makeUser({ status: "SUSPENDED" });
        const res = await request(app).post("/api/auth/login").send({ username: email, password: PASSWORD });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("ACCOUNT_INACTIVE");
        await destroyOrg(orgId);
    });
});

describe("POST /api/auth/refresh + logout", () => {
    it("rotates the refresh family; the stale token is then rejected", async () => {
        const { orgId, email } = await makeUser();
        const first = await request(app).post("/api/auth/login").send({ username: email, password: PASSWORD });
        const oldRefresh = setCookies(first).find(c => c.startsWith("pharmasuite_refresh="))!.split(";")[0];

        const rotated = await request(app).post("/api/auth/refresh").set("Cookie", oldRefresh).send({});
        expect(rotated.status).toBe(200);
        expect(rotated.body.data).toBeNull();

        const replay = await request(app).post("/api/auth/refresh").set("Cookie", oldRefresh).send({});
        expect(replay.status).toBe(401);
        expect(replay.body.code).toBe("UNAUTHORIZED");
        await destroyOrg(orgId);
    });

    it("rejects cross-origin refresh with a JSON 403", async () => {
        const { orgId, email } = await makeUser();
        const first = await request(app).post("/api/auth/login").send({ username: email, password: PASSWORD });
        const refreshCookie = setCookies(first).find(c => c.startsWith("pharmasuite_refresh="))!.split(";")[0];

        const res = await request(app)
            .post("/api/auth/refresh")
            .set("Cookie", refreshCookie)
            .set("Origin", "https://evil.test")
            .send({});
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ success: false, data: null, code: "FORBIDDEN" });
        await destroyOrg(orgId);
    });

    it("logout clears both cookies", async () => {
        const { orgId, email } = await makeUser();
        const agent = request.agent(app);
        await agent.post("/api/auth/login").send({ username: email, password: PASSWORD });
        const res = await agent.post("/api/auth/logout");
        expect(res.status).toBe(200);
        const cleared = setCookies(res).join(";");
        expect(cleared).toMatch(/pharmasuite_access=;/);
        expect(cleared).toMatch(/pharmasuite_refresh=;/);

        const me = await agent.get("/api/auth/me");
        expect(me.status).toBe(401);
        await destroyOrg(orgId);
    });
});
