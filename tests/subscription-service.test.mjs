import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSubscriptionService } from "../src/server/billing/subscription-service.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-10-02T12:00:00.000Z");
const trustedOrigin = "https://pos.example.com";

const tenant = {
  restaurant: { id: restaurantId, name: "Example Cafe", currencyCode: "PKR" },
};
const owner = { id: userId, email: "owner@example.com" };

function computePlanHash({ planCode, successUrl, cancelUrl }) {
  const canonical = `${planCode.toUpperCase()}|${successUrl}|${cancelUrl}`;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function subscriptionRow(overrides = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    plan_id: "44444444-4444-4444-8444-444444444444",
    status: "pending_checkout",
    current_period_start: null,
    current_period_end: null,
    trial_ends_at: null,
    grace_ends_at: null,
    cancel_at_period_end: false,
    cancelled_at: null,
    provider: "stripe",
    provider_subscription_id: null,
    billing_customer_id: null,
    provider_state: {},
    plan_code: "STANDARD",
    plan_name: "Standard",
    ...overrides,
  };
}

/**
 * A pool that models the parts of the schema these methods rely on: the plan
 * catalogue, the restaurant's own subscription rows, the one-current-subscription
 * unique index, and the audit log.
 */
function fakePool({
  subscriptions = [],
  plans = [{
    id: "44444444-4444-4444-8444-444444444444",
    plan_id: "44444444-4444-4444-8444-444444444444",
    plan_code: "STANDARD",
    plan_name: "Standard",
    amount_minor: 25_000,
    currency_code: "PKR",
    provider_price_id: "price_standard",
  }],
  billingCustomer = null,
  checkoutAttempts = new Map(),
  failOn = null,
} = {}) {
  const calls = [];
  const audit = [];
  const routes = [];
  const state = {
    subscriptions: subscriptions.map((row) => ({ ...row })),
    billingCustomer,
    plans: [...plans],
  };
  let nextId = 1;

  function handle(text, values, scope) {
    const sql = text.replace(/\s+/g, " ").trim();
    calls.push({ text: sql, values, scope });
    if (failOn && sql.startsWith(failOn)) throw new Error("database is unavailable");

    if (sql.startsWith("SELECT id FROM restaurants WHERE id = $1 FOR UPDATE")) {
      return { rows: [{ id: values[0] }] };
    }

    if (sql.startsWith("UPDATE checkout_attempts SET status = 'expired'")) {
      for (const attempt of new Set(checkoutAttempts.values())) {
        if (["creating", "created"].includes(attempt.status)
          && attempt.expires_at
          && new Date(attempt.expires_at).getTime() <= now.getTime()) {
          attempt.status = "expired";
        }
      }
      return { rows: [] };
    }

    if (sql.startsWith("SELECT p.id, p.code, p.name")) {
      return {
        rows: state.plans.map((price) => ({
          id: price.plan_id,
          code: price.plan_code,
          name: price.plan_name,
          description: null,
          features: {},
          prices: [{
            id: price.id,
            currencyCode: price.currency_code,
            amountMinor: price.amount_minor,
            interval: "month",
          }],
        })),
      };
    }

    if (sql.startsWith("SELECT pp.id, pp.plan_id")) {
      const price = state.plans.find((row) => row.plan_code === values[0]);
      return { rows: price ? [price] : [] };
    }

    if (sql.includes("FROM subscriptions s JOIN plans p")) {
      const rows = state.subscriptions
        .filter((row) => row.restaurantId === values[0])
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      return { rows: rows[0] ? [rows[0]] : [] };
    }

    if (sql.startsWith("SELECT id, provider_customer_id FROM billing_customers")) {
      return { rows: state.billingCustomer ? [state.billingCustomer] : [] };
    }

    if (sql.startsWith("INSERT INTO billing_customers")) {
      if (!state.billingCustomer) {
        state.billingCustomer = {
          id: `cc-${nextId++}`,
          provider_customer_id: values[3],
          restaurantId: values[1],
        };
      }
      return { rows: [], rowCount: state.billingCustomer.provider_customer_id === values[3] ? 1 : 0 };
    }

    if (sql.startsWith("SELECT ca.id, ca.status, ca.plan_code, ca.plan_hash")) {
      const attempt = checkoutAttempts.get(`${values[0]}::${values[1]}`);
      return { rows: attempt ? [attempt] : [] };
    }

    if (sql.startsWith("SELECT id, idempotency_key FROM checkout_attempts")) {
      // Find any live attempt for this restaurant
      for (const [key, attempt] of checkoutAttempts.entries()) {
        if (key.startsWith(`${values[0]}::`) && ['creating', 'created'].includes(attempt.status)) {
          return { rows: [attempt] };
        }
      }
      return { rows: [] };
    }

    if (sql.startsWith("UPDATE checkout_attempts SET status = 'creating'")) {
      const attempt = [...checkoutAttempts.values()].find((row) => row.id === values[0]);
      if (attempt) {
        attempt.status = "creating";
        attempt.error_message = null;
        attempt.expires_at = new Date(Date.now() + 3600000);
      }
      return { rows: [] };
    }

    if (sql.startsWith("INSERT INTO checkout_attempts")) {
      const attemptId = values[0];
      const key = values[3];
      const attempt = {
        id: attemptId,
        idempotency_key: key,
        status: "creating",
        plan_code: values[4],
        subscription_id: values[2],
        provider_checkout_session_id: null,
        provider_checkout_url: null,
        provider_customer_id: null,
        provider_idempotency_key: values[8],
        plan_hash: values[5],
        success_url: values[6],
        cancel_url: values[7],
      };
      checkoutAttempts.set(`${values[1]}::${key}`, attempt);
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE checkout_attempts SET status = 'created'")) {
      const attempt = [...checkoutAttempts.values()].find((row) => row.id === values[0]);
      if (attempt) {
        attempt.status = "created";
        attempt.provider_customer_id = values[2];
        attempt.provider_checkout_session_id = values[3];
        attempt.provider_checkout_url = values[4];
      }
      return { rows: [] };
    }

    if (sql.startsWith("UPDATE checkout_attempts SET status = 'failed'")) {
      const attempt = [...checkoutAttempts.values()].find((row) => row.id === values[0]);
      if (attempt) {
        attempt.status = "failed";
        attempt.error_message = values[2];
      }
      return { rows: [] };
    }

    if (sql.startsWith("INSERT INTO subscriptions")) {
      // Mirrors subscriptions_one_current_per_restaurant.
      const current = state.subscriptions.some((row) => row.restaurantId === values[1]
        && ["pending_checkout", "trialing", "active", "past_due", "cancel_at_period_end", "suspended"]
          .includes(row.status));
      if (current) {
        const error = new Error("duplicate key");
        error.code = "23505";
        error.constraint = "subscriptions_one_current_per_restaurant";
        throw error;
      }
      const created = subscriptionRow({
        id: `sub-${nextId++}`,
        restaurantId: values[1],
        status: "pending_checkout",
        provider: values[4],
        provider_state: JSON.parse(values[5]),
        createdAt: nextId,
      });
      state.subscriptions.push(created);
      return { rows: [{ id: created.id }] };
    }

    if (sql.startsWith("UPDATE subscriptions SET plan_id = $3")) {
      const row = state.subscriptions.find((item) => item.id === values[1]);
      row.plan_id = values[2];
      row.provider_state = { ...row.provider_state, ...JSON.parse(values[4]) };
      return { rows: [] };
    }

    if (sql.startsWith("UPDATE subscriptions") && sql.includes("provider_state = provider_state || $3::jsonb, billing_customer_id")) {
      const row = state.subscriptions.find((item) => item.id === values[1]);
      row.provider_state = { ...row.provider_state, ...JSON.parse(values[2]) };
      row.billing_customer_id = row.billing_customer_id ?? values[3];
      return { rows: [] };
    }

    if (sql.startsWith("UPDATE subscriptions")) {
      const row = state.subscriptions.find((item) => item.id === values[1]);
      if (sql.includes("SET plan_id = $3")) row.plan_id = values[2];
      if (sql.includes("SET cancel_at_period_end = $3")) {
        row.cancel_at_period_end = values[2];
        row.status = values[2] ? "cancel_at_period_end" : "cancelled";
        row.cancelled_at = values[2] ? null : values[3];
      }
      if (sql.includes("SET cancel_at_period_end = false")) {
        row.cancel_at_period_end = false;
        row.cancelled_at = null;
        if (values[2]) row.status = "active";
      }
      return { rows: [] };
    }

    if (sql.startsWith("INSERT INTO provider_tenant_routes")) {
      routes.push(sql.includes("'customer'")
        ? { reference: values[1], type: "customer", restaurantId: values[2] }
        : { reference: values[1], type: values[2], restaurantId: values[3] });
      return { rows: [] };
    }

    if (sql.startsWith("INSERT INTO audit_logs")) {
      audit.push({ action: values[2], userId: values[1], resourceId: values[3] });
      return { rows: [] };
    }

    if (sql.startsWith("SELECT id, provider, provider_payment_id, status")) {
      return { rows: [] };
    }

    return { rows: [] };
  }

  const client = {
    async query(text, values = []) {
      return handle(text, values, "tenant");
    },
    release() {},
  };

  return {
    calls,
    audit,
    routes,
    checkoutAttempts,
    state,
    find(predicate) {
      return calls.filter(predicate);
    },
    async query(text, values = []) {
      return handle(text, values, "platform");
    },
    async connect() {
      return client;
    },
  };
}

function fakeProvider(overrides = {}) {
  const calls = [];
  return {
    calls,
    name: "stripe",
    webhookSignatureHeader: "stripe-signature",
    async createCustomer(input) {
      calls.push(["createCustomer", input]);
      if (overrides.customerError) throw overrides.customerError;
      return { providerCustomerId: "cus_1" };
    },
    async createCheckoutSession(input) {
      calls.push(["createCheckoutSession", input]);
      if (overrides.checkoutError) throw overrides.checkoutError;
      return {
        providerCheckoutSessionId: "cs_1",
        checkoutUrl: "https://checkout.stripe.com/session",
        input,
      };
    },
    async changeSubscription(input) {
      calls.push(["changeSubscription", input]);
      if (overrides.changeError) throw overrides.changeError;
      return { status: "active" };
    },
    async cancelSubscription(input) {
      calls.push(["cancelSubscription", input]);
      if (overrides.cancelError) throw overrides.cancelError;
      return { status: "active" };
    },
    async resumeSubscription(input) {
      calls.push(["resumeSubscription", input]);
      if (overrides.resumeError) throw overrides.resumeError;
      return { status: "active" };
    },
    verifyWebhook: () => ({ verified: false, event: null }),
  };
}

function service(pool, provider = fakeProvider(), options = {}) {
  return createSubscriptionService(pool, {
    provider,
    trustedOrigins: [trustedOrigin],
    clock: () => now,
    ...options,
  });
}

const checkoutInput = {
  tenant,
  user: owner,
  planCode: "STANDARD",
  successUrl: "https://pos.example.com/billing/paid",
  cancelUrl: "https://pos.example.com/billing/cancelled",
  idempotencyKey: "55555555-5555-4555-8555-555555555555",
};

describe("subscription service overview", () => {
  it("shows only plans priced in the restaurant's own currency", async () => {
    const pool = fakePool();

    const result = await service(pool).overview({ tenant, user: owner });

    assert.equal(result.plans.length, 1);
    assert.equal(result.plans[0].code, "STANDARD");
    assert.equal(result.plans[0].prices[0].currencyCode, "PKR");
    assert.equal(result.subscription, null);
  });

  it("hides a plan that is not sold in this currency", async () => {
    const pool = fakePool();
    pool.state.plans[0].currency_code = "USD";

    const result = await service(pool).overview({ tenant, user: owner });

    assert.deepEqual(result.plans, []);
  });

  it("reads the restaurant subscription inside the tenant transaction", async () => {
    const pool = fakePool({
      subscriptions: [subscriptionRow({ restaurantId, status: "active", current_period_end: "2026-11-01T00:00:00Z" })],
    });

    const result = await service(pool).overview({ tenant, user: owner });

    assert.equal(result.subscription.status, "active");
    assert.equal(result.subscription.plan.code, "STANDARD");
    assert.equal(pool.find((call) => call.text.includes("app.restaurant_id")).length > 0, true);
  });
});

describe("subscription service checkout", () => {
  it("creates the subscription, the provider customer, and the checkout route", async () => {
    const pool = fakePool();
    const provider = fakeProvider();

    const result = await service(pool, provider).startCheckout(checkoutInput);

    assert.equal(result.checkoutUrl, "https://checkout.stripe.com/session");
    assert.equal(result.status, "awaiting_payment");
    assert.equal(result.amountMinor, 25_000);
    assert.equal(pool.state.subscriptions.length, 1);
    assert.equal(pool.state.subscriptions[0].status, "pending_checkout");
    assert.deepEqual(
      pool.routes.map((route) => route.type).sort(),
      ["checkout_session", "customer"],
    );
    assert.equal(pool.state.subscriptions[0].billing_customer_id, pool.state.billingCustomer.id);
  });

  it("locks the restaurant before deciding, so two checkouts cannot both win", async () => {
    const pool = fakePool();

    await service(pool).startCheckout(checkoutInput);

    const lockIndex = pool.findIndex?.(() => false)
      ?? pool.calls.findIndex((call) => call.text.startsWith("SELECT id FROM restaurants WHERE id = $1 FOR UPDATE"));
    const insertIndex = pool.calls.findIndex((call) => call.text.startsWith("INSERT INTO subscriptions"));
    assert.ok(lockIndex >= 0, "the restaurant row must be locked");
    assert.ok(lockIndex < insertIndex);
  });

  it("never calls the provider while a transaction is open", async () => {
    const pool = fakePool();
    const provider = fakeProvider();

    await service(pool, provider).startCheckout(checkoutInput);

    // The provider call happens between two short transactions. Holding a
    // transaction across the network ties up a connection and turns a provider
    // outage into database contention.
    const phaseOneEnd = pool.calls.findIndex((call) => call.text === "COMMIT");
    const phaseTwoStart = pool.calls.findIndex((call) => call.text === "BEGIN" && call.scope === "tenant"
      && pool.calls.indexOf(call) > phaseOneEnd);
    assert.ok(phaseOneEnd >= 0, "the first phase commits before the provider call");
    assert.ok(phaseTwoStart > phaseOneEnd);
  });

  it("refuses a second checkout while a subscription is active", async () => {
    const pool = fakePool({
      subscriptions: [subscriptionRow({ restaurantId, status: "active" })],
    });
    const provider = fakeProvider();

    await assert.rejects(
      () => service(pool, provider).startCheckout(checkoutInput),
      (error) => error.code === "SUBSCRIPTION_ALREADY_ACTIVE" && error.statusCode === 409,
    );
    assert.equal(provider.calls.length, 0);
  });

  it("reuses an unfinished checkout for the same idempotency key", async () => {
    const pool = fakePool({
      subscriptions: [subscriptionRow({
        restaurantId,
        status: "pending_checkout",
        provider_state: {
          checkout: {
            idempotencyKey: checkoutInput.idempotencyKey,
            checkoutUrl: "https://checkout.stripe.com/existing",
          },
        },
      })],
      checkoutAttempts: new Map([
        [`${restaurantId}::${checkoutInput.idempotencyKey}`, {
          id: "attempt-1",
          status: "created",
          idempotency_key: checkoutInput.idempotencyKey,
          plan_code: "STANDARD",
          provider_checkout_session_id: "cs_existing",
          provider_checkout_url: "https://checkout.stripe.com/existing",
          provider_customer_id: "cus_1",
          plan_hash: computePlanHash({
            planCode: checkoutInput.planCode,
            successUrl: checkoutInput.successUrl,
            cancelUrl: checkoutInput.cancelUrl,
          }),
        }],
      ]),
    });
    const provider = fakeProvider();

    const result = await service(pool, provider).startCheckout(checkoutInput);

    assert.equal(result.replayed, true);
    assert.equal(result.checkoutUrl, "https://checkout.stripe.com/existing");
    assert.equal(provider.calls.length, 0, "a retry must not create a second session");
  });

  it("checks the stored payload before replaying a created checkout", async () => {
    const attempt = {
      id: "attempt-created",
      status: "created",
      idempotency_key: checkoutInput.idempotencyKey,
      plan_code: "STANDARD",
      provider_checkout_session_id: "cs_existing",
      provider_checkout_url: "https://checkout.stripe.com/existing",
      provider_customer_id: "cus_1",
      plan_hash: computePlanHash({
        planCode: checkoutInput.planCode,
        successUrl: checkoutInput.successUrl,
        cancelUrl: checkoutInput.cancelUrl,
      }),
    };
    const pool = fakePool({
      checkoutAttempts: new Map([[`${restaurantId}::${checkoutInput.idempotencyKey}`, attempt]]),
    });
    const provider = fakeProvider();

    for (const changed of [
      { planCode: "PREMIUM" },
      { successUrl: "https://pos.example.com/billing/other" },
      { cancelUrl: "https://pos.example.com/billing/other" },
    ]) {
      await assert.rejects(
        () => service(pool, provider).startCheckout({ ...checkoutInput, ...changed }),
        (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT" && error.statusCode === 409,
      );
    }
    assert.equal(provider.calls.length, 0);
    assert.equal(attempt.status, "created");
  });

  it("replays the linked checkout price after the plan leaves the active catalogue", async () => {
    const attempt = {
      id: "attempt-created",
      status: "created",
      idempotency_key: checkoutInput.idempotencyKey,
      plan_code: "STANDARD",
      plan_hash: computePlanHash(checkoutInput),
      subscription_id: "33333333-3333-4333-8333-333333333333",
      provider_checkout_session_id: "cs_existing",
      provider_checkout_url: "https://checkout.stripe.com/existing",
      stored_price_id: "44444444-4444-4444-8444-444444444444",
      stored_plan_id: "55555555-5555-4555-8555-555555555555",
      amount_minor: 25_000,
      currency_code: "PKR",
      provider_price_id: "price_standard",
      plan_name: "Standard",
    };
    const pool = fakePool({
      plans: [],
      checkoutAttempts: new Map([[`${restaurantId}::${checkoutInput.idempotencyKey}`, attempt]]),
    });

    const result = await service(pool).startCheckout(checkoutInput);

    assert.equal(result.replayed, true);
    assert.equal(result.amountMinor, 25_000);
    assert.equal(result.checkoutUrl, attempt.provider_checkout_url);
  });

  it("returns CHECKOUT_IN_PROGRESS for a matching creating attempt", async () => {
    const attempt = {
      id: "attempt-creating",
      status: "creating",
      idempotency_key: checkoutInput.idempotencyKey,
      plan_code: "STANDARD",
      plan_hash: computePlanHash(checkoutInput),
    };
    const pool = fakePool({
      checkoutAttempts: new Map([[`${restaurantId}::${checkoutInput.idempotencyKey}`, attempt]]),
    });
    const provider = fakeProvider();

    await assert.rejects(
      () => service(pool, provider).startCheckout(checkoutInput),
      (error) => error.code === "CHECKOUT_IN_PROGRESS" && error.statusCode === 409,
    );
    assert.equal(provider.calls.length, 0);
    assert.equal(pool.checkoutAttempts.size, 1);
  });

  it("retries the same failed row with its original provider key and subscription", async () => {
    const attempt = {
      id: "attempt-failed",
      status: "failed",
      idempotency_key: checkoutInput.idempotencyKey,
      plan_code: "STANDARD",
      plan_hash: computePlanHash(checkoutInput),
      subscription_id: "33333333-3333-4333-8333-333333333333",
      provider_idempotency_key: "ca_original",
      error_message: "temporary failure",
    };
    const pool = fakePool({
      subscriptions: [subscriptionRow({ restaurantId })],
      checkoutAttempts: new Map([[`${restaurantId}::${checkoutInput.idempotencyKey}`, attempt]]),
    });
    const provider = fakeProvider();

    const result = await service(pool, provider).startCheckout(checkoutInput);

    assert.equal(result.replayed, false);
    assert.equal(attempt.status, "created");
    assert.equal(pool.checkoutAttempts.size, 1);
    const checkoutCall = provider.calls.find(([name]) => name === "createCheckoutSession");
    assert.equal(checkoutCall[1].idempotencyKey, "ca_original");
    assert.equal(pool.state.subscriptions.length, 1);
  });

  it("starts a new subscription after cancellation instead of reviving the dead one", async () => {
    const dead = subscriptionRow({
      id: "sub-dead",
      restaurantId,
      status: "cancelled",
      provider_subscription_id: "sub_dead",
      provider_state: {},
      createdAt: 1,
    });
    const pool = fakePool({ subscriptions: [dead] });

    const result = await service(pool).startCheckout(checkoutInput);

    assert.equal(result.status, "awaiting_payment");
    assert.equal(pool.state.subscriptions.length, 2);
    const current = pool.state.subscriptions.find((row) => row.status === "pending_checkout");
    assert.notEqual(current.id, "sub-dead");
    assert.equal(current.provider_subscription_id, null);
    assert.ok(pool.audit.some((row) => row.action === "subscription.resubscribe_started"));
  });

  it("starts a new subscription after expiry", async () => {
    const pool = fakePool({
      subscriptions: [subscriptionRow({
        restaurantId,
        status: "expired",
        provider_subscription_id: "sub_expired",
        createdAt: 1,
      })],
    });

    await service(pool).startCheckout(checkoutInput);

    assert.equal(pool.state.subscriptions.length, 2);
    assert.equal(
      pool.state.subscriptions.find((row) => row.status === "pending_checkout").provider_subscription_id,
      null,
    );
  });

  it("records the acting owner on every checkout mutation", async () => {
    const pool = fakePool();

    await service(pool).startCheckout(checkoutInput);

    assert.ok(pool.audit.length >= 2);
    for (const entry of pool.audit) assert.equal(entry.userId, userId);
    assert.ok(pool.audit.some((row) => row.action === "subscription.checkout_started"));
    assert.ok(pool.audit.some((row) => row.action === "subscription.checkout_created"));
  });

  it("rejects a redirect that does not point at this application", async () => {
    const pool = fakePool();
    const provider = fakeProvider();

    await assert.rejects(
      () => service(pool, provider).startCheckout({
        ...checkoutInput,
        successUrl: "https://evil.example.com/steal",
      }),
      (error) => error.code === "BILLING_URL_NOT_TRUSTED",
    );
    assert.equal(provider.calls.length, 0);
    assert.equal(pool.state.subscriptions.length, 0);
  });

  it("rejects a plain HTTP redirect", async () => {
    const pool = fakePool();

    await assert.rejects(
      () => service(pool).startCheckout({ ...checkoutInput, cancelUrl: "http://pos.example.com/x" }),
      (error) => error.code === "BILLING_URL_NOT_TRUSTED",
    );
  });

  it("rejects a plan that is not on sale", async () => {
    const pool = fakePool();

    await assert.rejects(
      () => service(pool).startCheckout({ ...checkoutInput, planCode: "enterprise" }),
      (error) => error.code === "PLAN_NOT_AVAILABLE" && error.statusCode === 404,
    );
  });

  it("surfaces a provider failure without recording a checkout", async () => {
    const pool = fakePool();
    const provider = fakeProvider({
      checkoutError: Object.assign(new Error("declined"), { code: "PAYMENT_PROVIDER_ERROR", statusCode: 502 }),
    });

    await assert.rejects(() => service(pool, provider).startCheckout(checkoutInput));
    assert.equal(pool.audit.some((row) => row.action === "subscription.checkout_created"), false);
    assert.equal(pool.state.subscriptions.length, 1, "the pending row remains for a retry");
  });

  it("surfaces a database failure before it ever reaches the provider", async () => {
    const pool = fakePool({ failOn: "SELECT id FROM restaurants WHERE id = $1 FOR UPDATE" });
    const provider = fakeProvider();

    await assert.rejects(
      () => service(pool, provider).startCheckout(checkoutInput),
      /database is unavailable/,
    );
    assert.equal(provider.calls.length, 0);
    assert.equal(pool.state.subscriptions.length, 0);
  });
});

describe("subscription service plan changes, cancellation, and resume", () => {
  it("changes the plan through the provider", async () => {
    const pool = fakePool({
      subscriptions: [subscriptionRow({
        restaurantId,
        status: "active",
        provider_subscription_id: "sub_1",
        createdAt: 1,
      })],
    });
    const provider = fakeProvider();

    const result = await service(pool, provider).changePlan({
      tenant,
      user: owner,
      planCode: "STANDARD",
    });

    assert.deepEqual(result.plan, { code: "STANDARD", name: "Standard" });
    assert.deepEqual(
      provider.calls.find(([name]) => name === "changeSubscription")[1],
      { providerSubscriptionId: "sub_1", providerPriceId: "price_standard" },
    );
    assert.ok(pool.audit.some((row) => row.action === "subscription.plan_changed"));
  });

  it("refuses a plan change when there is no provider subscription", async () => {
    const pool = fakePool({
      subscriptions: [subscriptionRow({ restaurantId, status: "pending_checkout", createdAt: 1 })],
    });

    await assert.rejects(
      () => service(pool).changePlan({ tenant, user: owner, planCode: "STANDARD" }),
      (error) => error.code === "SUBSCRIPTION_NOT_PROVIDER_MANAGED",
    );
  });

  it("aims cancellation at the current provider subscription", async () => {
    const pool = fakePool({
      subscriptions: [subscriptionRow({
        restaurantId,
        status: "active",
        provider_subscription_id: "sub_current",
        current_period_end: "2026-11-02T00:00:00Z",
        createdAt: 1,
      })],
    });
    const provider = fakeProvider();

    const result = await service(pool, provider).cancel({ tenant, user: owner });

    assert.equal(result.cancelAtPeriodEnd, true);
    assert.equal(result.accessUntil, "2026-11-02T00:00:00Z");
    assert.equal(
      provider.calls.find(([name]) => name === "cancelSubscription")[1].providerSubscriptionId,
      "sub_current",
    );
    const row = pool.state.subscriptions[0];
    assert.equal(row.status, "cancel_at_period_end");
    assert.equal(row.cancel_at_period_end, true);
  });

  it("cancels immediately when the owner asks for no grace", async () => {
    const pool = fakePool({
      subscriptions: [subscriptionRow({
        restaurantId,
        status: "active",
        provider_subscription_id: "sub_1",
        createdAt: 1,
      })],
    });

    const result = await service(pool).cancel({ tenant, user: owner, cancelAtPeriodEnd: false });

    assert.equal(result.accessUntil, null);
    assert.equal(pool.state.subscriptions[0].status, "cancelled");
    assert.ok(pool.audit.some((row) => row.action === "subscription.cancelled"));
  });

  it("resumes through the provider's own resume call", async () => {
    const pool = fakePool({
      subscriptions: [subscriptionRow({
        restaurantId,
        status: "cancel_at_period_end",
        provider_subscription_id: "sub_1",
        cancel_at_period_end: true,
        createdAt: 1,
      })],
    });
    const provider = fakeProvider();

    const result = await service(pool, provider).resume({ tenant, user: owner });

    // Re-sending the price would leave Stripe scheduling the cancellation.
    assert.deepEqual(provider.calls.at(-1), ["resumeSubscription", { providerSubscriptionId: "sub_1" }]);
    assert.equal(result.status, "active");
    assert.equal(pool.state.subscriptions[0].status, "active");
    assert.equal(pool.state.subscriptions[0].cancel_at_period_end, false);
  });

  it("does not resurrect a cancelled subscription on resume", async () => {
    const pool = fakePool({
      subscriptions: [subscriptionRow({
        restaurantId,
        status: "cancelled",
        provider_subscription_id: "sub_1",
        createdAt: 1,
      })],
    });

    const result = await service(pool).resume({ tenant, user: owner });

    assert.equal(result.status, "cancelled");
    assert.equal(pool.state.subscriptions[0].status, "cancelled");
  });

  it("propagates a provider failure instead of recording a local change", async () => {
    const pool = fakePool({
      subscriptions: [subscriptionRow({
        restaurantId,
        status: "active",
        provider_subscription_id: "sub_1",
        createdAt: 1,
      })],
    });
    const provider = fakeProvider({ cancelError: new Error("provider down") });

    await assert.rejects(() => service(pool, provider).cancel({ tenant, user: owner }));
    assert.equal(pool.state.subscriptions[0].status, "active");
    assert.equal(pool.audit.some((row) => row.action === "subscription.cancelled"), false);
  });

  it("caps the payment history window", async () => {
    const pool = fakePool();

    const result = await service(pool).paymentHistory({ tenant, limit: "5" });

    assert.deepEqual(result, []);
    const statement = pool.find((call) => call.text.includes("FROM billing_payments"))[0];
    assert.ok(statement, "the payment query must run");
    assert.equal(statement.values[0], restaurantId);
    assert.equal(statement.values[1], 5);
  });

  it("clamps an out-of-range payment history window", async () => {
    const pool = fakePool();

    await service(pool).paymentHistory({ tenant, limit: "5000" });
    assert.equal(pool.find((call) => call.text.includes("FROM billing_payments"))[0].values[1], 100);

    await service(pool).paymentHistory({ tenant, limit: "0" });
    assert.equal(pool.find((call) => call.text.includes("FROM billing_payments"))[1].values[1], 1);
  });
});
