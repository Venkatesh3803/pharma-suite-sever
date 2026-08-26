import type { BillingCycle, PaymentMode, SubscriptionTier } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../domain/errors";
import {
  OFFLINE_PAYMENT_DETAILS,
  TIER_CONFIG,
  priceFor,
} from "../domain/plans";
import { sendSubscriptionNotice } from "./email/email.service";

const TRIAL_DAYS = 14;
const GRACE_ACCESS_DAYS = 14;

export interface SelectPlanInput {
  tier: SubscriptionTier;
  billingCycle?: BillingCycle;
  paymentMode?: PaymentMode;
  transactionRef?: string;
  proofUrl?: string;
}

export interface VerifyPaymentInput {
  paymentRecordId: string;
  action: "APPROVE" | "REJECT";
}

export interface AdminUpdateSubscriptionInput {
  status?: "TRIALING" | "PENDING_VERIFICATION" | "ACTIVE" | "PAST_DUE" | "EXPIRED" | "CANCELLED";
  tier?: SubscriptionTier;
  billingCycle?: BillingCycle;
  trialEndsAt?: Date;
  currentPeriodEnd?: Date;
  currentPeriodStart?: Date;
  note?: string;
}

export interface SubscriptionSnapshot {
  plan: {
    tier: SubscriptionTier;
    displayName: string;
    tagline: string;
    status: string;
    billingCycle: BillingCycle;
    monthlyPrice: number;
    annualPrice: number;
    features: string[];
  };
  expiry: {
    trialStartsAt: Date;
    trialEndsAt: Date;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
  };
  access: {
    active: boolean;
    daysRemaining: number;
  };
  limits: {
    maxUsers: number | null;
    maxBranches: number | null;
    seatsUsed: number;
    branchesUsed: number;
    seatsLabel: string;
    branchesLabel: string;
  };
  payments: {
    id: string;
    amount: number;
    paymentMode: string;
    transactionRef: string | null;
    proofUrl: string | null;
    status: string;
    notes: string | null;
    createdAt: Date;
  }[];
  offlinePayment: typeof OFFLINE_PAYMENT_DETAILS;
}

/** A subscription grants active access while its billing or trial window is live. */
export function isAccessActive(s: {
  status: string;
  trialEndsAt: Date;
  currentPeriodEnd: Date;
}): boolean {
  const now = new Date();
  return s.currentPeriodEnd > now || s.trialEndsAt > now;
}

export function accessDaysRemaining(s: {
  trialEndsAt: Date;
  currentPeriodEnd: Date;
}): number {
  const now = Date.now();
  const end = Math.max(s.trialEndsAt.getTime(), s.currentPeriodEnd.getTime());
  return Math.max(0, Math.ceil((end - now) / (24 * 60 * 60 * 1000)));
}

/**
 * Lazily guarantees a Subscription row exists for an organization. Organizations
 * created before this feature (or without one) get a fresh 14-day trial.
 */
export async function ensureSubscription(organizationId: string) {
  const existing = await prisma.subscription.findUnique({
    where: { organizationId },
  });
  if (existing) return existing;

  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  return prisma.subscription.create({
    data: {
      organizationId,
      tier: "TRIAL_14_DAYS",
      status: "TRIALING",
      billingCycle: "MONTHLY",
      trialStartsAt: now,
      trialEndsAt,
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt,
    },
  });
}

export async function getMySubscription(organizationId: string): Promise<SubscriptionSnapshot> {
  const subscription = await ensureSubscription(organizationId);

  const [seatsUsed, branchesUsed] = await Promise.all([
    prisma.user.count({ where: { organizationId, deletedAt: null } }),
    prisma.branch.count({ where: { organizationId, isActive: true } }),
  ]);

  const config = TIER_CONFIG[subscription.tier];
  const payments = await prisma.paymentRecord.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
  });

  const limits = {
    maxUsers: config.maxUsers,
    maxBranches: config.maxBranches,
    seatsUsed,
    branchesUsed,
    seatsLabel:
      config.maxUsers === null
        ? `${seatsUsed} unlimited`
        : `${seatsUsed}/${config.maxUsers} seats used`,
    branchesLabel:
      config.maxBranches === null
        ? `${branchesUsed} unlimited`
        : `${branchesUsed}/${config.maxBranches} branch${config.maxBranches === 1 ? "" : "es"} used`,
  };

  return {
    plan: {
      tier: subscription.tier,
      displayName: config.displayName,
      tagline: config.tagline,
      status: subscription.status,
      billingCycle: subscription.billingCycle,
      monthlyPrice: config.monthlyPrice,
      annualPrice: config.annualPrice,
      features: config.features,
    },
    expiry: {
      trialStartsAt: subscription.trialStartsAt,
      trialEndsAt: subscription.trialEndsAt,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
    },
    access: {
      active: isAccessActive(subscription),
      daysRemaining: accessDaysRemaining(subscription),
    },
    limits,
    payments: payments.map(p => ({
      id: p.id,
      amount: Number(p.amount),
      paymentMode: p.paymentMode,
      transactionRef: p.transactionRef,
      proofUrl: p.proofUrl,
      status: p.status,
      notes: p.notes,
      createdAt: p.createdAt,
    })),
    offlinePayment: OFFLINE_PAYMENT_DETAILS,
  };
}

/**
 * Upgrade/downgrade the organization plan or submit a new offline payment
 * reference. Paid tiers flip the subscription to PENDING_VERIFICATION while
 * granting a temporary access window so the pharmacy can keep working until
 * the SuperAdmin verifies the UTR.
 */
export async function selectPlan(
  organizationId: string,
  userId: string,
  input: SelectPlanInput,
) {
  if (!TIER_CONFIG[input.tier]) {
    throw new AppError("Invalid plan tier.", 400, "VALIDATION");
  }

  const subscription = await ensureSubscription(organizationId);
  const now = new Date();

  if (input.tier === "TRIAL_14_DAYS") {
    const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const updated = await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        tier: "TRIAL_14_DAYS",
        billingCycle: "MONTHLY",
        status: "TRIALING",
        trialStartsAt: now,
        trialEndsAt,
        currentPeriodStart: now,
        currentPeriodEnd: trialEndsAt,
      },
    });

    await prisma.auditLog.create({
      data: {
        organizationId,
        userId,
        action: "SUBSCRIPTION_UPDATED",
        entityType: "Subscription",
        entityId: subscription.id,
        metadata: { tier: updated.tier, status: updated.status },
      },
    });

    return getMySubscription(organizationId);
  }

  const cycle = input.billingCycle ?? "MONTHLY";
  const amount = priceFor(input.tier, cycle);
  const paymentMode = input.paymentMode ?? "UPI";

  // Keep the organization working while the offline payment is verified.
  const trialEndsAt =
    subscription.trialEndsAt > now
      ? subscription.trialEndsAt
      : new Date(now.getTime() + GRACE_ACCESS_DAYS * 24 * 60 * 60 * 1000);
  const currentPeriodEnd =
    subscription.currentPeriodEnd > now
      ? subscription.currentPeriodEnd
      : new Date(now.getTime() + GRACE_ACCESS_DAYS * 24 * 60 * 60 * 1000);

  const updated = await prisma.$transaction(async tx => {
    const sub = await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        tier: input.tier,
        billingCycle: cycle,
        status: "PENDING_VERIFICATION",
        trialStartsAt: subscription.trialStartsAt,
        trialEndsAt,
        currentPeriodStart: now,
        currentPeriodEnd,
      },
    });

    await tx.paymentRecord.create({
      data: {
        subscriptionId: sub.id,
        organizationId,
        amount,
        paymentMode,
        transactionRef: input.transactionRef?.trim() || null,
        proofUrl: input.proofUrl?.trim() || null,
        status: "DUE",
        notes: `Offline ${cycle === "ANNUAL" ? "annual" : "monthly"} payment for ${input.tier}`,
      },
    });

    return sub;
  });

  await prisma.auditLog.create({
    data: {
      organizationId,
      userId,
      action: "SUBSCRIPTION_UPDATED",
      entityType: "Subscription",
      entityId: subscription.id,
      metadata: { tier: updated.tier, status: updated.status, cycle },
    },
  });

  return getMySubscription(organizationId);
}

export async function listSubscriptions() {
  const rows = await prisma.subscription.findMany({
    include: {
      organization: { select: { id: true, name: true, code: true, gstin: true } },
      _count: { select: { payments: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  return rows.map(s => ({
    id: s.id,
    organization: s.organization,
    tier: s.tier,
    status: s.status,
    billingCycle: s.billingCycle,
    trialStartsAt: s.trialStartsAt,
    trialEndsAt: s.trialEndsAt,
    currentPeriodStart: s.currentPeriodStart,
    currentPeriodEnd: s.currentPeriodEnd,
    updatedAt: s.updatedAt,
    paymentCount: s._count.payments,
    active: isAccessActive(s),
  }));
}

export async function listPendingPayments() {
  const payments = await prisma.paymentRecord.findMany({
    where: { status: "DUE" },
    include: {
      subscription: { select: { id: true, tier: true, billingCycle: true, status: true } },
      organization: { select: { id: true, name: true, code: true, gstin: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return payments.map(p => ({
    id: p.id,
    organization: p.organization,
    subscription: p.subscription,
    amount: Number(p.amount),
    paymentMode: p.paymentMode,
    transactionRef: p.transactionRef,
    proofUrl: p.proofUrl,
    notes: p.notes,
    createdAt: p.createdAt,
  }));
}

async function notifyOrganization(
  organizationId: string,
  title: string,
  message: string,
) {
  await prisma.alert.create({
    data: {
      organizationId,
      type: "SYSTEM",
      severity: "HIGH",
      status: "ACTIVE",
      title,
      message,
      entityType: "Subscription",
    },
  });

  const owner = await prisma.user.findFirst({
    where: { organizationId, deletedAt: null, role: { in: ["SUPER_ADMIN", "OWNER"] }, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
  });
  if (owner) {
    try {
      await sendSubscriptionNotice({
        to: { email: owner.email, name: owner.fullName },
        title,
        body: message,
      });
    } catch (err) {
      console.error("[SUBSCRIPTION] Notification email failed:", err);
    }
  }
}

/** Verified by a SUPER_ADMIN: approve marks payment PAID + extends the period. */
export async function verifyPayment(adminUserId: string, input: VerifyPaymentInput) {
  const payment = await prisma.paymentRecord.findUnique({
    where: { id: input.paymentRecordId },
    include: { subscription: true, organization: true },
  });
  if (!payment) {
    throw new AppError("Payment record not found.", 404, "NOT_FOUND");
  }
  if (payment.status === "PAID") {
    throw new AppError("This payment has already been verified.", 400, "ALREADY_VERIFIED");
  }

  if (input.action === "REJECT") {
    await prisma.$transaction([
      prisma.paymentRecord.update({
        where: { id: payment.id },
        data: {
          notes: payment.notes ? `${payment.notes}. Payment rejected by admin.` : "Payment rejected by admin.",
        },
      }),
      prisma.subscription.update({
        where: { id: payment.subscriptionId },
        data: { status: "PAST_DUE" },
      }),
    ]);
    await prisma.auditLog.create({
      data: {
        organizationId: payment.organizationId,
        userId: adminUserId,
        action: "PAYMENT_VERIFIED",
        entityType: "PaymentRecord",
        entityId: payment.id,
        metadata: { decision: "REJECT" },
      },
    });
    await notifyOrganization(
      payment.organizationId,
      "Offline payment could not be verified",
      "Your recent plan payment could not be verified. Your account is now in a past-due state. Please submit the correct UTR / transaction reference to continue.",
    );
    return getMySubscription(payment.organizationId);
  }

  // APPROVE
  const now = new Date();
  const cycleDays = payment.subscription.billingCycle === "ANNUAL" ? 365 : 30;
  const base = payment.subscription.currentPeriodEnd > now ? payment.subscription.currentPeriodEnd : now;
  const currentPeriodEnd = new Date(base.getTime() + cycleDays * 24 * 60 * 60 * 1000);

  await prisma.$transaction([
    prisma.paymentRecord.update({
      where: { id: payment.id },
      data: {
        status: "PAID",
        verifiedById: adminUserId,
        verifiedAt: now,
      },
    }),
    prisma.subscription.update({
      where: { id: payment.subscriptionId },
      data: {
        status: "ACTIVE",
        currentPeriodStart: now,
        currentPeriodEnd,
        trialEndsAt: currentPeriodEnd,
      },
    }),
  ]);

  await prisma.auditLog.create({
    data: {
      organizationId: payment.organizationId,
      userId: adminUserId,
      action: "PAYMENT_VERIFIED",
      entityType: "PaymentRecord",
      entityId: payment.id,
      metadata: { decision: "APPROVE", cycleDays },
    },
  });

  await notifyOrganization(
    payment.organizationId,
    `Your ${payment.subscription.tier} plan is active`,
    `Payment of ₹${Number(payment.amount).toLocaleString("en-IN")} was verified. Your plan is active until ${currentPeriodEnd.toLocaleDateString("en-IN")}.`,
  );

  return getMySubscription(payment.organizationId);
}

/** SuperAdmin manual override: adjust status, expiry, or grant extended trials. */
export async function adminUpdateSubscription(
  adminUserId: string,
  subscriptionId: string,
  input: AdminUpdateSubscriptionInput,
) {
  const existing = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { organization: { select: { id: true, name: true } } },
  });
  if (!existing) {
    throw new AppError("Subscription not found.", 404, "NOT_FOUND");
  }

  const data: Record<string, unknown> = {};
  if (input.status !== undefined) data.status = input.status;
  if (input.tier !== undefined) data.tier = input.tier;
  if (input.billingCycle !== undefined) data.billingCycle = input.billingCycle;
  if (input.trialEndsAt !== undefined) data.trialEndsAt = input.trialEndsAt;
  if (input.currentPeriodEnd !== undefined) data.currentPeriodEnd = input.currentPeriodEnd;
  if (input.currentPeriodStart !== undefined) data.currentPeriodStart = input.currentPeriodStart;

  const updated = await prisma.subscription.update({
    where: { id: subscriptionId },
    data,
    include: {
      organization: { select: { id: true, name: true, code: true } },
      payments: { orderBy: { createdAt: "desc" } },
    },
  });

  await prisma.auditLog.create({
    data: {
      organizationId: existing.organizationId,
      userId: adminUserId,
      action: "SUBSCRIPTION_UPDATED",
      entityType: "Subscription",
      entityId: subscriptionId,
      metadata: { updated: Object.keys(data), note: input.note ?? null },
    },
  });

  if (input.note) {
    await notifyOrganization(
      existing.organizationId,
      "Your subscription was updated by PharmaSuite support",
      input.note,
    );
  }

  return {
    id: updated.id,
    organization: updated.organization,
    tier: updated.tier,
    status: updated.status,
    billingCycle: updated.billingCycle,
    trialStartsAt: updated.trialStartsAt,
    trialEndsAt: updated.trialEndsAt,
    currentPeriodStart: updated.currentPeriodStart,
    currentPeriodEnd: updated.currentPeriodEnd,
    updatedAt: updated.updatedAt,
    payments: updated.payments.map(p => ({
      id: p.id,
      amount: Number(p.amount),
      paymentMode: p.paymentMode,
      transactionRef: p.transactionRef,
      status: p.status,
      createdAt: p.createdAt,
    })),
  };
}

/** Enforces the per-tier user seat limit before creating a user. */
export async function assertSeatLimit(organizationId: string): Promise<void> {
  const subscription = await ensureSubscription(organizationId);
  const config = TIER_CONFIG[subscription.tier];
  if (config.maxUsers === null) return;

  const used = await prisma.user.count({ where: { organizationId, deletedAt: null } });
  if (used >= config.maxUsers) {
    throw new AppError(
      `Your ${config.displayName} allows ${config.maxUsers} user seat${config.maxUsers === 1 ? "" : "s"}. Upgrade to add more team members.`,
      402,
      "SEAT_LIMIT_REACHED",
    );
  }
}

/** Enforces the per-tier branch limit before creating a branch. */
export async function assertBranchLimit(organizationId: string): Promise<void> {
  const subscription = await ensureSubscription(organizationId);
  const config = TIER_CONFIG[subscription.tier];
  if (config.maxBranches === null) return;

  const used = await prisma.branch.count({ where: { organizationId, isActive: true } });
  if (used >= config.maxBranches) {
    throw new AppError(
      `Your ${config.displayName} allows ${config.maxBranches} branch${config.maxBranches === 1 ? "" : "es"}. Upgrade to enable multi-branch.`,
      402,
      "BRANCH_LIMIT_REACHED",
    );
  }
}
