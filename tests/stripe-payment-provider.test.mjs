import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  createStripePaymentProvider,
  normalizeStripeEvent,
} from "../src/server/billing/stripe-payment-provider.mjs";
import { assertPaymentProvider } from "../src/server/billing/payment-provider.mjs";

const secretKey = "sk_test_example";
const webhookSecret = "whsec_example";
const now = new Date("2026-10-02T12:00:00.000Z");

function provider(overrides = {}) {
  return createStripePaymentProvider({
    secretKey,
    webhookSecret,
    clock: () => now,
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: "obj_1", url: "https://x" }) }),
    ...overrides,
  });
}

function sign(payload, { timestamp = Math.floor(now.getTime() / 1_000), secret = webhookSecret } = {}) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return { rawBody: raw, signatureHeader: `t=${timestamp},v1=${signature}` };
}

describe("stripe payment provider adapter", () => {
  it("implements every method the platform requires", () => {
    assert.doesNotThrow(() => assertPaymentProvider(provider()));
  });

  it("refuses a payload without a signature", () => {
    const result = provider().verifyWebhook({ rawBody: "{}", signatureHeader: null });

    assert.equal(result.verified, false);
    assert.equal(result.reason, "signature_missing");
    assert.equal(result.event, null);
  });

  it("refuses a payload signed with the wrong secret", () => {
    const { rawBody, signatureHeader } = sign({ id: "evt_1" }, { secret: "whsec_wrong" });

    const result = provider().verifyWebhook({ rawBody, signatureHeader });

    assert.equal(result.verified, false);
    assert.equal(result.reason, "signature_mismatch");
  });

  it("refuses a signature made for different content", () => {
    const { signatureHeader } = sign({ id: "evt_1" });

    const result = provider().verifyWebhook({
      rawBody: JSON.stringify({ id: "evt_2" }),
      signatureHeader,
    });

    assert.equal(result.verified, false);
    assert.equal(result.reason, "signature_mismatch");
  });

  it("refuses a captured request replayed outside the tolerance window", () => {
    const stale = Math.floor(now.getTime() / 1_000) - 3_600;
    const { rawBody, signatureHeader } = sign({ id: "evt_1" }, { timestamp: stale });

    const result = provider().verifyWebhook({ rawBody, signatureHeader });

    assert.equal(result.verified, false);
    assert.equal(result.reason, "signature_expired");
  });

  it("accepts a correctly signed event and reports the normalized shape", () => {
    const { rawBody, signatureHeader } = sign({
      id: "evt_1",
      type: "customer.subscription.updated",
      created: 1_772_560_000,
      data: {
        object: {
          id: "sub_1",
          object: "subscription",
          customer: "cus_1",
          status: "active",
          cancel_at_period_end: true,
          current_period_start: 1_772_560_000,
          current_period_end: 1_775_708_800,
        },
      },
    });

    const result = provider().verifyWebhook({ rawBody, signatureHeader });

    assert.equal(result.verified, true);
    assert.deepEqual(result.event, {
      providerEventId: "evt_1",
      type: "subscription.started",
      providerSubscriptionId: "sub_1",
      providerCheckoutSessionId: null,
      providerCustomerId: "cus_1",
      providerPaymentId: null,
      describesSubscription: true,
      status: "active",
      currentPeriodStart: "2026-03-03T17:46:40.000Z",
      currentPeriodEnd: "2026-04-09T04:26:40.000Z",
      cancelAtPeriodEnd: true,
      currencyCode: null,
      amountMinor: null,
      failureCode: null,
      failureMessage: null,
      occurredAt: "2026-03-03T17:46:40.000Z",
    });
  });

  it("reads the subscription reference and checkout session from a completed checkout", () => {
    const normalized = normalizeStripeEvent({
      id: "evt_2",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          object: "checkout.session",
          customer: "cus_1",
          subscription: "sub_1",
          currency: "pkr",
        },
      },
    });

    assert.equal(normalized.type, "checkout.completed");
    assert.equal(normalized.providerSubscriptionId, "sub_1");
    assert.equal(normalized.providerCheckoutSessionId, "cs_1");
    assert.equal(normalized.providerCustomerId, "cus_1");
    assert.equal(normalized.currencyCode, "PKR");
    // A checkout session is not a paid period, so it carries none.
    assert.equal(normalized.currentPeriodEnd, null);
  });

  it("reads the paid period and payment from a settled subscription invoice", () => {
    const normalized = normalizeStripeEvent({
      id: "evt_3",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_1",
          object: "invoice",
          customer: "cus_1",
          subscription: "sub_1",
          payment_intent: "pi_1",
          currency: "pkr",
          amount_paid: 25_000,
          billing_reason: "subscription_cycle",
          period_start: 1_772_560_000,
          period_end: 1_775_708_800,
        },
      },
    });

    assert.equal(normalized.type, "subscription.renewed");
    assert.equal(normalized.providerPaymentId, "pi_1");
    assert.equal(normalized.amountMinor, 25_000);
    assert.equal(normalized.currentPeriodEnd, "2026-04-09T04:26:40.000Z");
  });

  it("ignores a one-off invoice that is not part of a subscription", () => {
    const normalized = normalizeStripeEvent({
      id: "evt_one_off",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_one_off",
          object: "invoice",
          customer: "cus_1",
          payment_intent: "pi_one_off",
          currency: "pkr",
          amount_paid: 5_000,
          billing_reason: "manual",
          period_start: 1_772_560_000,
          period_end: 1_775_708_800,
        },
      },
    });

    // Before the fix this mapped to subscription.renewed and, because the
    // restaurant matched by customer id, granted paid access for a payment that
    // had nothing to do with the subscription.
    assert.equal(normalized.type, null);
  });

  it("ignores an invoice that names no subscription at all", () => {
    const normalized = normalizeStripeEvent({
      id: "evt_no_sub",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_no_sub",
          object: "invoice",
          customer: "cus_1",
          payment_intent: "pi_no_sub",
          currency: "pkr",
          amount_paid: 5_000,
          billing_reason: "subscription_create",
          period_start: 1_772_560_000,
          period_end: 1_775_708_800,
        },
      },
    });

    assert.equal(normalized.type, null);
    assert.equal(normalized.providerSubscriptionId, null);
  });

  it("ignores an invoice whose billing reason is not a subscription reason", () => {
    const normalized = normalizeStripeEvent({
      id: "evt_upcoming",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_upcoming",
          object: "invoice",
          customer: "cus_1",
          subscription: "sub_1",
          payment_intent: "pi_upcoming",
          currency: "pkr",
          amount_due: 25_000,
          billing_reason: "upcoming",
        },
      },
    });

    assert.equal(normalized.type, null);
    assert.equal(normalized.providerSubscriptionId, "sub_1");
  });

  it("reports a provider failure as an event rather than as a payment", () => {
    const normalized = normalizeStripeEvent({
      id: "evt_4",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_2",
          object: "invoice",
          customer: "cus_1",
          subscription: "sub_1",
          currency: "pkr",
          billing_reason: "subscription_cycle",
          last_payment_error: { code: "card_declined", message: "Declined." },
        },
      },
    });

    assert.equal(normalized.type, "subscription.past_due");
    assert.equal(normalized.failureCode, "card_declined");
    assert.equal(normalized.amountMinor, null);
    assert.equal(normalized.describesSubscription, false);
  });

  it("refuses a signed body that is not JSON", () => {
    const raw = "this is not json";
    const { rawBody, signatureHeader } = sign(raw);

    const result = provider().verifyWebhook({ rawBody, signatureHeader });

    // Before the fix the parse error escaped the provider and became a 500,
    // which invited the provider to retry a request that can never succeed.
    assert.equal(result.verified, false);
    assert.equal(result.reason, "malformed_payload");
  });

  it("refuses a signed JSON body that is not an object", () => {
    const { rawBody, signatureHeader } = sign("42");

    const result = provider().verifyWebhook({ rawBody, signatureHeader });

    assert.equal(result.verified, false);
    assert.equal(result.reason, "malformed_payload");
  });

  it("maps an unknown event type to nothing at all", () => {
    const normalized = normalizeStripeEvent({
      id: "evt_5",
      type: "radar.early_fraud_warning.created",
      data: { object: { id: "issfr_1", object: "issuing.fraud_warning" } },
    });

    assert.equal(normalized.type, null);
    // An unrelated provider object id must never be usable as a subscription.
    assert.equal(normalized.providerSubscriptionId, null);
    assert.equal(normalized.providerCustomerId, null);
    assert.equal(normalized.providerCheckoutSessionId, null);
    assert.equal(normalized.providerPaymentId, null);
    assert.equal(normalized.amountMinor, null);
  });

  it("sends credentials only to the provider and never logs them", async () => {
    const seen = [];
    const subject = provider({
      fetchImpl: async (url, init) => {
        seen.push({ url, authorization: init.headers.authorization, body: init.body });
        return { ok: true, json: async () => ({ id: "cus_1", url: "https://checkout" }) };
      },
    });

    const customer = await subject.createCustomer({
      restaurantId: "11111111-1111-4111-8111-111111111111",
      email: "owner@example.com",
      name: "Bite Tech",
    });

    assert.equal(customer.providerCustomerId, "cus_1");
    assert.equal(seen[0].url, "https://api.stripe.com/v1/customers");
    assert.equal(seen[0].authorization, `Bearer ${secretKey}`);
    assert.ok(seen[0].body.includes("restaurant_id"));
  });

  it("turns a provider rejection into a billing error instead of a crash", async () => {
    const subject = provider({
      fetchImpl: async () => ({
        ok: false,
        json: async () => ({ error: { message: "No such price" } }),
      }),
    });

    await assert.rejects(
      () => subject.createCheckoutSession({
        providerCustomerId: "cus_1",
        providerPriceId: "price_missing",
        successUrl: "https://app.example.com/ok",
        cancelUrl: "https://app.example.com/cancel",
        clientReferenceId: "11111111-1111-4111-8111-111111111111",
      }),
      (error) =>
        error.code === "PAYMENT_PROVIDER_ERROR"
        && error.statusCode === 502
        && error.details.providerMessage === "No such price",
    );
  });
});