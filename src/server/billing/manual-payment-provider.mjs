import { billingError } from "./payment-provider.mjs";

/**
 * Development provider used when no payment provider is configured.
 *
 * It exists so local development never silently reaches the internet, and it is
 * built so that no amount of local input can grant paid access: checkout cannot
 * be started, and every webhook is refused. Subscription access in a local
 * environment can only be granted deliberately through the platform admin
 * surface, never by the browser and never by an unverified callback.
 */
export function createManualPaymentProvider({ name = "manual" } = {}) {
  return Object.freeze({
    name,

    async createCustomer() {
      throw billingError(
        "No payment provider is configured for this environment.",
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        503,
      );
    },

    async createCheckoutSession() {
      throw billingError(
        "No payment provider is configured for this environment.",
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        503,
      );
    },

    async changeSubscription() {
      throw billingError(
        "No payment provider is configured for this environment.",
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        503,
      );
    },

    async cancelSubscription() {
      throw billingError(
        "No payment provider is configured for this environment.",
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        503,
      );
    },

    async resumeSubscription() {
      throw billingError(
        "No payment provider is configured for this environment.",
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        503,
      );
    },

    async openCustomerPortal() {
      throw billingError(
        "No payment provider is configured for this environment.",
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        503,
      );
    },

    verifyWebhook() {
      return { verified: false, event: null, reason: "provider_delivers_no_webhooks" };
    },

    webhookSignatureHeader: "x-billing-signature",
  });
}