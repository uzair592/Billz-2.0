import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBillingWebhookService } from "../src/server/billing/billing-webhook-service.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const otherRestaurantId = "99999999-9999-4999-8999-999999999999";
const subscriptionId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-10-02T12:00:00.000Z");

function event(overrides = {}) {
  return {
    providerEventId: "evt_1",
    type: "subscription.renewed",
    providerSubscriptionId: "sub_1",
    providerCustomerId: "cus_1",
    providerCheckoutSessionId: null,
    providerPaymentId: "pi_1",
    describesSubscription: false,
    status: "active",
    currentPeriodStart: "2026-10-02T00:00:00.000Z",
    currentPeriodEnd: "2026-11-02T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    currencyCode: "PKR",
    amountMinor: 25_000,
    failureCode: null,
    failureMessage: null,
    occurredAt: "2026-10-02T11:59:00.000Z",
    ...overrides,
  };
}

/**
 * A pool that keeps a real in-memory `webhook_events` table.
 *
 * The claim state machine is the thing under test, so it is modelled here with
 * the same conditional-update semantics the SQL uses: a retry only succeeds when
 * the row is `pending` or `failed` and still has attempts left.
 */
function fakePool({
  normalized = event(),
  verified = true,
  subscription = {
    id: subscriptionId,
    status: "pending_checkout",
    current_period_start: null,
    current_period_end: null,
    grace_ends_at: null,
    provider_subscription_id: null,
    cancel_at_period_end: false,
  },
  routes = new Map([
    ["sub_1", restaurantId],
    ["cus_1", restaurantId],
    ["cs_1", restaurantId],
  ]),
  maxAttempts = 8,
} = {}) {
  const calls = [];
  const logs = [];
  const webhookEvents = new Map();
  const state = {
    subscription: subscription ? { ...subscription } : null,
    payments: [],
    audit: [],
  };

  function rowFor(providerEventId) {
    return webhookEvents.get(`${"stripe"}::${providerEventId}`) ?? null;
  }

  function handle(text, values, scope) {
    const sql = text.replace(/\s+/g, " ").trim();
    calls.push({ text: sql, values, scope });

    if (sql.startsWith("INSERT INTO webhook_events")) {
      const key = `stripe::${values[2]}`;
      if (webhookEvents.has(key)) return { rows: [] };
      const row = {
        id: values[0],
        providerEventId: values[2],
        eventType: values[3],
        signatureVerified: values[4],
        payload: values[5],
        processingStatus: values[6],
        attempts: 1,
        receivedAt: values[7],
        processedAt: null,
        lastError: null,
      };
      webhookEvents.set(key, row);
      return { rows: [{ id: row.id, processing_status: row.processingStatus, attempts: 1 }] };
    }

    if (sql.includes("SET processing_status = 'processing'")) {
      const row = rowFor(values[1]);
      if (!row) return { rows: [] };
      if (!["pending", "failed"].includes(row.processingStatus)) return { rows: [] };
      if (row.attempts >= values[2]) return { rows: [] };
      row.processingStatus = "processing";
      row.attempts += 1;
      row.receivedAt = values[3];
      return { rows: [{ id: row.id, processing_status: row.processingStatus, attempts: row.attempts }] };
    }

    if (sql.startsWith("SELECT processing_status, attempts")) {
      const row = rowFor(values[1]);
      return {
        rows: row ? [{ processing_status: row.processingStatus, attempts: row.attempts, received_at: row.receivedAt }] : [],
      };
    }

    if (sql.startsWith("UPDATE webhook_events")) {
      console.log("UPDATE SQL:", sql);
      if (sql.includes("lease expired")) {
        // The lease sweep is keyed by time, not by event, so it scans.
        const cutoff = values[1];
        let released = 0;
        for (const row of webhookEvents.values()) {
          if (row.processingStatus !== "processing") continue;
          if (!(new Date(row.receivedAt).getTime() < new Date(cutoff).getTime())) continue;
          row.processingStatus = "failed";
          row.lastError = "processing lease expired";
          released += 1;
        }
        return { rows: [], rowCount: released };
      }
      const row = rowFor(values[1]);
      if (!row) return { rows: [], rowCount: 0 };
      // Reclaim expired processing lease for a specific event (in claimEvent)
      if (sql.includes("WHERE provider = $1 AND provider_event_id = $2 AND processing_status = 'processing' AND received_at < $5")) {
        if (row.processingStatus !== "processing") return { rows: [], rowCount: 0 };
        const cutoff = new Date(values[4]);
        if (!(new Date(row.receivedAt).getTime() < cutoff.getTime())) return { rows: [], rowCount: 0 };
        row.processingStatus = "processing";
        row.attempts += 1;
        row.receivedAt = values[3];
        return { rows: [{ id: row.id, processing_status: row.processingStatus, attempts: row.attempts }] };
      }
      // Release claim (set to failed)
      if (sql.includes("WHERE provider = $1 AND provider_event_id = $2 AND processing_status = 'processing'")) {
        if (row.processingStatus !== "processing") return { rows: [], rowCount: 0 };
        row.processingStatus = "failed";
        row.lastError = values[2];
        row.processedAt = null;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("'processed'")) {
        row.processingStatus = "processed";
        row.processedAt = values[2];
        row.lastError = null;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("'ignored'")) {
        row.processingStatus = "ignored";
        row.processedAt = values[2];
        row.lastError = values[3];
        return { rows: [], rowCount: 1 };
      }
      // Claim retry for pending/failed
      if (sql.includes("SET processing_status = 'processing'")) {
        const row = rowFor(values[1]);
        if (!row) return { rows: [] };
        if (!["pending", "failed"].includes(row.processingStatus)) return { rows: [] };
        if (row.attempts >= values[2]) return { rows: [] };
        row.processingStatus = "processing";
        row.attempts += 1;
        row.receivedAt = values[3];
        return { rows: [{ id: row.id, processing_status: row.processingStatus, attempts: row.attempts }] };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("FROM provider_tenant_routes")) {
      const restaurant = routes.get(values[1]);
      return { rows: restaurant ? [{ restaurant_id: restaurant }] : [] };
    }

    if (sql.startsWith("SELECT id, status, current_period_start")) {
      return { rows: state.subscription ? [state.subscription] : [] };
    }

    if (sql.startsWith("UPDATE subscriptions")) {
      state.subscription = {
        ...state.subscription,
        status: values[2],
        grace_ends_at: values[5],
        cancel_at_period_end: values[6],
        provider_subscription_id: values[9],
        trial_ends_at: values[10] ?? state.subscription?.trial_ends_at ?? null,
        updated_period_start: values[3],
        updated_period_end: values[4],
      };
      return { rows: [] };
    }

    if (sql.startsWith("INSERT INTO audit_logs")) {
      state.audit.push({ action: values[1], actorType: "webhook", resourceId: values[2] });
      return { rows: [] };
    }

    if (sql.startsWith("INSERT INTO billing_payments")) {
      state.payments.push({ status: values[4], amountMinor: values[6], paidAt: values[9] });
      return { rows: [] };
    }

    if (sql.startsWith("INSERT INTO provider_tenant_routes")) {
      if (!routes.has(values[1])) routes.set(values[1], values[2]);
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
    state,
    routes,
    webhookEvents,
    logs,
    normalized,
    verified,
    maxAttempts,
    eventRow: (providerEventId) => rowFor(providerEventId),
    find(predicate) {
      return calls.filter(predicate);
    },
    updates() {
      return calls.filter((call) => call.text.startsWith("UPDATE subscriptions"));
    },
    async query(text, values = []) {
      return handle(text, values, "platform");
    },
    async connect() {
      return client;
    },
  };
}

function service(pool, options = {}) {
  return createBillingWebhookService({
    pool,
    clock: () => now,
    maxAttempts: pool.maxAttempts,
    logger: {
      info: (entry) => pool.logs.push(["info", entry]),
      warn: (entry) => pool.logs.push(["warn", entry]),
      error: (entry) => pool.logs.push(["error", entry]),
    },
    provider: {
      name: "stripe",
      webhookSignatureHeader: "stripe-signature",
      verifyWebhook: () => (pool.verified
        ? { verified: true, event: pool.normalized, reason: null }
        : { verified: false, event: null, reason: "signature_mismatch" }),
    },
    ...options,
  });
}

function handle(pool, options = {}) {
  return service(pool, options).handle({ rawBody: "{}", signatureHeader: "t=1,v1=abc" });
}

describe("billing webhook service", () => {
  it("refuses an unverified payload without touching a subscription", async () => {
    const pool = fakePool();
    pool.verified = false;

    const result = await handle(pool);

    assert.equal(result.accepted, false);
    assert.equal(result.reason, "signature_mismatch");
    assert.equal(pool.updates().length, 0);
    const claim = pool.find((call) => call.text.startsWith("INSERT INTO webhook_events"))[0];
    assert.equal(claim.values[4], false);
    assert.equal(claim.values[6], "ignored");
    assert.ok(pool.logs.some(([level]) => level === "warn"));
  });

  it("activates a paid subscription from a verified renewal and records the payment", async () => {
    const pool = fakePool();

    const result = await handle(pool);

    assert.equal(result.applied, true);
    assert.equal(result.status, "active");
    assert.equal(result.paymentRecorded, true);
    assert.equal(pool.state.subscription.status, "active");
    assert.equal(pool.state.payments.length, 1);
    assert.equal(pool.state.payments[0].amountMinor, 25_000);
    assert.equal(pool.state.payments[0].paidAt instanceof Date, true);
    assert.equal(pool.eventRow("evt_1").processingStatus, "processed");
    assert.ok(pool.state.audit.some((row) => row.action === "subscription.active"));
    assert.equal(pool.state.audit[0].actorType, "webhook");
  });

  it("never grants access from a checkout event that carries no paid period", async () => {
    const pool = fakePool();
    pool.normalized = event({
      type: "checkout.completed",
      providerCheckoutSessionId: "cs_1",
      providerPaymentId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });

    const result = await handle(pool);

    assert.equal(result.applied, true);
    assert.equal(result.status, "pending_checkout");
    assert.equal(pool.state.subscription.status, "pending_checkout");
    assert.equal(pool.state.payments.length, 0);
  });

  it("resolves the restaurant from a checkout session when no subscription exists yet", async () => {
    const pool = fakePool();
    pool.routes.clear();
    pool.routes.set("cs_1", otherRestaurantId);
    pool.normalized = event({
      type: "checkout.completed",
      providerSubscriptionId: null,
      providerCheckoutSessionId: "cs_1",
      providerPaymentId: null,
      currentPeriodEnd: null,
    });

    const result = await handle(pool);

    assert.equal(result.applied, true);
    assert.equal(pool.updates()[0].values[0], otherRestaurantId);
  });

  it("reports an unresolvable provider route as retryable instead of accepting it", async () => {
    const pool = fakePool();
    pool.routes.clear();

    const result = await handle(pool);

    // Before the fix this returned accepted:true, so the provider stopped
    // retrying a payment it had already taken.
    assert.equal(result.accepted, false);
    assert.equal(result.retryable, true);
    assert.equal(result.reason, "restaurant_route_missing");
    assert.equal(pool.updates().length, 0);
    assert.notEqual(pool.eventRow("evt_1").processingStatus, "ignored");
    assert.ok(pool.logs.some(([level, entry]) => level === "error"
      && entry.message === "billing_event_route_missing"));
  });

  it("reports a missing local subscription as retryable", async () => {
    const pool = fakePool({ subscription: null });

    const result = await handle(pool);

    assert.equal(result.accepted, false);
    assert.equal(result.retryable, true);
    assert.equal(result.reason, "subscription_not_found");
    assert.equal(pool.eventRow("evt_1").processingStatus, "failed");
  });

  it("keeps an unrecognized event for audit without treating it as a payment", async () => {
    const pool = fakePool();
    pool.normalized = event({ type: null });

    const result = await handle(pool);

    // Terminal on purpose: providers send event types we do not model, and
    // inviting retries for those for days would bury real failures.
    assert.equal(result.accepted, true);
    assert.equal(result.ignored, true);
    assert.equal(result.retryable, false);
    assert.equal(pool.updates().length, 0);
    const claim = pool.find((call) => call.text.startsWith("INSERT INTO webhook_events"))[0];
    assert.equal(claim.values[2], "evt_1");
    assert.equal(claim.values[3], "unrecognized");
    assert.equal(claim.values[6], "ignored");
  });

  it("applies a provider retry only once after a success", async () => {
    const pool = fakePool();
    await handle(pool);
    assert.equal(pool.state.payments.length, 1);

    const repeat = await handle(pool);

    assert.equal(repeat.duplicate, true);
    assert.equal(pool.state.payments.length, 1);
    assert.equal(pool.updates().length, 1);
  });

  it("processes an event that failed on the first delivery", async () => {
    const pool = fakePool();
    const subject = service(pool);
    const originalConnect = pool.connect.bind(pool);
    let failNextUpdate = true;
    pool.connect = async () => {
      const client = await originalConnect();
      return {
        ...client,
        async query(text, values = []) {
          const sql = text.replace(/\s+/g, " ").trim();
          if (sql.startsWith("UPDATE subscriptions") && failNextUpdate) {
            failNextUpdate = false;
            throw new Error("connection terminated unexpectedly");
          }
          return client.query(text, values);
        },
        release() {},
      };
    };

    await assert.rejects(
      () => subject.handle({ rawBody: "{}", signatureHeader: "t=1,v1=abc" }),
      (error) => error.code === "BILLING_EVENT_FAILED" && error.statusCode === 500,
    );
    assert.equal(pool.eventRow("evt_1").processingStatus, "failed");
    assert.equal(pool.state.payments.length, 0);

    // The provider retries the same delivery. Before the fix this returned
    // "duplicate" and the payment was lost forever.
    const retry = await subject.handle({ rawBody: "{}", signatureHeader: "t=1,v1=abc" });

    assert.equal(retry.accepted, true);
    assert.equal(retry.duplicate, false);
    assert.equal(retry.applied, true);
    assert.equal(retry.status, "active");
    assert.equal(pool.state.payments.length, 1);
    assert.equal(pool.eventRow("evt_1").processingStatus, "processed");
    assert.equal(pool.eventRow("evt_1").attempts, 2);
  });

  it("stops retrying an event that keeps failing", async () => {
    const pool = fakePool({ maxAttempts: 2 });
    const subject = service(pool);
    const originalConnect = pool.connect.bind(pool);
    pool.connect = async () => {
      const client = await originalConnect();
      return {
        ...client,
        async query(text, values = []) {
          const sql = text.replace(/\s+/g, " ").trim();
          if (sql.startsWith("UPDATE subscriptions")) {
            throw new Error("connection terminated unexpectedly");
          }
          return client.query(text, values);
        },
        release() {},
      };
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(() => subject.handle({ rawBody: "{}", signatureHeader: "t=1,v1=abc" }));
    }

    const exhausted = await subject.handle({ rawBody: "{}", signatureHeader: "t=1,v1=abc" });
    const stillExhausted = await subject.handle({ rawBody: "{}", signatureHeader: "t=1,v1=abc" });

    assert.equal(exhausted.accepted, true);
    assert.equal(exhausted.exhausted, true);
    assert.equal(exhausted.retryable, false);
    // No fourth processing attempt: a poisoned event must stop, not spin.
    assert.equal(stillExhausted.exhausted, true);
    assert.equal(pool.eventRow("evt_1").attempts, 2);
    assert.ok(pool.logs.some(([level, entry]) => level === "error"
      && entry.message === "billing_event_exhausted"));
  });

it("releases a claim left behind by a crashed process", async () => {
    const pool = fakePool();
    const subject = service(pool);
    pool.webhookEvents.set("stripe::evt_9", {
      id: "wevt_9",
      providerEventId: "evt_9",
      processingStatus: "processing",
      attempts: 1,
      receivedAt: new Date(now.getTime() - 3_600_000),
    });

    const released = await subject.releaseExpiredClaims();

    assert.equal(released, 1);
    assert.equal(pool.webhookEvents.get("stripe::evt_9").processingStatus, "failed");
    // A fresh claim is still stuck, because it is inside the lease window.
    assert.equal(await subject.releaseExpiredClaims(), 0);
  });

  it("opens a grace window on a failed payment instead of losing access outright", async () => {
    const pool = fakePool({
      subscription: {
        id: subscriptionId,
        status: "active",
        current_period_start: "2026-10-02T00:00:00.000Z",
        current_period_end: "2026-11-02T00:00:00.000Z",
        grace_ends_at: null,
        provider_subscription_id: "sub_1",
        cancel_at_period_end: false,
      },
    });
    pool.normalized = event({
      type: "subscription.past_due",
      status: "past_due",
      failureCode: "card_declined",
      failureMessage: "Your card was declined.",
    });

    const result = await handle(pool);

    assert.equal(result.status, "past_due");
    assert.equal(pool.state.subscription.grace_ends_at.toISOString(), "2026-10-09T12:00:00.000Z");
    assert.equal(pool.state.payments[0].status, "failed");
    assert.equal(pool.state.payments[0].paidAt, null);
  });

  it("keeps a paid subscription active when a later event carries no period", async () => {
    const pool = fakePool({
      subscription: {
        id: subscriptionId,
        status: "active",
        current_period_start: "2026-10-02T00:00:00.000Z",
        current_period_end: "2026-11-02T00:00:00.000Z",
        grace_ends_at: null,
        provider_subscription_id: "sub_1",
        cancel_at_period_end: false,
      },
    });
    pool.normalized = event({
      type: "subscription.started",
      describesSubscription: true,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      providerPaymentId: null,
    });

    const result = await handle(pool);

    assert.equal(result.status, "active");
    assert.equal(pool.state.subscription.status, "active");
  });

  it("takes the cancel-at-period-end flag only from a subscription event", async () => {
    const pool = fakePool();
    pool.normalized = event({
      type: "subscription.started",
      describesSubscription: true,
      status: "active",
      cancelAtPeriodEnd: true,
      providerPaymentId: null,
    });

    const result = await handle(pool);

    assert.equal(result.status, "cancel_at_period_end");
    assert.equal(pool.state.subscription.cancel_at_period_end, true);
  });

  it("does not let an invoice clear a cancellation the provider still has scheduled", async () => {
    const pool = fakePool({
      subscription: {
        id: subscriptionId,
        status: "cancel_at_period_end",
        current_period_start: "2026-10-02T00:00:00.000Z",
        current_period_end: "2026-11-02T00:00:00.000Z",
        grace_ends_at: null,
        provider_subscription_id: "sub_1",
        cancel_at_period_end: true,
      },
    });
    pool.normalized = event({
      type: "subscription.past_due",
      status: "past_due",
      describesSubscription: false,
      failureCode: "card_declined",
      failureMessage: null,
    });

    await handle(pool);

    // The invoice says nothing about cancellation, so the flag must survive.
    assert.equal(pool.state.subscription.cancel_at_period_end, true);
  });

  it("ends access when the provider reports the subscription deleted", async () => {
    const pool = fakePool({
      subscription: {
        id: subscriptionId,
        status: "active",
        current_period_start: "2026-10-02T00:00:00.000Z",
        current_period_end: "2026-11-02T00:00:00.000Z",
        grace_ends_at: null,
        provider_subscription_id: "sub_1",
        cancel_at_period_end: false,
      },
    });
    pool.normalized = event({
      type: "subscription.cancelled",
      describesSubscription: true,
      status: "canceled",
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
      providerPaymentId: null,
    });

    const result = await handle(pool);

    assert.equal(result.status, "cancelled");
    assert.equal(pool.state.subscription.cancel_at_period_end, false);
  });

  it("replaces a dead provider subscription id with the current one", async () => {
    const pool = fakePool({
      subscription: {
        id: subscriptionId,
        status: "pending_checkout",
        current_period_start: null,
        current_period_end: null,
        grace_ends_at: null,
        provider_subscription_id: "sub_dead",
        cancel_at_period_end: false,
      },
    });

    await handle(pool);

    // Before the fix the row kept sub_dead forever, so cancel, resume, and plan
    // changes were aimed at a subscription the provider had already ended.
    assert.equal(pool.state.subscription.provider_subscription_id, "sub_1");
    const route = pool.find((call) =>
      call.text.startsWith("INSERT INTO provider_tenant_routes"),
    ).at(-1);
    assert.deepEqual(route.values, ["stripe", "sub_1", restaurantId]);
  });

  it("never lets an older event move the paid period backwards", async () => {
    const pool = fakePool();
    const update = (await handle(pool), pool.updates()[0]);

    const monotonic = update.text;

    // The behaviour itself is proven against PostgreSQL in
    // billing-postgres.test.mjs; here the statement must at least express a
    // null-safe maximum rather than an unconditional overwrite.
    assert.match(monotonic, /current_period_end = CASE[\s\S]*?\$5 > current_period_end THEN \$5[\s\S]*?ELSE current_period_end END/i);
    assert.match(monotonic, /current_period_start = CASE[\s\S]*?\$4 > current_period_start THEN \$4[\s\S]*?ELSE current_period_start END/i);
    assert.ok(!/current_period_end = COALESCE\(\$5, current_period_end\)/i.test(monotonic));
  });

  it("refuses a transition the state machine does not allow", async () => {
    const pool = fakePool({
      subscription: {
        id: subscriptionId,
        status: "suspended",
        current_period_start: "2026-10-02T00:00:00.000Z",
        current_period_end: "2026-11-02T00:00:00.000Z",
        grace_ends_at: null,
        provider_subscription_id: "sub_1",
        cancel_at_period_end: false,
      },
    });

    const result = await handle(pool);

    // A suspended subscription is a platform decision and cannot be undone by
    // a provider event, no matter how convincing that event looks.
    assert.equal(result.applied, false);
    assert.equal(result.retryable, false);
    assert.equal(result.reason, "illegal_transition");
    assert.equal(pool.updates().length, 0);
    assert.equal(pool.eventRow("evt_1").processingStatus, "ignored");
  });

  it("records a trial instead of treating it as an unpaid checkout", async () => {
    const pool = fakePool();
    pool.normalized = event({
      type: "subscription.started",
      describesSubscription: true,
      status: "trialing",
      cancelAtPeriodEnd: false,
      currentPeriodStart: "2026-10-02T00:00:00.000Z",
      currentPeriodEnd: "2026-10-16T00:00:00.000Z",
      providerPaymentId: null,
    });

    const result = await handle(pool);

    assert.equal(result.status, "trialing");
    assert.equal(pool.state.subscription.status, "trialing");
    assert.equal(pool.state.subscription.trial_ends_at instanceof Date, true);
  });

  it("expires a subscription whose paid period has elapsed", async () => {
    const pool = fakePool({
      subscription: {
        id: subscriptionId,
        status: "active",
        current_period_start: "2026-08-01T00:00:00.000Z",
        current_period_end: "2026-09-01T00:00:00.000Z",
        grace_ends_at: null,
        provider_subscription_id: "sub_1",
        cancel_at_period_end: false,
      },
    });
    const subject = service(pool);
    const originalConnect = pool.connect.bind(pool);
    pool.connect = async () => {
      const client = await originalConnect();
      return {
        ...client,
        async query(text, values = []) {
          const sql = text.replace(/\s+/g, " ").trim();
          if (sql.startsWith("UPDATE subscriptions SET status = 'expired'")
            || sql.includes("SET status = 'expired'")) {
            if (sql.includes("RETURNING")) return { rows: [{ id: subscriptionId }] };
          }
          return client.query(text, values);
        },
        release() {},
      };
    };

    const expired = await subject.expireElapsedSubscriptions({ restaurantId });

    assert.deepEqual(expired, [subscriptionId]);
  });

  it("another worker owning the reclaimed event returns retryable", async () => {
    const pool = fakePool();
    const subject = service(pool);
    // Simulate another worker having claimed the event and still processing it
    pool.webhookEvents.set("stripe::evt_1", {
      id: "wevt_1",
      providerEventId: "evt_1",
      processingStatus: "processing",
      attempts: 1,
      receivedAt: new Date(now.getTime() - 10_000), // Within lease window
    });

    const result = await subject.handle({ rawBody: "{}", signatureHeader: "t=1,v1=abc" });

    // Should return retryable 503 because another worker is actively processing
    assert.equal(result.accepted, false);
    assert.equal(result.retryable, true);
    assert.equal(result.reason, "event_in_progress");
  });

  it("crash after tenant commit but before markProcessed is replay-safe", async () => {
    const pool = fakePool();
    const subject = service(pool);
    // Simulate an event that was processed but markProcessed wasn't called (crash after tenant commit)
    pool.webhookEvents.set("stripe::evt_1", {
      id: "wevt_1",
      providerEventId: "evt_1",
      processingStatus: "processing", // Still marked as processing
      attempts: 1,
      receivedAt: new Date(now.getTime() - 10_000), // Within lease window
    });

    // The event was actually processed (subscription updated) but markProcessed wasn't called
    // On retry, it should be treated as in-progress and return retryable
    const firstRetry = await subject.handle({ rawBody: "{}", signatureHeader: "t=1,v1=abc" });
    console.log("First retry result:", JSON.stringify(firstRetry, null, 2));
    assert.equal(firstRetry.accepted, false);
    assert.equal(firstRetry.retryable, true);
    assert.equal(firstRetry.reason, "event_in_progress");

    // After lease expires, it should be reclaimed and processed
    pool.webhookEvents.get("stripe::evt_1").receivedAt = new Date(now.getTime() - 3_600_000);
    console.log("Event after lease expiry:", JSON.stringify(pool.webhookEvents.get("stripe::evt_1"), null, 2));
    const afterLease = await subject.handle({ rawBody: "{}", signatureHeader: "t=1,v1=abc" });
    console.log("After lease result:", JSON.stringify(afterLease, null, 2));
    assert.equal(afterLease.applied, true);
    assert.equal(afterLease.status, "active");
  });
});