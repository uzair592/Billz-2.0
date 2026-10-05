import { createStripePaymentProvider } from "../billing/stripe-payment-provider.mjs";
import { createManualPaymentProvider } from "../billing/manual-payment-provider.mjs";
import { assertPaymentProvider } from "../billing/payment-provider.mjs";

/**
 * Reads and validates the process environment.
 *
 * The rule here is fail closed. A half-configured service is far worse
 * than no service, because it looks configured while behaving
 * unpredictably. Anything ambiguous stops the process before it can
 * accept traffic.
 *
 * Production is held to a stricter standard than development or test:
 * placeholder secrets, localhost origins, and insecure cookies are
 * refused so a misconfigured deployment cannot silently go live.
 */

const PLACEHOLDER_SECRETS = new Set([
  "",
  "change-me",
  "changeme",
  "replace-me",
  "replace_with_a_secret",
  "replace-with-a-secret",
  "replace-with-at-least-32-random-bytes",
  "replace-with-a-separate-random-secret",
  "secret",
  "password",
  "test",
  "test-secret",
  "dummy",
  "placeholder",
  "your-secret",
  "your-secret-here",
  "sk_test_placeholder",
  "whsec_placeholder",
]);

function isPlaceholderSecret(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return PLACEHOLDER_SECRETS.has(normalized);
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

/**
 * Parses a comma-separated exact-origin allowlist. Each entry must be
 * an absolute URL. Wildcards are rejected: credentialed CORS must never
 * use a wildcard origin.
 */
export function parseTrustedOrigins(raw, { nodeEnv } = {}) {
  const entries = String(raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) return [];

  const origins = entries.map((entry) => {
    if (entry.includes("*")) {
      throw configurationError(
        "Wildcard origins are not allowed. List each trusted origin exactly.",
      );
    }
    let url;
    try {
      url = new URL(entry);
    } catch {
      throw configurationError(`Trusted origin "${entry}" is not an absolute URL.`);
    }
    if (nodeEnv === "production") {
      if (url.protocol !== "https:") {
        throw configurationError(
          `Trusted origin "${entry}" must use HTTPS in production.`,
        );
      }
      const hostname = url.hostname.toLowerCase();
      if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
        throw configurationError(
          `Trusted origin "${entry}" must not be localhost in production.`,
        );
      }
    }
    return url.origin;
  });

  return [...new Set(origins)];
}

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
  if (!webhookSecret.startsWith("whsec_")) {
    throw configurationError("STRIPE_WEBHOOK_SECRET is not a Stripe webhook signing secret.");
  }
  if (isPlaceholderSecret(secretKey) || isPlaceholderSecret(webhookSecret)) {
    throw configurationError(
      "Stripe credentials are placeholders. Set real STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.",
    );
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
  const nodeEnv = String(env.NODE_ENV ?? "development").trim().toLowerCase();
  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw configurationError(
      `NODE_ENV must be "development", "test", or "production", not "${nodeEnv}".`,
    );
  }

  const port = readPositiveInteger(env.PORT, 3_000);
  const host = String(env.HOST ?? "0.0.0.0").trim();
  const databaseUrl = String(env.DATABASE_URL ?? "").trim();
  const pepper = String(env.PASSWORD_PEPPER ?? "").trim();
  const sessionSecret = String(env.SESSION_SECRET ?? "").trim();
  const logLevel = String(env.LOG_LEVEL ?? (nodeEnv === "production" ? "info" : "warn")).trim().toLowerCase();
  const trustProxy = String(env.TRUST_PROXY ?? "false").trim().toLowerCase();

  const missing = [];
  if (!databaseUrl) missing.push("DATABASE_URL");
  if (!pepper) missing.push("PASSWORD_PEPPER");
  if (!sessionSecret) missing.push("SESSION_SECRET");
  if (missing.length > 0) {
    throw configurationError(
      `Missing required environment variables: ${missing.join(", ")}.`,
    );
  }

  if (pepper.length < 16) {
    throw configurationError("PASSWORD_PEPPER must be at least 16 characters.");
  }
  if (sessionSecret.length < 16) {
    throw configurationError("SESSION_SECRET must be at least 16 characters.");
  }
  if (sessionSecret === pepper) {
    throw configurationError("SESSION_SECRET and PASSWORD_PEPPER must differ.");
  }
  if (nodeEnv === "production") {
    if (isPlaceholderSecret(pepper)) {
      throw configurationError("PASSWORD_PEPPER is a placeholder in production.");
    }
    if (isPlaceholderSecret(sessionSecret)) {
      throw configurationError("SESSION_SECRET is a placeholder in production.");
    }
  }

  // Trusted origins: a comma-separated exact allowlist. A single
  // TRUSTED_ORIGIN is still accepted for backward compatibility and is
  // treated as a one-entry allowlist.
  const trustedOriginRaw = String(env.TRUSTED_ORIGINS ?? env.TRUSTED_ORIGIN ?? "").trim();
  const trustedOrigins = parseTrustedOrigins(trustedOriginRaw, { nodeEnv });
  if (trustedOrigins.length === 0) {
    throw configurationError(
      "TRUSTED_ORIGINS (or TRUSTED_ORIGIN) is required and must list at least one origin.",
    );
  }

  // Proxy handling: only enable trust-proxy when explicitly opted in,
  // because trusting proxies by default lets a client spoof its IP.
  const trustProxyEnabled = ["true", "1", "yes"].includes(trustProxy);

  return Object.freeze({
    nodeEnv,
    port,
    host,
    databaseUrl,
    pepper,
    sessionSecret,
    trustedOrigins,
    // The first origin remains the canonical origin for cookie and
    // CORS decisions; the full list is used for origin allowlisting.
    trustedOrigin: trustedOrigins[0],
    secureCookies: trustedOrigins.every((origin) => origin.startsWith("https:")),
    logLevel,
    trustProxy: trustProxyEnabled,
  });
}
