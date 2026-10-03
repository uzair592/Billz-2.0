import { createHmac, timingSafeEqual } from "node:crypto";
import {
  BILLING_EVENT,
  billingError,
} from "./payment-provider.mjs";

const STRIPE_API = "https://api.stripe.com/v1";
const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Stripe invoice `billing_reason` values that belong to a subscription. Anything
 * else (a one-off invoice, a manual adjustment) must never renew or activate a
 * restaurant subscription, so it is normalized to no event at all.
 */
const SUBSCRIPTION_BILLING_REASONS = new Set([
  "subscription_create",
  "subscription_cycle",
  "subscription_update",
  "subscription_threshold",
]);

function encodeForm(parameters) {
  return new URLSearchParams(
    Object.entries(parameters)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .flatMap(([key, value]) => (
        Array.isArray(value) ? value.map((entry) => [key, entry]) : [[key, value]]
      )),
  ).toString();
}

/**
 * Stripe adapter.
 *
 * Secrets are constructor arguments taken from the environment; nothing is
 * embedded in the source. Webhook verification follows Stripe's documented
 * scheme: an HMAC-SHA256 of `<timestamp>.<raw body>` compared in constant time,
 * with a timestamp tolerance so a captured request cannot be replayed later.
 */
export function createStripePaymentProvider({
  secretKey,
  webhookSecret,
  fetchImpl = globalThis.fetch,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  clock = () => new Date(),
  apiBaseUrl = STRIPE_API,
} = {}) {
  if (typeof secretKey !== "string" || !secretKey.startsWith("sk_")) {
    throw new TypeError("A Stripe secret key is required.");
  }
  if (typeof webhookSecret !== "string" || !webhookSecret) {
    throw new TypeError("A Stripe webhook signing secret is required.");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");

  async function callApi(path, parameters, { method = "POST" } = {}) {
    const response = await fetchImpl(`${apiBaseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: method === "GET" ? undefined : encodeForm(parameters),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw billingError(
        "The payment provider rejected this request.",
        "PAYMENT_PROVIDER_ERROR",
        502,
        { providerMessage: body?.error?.message ?? null },
      );
    }
    return body;
  }

  function verifyWebhook({ rawBody, signatureHeader }) {
    const raw = typeof rawBody === "string"
      ? rawBody
      : Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : null;
    if (raw === null || typeof signatureHeader !== "string" || !signatureHeader) {
      return { verified: false, event: null, reason: "signature_missing" };
    }

    const parts = new Map(
      signatureHeader.split(",").map((part) => {
        const [key, value] = part.split("=", 2);
        return [key.trim(), value];
      }),
    );
    const timestamp = parts.get("t");
    const signature = parts.get("v1");
    if (!timestamp || !signature) {
      return { verified: false, event: null, reason: "signature_missing" };
    }

    const ageSeconds = (clock().getTime() - Number(timestamp) * 1_000) / 1_000;
    if (!Number.isFinite(ageSeconds) || Math.abs(ageSeconds) > toleranceSeconds) {
      return { verified: false, event: null, reason: "signature_expired" };
    }

    const expected = createHmac("sha256", webhookSecret)
      .update(`${timestamp}.${raw}`)
      .digest("hex");
    const expectedBytes = Buffer.from(expected, "utf8");
    const providedBytes = Buffer.from(signature, "utf8");
    if (
      expectedBytes.length !== providedBytes.length
      || !timingSafeEqual(expectedBytes, providedBytes)
    ) {
      return { verified: false, event: null, reason: "signature_mismatch" };
    }

    // A body that is signed but not JSON can never be applied. Refusing it here
    // keeps the caller from throwing an unhandled parse error, which would
    // otherwise make the provider retry a request that can never succeed.
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { verified: false, event: null, reason: "malformed_payload" };
    }
    if (!payload || typeof payload !== "object") {
      return { verified: false, event: null, reason: "malformed_payload" };
    }
    return { verified: true, event: normalizeStripeEvent(payload), reason: null };
  }

  return Object.freeze({
    name: "stripe",

    async createCustomer({ restaurantId, email, name }) {
      const customer = await callApi("/customers", {
        email,
        name,
        "metadata[restaurant_id]": restaurantId,
      });
      return { providerCustomerId: customer.id };
    },

    async createCheckoutSession({ providerCustomerId, providerPriceId, successUrl, cancelUrl, clientReferenceId }) {
      const session = await callApi("/checkout/sessions", {
        mode: "subscription",
        customer: providerCustomerId,
        "line_items[0][price]": providerPriceId,
        "line_items[0][quantity]": "1",
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: clientReferenceId,
      });
      return {
        providerCheckoutSessionId: session.id,
        checkoutUrl: session.url,
      };
    },

    async changeSubscription({ providerSubscriptionId, providerPriceId }) {
      // Stripe addresses a plan change by subscription item, so the current item
      // is read first rather than stored on our side.
      const current = await callApi(
        `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`,
        undefined,
        { method: "GET" },
      );
      const itemId = current?.items?.data?.[0]?.id;
      if (!itemId) {
        throw billingError(
          "This subscription has no billable item to change.",
          "PAYMENT_PROVIDER_ERROR",
          409,
        );
      }
      const subscription = await callApi(
        `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`,
        { "items[0][id]": itemId, "items[0][price]": providerPriceId },
        { method: "POST" },
      );
      return { providerSubscriptionId: subscription.id, status: subscription.status };
    },

    async cancelSubscription({ providerSubscriptionId, cancelAtPeriodEnd = true }) {
      const subscription = await callApi(
        `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`,
        { cancel_at_period_end: String(cancelAtPeriodEnd) },
        { method: "POST" },
      );
      return { providerSubscriptionId: subscription.id, status: subscription.status };
    },

    async resumeSubscription({ providerSubscriptionId }) {
      // Resuming is not a plan change. Stripe keeps the subscription scheduled
      // for cancellation until `cancel_at_period_end` is cleared explicitly, so
      // re-sending the current price would leave the provider cancelling a
      // subscription the platform believes it resumed.
      const subscription = await callApi(
        `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`,
        { cancel_at_period_end: "false" },
        { method: "POST" },
      );
      return { providerSubscriptionId: subscription.id, status: subscription.status };
    },

webhookSignatureHeader: "stripe-signature",

    verifyWebhook,
  });
}

function stripeTimestamp(seconds) {
  return Number.isFinite(Number(seconds)) ? new Date(Number(seconds) * 1_000).toISOString() : null;
}

function stripeEventType(event, object) {
  switch (event.type) {
    case "checkout.session.completed":
      return BILLING_EVENT.CHECKOUT_COMPLETED;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.trial_will_end":
      return BILLING_EVENT.SUBSCRIPTION_STARTED;
    case "customer.subscription.deleted":
      return BILLING_EVENT.SUBSCRIPTION_CANCELLED;
    case "invoice.paid":
    case "invoice.payment_failed":
      // Stripe sends these for every invoice on a customer, including one-off
      // invoices that have nothing to do with the subscription. Renewing from
      // those would let an unrelated payment grant POS access, so an invoice
      // only counts when it is a subscription invoice that names its
      // subscription.
      if (!isSubscriptionInvoice(object)) return null;
      return event.type === "invoice.paid"
        ? BILLING_EVENT.SUBSCRIPTION_RENEWED
        : BILLING_EVENT.SUBSCRIPTION_PAST_DUE;
    default:
      return null;
  }
}

function isSubscriptionInvoice(object) {
  if (!object || typeof object !== "object") return false;
  if (typeof object.subscription !== "string" && !object.subscription?.id) return false;
  return object.billing_reason === undefined
    || object.billing_reason === null
    || SUBSCRIPTION_BILLING_REASONS.has(object.billing_reason);
}

export function normalizeStripeEvent(event) {
  const object = event?.data?.object ?? {};
  const type = stripeEventType(event ?? {}, object);
  const rawSubscription = object.subscription;
  const subscription = typeof rawSubscription === "string"
    ? { id: rawSubscription }
    : rawSubscription && typeof rawSubscription === "object"
      ? rawSubscription
      : object.object === "subscription" ? object : null;
  // An invoice reports the period it billed for, which is the paid period.
  const invoiceLine = Array.isArray(object?.lines?.data) ? object.lines.data[0] : null;
  const periodStart = subscription?.current_period_start
    ?? object?.period_start
    ?? invoiceLine?.period?.start;
  const periodEnd = subscription?.current_period_end
    ?? object?.period_end
    ?? invoiceLine?.period?.end;

  return {
    providerEventId: event?.id ?? null,
    type,
    providerSubscriptionId: subscription?.id ?? null,
    providerCheckoutSessionId: object?.object === "checkout.session" ? object.id ?? null : null,
    providerCustomerId: object?.customer ?? subscription?.customer ?? null,
    providerPaymentId: object?.payment_intent ?? null,
    // Only an event carrying the subscription object itself may move
    // subscription-owned flags such as cancel-at-period-end or a trial end.
    describesSubscription: object?.object === "subscription"
      || (rawSubscription !== null && typeof rawSubscription === "object"),
    status: subscription?.status ?? null,
    currentPeriodStart: stripeTimestamp(periodStart),
    currentPeriodEnd: stripeTimestamp(periodEnd),
    cancelAtPeriodEnd: subscription?.cancel_at_period_end === true,
    currencyCode: typeof object?.currency === "string" ? object.currency.toUpperCase() : null,
    amountMinor: Number.isFinite(Number(object?.amount_paid))
      ? Number(object.amount_paid)
      : Number.isFinite(Number(object?.amount_due)) ? Number(object.amount_due) : null,
    failureCode: object?.last_payment_error?.code ?? null,
    failureMessage: object?.last_payment_error?.message ?? null,
    occurredAt: stripeTimestamp(event?.created),
  };
}