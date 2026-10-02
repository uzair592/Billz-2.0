import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPostgresAuthRepository } from "../src/server/auth/postgres-auth-repository.mjs";

function fakePool({ tokenRow = null, duplicate = false, membershipRows = [] } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(text, values) {
      calls.push({ text: text.replace(/\s+/g, " ").trim(), values });
      if (duplicate && text.includes("INSERT INTO users")) {
        const error = new Error("duplicate");
        error.code = "23505";
        error.constraint = "users_normalized_email_key";
        throw error;
      }
      if (text.includes("INSERT INTO users")) {
        return { rows: [{
          id: values[0], email: values[1], display_name: values[4],
          platform_role: "user", status: "pending_verification",
          email_verified_at: null, password_hash: values[3],
        }] };
      }
      if (text.includes("FROM restaurant_memberships m")) {
        return { rows: membershipRows };
      }
      if (text.includes("FROM email_verification_tokens")) {
        return { rows: tokenRow ? [tokenRow] : [] };
      }
      if (text.includes("UPDATE users")) {
        return { rows: [{
          id: values[0], email: "owner@example.com", display_name: "Owner",
          platform_role: "user", status: "active",
          email_verified_at: values[1], password_hash: "hash",
        }] };
      }
      return { rows: [] };
    },
    release() { released = true; },
  };
  return {
    calls,
    get released() { return released; },
    async connect() { return client; },
    async query(text, values) {
      calls.push({ text: text.replace(/\s+/g, " ").trim(), values });
      return { rows: [] };
    },
  };
}

const registration = {
  email: "owner@example.com",
  normalizedEmail: "owner@example.com",
  displayName: "Owner",
  restaurantName: "Example Cafe",
  passwordHash: "$argon2id$hash",
  verificationTokenHash: Buffer.alloc(32, 1),
  verificationExpiresAt: new Date("2026-10-02T12:30:00Z"),
};

describe("PostgreSQL authentication repository", () => {
  it("creates the owner, restaurant, branch, settings, and token atomically", async () => {
    const pool = fakePool();
    const repository = createPostgresAuthRepository(pool);
    const user = await repository.createPendingOwner(registration);
    const statements = pool.calls.map((call) => call.text);

    assert.equal(user.email, registration.email);
    assert.equal(statements[0], "BEGIN");
    for (const table of [
      "users", "restaurants", "branches", "restaurant_memberships",
      "business_settings", "financial_accounts", "email_verification_tokens",
    ]) {
      assert.ok(statements.some((sql) => sql.startsWith(`INSERT INTO ${table}`)));
    }
    assert.equal(statements.at(-1), "COMMIT");
    assert.equal(pool.released, true);
  });

  it("rolls back and maps duplicate emails without database details", async () => {
    const pool = fakePool({ duplicate: true });
    const repository = createPostgresAuthRepository(pool);
    await assert.rejects(
      repository.createPendingOwner(registration),
      (error) => error.code === "EMAIL_EXISTS",
    );
    assert.equal(pool.calls.at(-1).text, "ROLLBACK");
    assert.equal(pool.released, true);
  });

  it("sets tenant context before activating the owner membership", async () => {
    const tokenRow = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      restaurant_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    };
    const pool = fakePool({ tokenRow });
    const repository = createPostgresAuthRepository(pool);
    const user = await repository.consumeEmailVerification({
      tokenHash: Buffer.alloc(32, 2),
      now: new Date("2026-10-02T12:00:00Z"),
    });
    const statements = pool.calls.map((call) => call.text);
    const contextIndex = statements.findIndex((sql) => sql.includes("set_config('app.restaurant_id'"));
    const membershipIndex = statements.findIndex((sql) => sql.startsWith("UPDATE restaurant_memberships"));

    assert.equal(user.status, "active");
    assert.ok(contextIndex > 0);
    assert.ok(membershipIndex > contextIndex);
    assert.equal(statements.at(-1), "COMMIT");
  });

  it("leaves an invalid or expired verification token unconsumed", async () => {
    const pool = fakePool();
    const repository = createPostgresAuthRepository(pool);
    const user = await repository.consumeEmailVerification({
      tokenHash: Buffer.alloc(32, 3),
      now: new Date("2026-10-02T12:00:00Z"),
    });

    assert.equal(user, null);
    assert.equal(pool.calls.at(-1).text, "ROLLBACK");
  });

  it("lists only the caller's own restaurants without a tenant context", async () => {
    const restaurantId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const pool = fakePool({
      membershipRows: [{
        restaurant_id: restaurantId,
        restaurant_name: "Example Cafe",
        restaurant_status: "active",
        currency_code: "PKR",
        role: "owner",
        default_branch_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }],
    });
    const repository = createPostgresAuthRepository(pool);
    const restaurants = await repository.listRestaurantsForUser(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    const statements = pool.calls.map((call) => call.text);
    const membershipQuery = pool.calls.find((call) => (
      call.text.includes("FROM restaurant_memberships m")
    ));

    assert.deepEqual(restaurants, [{
      restaurantId,
      name: "Example Cafe",
      status: "active",
      currencyCode: "PKR",
      role: "owner",
      defaultBranchId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    }]);
    assert.ok(membershipQuery.text.includes("m.user_id = $1 AND m.status = 'active'"));
    assert.equal(
      statements.some((sql) => sql.includes("app.restaurant_id")),
      false,
      "Selecting a restaurant must never happen inside the membership lookup.",
    );
    assert.equal(statements.at(-1), "COMMIT");
    assert.equal(pool.released, true);
  });
});
