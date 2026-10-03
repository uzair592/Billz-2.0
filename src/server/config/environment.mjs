import { createStripePaymentProvider } from "../billing/stripe-payment-provider.mjs";
import { createManualPaymentProvider } from "../billing/manual-payment-provider.mjs";
import { assertPaymentProvider } from "../billing/payment-provider.mjs";

/**
 * Reads and validates the process environment for the billing subsystem.
 *
 * The rule here is fail closed. A half-configured Stripe integration is far
 * worse than no integration, because it looks configured: checkout sessions can
 * be created while webhooks can never be verified, so payments would be taken
 * and access would never be granted. Anything ambiguous stops the process.
 */
export function loadBillingConfiguration(env = process.env) {
  const requested = String(env.PAYMENT_PROVIDER ?? "").trim().toLowerCase();
  const secretKey = String(env.STRIPE_SECRET_KEY ?? "").trim();
  const webhookSecret = String(env.STRIPE_WEBHOOK_SECRET ?? "").trim();
  const publishableKey = String(env.STRIPE_PUBLISHABLE_KEY ?? "").trim();

  const stripeConfigured = Boolean(secretKey || webhookSecret || publishableKey);
  const selected = requested || (stripeConfigured ? "stripe" : "manual");

  if (!["stripe", "manual"].includes(selected)) {
    throw configurationError(
      `PAYMENT_PROVIDER must be "stripe" or "manual", not "${selected}".`,
    );
  }

  if (selected === "manual") {
    if (stripeConfigured && requested === "stripe") {
      throw configurationError(
        "PAYMENT_PROVIDER is stripe but the Stripe credentials are incomplete.",
      );
    }
    return Object.freeze({
      providerName: "manual",
      publishableKey: null,
      graceDays: readPositiveInteger(env.BILLING_GRACE_DAYS, 7),
      maxAttempts: readPositiveInteger(env.BILLING_WEBHOOK_MAX_ATTEMPTS, 8),
      leaseSeconds: readPositiveInteger(env.BILLING_WEBHOOK_LEASE_SECONDS, 300),
      provider: createManualPaymentProvider(),
    });
  }

  const missing = [];
  if (!secretKey) missing.push("STRIPE_SECRET_KEY");
  if (!webhookSecret) missing.push("STRIPE_WEBHOOK_SECRET");
  if (missing.length > 0) {
    throw configurationError(
      `Stripe is selected but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing. `
      + "Billing cannot start without a webhook secret, because an unverifiable webhook must never grant access.",
    );
  }
  if (!secretKey.startsWith("sk_")) {
    throw configurationError("STRIPE_SECRET_KEY is not a Stripe secret key.");
  }

  const provider = assertPaymentProvider(createStripePaymentProvider({
    secretKey,
    webhookSecret,
  }));

  return Object.freeze({
    providerName: provider.name,
    publishableKey: publishableKey || null,
    graceDays: readPositiveInteger(env.BILLING_GRACE_DAYS, 7),
    maxAttempts: readPositiveInteger(env.BILLING_WEBHOOK_MAX_ATTEMPTS, 8),
    leaseSeconds: readPositiveInteger(env.BILLING_WEBHOOK_LEASE_SECONDS, 300),
    provider,
  });
}

export function loadServerConfiguration(env = process.env) {
  const port = readPositiveInteger(env.PORT, 3_000);
  const host = String(env.HOST ?? "0.0.0.0").trim();
  const databaseUrl = String(env.DATABASE_URL ?? "").trim();
  const trustedOrigin = String(env.TRUSTED_ORIGIN ?? "").trim();
  const pepper = String(env.PASSWORD_PEPPER ?? "").trim();
  const sessionSecret = String(env.SESSION_SECRET ?? "").trim();

  const missing = [];
  if (!databaseUrl) missing.push("DATABASE_URL");
  if (!trustedOrigin) missing.push("TRUSTED_ORIGIN");
  if (!pepper) missing.push("PASSWORD_PEPPER");
  if (!sessionSecret) missing.push("SESSION_SECRET");
  if (missing.length > 0) {
    throw configurationError(
      `Missing required environment variables: ${missing.join(", ")}.`,
    );
  }
  const nodeEnv = String(env.NODE_ENV ?? "development");
  if (pepper.length < 16) {
    throw configurationError("PASSWORD_PEPPER must be at least 16 characters.");
  }
  if (sessionSecret === pepper) {
    throw configurationError("SESSION_SECRET and PASSWORD_PEPPER must differ.");
  }
  let origin;
  try {
    origin = new URL(trustedOrigin);
  } catch {
    throw configurationError("TRUSTED_ORIGIN must be an absolute URL.");
  }
  if (origin.protocol !== "https:" && nodeEnv === "production") {
    throw configurationError("TRUSTED_ORIGIN must use HTTPS in production.");
  }

  return Object.freeze({
    port,
    host,
    databaseUrl,
    trustedOrigin: origin.origin,
    pepper,
    sessionSecret,
    nodeEnv,
    secureCookies: origin.protocol === "https:",
  });
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function configurationError(message) {
  const error = new Error(message);
  error.code = "CONFIGURATION_INVALID";
  error.statusCode = 500;
  return error;
}