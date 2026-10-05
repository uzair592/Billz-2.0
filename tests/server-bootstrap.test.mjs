import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  loadBillingConfiguration,
  loadServerConfiguration,
} from "../src/server/config/environment.mjs";
import { createLoggingMailer } from "../src/server/mail/logging-mailer.mjs";
import { createServer } from "../src/server/main.mjs";
import { createBillingWebhookService } from "../src/server/billing/billing-webhook-service.mjs";
import { createSubscriptionService } from "../src/server/billing/subscription-service.mjs";

const validEnv = {
  DATABASE_URL: "postgresql://app@127.0.0.1:5432/pos",
  TRUSTED_ORIGIN: "https://pos.example.com",
  PASSWORD_PEPPER: "a-long-enough-pepper-value",
  SESSION_SECRET: "a-different-session-secret",
  NODE_ENV: "test",
};

describe("server configuration", () => {
  it("reads a complete environment", () => {
    const config = loadServerConfiguration({ ...validEnv, PORT: "4000", HOST: "127.0.0.1" });

    assert.equal(config.port, 4000);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.trustedOrigin, "https://pos.example.com");
    assert.equal(config.secureCookies, true);
  });

  it("refuses to start without a database", () => {
    assert.throws(
      () => loadServerConfiguration({ ...validEnv, DATABASE_URL: "" }),
      (error) => error.code === "CONFIGURATION_INVALID" && /DATABASE_URL/.test(error.message),
    );
  });

  it("refuses a pepper that is too short or shared with the session secret", () => {
    assert.throws(
      () => loadServerConfiguration({ ...validEnv, PASSWORD_PEPPER: "short" }),
      /PASSWORD_PEPPER must be at least 16 characters/,
    );
    assert.throws(
      () => loadServerConfiguration({
        ...validEnv,
        SESSION_SECRET: validEnv.PASSWORD_PEPPER,
      }),
      /must differ/,
    );
  });

  it("refuses an http origin in production", () => {
    assert.throws(
      () => loadServerConfiguration({
        ...validEnv,
        TRUSTED_ORIGIN: "http://pos.example.com",
        NODE_ENV: "production",
      }),
      /must use HTTPS in production/,
    );
  });
});

describe("billing configuration fails closed", () => {
  it("selects the development provider when nothing is configured", () => {
    const billing = loadBillingConfiguration({});

    assert.equal(billing.providerName, "manual");
    assert.equal(billing.graceDays, 7);
    assert.equal(billing.maxAttempts, 8);
  });

  it("selects Stripe when any Stripe credential is present", () => {
    const billing = loadBillingConfiguration({
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
    });

    assert.equal(billing.providerName, "stripe");
    assert.equal(billing.provider.webhookSignatureHeader, "stripe-signature");
  });

  it("refuses Stripe without a webhook secret", () => {
    // This is the whole point of failing closed: with a secret key but no
    // webhook secret, checkout sessions could be created while no payment could
    // ever be verified, so customers would pay and never receive access.
    assert.throws(
      () => loadBillingConfiguration({
        STRIPE_SECRET_KEY: "sk_test_123",
        PAYMENT_PROVIDER: "stripe",
      }),
      (error) => error.code === "CONFIGURATION_INVALID"
        && /STRIPE_WEBHOOK_SECRET/.test(error.message),
    );
  });

  it("refuses a webhook secret without a secret key", () => {
    assert.throws(
      () => loadBillingConfiguration({ STRIPE_WEBHOOK_SECRET: "whsec_123" }),
      /STRIPE_SECRET_KEY/,
    );
  });

  it("refuses an unknown provider name", () => {
    assert.throws(
      () => loadBillingConfiguration({ PAYMENT_PROVIDER: "paypal" }),
      /must be "stripe" or "manual"/,
    );
  });

  it("refuses a value that is not a Stripe secret key", () => {
    assert.throws(
      () => loadBillingConfiguration({
        STRIPE_SECRET_KEY: "pk_test_123",
        STRIPE_WEBHOOK_SECRET: "whsec_123",
      }),
      /not a Stripe secret key/,
    );
  });

  it("never lets the development provider confirm a webhook", () => {
    const billing = loadBillingConfiguration({ PAYMENT_PROVIDER: "manual" });

    assert.deepEqual(billing.provider.verifyWebhook({ rawBody: "{}", signatureHeader: "x" }), {
      verified: false,
      event: null,
      reason: "provider_delivers_no_webhooks",
    });
  });
});

describe("mailer fails closed", () => {
  it("refuses to start in production", () => {
    assert.throws(
      () => createLoggingMailer({ nodeEnv: "production" }),
      /Refusing to start/,
    );
  });

  it("logs the verification token in development", async () => {
    const seen = [];
    const mailer = createLoggingMailer({ nodeEnv: "development", log: (entry) => seen.push(entry) });

    const result = await mailer.sendVerification({ email: "a@b.com", token: "t", expiresAt: "later" });

    assert.equal(result.delivered, false);
    assert.equal(seen[0].token, "t");
  });
});

describe("server bootstrap", () => {
  it("assembles the billing stack without opening a socket", async () => {
    const pool = {
      async query(sql) {
        // The startup readiness probe runs SELECT 1 AS ok.
        if (String(sql).includes("SELECT 1")) return { rows: [{ ok: 1 }] };
        return { rows: [] };
      },
      async connect() {
        return {
          async query(sql) {
            if (String(sql).includes("SELECT 1")) return { rows: [{ ok: 1 }] };
            return { rows: [] };
          },
          release() {},
        };
      },
      async end() {},
    };

    const server = await createServer({ env: validEnv, pool, migrationsDir: null });

    try {
      assert.equal(server.billing.providerName, "manual");
      assert.equal(typeof server.subscriptionService.startCheckout, "function");
      assert.equal(typeof server.billingWebhookService.handle, "function");
      assert.equal(server.billingWebhookService.webhookSignatureHeader, "x-billing-signature");

      const health = await server.app.inject({ method: "GET", url: "/health/live" });
      assert.equal(health.statusCode, 200);

      // Readiness with a mock pool that reports a reachable database.
      const ready = await server.app.inject({ method: "GET", url: "/health/ready" });
      assert.equal(ready.statusCode, 200);

      // The webhook must exist even with no subscription, because it is what
      // later grants one.
      const webhook = await server.app.inject({
        method: "POST",
        url: "/webhook",
        headers: { "content-type": "application/json", "x-billing-signature": "t=1,v1=x" },
        payload: "{}",
      });
      assert.equal(webhook.statusCode, 400);
      assert.equal(webhook.json().accepted, false);
    } finally {
      await server.close();
    }
  });

  it("refuses to build a server from an incomplete environment", async () => {
    await assert.rejects(
      () => createServer({ env: { DATABASE_URL: "" } }),
      /Missing required environment variables/,
    );
  });

  it("passes the selected provider into both billing services", async () => {
    const pool = {
      async query() { return { rows: [] }; },
      async connect() {
        return { async query() { return { rows: [] }; }, release() {} };
      },
      async end() {},
    };
    const provider = {
      name: "stripe",
      webhookSignatureHeader: "stripe-signature",
      async createCustomer() { return { providerCustomerId: "cus" }; },
      async createCheckoutSession() { return { providerCheckoutSessionId: "cs", checkoutUrl: "u" }; },
      async changeSubscription() { return { status: "active" }; },
      async cancelSubscription() { return { status: "active" }; },
      async resumeSubscription() { return { status: "active" }; },
      verifyWebhook: () => ({ verified: false, event: null, reason: "x" }),
    };

    const billing = createBillingWebhookService({ pool, provider });
    const subscriptions = createSubscriptionService(pool, { provider });

    assert.equal(billing.webhookSignatureHeader, "stripe-signature");
    assert.equal(subscriptions.constructor.name, "Object");
    assert.equal(typeof subscriptions.startCheckout, "function");
  });
});