import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PERMISSION } from "../src/server/authorization/permissions.mjs";
import { createRequestGuards } from "../src/server/http/request-guards.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

function replyFixture() {
  return {
    statusCode: 200,
    payload: null,
    code(value) { this.statusCode = value; return this; },
    send(value) { this.payload = value; return this; },
  };
}

function context({ role = "cashier", subscriptionStatus = "active" } = {}) {
  return {
    restaurant: { id: restaurantId, status: "active" },
    membership: { userId, role, status: "active", defaultBranchId: "branch" },
    subscription: {
      status: subscriptionStatus,
      currentPeriodEnd: "2999-01-01T00:00:00Z",
    },
  };
}

function guardsWith({ session = { user: { id: userId } }, tenant = context() } = {}) {
  return createRequestGuards({
    authService: { async authenticate() { return session; } },
    tenantContextService: { async load() { return tenant; } },
  });
}

describe("authenticated tenant request guards", () => {
  it("rejects a request without an active session", async () => {
    const guards = guardsWith({ session: null });
    const request = { cookies: {}, headers: {} };
    const reply = replyFixture();
    await guards.authenticate(request, reply);

    assert.equal(reply.statusCode, 401);
    assert.equal(request.auth, undefined);
  });

  it("rejects missing or malformed restaurant context", async () => {
    const guards = guardsWith();
    const request = { auth: { user: { id: userId } }, headers: { "x-restaurant-id": "bad" } };
    const reply = replyFixture();
    await guards.tenant(PERMISSION.ORDER_CREATE)(request, reply);

    assert.equal(reply.statusCode, 400);
  });

  it("rejects access when no matching active membership exists", async () => {
    const guards = guardsWith({ tenant: null });
    const request = { auth: { user: { id: userId } }, headers: { "x-restaurant-id": restaurantId } };
    const reply = replyFixture();
    await guards.tenant(PERMISSION.ORDER_CREATE)(request, reply);

    assert.equal(reply.statusCode, 403);
    assert.equal(reply.payload.code, "MEMBERSHIP_REQUIRED");
  });

  it("checks role permission before exposing tenant context", async () => {
    const guards = guardsWith({ tenant: context({ role: "kitchen" }) });
    const request = { auth: { user: { id: userId } }, headers: { "x-restaurant-id": restaurantId } };
    const reply = replyFixture();
    await guards.tenant(PERMISSION.PAYMENT_PROCESS)(request, reply);

    assert.equal(reply.statusCode, 403);
    assert.equal(request.tenant, undefined);
  });

  it("blocks protected POS work for an expired subscription", async () => {
    const guards = guardsWith({ tenant: context({ subscriptionStatus: "expired" }) });
    const request = { auth: { user: { id: userId } }, headers: { "x-restaurant-id": restaurantId } };
    const reply = replyFixture();
    await guards.tenant(PERMISSION.ORDER_CREATE)(request, reply);

    assert.equal(reply.statusCode, 402);
    assert.equal(reply.payload.code, "SUBSCRIPTION_REQUIRED");
  });

  it("attaches trusted context only after every gate succeeds", async () => {
    const guards = guardsWith();
    const request = { auth: { user: { id: userId } }, headers: { "x-restaurant-id": restaurantId } };
    const reply = replyFixture();
    await guards.tenant(PERMISSION.ORDER_CREATE)(request, reply);

    assert.equal(reply.statusCode, 200);
    assert.equal(request.tenant.restaurant.id, restaurantId);
    assert.equal(request.tenant.subscriptionAccess.level, "full");
  });
});
