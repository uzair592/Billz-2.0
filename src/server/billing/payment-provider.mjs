/**
 * The single seam between the platform and whatever payment provider is used.
 *
 * Nothing outside this module knows a provider's request or event format. The
 * only trust boundary in the system is `verifyWebhook`: a subscription can never
 * become paid because a browser, a cron job, or a hand-written SQL statement said
 * so — only because a verified provider event said so.
 */

export const BILLING_EVENT = Object.freeze({
  CHECKOUT_COMPLETED: "checkout.completed",
  SUBSCRIPTION_STARTED: "subscription.started",
  SUBSCRIPTION_RENEWED: "subscription.renewed",
  SUBSCRIPTION_PAST_DUE: "subscription.past_due",
  SUBSCRIPTION_CANCELLED: "subscription.cancelled",
  SUBSCRIPTION_EXPIRED: "subscription.expired",
});

export const BILLING_EVENT_TYPES = Object.freeze(Object.values(BILLING_EVENT));

/**
 * Only the methods the platform actually calls are required. An earlier version
 * of this contract also demanded `openCustomerPortal` and `normalizeEvent`; no
 * caller existed for either, so every adapter had to implement dead code.
 */
export const REQUIRED_PROVIDER_METHODS = Object.freeze([
  "createCustomer",
  "createCheckoutSession",
  "changeSubscription",
  "cancelSubscription",
  "resumeSubscription",
  "verifyWebhook",
]);

export function billingError(message, code, statusCode = 400, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details !== undefined) error.details = details;
  return error;
}

export function assertPaymentProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throw new TypeError("A payment provider adapter is required.");
  }
  if (typeof provider.name !== "string" || !provider.name) {
    throw new TypeError("The payment provider must declare a name.");
  }
  for (const method of REQUIRED_PROVIDER_METHODS) {
    if (typeof provider[method] !== "function") {
      throw new TypeError(`The payment provider must implement ${method}().`);
    }
  }
  if (typeof provider.webhookSignatureHeader !== "string" || !provider.webhookSignatureHeader) {
    throw new TypeError("The payment provider must declare webhookSignatureHeader.");
  }
  return provider;
}

export function isBillingEventType(value) {
  return BILLING_EVENT_TYPES.includes(value);
}

/**
 * Normalizes a verified provider event into the shape the billing services
 * understand. Anything unrecognised becomes an explicitly ignored event rather
 * than an error, because providers add event types over time and an unknown
 * event must never be treated as a payment.
 *
 * `describesSubscription` matters: only an event that actually carries a
 * subscription object may move the cancel-at-period-end flag or set a trial
 * end, and only an invoice that belongs to a subscription may renew one.
 */
export function normalizeBillingEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const eventType = isBillingEventType(raw.type) ? raw.type : null;
  return Object.freeze({
    type: eventType,
    providerSubscriptionId: raw.providerSubscriptionId ?? null,
    providerCheckoutSessionId: raw.providerCheckoutSessionId ?? null,
    providerCustomerId: raw.providerCustomerId ?? null,
    providerPaymentId: raw.providerPaymentId ?? null,
    describesSubscription: raw.describesSubscription === true,
    status: raw.status ?? null,
    currentPeriodStart: raw.currentPeriodStart ?? null,
    currentPeriodEnd: raw.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: raw.cancelAtPeriodEnd === true,
    currencyCode: raw.currencyCode ?? null,
    amountMinor: Number.isFinite(Number(raw.amountMinor)) ? Number(raw.amountMinor) : null,
    failureCode: raw.failureCode ?? null,
    failureMessage: raw.failureMessage ?? null,
    occurredAt: raw.occurredAt ?? null,
  });
}