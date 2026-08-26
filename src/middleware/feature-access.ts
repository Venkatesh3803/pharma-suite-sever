import type { NextFunction, Request, Response } from "express";
import type { SubscriptionTier } from "@prisma/client";
import { AppError } from "../domain/errors";
import { TIER_CONFIG } from "../domain/plans";
import { ensureSubscription, isAccessActive } from "../services/subscription.service";

declare global {
  namespace Express {
    interface Request {
      subscriptionTier?: SubscriptionTier;
      subscriptionAccessActive?: boolean;
    }
  }
}

/**
 * Global feature-gating middleware.
 *
 * 1. Active Check  — the subscription must be inside `currentPeriodEnd` or
 *    `trialEndsAt`. When access has lapsed, read-only requests (GET/HEAD) are
 *    still allowed but mutations are locked with `402 Payment Required`.
 * 2. Tier Check    — when `requiredTier` is supplied the organization's tier
 *    must meet or exceed it, otherwise the feature is denied with `403`.
 *
 * The loaded subscription is attached to `req.subscriptionTier` so downstream
 * handlers can rely on it without a second query.
 */
export function checkFeatureAccess(requiredTier: SubscriptionTier | null = null) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const organizationId = req.organizationId ?? req.user?.organizationId;
      if (!organizationId) {
        next(new AppError("Organization context is required.", 403, "FORBIDDEN"));
        return;
      }

      const subscription = await ensureSubscription(organizationId);
      req.subscriptionTier = subscription.tier;
      req.subscriptionAccessActive = isAccessActive(subscription);

      if (!isAccessActive(subscription)) {
        const method = req.method.toUpperCase();
        if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
          next(
            new AppError(
              "Subscription expired. Please renew your plan to continue billing.",
              402,
              "PAYMENT_REQUIRED",
            ),
          );
          return;
        }
      }

      if (requiredTier) {
        const meetsTier = TIER_CONFIG[subscription.tier].rank >= TIER_CONFIG[requiredTier].rank;
        if (!meetsTier) {
          next(
            new AppError(
              `This feature requires the ${TIER_CONFIG[requiredTier].displayName} or higher.`,
              403,
              "TIER_ACCESS_DENIED",
            ),
          );
          return;
        }
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
