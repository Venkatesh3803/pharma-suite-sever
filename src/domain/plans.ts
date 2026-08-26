import type { BillingCycle, SubscriptionTier } from "@prisma/client";

export type TierKey = SubscriptionTier;

export interface TierConfig {
  key: TierKey;
  displayName: string;
  tagline: string;
  monthlyPrice: number;
  annualPrice: number;
  /** Rank used for tier comparisons. Higher = more access. */
  rank: number;
  /** Max active (non-deleted) users; null = unlimited. */
  maxUsers: number | null;
  /** Max active branches; null = unlimited. */
  maxBranches: number | null;
  features: string[];
}

/**
 * The subscription tier matrix. Prices are in INR.
 * TRIAL_14_DAYS grants the full Standard feature set for 14 days,
 * so its effective limits mirror the STANDARD plan.
 */
export const TIER_CONFIG: Record<TierKey, TierConfig> = {
  TRIAL_14_DAYS: {
    key: "TRIAL_14_DAYS",
    displayName: "14-Day Free Trial",
    tagline: "Full Standard features. No payment details required.",
    monthlyPrice: 0,
    annualPrice: 0,
    rank: 2,
    maxUsers: 2,
    maxBranches: 1,
    features: [
      "Full access to Standard features for 14 days",
      "2 user seats (Owner + Manager)",
      "1 store branch",
      "POS billing & offline counter",
      "Stock & expiry alerts",
      "GST invoices",
    ],
  },
  BASIC: {
    key: "BASIC",
    displayName: "Basic Plan",
    tagline: "For single-store pharmacies just getting started.",
    monthlyPrice: 599,
    annualPrice: 4999,
    rank: 1,
    maxUsers: 2,
    maxBranches: 1,
    features: [
      "2 user seats (Owner + Manager)",
      "1 store branch",
      "Basic POS billing",
      "Stock & expiry alerts",
      "GST invoices",
    ],
  },
  STANDARD: {
    key: "STANDARD",
    displayName: "Standard Plan",
    tagline: "The most popular choice for growing pharmacies.",
    monthlyPrice: 1299,
    annualPrice: 11999,
    rank: 2,
    maxUsers: 3,
    maxBranches: 1,
    features: [
      "3 user seats",
      "POS offline auto-sync",
      "Schedule H / H1 digital registers",
      "Dynamic reorder suggestions",
    ],
  },
  PREMIUM: {
    key: "PREMIUM",
    displayName: "Premium Plan",
    tagline: "Unlimited everything for multi-branch chains.",
    monthlyPrice: 2500,
    annualPrice: 23999,
    rank: 3,
    maxUsers: null,
    maxBranches: null,
    features: [
      "Unlimited users",
      "Multi-branch stock transfers",
      "Advanced analytics",
      "Direct REST API access",
    ],
  },
};

export const PAID_TIERS: TierKey[] = ["BASIC", "STANDARD", "PREMIUM"];

/** A TierConfig is satisfiable when orgTier is defined and its rank meets/exceeds required rank. */
export function tierSatisfies(orgTier: TierKey, requiredTier: TierKey): boolean {
  return TIER_CONFIG[orgTier].rank >= TIER_CONFIG[requiredTier].rank;
}

export function priceFor(tier: TierKey, cycle: BillingCycle): number {
  return cycle === "ANNUAL" ? TIER_CONFIG[tier].annualPrice : TIER_CONFIG[tier].monthlyPrice;
}

export function isPaidTier(tier: TierKey): boolean {
  return PAID_TIERS.includes(tier);
}

/** Offline payment instructions surfaced to organizations on plan selection. */
export const OFFLINE_PAYMENT_DETAILS = {
  upiId: "pharmasuite@hdfcbank",
  upiQrHint: "Scan any UPI app (GPay / PhonePe / Paytm) to pay.",
  bank: {
    beneficiary: "PharmaSuite Retail Solutions Pvt Ltd",
    bankName: "HDFC Bank",
    accountNumber: "50200087654321",
    ifsc: "HDFC0001234",
  },
  note: "After paying, submit the UTR / transaction reference number below. Our team verifies and activates your plan within a few hours.",
};
