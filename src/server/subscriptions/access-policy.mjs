export const ACCESS_LEVEL = Object.freeze({
  FULL: "full",
  BILLING_ONLY: "billing_only",
});

function future(dateValue, now) {
  if (!dateValue) return false;
  const timestamp = new Date(dateValue).getTime();
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function result(level, reason, warning = null) {
  return Object.freeze({ level, reason, warning });
}

/**
 * Computes the server-side entitlement for restaurant POS routes. Account,
 * billing, logout, and export routes may accept BILLING_ONLY; POS mutations may
 * only accept FULL.
 */
export function evaluateSubscriptionAccess(
  { restaurantStatus = "active", subscription = null } = {},
  now = new Date(),
) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid Date.");
  }
  if (restaurantStatus !== "active") {
    return result(ACCESS_LEVEL.BILLING_ONLY, `restaurant_${restaurantStatus}`);
  }
  if (!subscription) {
    return result(ACCESS_LEVEL.BILLING_ONLY, "subscription_missing");
  }

  switch (subscription.status) {
    case "active":
      return future(subscription.currentPeriodEnd, now)
        ? result(ACCESS_LEVEL.FULL, "subscription_active")
        : result(ACCESS_LEVEL.BILLING_ONLY, "subscription_period_ended");

    case "trialing":
      return future(subscription.trialEndsAt, now)
        ? result(ACCESS_LEVEL.FULL, "trial_active")
        : result(ACCESS_LEVEL.BILLING_ONLY, "trial_ended");

    case "past_due":
      return future(subscription.graceEndsAt, now)
        ? result(
            ACCESS_LEVEL.FULL,
            "past_due_grace",
            "Payment is overdue. Update billing details before the grace period ends.",
          )
        : result(ACCESS_LEVEL.BILLING_ONLY, "past_due_grace_ended");

    case "cancel_at_period_end":
      return future(subscription.currentPeriodEnd, now)
        ? result(
            ACCESS_LEVEL.FULL,
            "cancels_at_period_end",
            "The subscription will end at the close of the current billing period.",
          )
        : result(ACCESS_LEVEL.BILLING_ONLY, "cancelled_period_ended");

    case "cancelled":
    case "expired":
    case "suspended":
      return result(ACCESS_LEVEL.BILLING_ONLY, `subscription_${subscription.status}`);

    default:
      return result(ACCESS_LEVEL.BILLING_ONLY, "subscription_status_unknown");
  }
}

export function requireFullSubscriptionAccess(context, now = new Date()) {
  const decision = evaluateSubscriptionAccess(context, now);
  if (decision.level !== ACCESS_LEVEL.FULL) {
    const error = new Error("An active restaurant subscription is required.");
    error.code = "SUBSCRIPTION_REQUIRED";
    error.statusCode = 402;
    error.reason = decision.reason;
    throw error;
  }
  return decision;
}
