import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTenantContextService } from "../src/server/tenancy/tenant-context-service.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

function poolWith(row) {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes("FROM restaurant_memberships")) return { rows: row ? [row] : [] };
      return { rows: [] };
    },
    release() {},
  };
  return { calls, async connect() { return client; } };
}

describe("tenant context service", () => {
  it("loads membership, restaurant, branch, and subscription under RLS", async () => {
    const pool = poolWith({
      restaurant_id: restaurantId,
      restaurant_name: "Example Cafe",
      restaurant_status: "active",
      restaurant_timezone: "Asia/Karachi",
      currency_code: "PKR",
      user_id: userId,
      role: "owner",
      membership_status: "active",
      default_branch_id: "33333333-3333-4333-8333-333333333333",
      subscription_id: "44444444-4444-4444-8444-444444444444",
      subscription_status: "active",
      current_period_end: "2026-11-02T00:00:00Z",
      trial_ends_at: null,
      grace_ends_at: null,
    });
    const context = await createTenantContextService(pool).load({ userId, restaurantId });

    assert.equal(context.restaurant.id, restaurantId);
    assert.equal(context.membership.role, "owner");
    assert.equal(context.subscription.status, "active");
    const contextCall = pool.calls.find((call) => call.text.includes("set_config('app.restaurant_id'"));
    assert.deepEqual(contextCall.values, [restaurantId]);
  });

  it("returns null when the user has no active membership", async () => {
    const context = await createTenantContextService(poolWith(null)).load({ userId, restaurantId });
    assert.equal(context, null);
  });

  it("rejects malformed identifiers before acquiring a database connection", async () => {
    let connected = false;
    const service = createTenantContextService({ async connect() { connected = true; } });
    assert.equal(await service.load({ userId, restaurantId: "attacker-value" }), null);
    assert.equal(connected, false);
  });
});
