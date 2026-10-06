import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  loadServerConfiguration,
  loadBillingConfiguration,
  parseTrustedOrigins,
} from "../src/server/config/environment.mjs";

const baseEnv = {
  DATABASE_URL: "postgresql://app@127.0.0.1:5432/pos",
  TRUSTED_ORIGINS: "https://pos.example.com",
  PASSWORD_PEPPER: "a-long-enough-pepper-value",
  SESSION_SECRET: "a-different-session-secret",
  NODE_ENV: "test",
};

describe("production configuration", () => {
  it("reads a complete environment with the new origin allowlist", () => {
    const config = loadServerConfiguration({
      ...baseEnv,
      PORT: "4000",
      HOST: "127.0.0.1",
      LOG_LEVEL: "info",
      TRUST_PROXY: "true",
    });
    assert.equal(config.port, 4000);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.trustedOrigin, "https://pos.example.com");
    assert.deepEqual(config.trustedOrigins, ["https://pos.example.com"]);
    assert.equal(config.secureCookies, true);
    assert.equal(config.logLevel, "info");
    assert.equal(config.trustProxy, true);
  });

  it("supports a comma-separated exact origin allowlist", () => {
    const config = loadServerConfiguration({
      ...baseEnv,
      TRUSTED_ORIGINS: "https://pos.example.com,https://admin.example.com",
    });
    assert.deepEqual(config.trustedOrigins, [
      "https://pos.example.com",
      "https://admin.example.com",
    ]);
  });

  it("rejects a wildcard origin", () => {
    assert.throws(
      () => loadServerConfiguration({ ...baseEnv, TRUSTED_ORIGINS: "https://*.example.com" }),
      /Wildcard origins are not allowed/,
    );
  });

  it("rejects a localhost origin in production", () => {
    assert.throws(
      () => loadServerConfiguration({
        ...baseEnv,
        TRUSTED_ORIGINS: "https://localhost:3000",
        NODE_ENV: "production",
      }),
      /must not be localhost in production/,
    );
  });

  it("rejects an http origin in production", () => {
    assert.throws(
      () => loadServerConfiguration({
        ...baseEnv,
        TRUSTED_ORIGINS: "http://pos.example.com",
        NODE_ENV: "production",
      }),
      /must use HTTPS in production/,
    );
  });

  it("rejects a placeholder pepper in production", () => {
    assert.throws(
      () => loadServerConfiguration({
        ...baseEnv,
        PASSWORD_PEPPER: "replace-with-a-secret",
        NODE_ENV: "production",
      }),
      /PASSWORD_PEPPER is a placeholder/,
    );
  });

  it("rejects a placeholder session secret in production", () => {
    assert.throws(
      () => loadServerConfiguration({
        ...baseEnv,
        SESSION_SECRET: "replace-with-at-least-32-random-bytes",
        NODE_ENV: "production",
      }),
      /SESSION_SECRET is a placeholder/,
    );
  });

  it("rejects an invalid NODE_ENV", () => {
    assert.throws(
      () => loadServerConfiguration({ ...baseEnv, NODE_ENV: "staging" }),
      /NODE_ENV must be/,
    );
  });

  it("rejects a session secret that equals the pepper", () => {
    assert.throws(
      () => loadServerConfiguration({
        ...baseEnv,
        SESSION_SECRET: baseEnv.PASSWORD_PEPPER,
      }),
      /must differ/,
    );
  });

  it("rejects a short session secret", () => {
    assert.throws(
      () => loadServerConfiguration({ ...baseEnv, SESSION_SECRET: "short" }),
      /SESSION_SECRET must be at least 16 characters/,
    );
  });

  it("rejects a missing trusted origin", () => {
    assert.throws(
      () => loadServerConfiguration({ ...baseEnv, TRUSTED_ORIGINS: "" }),
      /TRUSTED_ORIGINS/,
    );
  });

  it("still accepts the single TRUSTED_ORIGIN shorthand", () => {
    const config = loadServerConfiguration({
      ...baseEnv,
      TRUSTED_ORIGIN: "https://pos.example.com",
    });
    assert.deepEqual(config.trustedOrigins, ["https://pos.example.com"]);
  });

  it("rejects a placeholder Stripe key in production", () => {
    assert.throws(
      () => loadBillingConfiguration({
        PAYMENT_PROVIDER: "stripe",
        STRIPE_SECRET_KEY: "sk_test_placeholder",
        STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
        NODE_ENV: "production",
      }),
      /placeholders/,
    );
  });

  it("rejects a Stripe webhook secret that is not a whsec_ key", () => {
    assert.throws(
      () => loadBillingConfiguration({
        PAYMENT_PROVIDER: "stripe",
        STRIPE_SECRET_KEY: "sk_live_realkey",
        STRIPE_WEBHOOK_SECRET: "not-a-webhook-secret",
      }),
      /STRIPE_WEBHOOK_SECRET is not a Stripe webhook signing secret/,
    );
  });

  it("accepts a valid manual provider configuration", () => {
    const billing = loadBillingConfiguration({ PAYMENT_PROVIDER: "manual" });
    assert.equal(billing.providerName, "manual");
  });

  it("parseTrustedOrigins deduplicates entries", () => {
    const origins = parseTrustedOrigins(
      "https://a.example.com,https://a.example.com,https://b.example.com",
      { nodeEnv: "production" },
    );
    assert.deepEqual(origins, ["https://a.example.com", "https://b.example.com"]);
  });
});
