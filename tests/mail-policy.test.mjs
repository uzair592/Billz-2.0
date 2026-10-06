import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPolicyMailer,
  resolveRegistrationPolicy,
} from "../src/server/mail/mail-policy.mjs";
import { createAuthService } from "../src/server/auth/auth-service.mjs";
import { createLoggingMailer } from "../src/server/mail/logging-mailer.mjs";

describe("production registration and mail policy", () => {
  it("enables registration outside production", () => {
    const policy = resolveRegistrationPolicy({ nodeEnv: "development" });
    assert.equal(policy.registrationEnabled, true);
  });

  it("disables production registration when no mail provider is configured", () => {
    const policy = resolveRegistrationPolicy({ nodeEnv: "production" });
    assert.equal(policy.registrationEnabled, false);
    assert.equal(policy.reason, "production_registration_disabled_no_mail_provider");
  });

  it("enables production registration when a real mail provider is configured", () => {
    const policy = resolveRegistrationPolicy({
      nodeEnv: "production",
      mailProvider: "sendgrid",
    });
    assert.equal(policy.registrationEnabled, true);
    assert.equal(policy.reason, "mail_provider_configured");
  });

  it("treats placeholder provider names as no provider", () => {
    for (const placeholder of ["", "none", "disabled", "log"]) {
      const policy = resolveRegistrationPolicy({
        nodeEnv: "production",
        mailProvider: placeholder,
      });
      assert.equal(policy.registrationEnabled, false, placeholder);
    }
  });

  it("production mailer never logs the verification token", async () => {
    const captured = [];
    const mailer = createPolicyMailer({
      registrationEnabled: false,
      nodeEnv: "production",
      log: (payload) => captured.push(JSON.stringify(payload)),
    });
    await assert.rejects(
      () => mailer.sendVerification({
        email: "a@example.com",
        token: "super-secret-verification-token",
        expiresAt: new Date(),
      }),
      (error) => error.code === "REGISTRATION_DISABLED",
    );
    const output = captured.join("\n");
    assert.ok(!output.includes("super-secret-verification-token"), "token must not be logged");
  });

  it("registration is rejected when disabled", async () => {
    const mailer = createPolicyMailer({
      registrationEnabled: false,
      nodeEnv: "production",
    });
    const repository = {
      async createPendingOwner() {
        throw new Error("must not be called when registration is disabled");
      },
    };
    const authService = createAuthService({
      repository,
      mailer,
      passwordPepper: "a-long-enough-pepper-value",
    });
    await assert.rejects(
      () => authService.register({
        email: "a@example.com",
        password: "long-enough-password",
        displayName: "A",
        restaurantName: "R",
      }),
      (error) => error.code === "REGISTRATION_DISABLED" && error.statusCode === 503,
    );
  });

  it("development logging mailer keeps its behavior", async () => {
    const captured = [];
    const mailer = createPolicyMailer({
      registrationEnabled: true,
      nodeEnv: "development",
      log: (payload) => captured.push(payload),
    });
    const result = await mailer.sendVerification({
      email: "a@example.com",
      token: "dev-token",
      expiresAt: new Date(),
    });
    assert.equal(result.delivered, false);
    assert.equal(result.transport, "log");
    assert.equal(captured[0].token, "dev-token");
  });

  it("production registration with a provider delegates to the provider", async () => {
    const sent = [];
    const provider = {
      async sendVerification(input) {
        sent.push(input);
        return { delivered: true, transport: "provider" };
      },
    };
    const mailer = createPolicyMailer({
      registrationEnabled: true,
      nodeEnv: "production",
      provider,
    });
    const result = await mailer.sendVerification({
      email: "a@example.com",
      token: "prod-token",
      expiresAt: new Date(),
    });
    assert.equal(result.delivered, true);
    assert.equal(sent.length, 1);
  });

  it("production registration enabled without a provider adapter fails closed", () => {
    assert.throws(
      () => createPolicyMailer({
        registrationEnabled: true,
        nodeEnv: "production",
      }),
      (error) => error.code === "MAIL_PROVIDER_REQUIRED",
    );
  });

  it("the legacy logging mailer still refuses to start in production", () => {
    assert.throws(
      () => createLoggingMailer({ nodeEnv: "production" }),
      /No transactional mail provider is configured/,
    );
  });
});
