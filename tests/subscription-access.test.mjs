import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACCESS_LEVEL,
  evaluateSubscriptionAccess,
  requireFullSubscriptionAccess,
} from "../src/server/subscriptions/access-policy.mjs";

const now = new Date("2026-10-02T12:00:00.000Z");
const future = "2026-11-02T12:00:00.000Z";
const past = "2026-09-02T12:00:00.000Z";

describe("restaurant subscription access policy", () => {
  it("grants active and current subscriptions full POS access", () => {
    const decision = evaluateSubscriptionAccess(
      { subscription: { status: "active", currentPeriodEnd: future } },
      now,
    );

    assert.equal(decision.level, ACCESS_LEVEL.FULL);
  });

  it("allows a past-due restaurant only during its grace period", () => {
    const duringGrace = evaluateSubscriptionAccess(
      { subscription: { status: "past_due", graceEndsAt: future } },
      now,
    );
    const afterGrace = evaluateSubscriptionAccess(
      { subscription: { status: "past_due", graceEndsAt: past } },
      now,
    );

    assert.equal(duringGrace.level, ACCESS_LEVEL.FULL);
    assert.ok(duringGrace.warning);
    assert.equal(afterGrace.level, ACCESS_LEVEL.BILLING_ONLY);
  });

  it("honors cancellation through the already-paid period", () => {
    assert.equal(
      evaluateSubscriptionAccess(
        { subscription: { status: "cancel_at_period_end", currentPeriodEnd: future } },
        now,
      ).level,
      ACCESS_LEVEL.FULL,
    );
    assert.equal(
      evaluateSubscriptionAccess(
        { subscription: { status: "cancel_at_period_end", currentPeriodEnd: past } },
        now,
      ).level,
      ACCESS_LEVEL.BILLING_ONLY,
    );
  });

  it("restricts expired subscriptions but leaves billing-level access", () => {
    for (const status of ["cancelled", "expired", "suspended"]) {
      assert.equal(
        evaluateSubscriptionAccess({ subscription: { status } }, now).level,
        ACCESS_LEVEL.BILLING_ONLY,
      );
    }
  });

  it("lets platform suspension override a paid subscription", () => {
    const decision = evaluateSubscriptionAccess(
      {
        restaurantStatus: "suspended",
        subscription: { status: "active", currentPeriodEnd: future },
      },
      now,
    );

    assert.equal(decision.level, ACCESS_LEVEL.BILLING_ONLY);
    assert.equal(decision.reason, "restaurant_suspended");
  });

  it("raises a payment-required error at the protected POS boundary", () => {
    assert.throws(
      () => requireFullSubscriptionAccess({ subscription: null }, now),
      (error) =>
        error.code === "SUBSCRIPTION_REQUIRED" && error.statusCode === 402,
    );
  });
});
