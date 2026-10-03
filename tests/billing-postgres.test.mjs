import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createBillingWebhookService } from "../src/server/billing/billing-webhook-service.mjs";
import {
  createSubscriptionService,
  ensureCanonicalBillingCustomer,
} from "../src/server/billing/subscription-service.mjs";
import {
  connectAdmin,
  createAppPool,
  isDatabaseAvailable,
  provisionIntegrationDatabase,
  resetBillingState,
  seedPlan,
  seedRestaurant,
} from "./helpers/postgres.mjs";

/**
 * Real PostgreSQL tests for the properties a mock cannot demonstrate: forced
 * row-level security between tenants, the partial unique index that admits only
 * one current subscription, the exact `ON CONFLICT` inference clauses, and
 * concurrent checkout.
 *
 * These run against the same schema the application uses, through the same
 * tenant transaction boundary, as a non-superuser role so RLS actually applies.
 */

const available = await isDatabaseAvailable();
const describeDatabase = available ? describe : describe.skip;

if (!available) {
  console.warn(
    "[skipped] PostgreSQL integration tests: no database. "
    + "Run `docker compose -f compose.test-database.yaml up -d` then `npm run test:integration`.",
  );
}

function billingProvider(overrides = {}) {
  const calls = [];
  return {
    calls,
    name: "stripe",
    webhookSignatureHeader: "stripe-signature",
    async createCustomer({ restaurantId }) {
      calls.push(["createCustomer", restaurantId]);
      return { providerCustomerId: `cus_${calls.length}` };
    },
    async createCheckoutSession({ providerCustomerId }) {
      calls.push(["createCheckoutSession", providerCustomerId]);
      return {
        providerCheckoutSessionId: `cs_${calls.length}`,
        checkoutUrl: "https://checkout.stripe.com/test",
      };
    },
    async changeSubscription(input) {
      calls.push(["changeSubscription", input]);
      return { status: "active" };
    },
    async cancelSubscription(input) {
      calls.push(["cancelSubscription", input]);
      return { status: "active" };
    },
    async resumeSubscription(input) {
      calls.push(["resumeSubscription", input]);
      return { status: "active" };
    },
    verifyWebhook: () => ({ verified: false, event: null, reason: "test" }),
    ...overrides,
  };
}

function webhookEvent(overrides = {}) {
  return {
    providerEventId: "evt_1",
    type: "subscription.renewed",
    providerSubscriptionId: "sub_1",
    providerCheckoutSessionId: null,
    providerCustomerId: "cus_1",
    providerPaymentId: "pi_1",
    describesSubscription: false,
    status: "active",
    currentPeriodStart: "2026-10-01T00:00:00.000Z",
    currentPeriodEnd: "2026-11-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    currencyCode: "PKR",
    amountMinor: 25_000,
    failureCode: null,
    failureMessage: null,
    occurredAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

function checkoutPayloadHash({ planCode, successUrl, cancelUrl }) {
  return createHash("sha256")
    .update(`${planCode.trim().toUpperCase()}|${successUrl.trim()}|${cancelUrl.trim()}`)
    .digest("hex")
    .slice(0, 32);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describeDatabase("billing against real PostgreSQL", () => {
  let admin;
  let app;
  let provider;
  let service;

  const now = new Date("2026-10-02T12:00:00.000Z");

  before(async () => {
    await provisionIntegrationDatabase();
    admin = await connectAdmin();
    app = await createAppPool();
    provider = billingProvider();
    service = createSubscriptionService(app, {
      provider,
      trustedOrigins: ["https://pos.example.com"],
      clock: () => now,
    });
  });

  after(async () => {
    await app?.end();
    await admin?.end();
  });

  it("does not let one restaurant read another restaurant's billing data", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const b = await seedRestaurant(admin, { name: "Cafe B" });

    await admin.query(
      `INSERT INTO subscriptions (
         id, restaurant_id, plan_id, plan_price_id, provider, status,
         current_period_start, current_period_end
       ) VALUES (gen_random_uuid(), $1, $2, $3, 'stripe', 'active', $4, $5)`,
      [a.restaurantId, plan.planId, plan.priceId, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"],
    );
    await admin.query(
      `INSERT INTO subscriptions (
         id, restaurant_id, plan_id, plan_price_id, provider, status,
         current_period_start, current_period_end
       ) VALUES (gen_random_uuid(), $1, $2, $3, 'stripe', 'active', $4, $5)`,
      [b.restaurantId, plan.planId, plan.priceId, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"],
    );

    const aView = await service.overview({
      tenant: { restaurant: { id: a.restaurantId, name: "Cafe A", currencyCode: "PKR" } },
      user: { id: a.userId, email: "a@example.com" },
    });
    const bView = await service.overview({
      tenant: { restaurant: { id: b.restaurantId, name: "Cafe B", currencyCode: "PKR" } },
      user: { id: b.userId, email: "b@example.com" },
    });

    assert.equal(aView.subscription.id !== null, true);
    assert.notEqual(aView.subscription.id, bView.subscription.id);
  });

  it("refuses to update another restaurant's subscription", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const b = await seedRestaurant(admin, { name: "Cafe B" });
    const inserted = await admin.query(
      `INSERT INTO subscriptions (
         id, restaurant_id, plan_id, plan_price_id, provider, status
       ) VALUES (gen_random_uuid(), $1, $2, $3, 'stripe', 'active')
       RETURNING id`,
      [b.restaurantId, plan.planId, plan.priceId],
    );
    const bSubscriptionId = inserted.rows[0].id;

    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.restaurant_id', $1, true)", [a.restaurantId]);
      const visible = await client.query(
        "SELECT id FROM subscriptions WHERE restaurant_id = $1",
        [b.restaurantId],
      );
      const blocked = await client.query(
        `UPDATE subscriptions SET status = 'cancelled' WHERE id = $1`,
        [bSubscriptionId],
      );
      await client.query("ROLLBACK");

      // Forced row-level security hides restaurant B's rows from restaurant A's
      // transaction, so a cross-tenant identifier matches nothing at all.
      assert.equal(visible.rowCount, 0);
      assert.equal(blocked.rowCount, 0);
    } finally {
      client.release();
    }

    const unchanged = await admin.query(
      "SELECT status FROM subscriptions WHERE id = $1",
      [bSubscriptionId],
    );
    assert.equal(unchanged.rows[0].status, "active");
  });

  it("keeps provider customer and subscription identifiers inside their tenant", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const b = await seedRestaurant(admin, { name: "Cafe B" });

    const customerA = await admin.query(
      `INSERT INTO billing_customers (restaurant_id, provider, provider_customer_id)
       VALUES ($1, 'stripe', 'cus_a') RETURNING id`,
      [a.restaurantId],
    );
    await admin.query(
      `INSERT INTO subscriptions (
         restaurant_id, plan_id, plan_price_id, provider, status,
         provider_subscription_id, billing_customer_id
       ) VALUES ($1, $2, $3, 'stripe', 'active', 'sub_a', $4)`,
      [a.restaurantId, plan.planId, plan.priceId, customerA.rows[0].id],
    );

    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.restaurant_id', $1, true)", [b.restaurantId]);

      const byCustomer = await client.query(
        "SELECT id FROM subscriptions WHERE provider_subscription_id = $1",
        ["sub_a"],
      );
      const byLocalId = await client.query(
        "SELECT id FROM subscriptions WHERE provider_subscription_id = $1",
        ["sub_b"],
      );
      const customers = await client.query(
        "SELECT id FROM billing_customers WHERE provider_customer_id = $1",
        ["cus_a"],
      );
      await client.query("ROLLBACK");

      assert.equal(byCustomer.rowCount, 0, "another tenant's provider subscription id is invisible");
      assert.equal(byLocalId.rowCount, 0);
      assert.equal(customers.rowCount, 0, "another tenant's provider customer is invisible");
    } finally {
      client.release();
    }
  });

  it("admits only one current subscription per restaurant", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });

    await admin.query(
      `INSERT INTO subscriptions (restaurant_id, plan_id, plan_price_id, provider, status)
       VALUES ($1, $2, $3, 'stripe', 'pending_checkout')`,
      [a.restaurantId, plan.planId, plan.priceId],
    );

    await assert.rejects(
      admin.query(
        `INSERT INTO subscriptions (restaurant_id, plan_id, plan_price_id, provider, status)
         VALUES ($1, $2, $3, 'stripe', 'active')`,
        [a.restaurantId, plan.planId, plan.priceId],
      ),
      (error) => error.code === "23505",
      "a second live subscription must be refused by the partial unique index",
    );

    // A cancelled subscription does not hold the slot, which is what lets a
    // re-subscribe create a fresh row.
    await admin.query("UPDATE subscriptions SET status = 'cancelled'");
    await admin.query(
      `INSERT INTO subscriptions (restaurant_id, plan_id, plan_price_id, provider, status)
       VALUES ($1, $2, $3, 'stripe', 'pending_checkout')`,
      [a.restaurantId, plan.planId, plan.priceId],
    );
    const rows = await admin.query(
      "SELECT id FROM subscriptions WHERE restaurant_id = $1 ORDER BY created_at",
      [a.restaurantId],
    );
    assert.equal(rows.rowCount, 2);
  });

  it("executes the real ON CONFLICT clauses used by the services", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const subscription = await admin.query(
      `INSERT INTO subscriptions (restaurant_id, plan_id, plan_price_id, provider, status)
       VALUES ($1, $2, $3, 'stripe', 'pending_checkout') RETURNING id`,
      [a.restaurantId, plan.planId, plan.priceId],
    );

    // billing_customers: the checkout path relies on this inference.
    await app.query(
      `INSERT INTO billing_customers (id, restaurant_id, provider, provider_customer_id)
       VALUES ($1, $2, 'stripe', 'cus_conflict')`,
      ["11111111-1111-4111-8111-111111111111", a.restaurantId],
    ).catch(() => { /* the app role cannot insert without tenant context */ });

    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.restaurant_id', $1, true)", [a.restaurantId]);

      const first = await client.query(
        `INSERT INTO billing_customers (id, restaurant_id, provider, provider_customer_id)
         VALUES ($1, $2, 'stripe', 'cus_1')
         ON CONFLICT (restaurant_id, provider) DO UPDATE
           SET provider_customer_id = EXCLUDED.provider_customer_id
         RETURNING id, provider_customer_id`,
        ["22222222-2222-4222-8222-222222222222", a.restaurantId],
      );
      const second = await client.query(
        `INSERT INTO billing_customers (id, restaurant_id, provider, provider_customer_id)
         VALUES ($1, $2, 'stripe', 'cus_2')
         ON CONFLICT (restaurant_id, provider) DO UPDATE
           SET provider_customer_id = EXCLUDED.provider_customer_id
         RETURNING id, provider_customer_id`,
        ["33333333-3333-4333-8333-333333333333", a.restaurantId],
      );

      await client.query(
        `INSERT INTO billing_payments (
           id, restaurant_id, subscription_id, provider, provider_payment_id,
           status, currency_code, amount_minor
         ) VALUES (gen_random_uuid(), $1, $2, 'stripe', 'pi_1', 'succeeded', 'PKR', 25000)`,
        [a.restaurantId, subscription.rows[0].id],
      );
      const replay = await client.query(
        `INSERT INTO billing_payments (
           id, restaurant_id, subscription_id, provider, provider_payment_id,
           status, currency_code, amount_minor
         ) VALUES (gen_random_uuid(), $1, $2, 'stripe', 'pi_1', 'succeeded', 'PKR', 25000)
         ON CONFLICT (provider, provider_payment_id)
           WHERE provider_payment_id IS NOT NULL
         DO UPDATE SET status = EXCLUDED.status`,
        [a.restaurantId, subscription.rows[0].id],
      );
      await client.query("ROLLBACK");

      assert.equal(first.rows[0].provider_customer_id, "cus_1");
      assert.equal(second.rows[0].provider_customer_id, "cus_2");
      assert.equal(first.rows[0].id, second.rows[0].id, "one customer row per restaurant survives");
      assert.equal(replay.rowCount, 1);
    } finally {
      client.release();
    }
  });

  it("never lets an older event move a paid period backwards", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const customer = await admin.query(
      `INSERT INTO billing_customers (restaurant_id, provider, provider_customer_id)
       VALUES ($1, 'stripe', 'cus_1') RETURNING id`,
      [a.restaurantId],
    );
    const subscription = await admin.query(
      `INSERT INTO subscriptions (
         restaurant_id, plan_id, plan_price_id, provider, status,
         provider_subscription_id, billing_customer_id,
         current_period_start, current_period_end
       ) VALUES ($1, $2, $3, 'stripe', 'active', 'sub_1', $4, $5, $6)
       RETURNING id`,
      [
        a.restaurantId, plan.planId, plan.priceId, customer.rows[0].id,
        "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z",
      ],
    );
    await admin.query(
      `INSERT INTO provider_tenant_routes
         (provider, provider_reference, provider_reference_type, restaurant_id)
       VALUES ('stripe', 'cus_1', 'customer', $1)`,
      [a.restaurantId],
    );

    const webhooks = createBillingWebhookService({
      pool: app,
      provider: {
        name: "stripe",
        verifyWebhook: () => ({
          verified: true,
          // A late delivery for the previous, already elapsed period.
          event: webhookEvent({
            providerEventId: "evt_stale",
            currentPeriodStart: "2026-08-01T00:00:00.000Z",
            currentPeriodEnd: "2026-09-01T00:00:00.000Z",
          }),
        }),
      },
      clock: () => now,
    });

    const result = await webhooks.handle({ rawBody: "{}", signatureHeader: "t=1,v1=x" });
    const stored = await admin.query(
      "SELECT status, current_period_start, current_period_end FROM subscriptions WHERE id = $1",
      [subscription.rows[0].id],
    );

    assert.equal(result.applied, true);
    // This is the regression the audit found: an unconditional overwrite let a
    // late invoice truncate the paid period and silently revoke access.
    assert.equal(stored.rows[0].status, "active");
    assert.equal(
      stored.rows[0].current_period_end.toISOString(),
      "2026-11-01T00:00:00.000Z",
      "the newer paid period must survive an older event",
    );
  });

  it("replaces a dead provider subscription id on re-subscription", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const tenant = { restaurant: { id: a.restaurantId, name: "Cafe A", currencyCode: "PKR" } };
    const user = { id: a.userId, email: "a@example.com" };

    const firstCheckout = await service.startCheckout({
      tenant,
      user,
      planCode: "standard",
      successUrl: "https://pos.example.com/ok",
      cancelUrl: "https://pos.example.com/cancel",
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
    });
    assert.equal(firstCheckout.status, "awaiting_payment");

    // The provider creates its first subscription and the webhook records it.
    let subscriptionId = null;
    const activation = createBillingWebhookService({
      pool: app,
      provider: {
        name: "stripe",
        verifyWebhook: () => ({
          verified: true,
          event: webhookEvent({ providerEventId: "evt_first", providerSubscriptionId: "sub_A" }),
        }),
      },
      clock: () => now,
    });
    await activation.handle({ rawBody: "{}", signatureHeader: "t=1,v1=x" });
    const afterActivation = await admin.query(
      "SELECT id, provider_subscription_id, status FROM subscriptions WHERE restaurant_id = $1",
      [a.restaurantId],
    );
    subscriptionId = afterActivation.rows[0].id;
    assert.equal(afterActivation.rows[0].provider_subscription_id, "sub_A");
    assert.equal(afterActivation.rows[0].status, "active");

    // The owner cancels outright and subscribes again. A pending cancellation
    // is refused a new checkout on purpose; re-subscribing is what a finished
    // cancellation means.
    await service.cancel({ tenant, user, cancelAtPeriodEnd: false });
    await service.startCheckout({
      tenant,
      user,
      planCode: "standard",
      successUrl: "https://pos.example.com/ok",
      cancelUrl: "https://pos.example.com/cancel",
      idempotencyKey: "77777777-7777-4777-8777-777777777777",
    });

    const secondActivation = createBillingWebhookService({
      pool: app,
      provider: {
        name: "stripe",
        verifyWebhook: () => ({
          verified: true,
          event: webhookEvent({
            providerEventId: "evt_second",
            providerSubscriptionId: "sub_B",
            // Stripe keeps the same customer and issues a new subscription.
            providerCustomerId: "cus_1",
            currentPeriodStart: "2026-10-02T00:00:00.000Z",
            currentPeriodEnd: "2026-11-02T00:00:00.000Z",
          }),
        }),
      },
      clock: () => now,
    });
    await secondActivation.handle({ rawBody: "{}", signatureHeader: "t=1,v1=x" });

    const current = await admin.query(
      `SELECT provider_subscription_id, status
         FROM subscriptions
        WHERE restaurant_id = $1 AND status IN ('pending_checkout','trialing','active','past_due','cancel_at_period_end','suspended')`,
      [a.restaurantId],
    );

    assert.equal(current.rowCount, 1, "exactly one live subscription must exist");
    assert.equal(current.rows[0].provider_subscription_id, "sub_B");
    assert.notEqual(current.rows[0].provider_subscription_id, "sub_A");
    assert.equal(current.rows[0].status, "active");

    const dead = await admin.query(
      "SELECT provider_subscription_id FROM subscriptions WHERE restaurant_id = $1 AND status = 'cancelled'",
      [a.restaurantId],
    );
    assert.equal(dead.rows[0].provider_subscription_id, "sub_A");
    void subscriptionId;
  });

  it("admits only one current subscription under concurrent checkout", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const tenant = { restaurant: { id: a.restaurantId, name: "Cafe A", currencyCode: "PKR" } };
    const user = { id: a.userId, email: "a@example.com" };

    const input = {
      tenant,
      user,
      planCode: "standard",
      successUrl: "https://pos.example.com/ok",
      cancelUrl: "https://pos.example.com/cancel",
    };

    const attempts = await Promise.allSettled([
      service.startCheckout({ ...input, idempotencyKey: "88888888-8888-4888-8888-888888888881" }),
      service.startCheckout({ ...input, idempotencyKey: "88888888-8888-4888-8888-888888888882" }),
      service.startCheckout({ ...input, idempotencyKey: "88888888-8888-4888-8888-888888888883" }),
    ]);

    const live = await admin.query(
      `SELECT count(*)::int AS total
         FROM subscriptions
        WHERE restaurant_id = $1 AND status IN ('pending_checkout','active')`,
      [a.restaurantId],
    );
    const all = await admin.query(
      "SELECT count(*)::int AS total FROM subscriptions WHERE restaurant_id = $1",
      [a.restaurantId],
    );

    assert.equal(all.rows[0].total <= 1, true, `expected at most one row, saw ${all.rows[0].total}`);
    assert.equal(live.rows[0].total, 1);
    assert.ok(attempts.some((attempt) => attempt.status === "fulfilled"));
  });

  it("recovers a failed webhook and applies it on the next delivery", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const customer = await admin.query(
      `INSERT INTO billing_customers (restaurant_id, provider, provider_customer_id)
       VALUES ($1, 'stripe', 'cus_1') RETURNING id`,
      [a.restaurantId],
    );
    await admin.query(
      `INSERT INTO provider_tenant_routes
         (provider, provider_reference, provider_reference_type, restaurant_id)
       VALUES ('stripe', 'cus_1', 'customer', $1)`,
      [a.restaurantId],
    );
    // Deliberately no subscription row yet, so the first delivery is a genuine
    // server-side inconsistency rather than a rejected event.
    let attempt = 0;
    const webhooks = createBillingWebhookService({
      pool: app,
      provider: {
        name: "stripe",
        verifyWebhook: () => {
          attempt += 1;
          return { verified: true, event: webhookEvent({ providerEventId: "evt_retry" }) };
        },
      },
      clock: () => now,
    });

    const first = await webhooks.handle({ rawBody: "{}", signatureHeader: "t=1,v1=x" });
    const afterFirst = await admin.query(
      "SELECT processing_status, attempts FROM webhook_events WHERE provider_event_id = 'evt_retry'",
    );

    assert.equal(first.applied, false);
    assert.equal(first.retryable, true);
    assert.equal(first.reason, "subscription_not_found");
    // A failed claim must be released, or the provider's retry would be thrown
    // away as a duplicate and the payment would never be applied.
    assert.equal(afterFirst.rows[0].processing_status, "failed");
    assert.equal(afterFirst.rows[0].attempts, 1);

    const created = await admin.query(
      `INSERT INTO subscriptions (
         restaurant_id, plan_id, plan_price_id, provider, status,
         provider_subscription_id, billing_customer_id,
         current_period_start, current_period_end
       ) VALUES ($1, $2, $3, 'stripe', 'pending_checkout', 'sub_1', $4, NULL, NULL)
       RETURNING id`,
      [a.restaurantId, plan.planId, plan.priceId, customer.rows[0].id],
    );

    const second = await webhooks.handle({ rawBody: "{}", signatureHeader: "t=1,v1=x" });
    const stored = await admin.query(
      "SELECT status FROM subscriptions WHERE id = $1",
      [created.rows[0].id],
    );
    const finalEvent = await admin.query(
      "SELECT processing_status, attempts FROM webhook_events WHERE provider_event_id = 'evt_retry'",
    );

    assert.equal(second.applied, true);
    assert.equal(second.duplicate, false);
    assert.equal(stored.rows[0].status, "active");
    assert.equal(finalEvent.rows[0].processing_status, "processed");
    assert.equal(finalEvent.rows[0].attempts, 2, "the retry must count as a second attempt");

    // A third delivery of an already processed event must change nothing.
    const paymentsBefore = await admin.query(
      "SELECT count(*)::int AS total FROM billing_payments",
    );
    const third = await webhooks.handle({ rawBody: "{}", signatureHeader: "t=1,v1=x" });
    const paymentsAfter = await admin.query(
      "SELECT count(*)::int AS total FROM billing_payments",
    );
    assert.equal(third.duplicate, true);
    assert.equal(third.applied, undefined);
    assert.equal(paymentsAfter.rows[0].total, paymentsBefore.rows[0].total);
  });

  it("does not report a claim loser as a duplicate after the winner releases", async () => {
    await resetBillingState(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    await admin.query(
      `INSERT INTO provider_tenant_routes
         (provider, provider_reference, provider_reference_type, restaurant_id)
       VALUES ('stripe', 'cus_claim_race', 'customer', $1)`,
      [a.restaurantId],
    );
    await admin.query(
      `INSERT INTO webhook_events (
         provider, provider_event_id, event_type, signature_verified, payload,
         processing_status, attempts, received_at, last_error
       ) VALUES (
         'stripe', 'evt_claim_race', 'subscription.renewed', true, '{}'::jsonb,
         'failed', 1, $1, 'first delivery failed'
       )`,
      [new Date(now.getTime() - 3_600_000)],
    );

    const loserAtClaim = deferred();
    const winnerClaimed = deferred();
    const allowWinnerToApply = deferred();
    const winnerReleased = deferred();
    let loserLostClaim = false;

    const loserPool = {
      connect: app.connect.bind(app),
      async query(text, values = []) {
        const sql = text.replace(/\s+/g, " ").trim();
        if (sql.includes("processing_status IN ('pending', 'failed')")) {
          loserAtClaim.resolve();
          await winnerClaimed.promise;
          const result = await app.query(text, values);
          assert.equal(result.rowCount, 0, "the competing worker must win the conditional claim");
          loserLostClaim = true;
          allowWinnerToApply.resolve();
          return result;
        }
        if (loserLostClaim && sql.startsWith("SELECT processing_status, attempts")) {
          await winnerReleased.promise;
        }
        return app.query(text, values);
      },
    };
    const winnerPool = {
      async connect() {
        winnerClaimed.resolve();
        await allowWinnerToApply.promise;
        return app.connect();
      },
      async query(text, values = []) {
        const sql = text.replace(/\s+/g, " ").trim();
        const result = await app.query(text, values);
        if (sql.includes("SET processing_status = 'failed'")) winnerReleased.resolve();
        return result;
      },
    };
    const provider = {
      name: "stripe",
      verifyWebhook: () => ({
        verified: true,
        event: webhookEvent({
          providerEventId: "evt_claim_race",
          providerSubscriptionId: null,
          providerCustomerId: "cus_claim_race",
          providerPaymentId: "pi_claim_race",
        }),
      }),
    };
    const losingDelivery = createBillingWebhookService({
      pool: loserPool,
      provider,
      clock: () => now,
    });
    const winningDelivery = createBillingWebhookService({
      pool: winnerPool,
      provider,
      clock: () => now,
    });

    const loserResultPromise = losingDelivery.handle({ rawBody: "{}", signatureHeader: "x" });
    await loserAtClaim.promise;
    const winnerResultPromise = winningDelivery.handle({ rawBody: "{}", signatureHeader: "x" });
    const [loserResult, winnerResult] = await Promise.all([
      loserResultPromise,
      winnerResultPromise,
    ]);

    assert.deepEqual(loserResult, {
      accepted: false,
      retryable: true,
      reason: "event_claim_race",
    });
    assert.equal(winnerResult.accepted, false);
    assert.equal(winnerResult.retryable, true);
    assert.equal(winnerResult.reason, "subscription_not_found");

    const afterRace = await admin.query(
      `SELECT
         (SELECT processing_status FROM webhook_events
           WHERE provider_event_id = 'evt_claim_race') AS event_status,
         (SELECT attempts FROM webhook_events
           WHERE provider_event_id = 'evt_claim_race') AS attempts,
         (SELECT count(*)::int FROM billing_payments
           WHERE provider_payment_id = 'pi_claim_race') AS payments,
         (SELECT count(*)::int FROM audit_logs
           WHERE metadata->>'providerEventId' = 'evt_claim_race') AS audits`,
    );
    assert.deepEqual(afterRace.rows[0], {
      event_status: "failed",
      attempts: 2,
      payments: 0,
      audits: 0,
    });

    await admin.query(
      `UPDATE webhook_events
          SET processing_status = 'processed', processed_at = $1
        WHERE provider_event_id = 'evt_claim_race'`,
      [now],
    );
    const terminal = await losingDelivery.handle({ rawBody: "{}", signatureHeader: "x" });
    assert.equal(terminal.accepted, true);
    assert.equal(terminal.duplicate, true);
    assert.equal(terminal.retryable, false);
  });

  it("atomically rolls back a crash before commit and applies one replay", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const customer = await admin.query(
      `INSERT INTO billing_customers (restaurant_id, provider, provider_customer_id)
       VALUES ($1, 'stripe', 'cus_crash') RETURNING id`,
      [a.restaurantId],
    );
    const subscription = await admin.query(
      `INSERT INTO subscriptions (
         restaurant_id, plan_id, plan_price_id, provider, status,
         provider_subscription_id, billing_customer_id
       ) VALUES ($1, $2, $3, 'stripe', 'pending_checkout', 'sub_crash', $4)
       RETURNING id`,
      [a.restaurantId, plan.planId, plan.priceId, customer.rows[0].id],
    );
    await admin.query(
      `INSERT INTO provider_tenant_routes
         (provider, provider_reference, provider_reference_type, restaurant_id)
       VALUES ('stripe', 'cus_crash', 'customer', $1)`,
      [a.restaurantId],
    );
    await admin.query(`
      CREATE FUNCTION fail_crash_event_before_commit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.provider_event_id = 'evt_crash'
           AND NEW.processing_status = 'processed' THEN
          RAISE EXCEPTION 'injected crash before commit';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER webhook_crash_before_commit
      BEFORE UPDATE ON webhook_events
      FOR EACH ROW EXECUTE FUNCTION fail_crash_event_before_commit();
    `);

    const webhooks = createBillingWebhookService({
      pool: app,
      provider: {
        name: "stripe",
        verifyWebhook: () => ({
          verified: true,
          event: webhookEvent({
            providerEventId: "evt_crash",
            providerSubscriptionId: "sub_crash",
            providerCustomerId: "cus_crash",
            providerPaymentId: "pi_crash",
          }),
        }),
      },
      clock: () => now,
    });

    try {
      await assert.rejects(
        webhooks.handle({ rawBody: "{}", signatureHeader: "t=1,v1=x" }),
        (error) => error.code === "BILLING_EVENT_FAILED" && error.statusCode === 500,
      );
    } finally {
      await admin.query("DROP TRIGGER webhook_crash_before_commit ON webhook_events");
      await admin.query("DROP FUNCTION fail_crash_event_before_commit()" );
    }

    const afterCrash = await admin.query(
      `SELECT
         (SELECT status FROM subscriptions WHERE id = $1) AS subscription_status,
         (SELECT count(*)::int FROM billing_payments WHERE provider_payment_id = 'pi_crash') AS payments,
         (SELECT count(*)::int FROM audit_logs WHERE metadata->>'providerEventId' = 'evt_crash') AS audits,
         (SELECT processing_status FROM webhook_events WHERE provider_event_id = 'evt_crash') AS event_status`,
      [subscription.rows[0].id],
    );
    assert.deepEqual(afterCrash.rows[0], {
      subscription_status: "pending_checkout",
      payments: 0,
      audits: 0,
      event_status: "failed",
    });

    const retry = await webhooks.handle({ rawBody: "{}", signatureHeader: "t=1,v1=x" });
    assert.equal(retry.applied, true);
    const afterRetry = await admin.query(
      `SELECT
         (SELECT status FROM subscriptions WHERE id = $1) AS subscription_status,
         (SELECT count(*)::int FROM billing_payments WHERE provider_payment_id = 'pi_crash') AS payments,
         (SELECT count(*)::int FROM audit_logs WHERE metadata->>'providerEventId' = 'evt_crash') AS audits,
         (SELECT processing_status FROM webhook_events WHERE provider_event_id = 'evt_crash') AS event_status`,
      [subscription.rows[0].id],
    );
    assert.deepEqual(afterRetry.rows[0], {
      subscription_status: "active",
      payments: 1,
      audits: 1,
      event_status: "processed",
    });

    const duplicate = await webhooks.handle({ rawBody: "{}", signatureHeader: "t=1,v1=x" });
    assert.equal(duplicate.duplicate, true);
    const finalCounts = await admin.query(
      `SELECT
         (SELECT count(*)::int FROM billing_payments WHERE provider_payment_id = 'pi_crash') AS payments,
         (SELECT count(*)::int FROM audit_logs WHERE metadata->>'providerEventId' = 'evt_crash') AS audits`,
    );
    assert.deepEqual(finalCounts.rows[0], { payments: 1, audits: 1 });
  });

  it("stops retrying a webhook at the configured maximum attempts", async () => {
    await resetBillingState(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    await admin.query(
      `INSERT INTO provider_tenant_routes
         (provider, provider_reference, provider_reference_type, restaurant_id)
       VALUES ('stripe', 'cus_exhausted', 'customer', $1)`,
      [a.restaurantId],
    );
    const webhooks = createBillingWebhookService({
      pool: app,
      maxAttempts: 2,
      provider: {
        name: "stripe",
        verifyWebhook: () => ({
          verified: true,
          event: webhookEvent({
            providerEventId: "evt_exhausted",
            providerSubscriptionId: null,
            providerCustomerId: "cus_exhausted",
          }),
        }),
      },
      clock: () => now,
    });

    const first = await webhooks.handle({ rawBody: "{}", signatureHeader: "x" });
    const second = await webhooks.handle({ rawBody: "{}", signatureHeader: "x" });
    const exhausted = await webhooks.handle({ rawBody: "{}", signatureHeader: "x" });
    assert.equal(first.reason, "subscription_not_found");
    assert.equal(second.reason, "subscription_not_found");
    assert.equal(exhausted.exhausted, true);
    assert.equal(exhausted.retryable, false);
    const stored = await admin.query(
      "SELECT processing_status, attempts FROM webhook_events WHERE provider_event_id = 'evt_exhausted'",
    );
    assert.deepEqual(stored.rows[0], { processing_status: "failed", attempts: 2 });
  });

  it("survives a verified event whose period is unusable without consuming it", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const customer = await admin.query(
      `INSERT INTO billing_customers (restaurant_id, provider, provider_customer_id)
       VALUES ($1, 'stripe', 'cus_1') RETURNING id`,
      [a.restaurantId],
    );
    const subscription = await admin.query(
      `INSERT INTO subscriptions (
         restaurant_id, plan_id, plan_price_id, provider, status,
         provider_subscription_id, billing_customer_id,
         current_period_start, current_period_end
       ) VALUES ($1, $2, $3, 'stripe', 'pending_checkout', 'sub_1', $4, NULL, NULL)
       RETURNING id`,
      [a.restaurantId, plan.planId, plan.priceId, customer.rows[0].id],
    );
    await admin.query(
      `INSERT INTO provider_tenant_routes
         (provider, provider_reference, provider_reference_type, restaurant_id)
       VALUES ('stripe', 'cus_1', 'customer', $1)`,
      [a.restaurantId],
    );

    const webhooks = createBillingWebhookService({
      pool: app,
      provider: {
        name: "stripe",
        verifyWebhook: () => ({
          verified: true,
          event: {
            ...webhookEvent({ providerEventId: "evt_bad_period" }),
            // The period ends before it begins, which the schema forbids.
            currentPeriodStart: "2026-11-01T00:00:00.000Z",
            currentPeriodEnd: "2026-10-01T00:00:00.000Z",
          },
        }),
      },
      clock: () => now,
    });

    const result = await webhooks.handle({ rawBody: "{}", signatureHeader: "t=1,v1=x" });
    const stored = await admin.query(
      "SELECT status, current_period_end FROM subscriptions WHERE id = $1",
      [subscription.rows[0].id],
    );

    // The unusable period is dropped rather than allowed to violate the schema
    // check and roll back the whole event, and it grants nothing.
    assert.equal(result.applied, true);
    assert.equal(stored.rows[0].status, "pending_checkout");
    assert.equal(stored.rows[0].current_period_end, null);
  });

  it("records a verified billing event in the audit log", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const customer = await admin.query(
      `INSERT INTO billing_customers (restaurant_id, provider, provider_customer_id)
       VALUES ($1, 'stripe', 'cus_1') RETURNING id`,
      [a.restaurantId],
    );
    await admin.query(
      `INSERT INTO subscriptions (
         restaurant_id, plan_id, plan_price_id, provider, status,
         provider_subscription_id, billing_customer_id,
         current_period_start, current_period_end
       ) VALUES ($1, $2, $3, 'stripe', 'pending_checkout', 'sub_1', $4, NULL, NULL)`,
      [a.restaurantId, plan.planId, plan.priceId, customer.rows[0].id],
    );
    await admin.query(
      `INSERT INTO provider_tenant_routes
         (provider, provider_reference, provider_reference_type, restaurant_id)
       VALUES ('stripe', 'cus_1', 'customer', $1)`,
      [a.restaurantId],
    );

    const webhooks = createBillingWebhookService({
      pool: app,
      provider: {
        name: "stripe",
        verifyWebhook: () => ({ verified: true, event: webhookEvent({ providerEventId: "evt_audit" }) }),
      },
      clock: () => now,
    });
    await webhooks.handle({ rawBody: "{}", signatureHeader: "t=1,v1=x" });

    const audit = await admin.query(
      `SELECT action, actor_type, restaurant_id FROM audit_logs
        WHERE restaurant_id = $1 ORDER BY created_at`,
      [a.restaurantId],
    );

    assert.ok(audit.rowCount >= 1);
    assert.equal(audit.rows.at(-1).actor_type, "webhook");
    assert.equal(audit.rows.at(-1).action, "subscription.active");
  });

  it("checkout_attempts RLS between Restaurant A and Restaurant B", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const b = await seedRestaurant(admin, { name: "Cafe B" });

    // Insert attempt for restaurant A
    await admin.query(
      `INSERT INTO checkout_attempts (
         id, restaurant_id, idempotency_key, plan_code, plan_hash,
         success_url, cancel_url, status
       ) VALUES (gen_random_uuid(), $1, 'key_a', 'STANDARD', 'hash_a',
         'https://a.com/success', 'https://a.com/cancel', 'creating')`,
      [a.restaurantId],
    );

    // Restaurant B cannot select, update, or delete restaurant A's attempt.
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.restaurant_id', $1, true)", [b.restaurantId]);
      const visible = await client.query(
        "SELECT * FROM checkout_attempts WHERE restaurant_id = $1",
        [a.restaurantId],
      );
      const updated = await client.query(
        "UPDATE checkout_attempts SET status = 'failed' WHERE restaurant_id = $1",
        [a.restaurantId],
      );
      const deleted = await client.query(
        "DELETE FROM checkout_attempts WHERE restaurant_id = $1",
        [a.restaurantId],
      );
      await client.query("ROLLBACK");
      assert.equal(visible.rowCount, 0, "Restaurant B cannot see Restaurant A's checkout attempts");
      assert.equal(updated.rowCount, 0, "Restaurant B cannot update Restaurant A's checkout attempts");
      assert.equal(deleted.rowCount, 0, "Restaurant B cannot delete Restaurant A's checkout attempts");
    } finally {
      client.release();
    }

    const insertClient = await app.connect();
    try {
      await insertClient.query("BEGIN");
      await insertClient.query("SELECT set_config('app.restaurant_id', $1, true)", [b.restaurantId]);
      await assert.rejects(
        insertClient.query(
          `INSERT INTO checkout_attempts (
             id, restaurant_id, idempotency_key, plan_code, plan_hash,
             success_url, cancel_url, status
           ) VALUES (gen_random_uuid(), $1, 'foreign_insert', 'STANDARD', 'hash',
             'https://pos.example.com/ok', 'https://pos.example.com/cancel', 'failed')`,
          [a.restaurantId],
        ),
        (error) => error.code === "42501",
      );
      await insertClient.query("ROLLBACK");
    } finally {
      insertClient.release();
    }

    const remaining = await admin.query(
      "SELECT status FROM checkout_attempts WHERE restaurant_id = $1",
      [a.restaurantId],
    );
    assert.equal(remaining.rowCount, 1);
    assert.equal(remaining.rows[0].status, "creating");
  });

  it("one-live-attempt unique index prevents multiple creating/created attempts", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });

    await admin.query(
      `INSERT INTO checkout_attempts (
         id, restaurant_id, idempotency_key, plan_code, plan_hash,
         success_url, cancel_url, status
       ) VALUES (gen_random_uuid(), $1, 'key1', 'STANDARD', 'hash1',
         'https://a.com/success', 'https://a.com/cancel', 'creating')`,
      [a.restaurantId],
    );

    await assert.rejects(
      admin.query(
        `INSERT INTO checkout_attempts (
           id, restaurant_id, idempotency_key, plan_code, plan_hash,
           success_url, cancel_url, status
         ) VALUES (gen_random_uuid(), $1, 'key2', 'STANDARD', 'hash2',
           'https://a.com/success', 'https://a.com/cancel', 'created')`,
        [a.restaurantId],
      ),
      (error) => error.code === "23505",
      "second live attempt must be refused by partial unique index",
    );
  });

  it("complete first checkout flow", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const tenant = { restaurant: { id: a.restaurantId, name: "Cafe A", currencyCode: "PKR" } };
    const user = { id: a.userId, email: "a@example.com" };

    const result = await service.startCheckout({
      tenant,
      user,
      planCode: "STANDARD",
      successUrl: "https://pos.example.com/ok",
      cancelUrl: "https://pos.example.com/cancel",
      idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    assert.equal(result.status, "awaiting_payment");
    assert.equal(result.replayed, false);
    assert.ok(result.checkoutUrl);

    // Verify attempt was created and marked created
    const attempt = await admin.query(
      `SELECT status, plan_hash, provider_checkout_session_id, provider_checkout_url
         FROM checkout_attempts
        WHERE idempotency_key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`,
    );
    assert.equal(attempt.rows[0].status, "created");
    assert.equal(attempt.rows[0].plan_hash, checkoutPayloadHash({
      planCode: "STANDARD",
      successUrl: "https://pos.example.com/ok",
      cancelUrl: "https://pos.example.com/cancel",
    }));
    assert.ok(attempt.rows[0].provider_checkout_session_id);
    assert.ok(attempt.rows[0].provider_checkout_url);

    const providerCallsBeforeReplay = provider.calls.length;
    const replay = await service.startCheckout({
      tenant, user, planCode: "standard",
      successUrl: "https://pos.example.com/ok",
      cancelUrl: "https://pos.example.com/cancel",
      idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.checkoutUrl, result.checkoutUrl);
    assert.equal(provider.calls.length, providerCallsBeforeReplay);
  });

  it("failed checkout retry uses same provider idempotency key", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const tenant = { restaurant: { id: a.restaurantId, name: "Cafe A", currencyCode: "PKR" } };
    const user = { id: a.userId, email: "a@example.com" };

    // First attempt fails at provider
    let failFirst = true;
    const checkoutKeys = [];
    const provider = {
      name: "stripe",
      webhookSignatureHeader: "stripe-signature",
      async createCustomer() { return { providerCustomerId: "cus_1" }; },
      async createCheckoutSession(input) {
        checkoutKeys.push(input.idempotencyKey);
        if (failFirst) {
          failFirst = false;
          throw new Error("provider temporarily unavailable");
        }
        return { providerCheckoutSessionId: "cs_2", checkoutUrl: "https://checkout.stripe.com/retry" };
      },
      async changeSubscription() { return { status: "active" }; },
      async cancelSubscription() { return { status: "active" }; },
      async resumeSubscription() { return { status: "active" }; },
      verifyWebhook: () => ({ verified: false, event: null, reason: "test" }),
    };

    const service2 = createSubscriptionService(app, { provider, trustedOrigins: ["https://pos.example.com"] });

    // First attempt fails
    await assert.rejects(
      () => service2.startCheckout({
        tenant: { restaurant: { id: a.restaurantId, name: "Cafe A", currencyCode: "PKR" } },
        user: { id: a.userId, email: "a@example.com" },
        planCode: "STANDARD",
        successUrl: "https://pos.example.com/ok",
        cancelUrl: "https://pos.example.com/cancel",
        idempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
      /provider temporarily unavailable/,
    );

    // Verify attempt marked failed
    const failedAttempt = await admin.query(
      `SELECT id, subscription_id, status, error_message, provider_idempotency_key
         FROM checkout_attempts WHERE idempotency_key = $1`,
      ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    );
    assert.equal(failedAttempt.rows[0].status, "failed");
    assert.ok(failedAttempt.rows[0].error_message);
    assert.ok(failedAttempt.rows[0].subscription_id);
    assert.ok(failedAttempt.rows[0].provider_idempotency_key);

    // Retry succeeds
    const result = await service2.startCheckout({
      tenant: { restaurant: { id: a.restaurantId, name: "Cafe A", currencyCode: "PKR" } },
      user: { id: a.userId, email: "a@example.com" },
      planCode: "STANDARD",
      successUrl: "https://pos.example.com/ok",
      cancelUrl: "https://pos.example.com/cancel",
      idempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    assert.equal(result.replayed, false);
    assert.equal(result.status, "awaiting_payment");

    // Verify attempt was updated to created with same provider idempotency key
    const retried = await admin.query(
      `SELECT id, subscription_id, status, provider_idempotency_key
         FROM checkout_attempts WHERE idempotency_key = $1`,
      ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    );
    assert.equal(retried.rows[0].status, "created");
    assert.equal(retried.rowCount, 1);
    assert.equal(retried.rows[0].id, failedAttempt.rows[0].id);
    assert.equal(retried.rows[0].subscription_id, failedAttempt.rows[0].subscription_id);
    assert.equal(
      retried.rows[0].provider_idempotency_key,
      failedAttempt.rows[0].provider_idempotency_key,
    );
    assert.deepEqual(checkoutKeys, [
      failedAttempt.rows[0].provider_idempotency_key,
      failedAttempt.rows[0].provider_idempotency_key,
    ]);
    const counts = await admin.query(
      `SELECT
         (SELECT count(*)::int FROM checkout_attempts WHERE restaurant_id = $1) AS attempts,
         (SELECT count(*)::int FROM subscriptions WHERE restaurant_id = $1) AS subscriptions`,
      [a.restaurantId],
    );
    assert.deepEqual(counts.rows[0], { attempts: 1, subscriptions: 1 });
  });

  it("expired checkout retry reactivates the attempt", async () => {
    await resetBillingState(admin);
    await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const tenant = { restaurant: { id: a.restaurantId, name: "Cafe A", currencyCode: "PKR" } };
    const user = { id: a.userId, email: "a@example.com" };
    const key = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const input = {
      tenant, user, planCode: "STANDARD",
      successUrl: "https://pos.example.com/ok",
      cancelUrl: "https://pos.example.com/cancel",
      idempotencyKey: key,
    };

    await service.startCheckout(input);
    const original = await admin.query(
      `UPDATE checkout_attempts
          SET status = 'expired', expires_at = now() - interval '1 day'
        WHERE restaurant_id = $1 AND idempotency_key = $2
        RETURNING id, subscription_id, provider_idempotency_key`,
      [a.restaurantId, key],
    );

    const result = await service.startCheckout(input);

    assert.equal(result.replayed, false);
    assert.equal(result.status, "awaiting_payment");

    const reactivated = await admin.query(
      `SELECT id, status, subscription_id, provider_idempotency_key
         FROM checkout_attempts WHERE restaurant_id = $1 AND idempotency_key = $2`,
      [a.restaurantId, key],
    );
    assert.equal(reactivated.rowCount, 1);
    assert.equal(reactivated.rows[0].id, original.rows[0].id);
    assert.equal(reactivated.rows[0].status, "created");
    assert.equal(reactivated.rows[0].subscription_id, original.rows[0].subscription_id);
    assert.equal(
      reactivated.rows[0].provider_idempotency_key,
      original.rows[0].provider_idempotency_key,
    );
    const subscriptions = await admin.query(
      "SELECT count(*)::int AS total FROM subscriptions WHERE restaurant_id = $1",
      [a.restaurantId],
    );
    assert.equal(subscriptions.rows[0].total, 1);
  });

  it("same-key payload conflict rejected with IDEMPOTENCY_KEY_CONFLICT", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const tenant = { restaurant: { id: a.restaurantId, name: "Cafe A", currencyCode: "PKR" } };
    const user = { id: a.userId, email: "a@example.com" };

    // First request
    await service.startCheckout({
      tenant: { restaurant: { id: a.restaurantId, name: "Cafe A", currencyCode: "PKR" } },
      user: { id: a.userId, email: "a@example.com" },
      planCode: "STANDARD",
      successUrl: "https://pos.example.com/ok",
      cancelUrl: "https://pos.example.com/cancel",
      idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });

    // Same key, different plan
    await assert.rejects(
      () => service.startCheckout({
        tenant: { restaurant: { id: a.restaurantId, name: "Cafe A", currencyCode: "PKR" } },
        user: { id: a.userId, email: "a@example.com" },
        planCode: "PREMIUM", // Different plan
        successUrl: "https://pos.example.com/ok",
        cancelUrl: "https://pos.example.com/cancel",
        idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }),
      (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT" && error.statusCode === 409,
    );

    for (const changed of [
      { successUrl: "https://pos.example.com/other-success" },
      { cancelUrl: "https://pos.example.com/other-cancel" },
    ]) {
      await assert.rejects(
        () => service.startCheckout({
          tenant, user, planCode: "STANDARD",
          successUrl: "https://pos.example.com/ok",
          cancelUrl: "https://pos.example.com/cancel",
          idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          ...changed,
        }),
        (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT" && error.statusCode === 409,
      );
    }
    const attempts = await admin.query(
      "SELECT count(*)::int AS total FROM checkout_attempts WHERE restaurant_id = $1",
      [a.restaurantId],
    );
    assert.equal(attempts.rows[0].total, 1);
  });

  it("concurrent same-key calls resolve to same session", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const tenant = { restaurant: { id: a.restaurantId, name: "Cafe A", currencyCode: "PKR" } };
    const user = { id: a.userId, email: "a@example.com" };
    const key = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    let releaseProvider;
    let providerStarted;
    const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
    const started = new Promise((resolve) => { providerStarted = resolve; });
    let checkoutCalls = 0;
    const concurrentProvider = billingProvider({
      async createCustomer() { return { providerCustomerId: "cus_concurrent" }; },
      async createCheckoutSession() {
        checkoutCalls += 1;
        providerStarted();
        await providerGate;
        return {
          providerCheckoutSessionId: "cs_concurrent",
          checkoutUrl: "https://checkout.stripe.com/concurrent",
        };
      },
    });
    const concurrentService = createSubscriptionService(app, {
      provider: concurrentProvider,
      trustedOrigins: ["https://pos.example.com"],
    });
    const input = {
      tenant, user, planCode: "STANDARD",
      successUrl: "https://pos.example.com/ok",
      cancelUrl: "https://pos.example.com/cancel",
      idempotencyKey: key,
    };

    const winnerPromise = concurrentService.startCheckout(input);
    await started;
    const followersPromise = Promise.allSettled([
      concurrentService.startCheckout(input),
      concurrentService.startCheckout(input),
    ]);
    const followers = await followersPromise;
    releaseProvider();
    const winner = await winnerPromise;

    assert.equal(winner.replayed, false);
    assert.equal(checkoutCalls, 1);
    assert.deepEqual(
      followers.map((result) => result.status === "rejected" ? result.reason.code : "fulfilled"),
      ["CHECKOUT_IN_PROGRESS", "CHECKOUT_IN_PROGRESS"],
    );
    const counts = await admin.query(
      `SELECT
         (SELECT count(*)::int FROM checkout_attempts WHERE restaurant_id = $1) AS attempts,
         (SELECT count(*)::int FROM subscriptions WHERE restaurant_id = $1) AS subscriptions`,
      [a.restaurantId],
    );
    assert.deepEqual(counts.rows[0], { attempts: 1, subscriptions: 1 });
  });

  it("concurrent different-key calls are rejected", async () => {
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const tenant = { restaurant: { id: a.restaurantId, name: "Cafe A", currencyCode: "PKR" } };
    const user = { id: a.userId, email: "a@example.com" };

    // First checkout starts
    const firstPromise = service.startCheckout({
      tenant: { restaurant: { id: a.restaurantId, name: "Cafe A", currencyCode: "PKR" } },
      user: { id: a.userId, email: "a@example.com" },
      planCode: "STANDARD",
      successUrl: "https://pos.example.com/ok",
      cancelUrl: "https://pos.example.com/cancel",
      idempotencyKey: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });

    // Second with different key should be rejected
    const secondPromise = service.startCheckout({
      tenant: { restaurant: { id: a.restaurantId, name: "Cafe A", currencyCode: "PKR" } },
      user: { id: a.userId, email: "a@example.com" },
      planCode: "STANDARD",
      successUrl: "https://pos.example.com/ok",
      cancelUrl: "https://pos.example.com/cancel",
      idempotencyKey: "gggggggg-gggg-4ggg-8ggg-gggggggggggg",
    });

    const [first, second] = await Promise.allSettled([firstPromise, secondPromise]);

    const successful = [first, second].filter((r) => r.status === "fulfilled");
    assert.equal(successful.length, 1, "only one checkout should succeed");

    const rejected = [first, second].filter((r) => r.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, "CHECKOUT_ALREADY_IN_PROGRESS");
  });

  it("preserves one canonical billing customer under concurrent creation", async () => {
    await resetBillingState(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });
    const calls = [];
    let sequence = 0;
    const concurrentProvider = {
      name: "stripe",
      async createCustomer(input) {
        calls.push(input);
        const candidate = ++sequence;
        await new Promise((resolve) => setImmediate(resolve));
        return { providerCustomerId: `cus_candidate_${candidate}` };
      },
    };
    const input = {
      provider: concurrentProvider,
      restaurantId: a.restaurantId,
      userId: a.userId,
      email: "a@example.com",
      restaurantName: "Cafe A",
    };

    const [first, second] = await Promise.all([
      ensureCanonicalBillingCustomer(app, input),
      ensureCanonicalBillingCustomer(app, input),
    ]);

    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((call) => call.idempotencyKey),
      [`cust_${a.restaurantId}_stripe`, `cust_${a.restaurantId}_stripe`],
    );
    assert.equal(first.id, second.id);
    assert.equal(first.provider_customer_id, second.provider_customer_id);
    const stored = await admin.query(
      `SELECT id, provider_customer_id
         FROM billing_customers
        WHERE restaurant_id = $1 AND provider = 'stripe'`,
      [a.restaurantId],
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].id, first.id);
    assert.equal(stored.rows[0].provider_customer_id, first.provider_customer_id);
    const routes = await admin.query(
      `SELECT provider_reference FROM provider_tenant_routes
        WHERE restaurant_id = $1 AND provider = 'stripe'`,
      [a.restaurantId],
    );
    assert.deepEqual(routes.rows.map((row) => row.provider_reference), [first.provider_customer_id]);
  });

  it("correct parameter execution against PostgreSQL", async () => {
    // Verify the UPDATE statement uses correct placeholder order
    await resetBillingState(admin);
    const plan = await seedPlan(admin);
    const a = await seedRestaurant(admin, { name: "Cafe A" });

    // Insert a created attempt with a valid UUID
    const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await admin.query(
      `INSERT INTO checkout_attempts (
         id, restaurant_id, idempotency_key, plan_code, plan_hash,
         success_url, cancel_url, status
       ) VALUES ($1, $2, 'key_param', 'STANDARD', 'hash_param',
         'https://a.com/success', 'https://a.com/cancel', 'created')`,
      [attemptId, a.restaurantId],
    );

    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.restaurant_id', $1, true)", [a.restaurantId]);

      // This mirrors the exact UPDATE in the service - check parameter count
      const result = await client.query(
        `UPDATE checkout_attempts
            SET status = 'created',
                provider_customer_id = $3,
                provider_checkout_session_id = $4,
                provider_checkout_url = $5,
                updated_at = now()
          WHERE id = $1 AND restaurant_id = $2
          RETURNING provider_customer_id, provider_checkout_session_id`,
        [attemptId, a.restaurantId, "cus_test", "cs_test", "https://checkout.stripe.com/test"],
      );

      assert.equal(result.rowCount, 1);
      assert.equal(result.rows[0].provider_customer_id, "cus_test");
      assert.equal(result.rows[0].provider_checkout_session_id, "cs_test");

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
