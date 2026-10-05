import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { bootstrapFirstRestaurant } from "../src/server/bootstrap-first-restaurant.mjs";
import { hashPassword, verifyPassword } from "../src/server/auth/passwords.mjs";
import {
  connectAdmin,
} from "./helpers/postgres.mjs";

const PEPPER = "bootstrap-test-pepper-at-least-16-chars";

async function createScratchDatabase() {
  const admin = await connectAdmin();
  const name = `bootstrap_test_${randomUUID().replace(/-/g, "_").slice(0, 24)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return name;
}

async function dropScratchDatabase(name) {
  const admin = await connectAdmin();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
}

function scratchPool(databaseName) {
  return new pg.Pool({
    connectionString: `postgresql://postgres:validation-only@127.0.0.1:55432/${databaseName}`,
    max: 2,
  });
}

describe("first-restaurant bootstrap CLI", () => {
  let databaseName;
  let pool;

  before(async () => {
    databaseName = await createScratchDatabase();
    pool = scratchPool(databaseName);
    // Apply the real migrations so the bootstrap tables exist.
    const { runMigrations } = await import("../src/server/database/migration-runner.mjs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const realDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)), "..", "database", "migrations",
    );
    await runMigrations({ pool, migrationsDir: realDir, logger: { info() {} } });
  });

  after(async () => {
    await pool.end();
    await dropScratchDatabase(databaseName);
  });

  it("creates a restaurant, branch, owner, membership, and trial subscription", async () => {
    const result = await bootstrapFirstRestaurant({
      pool,
      input: {
        restaurantName: "Pilot Cafe",
        slug: "pilot-cafe",
        timezone: "Asia/Karachi",
        currencyCode: "PKR",
        ownerEmail: "owner@pilot.example",
        ownerDisplayName: "Pilot Owner",
        ownerPassword: "secure-password-123",
        pepper: PEPPER,
        subscriptionStatus: "trial",
      },
      logger: { info() {} },
    });

    assert.ok(result.restaurantId);
    assert.equal(result.restaurantSlug, "pilot-cafe");
    assert.ok(result.branchId);
    assert.ok(result.ownerId);
    assert.equal(result.ownerEmail, "owner@pilot.example");

    // Verify the rows exist.
    const restaurant = await pool.query(
      "SELECT name, slug, timezone, currency_code FROM restaurants WHERE id = $1",
      [result.restaurantId],
    );
    assert.equal(restaurant.rows[0].slug, "pilot-cafe");
    assert.equal(restaurant.rows[0].timezone, "Asia/Karachi");
    assert.equal(restaurant.rows[0].currency_code, "PKR");

    const membership = await pool.query(
      `SELECT role, status FROM restaurant_memberships
       WHERE restaurant_id = $1 AND user_id = $2`,
      [result.restaurantId, result.ownerId],
    );
    assert.equal(membership.rows[0].role, "owner");
    assert.equal(membership.rows[0].status, "active");

    const subscription = await pool.query(
      "SELECT status FROM subscriptions WHERE restaurant_id = $1",
      [result.restaurantId],
    );
    assert.equal(subscription.rows[0].status, "trialing");
  });

  it("hashes the owner password with the project argon2id implementation", async () => {
    const result = await bootstrapFirstRestaurant({
      pool,
      input: {
        restaurantName: "Hash Check Cafe",
        slug: "hash-check-cafe",
        timezone: "Asia/Karachi",
        currencyCode: "PKR",
        ownerEmail: "hashowner@pilot.example",
        ownerPassword: "another-secure-password",
        pepper: PEPPER,
        subscriptionStatus: "trial",
      },
      logger: { info() {} },
    });

    const user = await pool.query(
      "SELECT password_hash FROM users WHERE id = $1",
      [result.ownerId],
    );
    const hash = user.rows[0].password_hash;
    assert.ok(hash.startsWith("$argon2id$"));
    // The stored hash verifies against the supplied password and pepper.
    assert.equal(await verifyPassword(hash, "another-secure-password", PEPPER), true);
    // And does not verify against a wrong password.
    assert.equal(await verifyPassword(hash, "wrong-password", PEPPER), false);
  });

  it("is idempotent: re-running with the same identifiers does not duplicate", async () => {
    const first = await bootstrapFirstRestaurant({
      pool,
      input: {
        restaurantName: "Idempotent Cafe",
        slug: "idempotent-cafe",
        timezone: "Asia/Karachi",
        currencyCode: "PKR",
        ownerEmail: "idem@pilot.example",
        ownerPassword: "idempotent-password-1",
        pepper: PEPPER,
        subscriptionStatus: "trial",
      },
      logger: { info() {} },
    });

    const second = await bootstrapFirstRestaurant({
      pool,
      input: {
        restaurantName: "Idempotent Cafe Renamed",
        slug: "idempotent-cafe",
        timezone: "Asia/Karachi",
        currencyCode: "PKR",
        ownerEmail: "idem@pilot.example",
        ownerPassword: "idempotent-password-2",
        pepper: PEPPER,
        subscriptionStatus: "trial",
      },
      logger: { info() {} },
    });

    // Same restaurant, branch, and owner — no duplicates.
    assert.equal(second.restaurantId, first.restaurantId);
    assert.equal(second.branchId, first.branchId);
    assert.equal(second.ownerId, first.ownerId);

    const restaurantCount = await pool.query(
      "SELECT count(*) AS c FROM restaurants WHERE slug = 'idempotent-cafe'",
    );
    assert.equal(Number(restaurantCount.rows[0].c), 1);

    const membershipCount = await pool.query(
      `SELECT count(*) AS c FROM restaurant_memberships
       WHERE restaurant_id = $1 AND user_id = $2`,
      [first.restaurantId, first.ownerId],
    );
    assert.equal(Number(membershipCount.rows[0].c), 1);
  });

  it("rejects an invalid slug", async () => {
    await assert.rejects(
      () => bootstrapFirstRestaurant({
        pool,
        input: {
          restaurantName: "Bad Slug",
          slug: "Invalid_Slug!",
          timezone: "Asia/Karachi",
          currencyCode: "PKR",
          ownerEmail: "bad@pilot.example",
          ownerPassword: "secure-password-123",
          pepper: PEPPER,
        },
        logger: { info() {} },
      }),
      (error) => error.code === "BOOTSTRAP_FAILED" && /slug/.test(error.message),
    );
  });

  it("rejects an invalid currency code", async () => {
    await assert.rejects(
      () => bootstrapFirstRestaurant({
        pool,
        input: {
          restaurantName: "Bad Currency",
          slug: "bad-currency-cafe",
          timezone: "Asia/Karachi",
          currencyCode: "PKR1",
          ownerEmail: "badcur@pilot.example",
          ownerPassword: "secure-password-123",
          pepper: PEPPER,
        },
        logger: { info() {} },
      }),
      (error) => error.code === "BOOTSTRAP_FAILED" && /Currency/.test(error.message),
    );
  });

  it("rejects a password shorter than 10 characters", async () => {
    await assert.rejects(
      () => bootstrapFirstRestaurant({
        pool,
        input: {
          restaurantName: "Short Password",
          slug: "short-password-cafe",
          timezone: "Asia/Karachi",
          currencyCode: "PKR",
          ownerEmail: "short@pilot.example",
          ownerPassword: "short",
          pepper: PEPPER,
        },
        logger: { info() {} },
      }),
      (error) => /at least 10 characters/.test(error.message),
    );
  });

  it("requires a pepper of at least 16 characters", async () => {
    await assert.rejects(
      () => bootstrapFirstRestaurant({
        pool,
        input: {
          restaurantName: "No Pepper",
          slug: "no-pepper-cafe",
          timezone: "Asia/Karachi",
          currencyCode: "PKR",
          ownerEmail: "nopepper@pilot.example",
          ownerPassword: "secure-password-123",
          pepper: "too-short",
        },
        logger: { info() {} },
      }),
      (error) => /pepper of at least 16 characters/.test(error.message),
    );
  });

  it("does not print the password or hash", async () => {
    const captured = [];
    const logger = { info: (entry) => captured.push(JSON.stringify(entry)) };
    await bootstrapFirstRestaurant({
      pool,
      input: {
        restaurantName: "Secret Cafe",
        slug: "secret-cafe",
        timezone: "Asia/Karachi",
        currencyCode: "PKR",
        ownerEmail: "secret@pilot.example",
        ownerPassword: "super-secret-password-99",
        pepper: PEPPER,
        subscriptionStatus: "trial",
      },
      logger,
    });
    const output = captured.join("\n");
    assert.ok(!output.includes("super-secret-password-99"), "password must not be logged");
    assert.ok(!output.includes("$argon2id$"), "hash must not be logged");
  });
});
