import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "../src/lib/prisma";
import { AppError } from "../src/domain/errors";
import {
  ensureSubscription,
  getMySubscription,
  selectPlan,
  verifyPayment,
  adminUpdateSubscription,
  assertSeatLimit,
  isAccessActive,
} from "../src/services/subscription.service";

const { sendSubscriptionNoticeMock } = vi.hoisted(() => ({
  sendSubscriptionNoticeMock: vi.fn(),
}));

vi.mock("../src/services/email/email.service", () => ({
  sendOtpEmail: vi.fn(),
  sendSubscriptionNotice: sendSubscriptionNoticeMock,
}));

let createdOrgIds: string[] = [];

async function makeOrg() {
  const code = `SUB-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const org = await prisma.organization.create({ data: { name: "Subscription Test Org", code } });
  createdOrgIds.push(org.id);
  const hash = await (await import("bcryptjs")).hash("Password123", 10);
  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `sub-${code}@test.local`,
      fullName: "Sub Owner",
      passwordHash: hash,
      role: "OWNER",
    },
  });
  await prisma.branch.create({
    data: { organizationId: org.id, name: "Main", code: "SUB01" },
  });
  return { orgId: org.id, userId: user.id };
}

async function destroyOrg(orgId: string) {
  createdOrgIds = createdOrgIds.filter(id => id !== orgId);
  await prisma.paymentRecord.deleteMany({ where: { organizationId: orgId } });
  await prisma.subscription.deleteMany({ where: { organizationId: orgId } });
  await prisma.alert.deleteMany({ where: { organizationId: orgId } });
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.branch.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
}

beforeAll(async () => {
  sendSubscriptionNoticeMock.mockResolvedValue({ sent: false, channel: "console" });
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

describe("Subscription module", () => {
  it("ensureSubscription lazily creates a 14-day TRIALING subscription", async () => {
    const { orgId } = await makeOrg();
    const sub = await ensureSubscription(orgId);
    expect(sub.tier).toBe("TRIAL_14_DAYS");
    expect(sub.status).toBe("TRIALING");
    const days = Math.round((sub.trialEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    expect(days).toBeGreaterThanOrEqual(13);
    expect(days).toBeLessThanOrEqual(14);
    await destroyOrg(orgId);
  });

  it("getMySubscription reports plan, access window and limits used", async () => {
    const { orgId } = await makeOrg();
    const snap = await getMySubscription(orgId);
    expect(snap.plan.tier).toBe("TRIAL_14_DAYS");
    expect(snap.access.active).toBe(true);
    expect(snap.limits.seatsUsed).toBe(1);
    expect(snap.limits.branchesUsed).toBe(1);
    expect(snap.limits.seatsLabel).toBe("1/2 seats used");
    await destroyOrg(orgId);
  });

  it("selecting a paid plan flips status to PENDING_VERIFICATION and records payment", async () => {
    const { orgId, userId } = await makeOrg();
    await selectPlan(orgId, userId, {
      tier: "STANDARD",
      billingCycle: "MONTHLY",
      paymentMode: "UPI",
      transactionRef: "UTR123456789",
    });

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: orgId } });
    expect(sub.tier).toBe("STANDARD");
    expect(sub.status).toBe("PENDING_VERIFICATION");

    const payment = await prisma.paymentRecord.findFirstOrThrow({
      where: { organizationId: orgId },
    });
    expect(payment.amount.toString()).toBe("1299");
    expect(payment.paymentMode).toBe("UPI");
    expect(payment.transactionRef).toBe("UTR123456789");
    expect(payment.status).toBe("DUE");

    const snap = await getMySubscription(orgId);
    expect(snap.payments).toHaveLength(1);
    await destroyOrg(orgId);
  });

  it("approving a payment activates the plan and extends the period by 30 days", async () => {
    const { orgId, userId } = await makeOrg();
    const admin = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `sub-admin-${Date.now()}@test.local`,
        fullName: "Platform Admin",
        passwordHash: await (await import("bcryptjs")).hash("Password123", 10),
        role: "SUPER_ADMIN",
      },
    });
    await selectPlan(orgId, userId, { tier: "BASIC", billingCycle: "MONTHLY", paymentMode: "UPI", transactionRef: "UTR987654321" });
    const payment = await prisma.paymentRecord.findFirstOrThrow({ where: { organizationId: orgId } });
    const before = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: orgId } });

    await verifyPayment(admin.id, { paymentRecordId: payment.id, action: "APPROVE" });

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: orgId } });
    expect(sub.status).toBe("ACTIVE");
    expect(sub.tier).toBe("BASIC");
    const diffDays = Math.round((sub.currentPeriodEnd.getTime() - before.currentPeriodEnd.getTime()) / (24 * 60 * 60 * 1000));
    expect(diffDays).toBeGreaterThanOrEqual(29);
    expect(diffDays).toBeLessThanOrEqual(30);

    const updated = await prisma.paymentRecord.findUniqueOrThrow({ where: { id: payment.id } });
    expect(updated.status).toBe("PAID");
    expect(updated.verifiedById).toBe(admin.id);
    expect(sendSubscriptionNoticeMock).toHaveBeenCalled();
    await destroyOrg(orgId);
  });

  it("rejecting a payment marks the subscription PAST_DUE and notifies the owner", async () => {
    const { orgId, userId } = await makeOrg();
    const admin = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `sub-admin-${Date.now()}@test.local`,
        fullName: "Platform Admin",
        passwordHash: await (await import("bcryptjs")).hash("Password123", 10),
        role: "SUPER_ADMIN",
      },
    });
    await selectPlan(orgId, userId, { tier: "BASIC", billingCycle: "MONTHLY", transactionRef: "UTR000000000" });
    const payment = await prisma.paymentRecord.findFirstOrThrow({ where: { organizationId: orgId } });

    await verifyPayment(admin.id, { paymentRecordId: payment.id, action: "REJECT" });

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: orgId } });
    expect(sub.status).toBe("PAST_DUE");
    expect(sendSubscriptionNoticeMock).toHaveBeenCalled();
    await destroyOrg(orgId);
  });

  it("approving a rejected payment again throws ALREADY_VERIFIED only after first approval", async () => {
    const { orgId, userId } = await makeOrg();
    const admin = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `sub-admin-${Date.now()}@test.local`,
        fullName: "Platform Admin",
        passwordHash: await (await import("bcryptjs")).hash("Password123", 10),
        role: "SUPER_ADMIN",
      },
    });
    await selectPlan(orgId, userId, { tier: "BASIC", billingCycle: "MONTHLY", transactionRef: "UTR555555555" });
    const payment = await prisma.paymentRecord.findFirstOrThrow({ where: { organizationId: orgId } });
    await verifyPayment(admin.id, { paymentRecordId: payment.id, action: "APPROVE" });
    await expect(
      verifyPayment(admin.id, { paymentRecordId: payment.id, action: "APPROVE" }),
    ).rejects.toMatchObject({ code: "ALREADY_VERIFIED" });
    await destroyOrg(orgId);
  });

  it("adminUpdateSubscription can grant an extended trial and override status", async () => {
    const { orgId } = await makeOrg();
    const admin = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `sub-admin-${Date.now()}@test.local`,
        fullName: "Platform Admin",
        passwordHash: await (await import("bcryptjs")).hash("Password123", 10),
        role: "SUPER_ADMIN",
      },
    });
    const sub = await ensureSubscription(orgId);
    const newTrialEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await adminUpdateSubscription(admin.id, sub.id, {
      status: "ACTIVE",
      tier: "STANDARD",
      trialEndsAt: newTrialEnd,
      note: "Support extension",
    });

    const updated = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(updated.status).toBe("ACTIVE");
    expect(updated.tier).toBe("STANDARD");
    expect(updated.trialEndsAt.getTime()).toBeCloseTo(newTrialEnd.getTime(), -2);
    await destroyOrg(orgId);
  });

  it("assertSeatLimit blocks a third seat on BASIC but allows multiple on PREMIUM", async () => {
    const { orgId } = await makeOrg();
    const sub = await ensureSubscription(orgId);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { tier: "BASIC", status: "ACTIVE" },
    });
    const hash = await (await import("bcryptjs")).hash("Password123", 10);
    await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `sub-second-${Date.now()}@test.local`,
        fullName: "Second Member",
        passwordHash: hash,
        role: "MANAGER",
      },
    });
    await expect(assertSeatLimit(orgId)).rejects.toMatchObject({ code: "SEAT_LIMIT_REACHED" });

    await prisma.subscription.update({
      where: { id: sub.id },
      data: { tier: "PREMIUM", status: "ACTIVE" },
    });
    await expect(assertSeatLimit(orgId)).resolves.toBeUndefined();
    await destroyOrg(orgId);
  });

  it("isAccessActive respects expired windows", () => {
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 1000);
    expect(isAccessActive({ status: "ACTIVE", currentPeriodEnd: future, trialEndsAt: past })).toBe(true);
    expect(isAccessActive({ status: "EXPIRED", currentPeriodEnd: past, trialEndsAt: past })).toBe(false);
  });

  it("unknown payment record yields a 404 AppError", async () => {
    await expect(
      verifyPayment("nobody", { paymentRecordId: "missing", action: "APPROVE" }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
