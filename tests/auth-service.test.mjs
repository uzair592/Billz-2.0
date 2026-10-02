import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAuthService } from "../src/server/auth/auth-service.mjs";
import { hashPassword } from "../src/server/auth/passwords.mjs";

const pepper = "test-pepper-is-long-enough";
const now = new Date("2026-10-02T12:00:00.000Z");

function fixture(overrides = {}) {
  const calls = [];
  const user = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "owner@example.com",
    displayName: "Owner",
    platformRole: "user",
    status: "active",
    emailVerifiedAt: now,
    passwordHash: null,
  };
  const repository = {
    async createPendingOwner(input) {
      calls.push(["createPendingOwner", input]);
      return user;
    },
    async consumeEmailVerification(input) {
      calls.push(["consumeEmailVerification", input]);
      return user;
    },
    async findUserByEmail(email) {
      calls.push(["findUserByEmail", email]);
      return user;
    },
    async createSession(input) {
      calls.push(["createSession", input]);
    },
    async findActiveSession(tokenHash, at) {
      calls.push(["findActiveSession", { tokenHash, at }]);
      return { user, memberships: [] };
    },
    async revokeSession(tokenHash, at) {
      calls.push(["revokeSession", { tokenHash, at }]);
    },
    ...overrides.repository,
  };
  const mailer = {
    async sendVerification(input) {
      calls.push(["sendVerification", input]);
    },
  };
  const service = createAuthService({
    repository,
    mailer,
    passwordPepper: pepper,
    clock: () => new Date(now),
  });
  return { service, calls, user };
}

describe("authentication service", () => {
  it("registers a pending owner with hashes and emails only the raw verification token", async () => {
    const { service, calls } = fixture();
    const result = await service.register({
      email: " Owner@Example.com ",
      password: "correct horse battery staple",
      displayName: " Owner ",
      restaurantName: " Example Cafe ",
    });

    const created = calls.find(([name]) => name === "createPendingOwner")[1];
    const mailed = calls.find(([name]) => name === "sendVerification")[1];
    assert.equal(created.normalizedEmail, "owner@example.com");
    assert.match(created.passwordHash, /^\$argon2id\$/);
    assert.ok(Buffer.isBuffer(created.verificationTokenHash));
    assert.notEqual(created.verificationTokenHash.toString("hex"), mailed.token);
    assert.equal(result.verificationRequired, true);
    assert.equal("token" in result, false);
    assert.equal("userId" in result, false);
  });

  it("consumes email verification and creates a hashed server session", async () => {
    const { service, calls } = fixture();
    const session = await service.verifyEmail({ token: "v".repeat(43) });

    const consumed = calls.find(([name]) => name === "consumeEmailVerification")[1];
    const storedSession = calls.find(([name]) => name === "createSession")[1];
    assert.ok(Buffer.isBuffer(consumed.tokenHash));
    assert.ok(Buffer.isBuffer(storedSession.tokenHash));
    assert.notEqual(storedSession.tokenHash.toString("hex"), session.token);
    assert.equal(session.user.email, "owner@example.com");
  });

  it("logs in a verified active user without exposing the password hash", async () => {
    const passwordHash = await hashPassword("correct horse battery staple", pepper);
    const { service, user } = fixture();
    user.passwordHash = passwordHash;

    const session = await service.login({
      email: "OWNER@example.com",
      password: "correct horse battery staple",
    });

    assert.equal(session.user.id, user.id);
    assert.equal("passwordHash" in session.user, false);
  });

  it("uses one generic error for missing users and incorrect passwords", async () => {
    const missing = fixture({
      repository: { async findUserByEmail() { return null; } },
    });
    await assert.rejects(
      missing.service.login({ email: "none@example.com", password: "anything" }),
      (error) => error.code === "INVALID_CREDENTIALS" && error.statusCode === 401,
    );

    const wrong = fixture();
    wrong.user.passwordHash = await hashPassword("correct horse battery staple", pepper);
    await assert.rejects(
      wrong.service.login({ email: "owner@example.com", password: "wrong password" }),
      (error) => error.code === "INVALID_CREDENTIALS" && error.statusCode === 401,
    );
  });

  it("revokes a session by its hash instead of storing the raw cookie", async () => {
    const { service, calls } = fixture();
    const rawToken = "s".repeat(43);
    await service.logout(rawToken);

    const revoked = calls.find(([name]) => name === "revokeSession")[1];
    assert.ok(Buffer.isBuffer(revoked.tokenHash));
    assert.notEqual(revoked.tokenHash.toString("hex"), rawToken);
  });

  it("does not reveal that a registration email already exists", async () => {
    const duplicate = fixture({
      repository: {
        async createPendingOwner() {
          const error = new Error("duplicate");
          error.code = "EMAIL_EXISTS";
          throw error;
        },
      },
    });
    const result = await duplicate.service.register({
      email: "owner@example.com",
      password: "correct horse battery staple",
      displayName: "Owner",
      restaurantName: "Example Cafe",
    });

    assert.deepEqual(result, { verificationRequired: true });
    assert.equal(duplicate.calls.some(([name]) => name === "sendVerification"), false);
  });
});
