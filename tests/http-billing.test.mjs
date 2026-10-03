import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildHttpApp } from "../src/server/http/app.mjs";

const apps = [];
const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

function tenant(role = "owner", subscriptionStatus = "active") {
  return {
    restaurant: {
      id: restaurantId,
      name: "Example Cafe",
      status: "active",
      currencyCode: "PKR",
    },
    membership: { userId, role, status: "active", defaultBranchId: "branch-1" },
    subscription: {
      status: subscriptionStatus,
      currentPeriodEnd: "2999-01-01T00:00:00Z",
    },
  };
}

async function makeApp({ role = "owner", subscriptionStatus = "active" } = {}) {
  const calls = [];
  const app = await buildHttpApp({
    trustedOrigin: "https://pos.example.com",
    secureCookies: true,
    authService: {
      async authenticate(token) {
        return token ? { user: { id: userId, email: "owner@example.com" } } : null;
      },
      async register() {}, async verifyEmail() {}, async login() {}, async logout() {},
    },
    tenantContextService: {
      async load() { return tenant(role, subscriptionStatus); },
    },
    subscriptionService: {
      async overview(input) {
        calls.push(["billing:overview", input]);
        return { plans: [], subscription: { status: "active" } };
      },
      async startCheckout(input) {
        calls.push(["billing:checkout", input]);
        return {
          checkoutUrl: "https://checkout.example.com/session",
          plan: { code: input.planCode, name: "Standard" },
          amountMinor: 25_000,
          currencyCode: "PKR",
          status: "awaiting_payment",
        };
      },
      async changePlan(input) {
        calls.push(["billing:change-plan", input]);
        return { plan: { code: input.planCode, name: "Growth" }, providerStatus: "active" };
      },
      async cancel(input) {
        calls.push(["billing:cancel", input]);
        return { cancelAtPeriodEnd: input.cancelAtPeriodEnd, accessUntil: null };
      },
      async resume(input) {
        calls.push(["billing:resume", input]);
        return { status: "active" };
      },
      async paymentHistory(input) {
        calls.push(["billing:payments", input]);
        return [{ id: "payment-1", status: "succeeded", amountMinor: 25_000 }];
      },
    },
    billingWebhookService: {
      webhookSignatureHeader: "stripe-signature",
      async handle({ rawBody, signatureHeader }) {
        calls.push(["billing:webhook", {
          rawBody: rawBody?.toString?.("utf8") ?? rawBody,
          signatureHeader,
        }]);
        if (!signatureHeader) return { accepted: false, retryable: false, reason: "signature_missing" };
        if (signatureHeader.includes("route-missing")) {
          // A real billing event the server could not resolve. This must not be
          // answered 200, or the provider stops retrying a payment it took.
          return { accepted: false, retryable: true, reason: "restaurant_route_missing" };
        }
        return { accepted: true, duplicate: false, applied: true, status: "active" };
      },
    },
  });
  apps.push(app);
  return { app, calls };
}

const authenticatedHeaders = {
  cookie: `pos_session=${"s".repeat(43)}`,
  "x-restaurant-id": restaurantId,
  origin: "https://pos.example.com",
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("billing HTTP endpoints", () => {
  it("shows plans and the current subscription to an owner", async () => {
    const { app, calls } = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/billing",
      headers: authenticatedHeaders,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().subscription.status, "active");
    assert.equal(calls[0][0], "billing:overview");
  });

  it("keeps billing away from every other role", async () => {
    const { app, calls } = await makeApp({ role: "manager" });
    const response = await app.inject({
      method: "GET",
      url: "/api/billing",
      headers: authenticatedHeaders,
    });

    assert.equal(response.statusCode, 403);
    assert.equal(calls.length, 0);
  });

  it("still allows billing management after paid access expires", async () => {
    const { app, calls } = await makeApp({ subscriptionStatus: "expired" });
    const response = await app.inject({
      method: "GET",
      url: "/api/billing",
      headers: authenticatedHeaders,
    });

    // Losing POS access must never strand a restaurant in a state where it
    // cannot pay to get the access back.
    assert.equal(response.statusCode, 200);
    assert.equal(calls[0][0], "billing:overview");
  });

  it("requires a session before any billing request", async () => {
    const { app, calls } = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/billing",
      headers: { "x-restaurant-id": restaurantId },
    });

    assert.equal(response.statusCode, 401);
    assert.equal(calls.length, 0);
  });

  it("starts a checkout for the requested plan", async () => {
    const { app, calls } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/billing/checkout",
      headers: authenticatedHeaders,
      payload: {
        planCode: "standard",
        successUrl: "https://pos.example.com/billing/paid",
        cancelUrl: "https://pos.example.com/billing/cancelled",
        idempotencyKey: "33333333-3333-4333-8333-333333333333",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "awaiting_payment");
    assert.equal(calls[0][1].planCode, "standard");
    assert.equal(calls[0][1].user.id, userId);
    assert.equal(calls[0][1].idempotencyKey, "33333333-3333-4333-8333-333333333333");
  });

  it("refuses a checkout with no idempotency key", async () => {
    const { app, calls } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/billing/checkout",
      headers: authenticatedHeaders,
      payload: {
        planCode: "standard",
        successUrl: "https://pos.example.com/billing/paid",
        cancelUrl: "https://pos.example.com/billing/cancelled",
      },
    });

    // Without a key a double click would create two chargeable sessions.
    assert.equal(response.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  it("rejects a checkout without a plan", async () => {
    const { app, calls } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/billing/checkout",
      headers: authenticatedHeaders,
      payload: {
        successUrl: "https://pos.example.com/billing/paid",
        cancelUrl: "https://pos.example.com/billing/cancelled",
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  it("rejects a cross-site checkout attempt", async () => {
    const { app, calls } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/billing/checkout",
      headers: { ...authenticatedHeaders, origin: "https://evil.example.com" },
      payload: {
        planCode: "standard",
        successUrl: "https://pos.example.com/billing/paid",
        cancelUrl: "https://pos.example.com/billing/cancelled",
        idempotencyKey: "33333333-3333-4333-8333-333333333333",
      },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(calls.length, 0);
  });

  it("changes, cancels and resumes a subscription", async () => {
    const { app, calls } = await makeApp();

    const changed = await app.inject({
      method: "POST",
      url: "/api/billing/change-plan",
      headers: authenticatedHeaders,
      payload: { planCode: "growth" },
    });
    const cancelled = await app.inject({
      method: "POST",
      url: "/api/billing/cancel",
      headers: authenticatedHeaders,
      payload: {},
    });
    const resumed = await app.inject({
      method: "POST",
      url: "/api/billing/resume",
      headers: authenticatedHeaders,
      payload: {},
    });

    assert.equal(changed.statusCode, 200);
    assert.equal(cancelled.statusCode, 200);
    assert.equal(resumed.statusCode, 200);
    assert.deepEqual(
      calls.map(([name]) => name),
      ["billing:change-plan", "billing:cancel", "billing:resume"],
    );
    assert.equal(calls[1][1].cancelAtPeriodEnd, true);
  });

  it("lists payments for the current restaurant only", async () => {
    const { app, calls } = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/billing/payments?limit=5",
      headers: authenticatedHeaders,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json()[0].amountMinor, 25_000);
    assert.equal(calls[0][1].limit, "5");
    assert.equal(calls[0][1].tenant.restaurant.id, restaurantId);
  });

  it("hands the webhook the exact bytes the provider signed", async () => {
    const { app, calls } = await makeApp();
    const payload = '{"id":"evt_1","type":"invoice.paid"}';
    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=abc" },
      payload,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(calls[0][0], "billing:webhook");
    assert.equal(calls[0][1].rawBody, payload);
    assert.equal(calls[0][1].signatureHeader, "t=1,v1=abc");
  });

  it("refuses an unsigned webhook without a session or tenant", async () => {
    const { app, calls } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload: '{"id":"evt_1"}',
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().accepted, false);
    assert.equal(calls[0][1].signatureHeader, null);
  });

  it("rejects a webhook sent with a browser session cookie", async () => {
    const { app, calls } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        cookie: `pos_session=${"s".repeat(43)}`,
        origin: "https://evil.example.com",
        "stripe-signature": "t=1,v1=abc",
      },
      payload: '{"id":"evt_1"}',
    });

    assert.equal(response.statusCode, 403);
    assert.equal(calls.length, 0);
  });

  it("asks the provider to retry a paid event it could not resolve", async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=route-missing" },
      payload: '{"id":"evt_1","type":"invoice.paid"}',
    });

    // A 200 here would be taken as a successful delivery of a payment that was
    // never applied, and the provider would stop retrying.
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().retryable, true);
    assert.equal(response.json().reason, "restaurant_route_missing");
  });
});