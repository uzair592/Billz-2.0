import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import path from "node:path";
import pg from "pg";
import {
  bootstrapFirstRestaurant,
  repairMissingCashAccounts,
  resolveProvisioningDatabaseUrl,
} from "../src/server/bootstrap-first-restaurant.mjs";
import { hashPassword, verifyPassword } from "../src/server/auth/passwords.mjs";
import { createOrderService } from "../src/server/pos/order-service.mjs";
import {
  connectAdmin,
  scratchDatabaseUrl,
} from "./helpers/postgres.mjs";

const execFileAsync = promisify(execFile);
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
    connectionString: scratchDatabaseUrl(databaseName),
    max: 5,
  });
}

function scratchPoolWithRole(databaseName, role, password) {
  const parsed = new URL(scratchDatabaseUrl(databaseName));
  parsed.username = role;
  parsed.password = password;
  return new pg.Pool({
    connectionString: parsed.toString(),
    max: 5,
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
    const { fileURLToPath } = await import("node:url");
    const realDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)), "..", "database", "migrations",
    );
    await runMigrations({ pool, migrationsDir: realDir, logger: { info() {} } });

    // Ensure pos_integration_app (no bypassrls) and pos_control_test (bypassrls) exist and have permissions
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pos_integration_app') THEN
          CREATE ROLE pos_integration_app LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pos_control_test') THEN
          CREATE ROLE pos_control_test LOGIN PASSWORD 'control-test-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
        END IF;
      END
      $$;
    `);
    await pool.query(`
      GRANT USAGE, CREATE ON SCHEMA public TO pos_control_test, pos_integration_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pos_control_test, pos_integration_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pos_control_test, pos_integration_app;
    `);
  });

  after(async () => {
    await pool.end();
    await dropScratchDatabase(databaseName);
  });

  it("creates a restaurant, branch, owner, membership, default cash account, business settings, and trial subscription atomically", async () => {
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

    // Verify business_settings created
    const settings = await pool.query(
      "SELECT business_name, default_branch_id FROM business_settings WHERE restaurant_id = $1",
      [result.restaurantId],
    );
    assert.equal(settings.rows.length, 1);
    assert.equal(settings.rows[0].business_name, "Pilot Cafe");
    assert.equal(settings.rows[0].default_branch_id, result.branchId);

    // Verify tenant_storage_allowances created (5 GB quota)
    const allowance = await pool.query(
      "SELECT max_storage_bytes, used_storage_bytes FROM tenant_storage_allowances WHERE restaurant_id = $1",
      [result.restaurantId],
    );
    assert.equal(allowance.rows.length, 1);
    assert.equal(Number(allowance.rows[0].max_storage_bytes), 5368709120);
    assert.equal(Number(allowance.rows[0].used_storage_bytes), 0);

    // Verify default active cash financial account created
    const cashAccount = await pool.query(
      "SELECT id, account_type, display_name, is_active FROM financial_accounts WHERE restaurant_id = $1",
      [result.restaurantId],
    );
    assert.equal(cashAccount.rows.length, 1);
    assert.equal(cashAccount.rows[0].account_type, "cash");
    assert.equal(cashAccount.rows[0].display_name, "Cash");
    assert.equal(cashAccount.rows[0].is_active, true);
  });

  it("verifies cash checkout succeeds without PAYMENT_ACCOUNT_REQUIRED error on bootstrapped restaurant", async () => {
    const slug = `cash-checkout-${randomUUID().slice(0, 8)}`;
    const bootstrapped = await bootstrapFirstRestaurant({
      pool,
      input: {
        restaurantName: "Cash Checkout Cafe",
        slug,
        timezone: "Asia/Karachi",
        currencyCode: "PKR",
        ownerEmail: `${slug}@example.com`,
        ownerPassword: "secure-password-123",
        pepper: PEPPER,
        subscriptionStatus: "active",
      },
      logger: { info() {} },
    });

    // Insert menu item
    const menuCat = await pool.query(
      "INSERT INTO menu_categories (restaurant_id, name) VALUES ($1, 'Burgers') RETURNING id",
      [bootstrapped.restaurantId],
    );
    const menuItem = await pool.query(
      `INSERT INTO menu_items (restaurant_id, category_id, name, price_minor)
       VALUES ($1, $2, 'Zinger Burger', 50000) RETURNING id`,
      [bootstrapped.restaurantId, menuCat.rows[0].id],
    );

    const orderService = createOrderService(pool);
    const order = await orderService.create({
      tenant: {
        restaurant: { id: bootstrapped.restaurantId, timezone: "Asia/Karachi" },
        membership: { defaultBranchId: bootstrapped.branchId, role: "owner" },
      },
      userId: bootstrapped.ownerId,
      input: {
        idempotencyKey: randomUUID(),
        orderType: "takeaway",
        expectedTotalMinor: 50000,
        items: [{ menuItemId: menuItem.rows[0].id, quantity: 1 }],
        payment: { method: "cash", amountReceivedMinor: 50000 },
      },
    });

    assert.ok(order.order.id);
    assert.equal(order.order.orderStatus, "completed");
    assert.equal(order.order.paymentStatus, "paid");
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
    assert.equal(await verifyPassword(hash, "another-secure-password", PEPPER), true);
    assert.equal(await verifyPassword(hash, "wrong-password", PEPPER), false);
  });

  it("is idempotent: re-running with the same identifiers does not duplicate or overwrite password/settings", async () => {
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

    // Fetch initial password hash and cash account ID
    const initialUser = (await pool.query("SELECT password_hash FROM users WHERE id = $1", [first.ownerId])).rows[0];
    const initialCash = (await pool.query("SELECT id FROM financial_accounts WHERE restaurant_id = $1", [first.restaurantId])).rows[0];

    // Modify business settings to test non-overwriting
    await pool.query("UPDATE business_settings SET phone = '0300-1234567' WHERE restaurant_id = $1", [first.restaurantId]);

    const second = await bootstrapFirstRestaurant({
      pool,
      input: {
        restaurantName: "Idempotent Cafe Renamed",
        slug: "idempotent-cafe",
        timezone: "Asia/Karachi",
        currencyCode: "PKR",
        ownerEmail: "idem@pilot.example",
        ownerPassword: "idempotent-password-different",
        pepper: PEPPER,
        subscriptionStatus: "trial",
      },
      logger: { info() {} },
    });

    // Same restaurant, branch, and owner — no duplicates.
    assert.equal(second.restaurantId, first.restaurantId);
    assert.equal(second.branchId, first.branchId);
    assert.equal(second.ownerId, first.ownerId);

    // Password must NOT be reset or overwritten
    const preservedUser = (await pool.query("SELECT password_hash FROM users WHERE id = $1", [first.ownerId])).rows[0];
    assert.equal(preservedUser.password_hash, initialUser.password_hash);
    assert.equal(await verifyPassword(preservedUser.password_hash, "idempotent-password-1", PEPPER), true);

    // Settings must NOT be overwritten
    const settings = (await pool.query("SELECT phone FROM business_settings WHERE restaurant_id = $1", [first.restaurantId])).rows[0];
    assert.equal(settings.phone, "0300-1234567");

    // Cash accounts count must remain exactly 1 with the same ID
    const cashAccounts = await pool.query(
      "SELECT id FROM financial_accounts WHERE restaurant_id = $1 AND account_type = 'cash'",
      [first.restaurantId],
    );
    assert.equal(cashAccounts.rows.length, 1);
    assert.equal(cashAccounts.rows[0].id, initialCash.id);
  });

  it("fails with UNSUITABLE_PROVISIONING_ROLE when called with restricted POS role", async () => {
    const restrictedPool = scratchPoolWithRole(databaseName, "pos_integration_app", "integration-only");
    try {
      await assert.rejects(
        () => bootstrapFirstRestaurant({
          pool: restrictedPool,
          input: {
            restaurantName: "Restricted Role Cafe",
            slug: "restricted-role-cafe",
            timezone: "Asia/Karachi",
            currencyCode: "PKR",
            ownerEmail: "restricted@pilot.example",
            ownerPassword: "secure-password-123",
            pepper: PEPPER,
          },
          logger: { info() {} },
        }),
        (err) => err.code === "UNSUITABLE_PROVISIONING_ROLE",
      );
    } finally {
      await restrictedPool.end();
    }
  });

  it("succeeds when called with non-superuser control role with BYPASSRLS", async () => {
    const controlPool = scratchPoolWithRole(databaseName, "pos_control_test", "control-test-only");
    try {
      const result = await bootstrapFirstRestaurant({
        pool: controlPool,
        input: {
          restaurantName: "Control Role Cafe",
          slug: "control-role-cafe",
          timezone: "Asia/Karachi",
          currencyCode: "PKR",
          ownerEmail: "control@pilot.example",
          ownerPassword: "secure-password-123",
          pepper: PEPPER,
        },
        logger: { info() {} },
      });
      assert.ok(result.restaurantId);
      assert.equal(result.restaurantSlug, "control-role-cafe");
    } finally {
      await controlPool.end();
    }
  });

  it("tests repairMissingCashAccounts: repairs missing cash accounts without reactivating deliberately disabled ones", async () => {
    // 1. Create a restaurant that has no cash account
    const noCashRes = await pool.query(
      `INSERT INTO restaurants (name, slug, timezone, currency_code, code)
       VALUES ('No Cash Cafe', 'no-cash-cafe', 'Asia/Karachi', 'PKR', 'no-cash-cafe')
       RETURNING id`,
    );
    const noCashRestId = noCashRes.rows[0].id;
    const branchRes = await pool.query(
      `INSERT INTO branches (restaurant_id, name, code, is_default)
       VALUES ($1, 'Main', 'main', true)
       RETURNING id`,
      [noCashRestId],
    );

    // 2. Create another restaurant that has a deliberately disabled cash account
    const disabledCashRes = await pool.query(
      `INSERT INTO restaurants (name, slug, timezone, currency_code, code)
       VALUES ('Disabled Cash Cafe', 'disabled-cash-cafe', 'Asia/Karachi', 'PKR', 'disabled-cash-cafe')
       RETURNING id`,
    );
    const disabledRestId = disabledCashRes.rows[0].id;
    const disabledBranchRes = await pool.query(
      `INSERT INTO branches (restaurant_id, name, code, is_default)
       VALUES ($1, 'Main', 'main', true)
       RETURNING id`,
      [disabledRestId],
    );
    await pool.query(
      `INSERT INTO financial_accounts (restaurant_id, branch_id, account_type, display_name, is_active)
       VALUES ($1, $2, 'cash', 'Old Cash', false)`,
      [disabledRestId, disabledBranchRes.rows[0].id],
    );

    // Run repair
    const repairResult = await repairMissingCashAccounts({ pool, logger: { info() {}, warn() {} } });
    assert.ok(repairResult.repairedCount >= 1);
    const repairedIds = repairResult.repairedRestaurants.map((r) => r.id);
    assert.ok(repairedIds.includes(noCashRestId), "Missing restaurant must be repaired");
    assert.ok(!repairedIds.includes(disabledRestId), "Deliberately disabled cash restaurant must NOT be repaired");

    // Verify no-cash cafe now has active cash account
    const repairedAccounts = await pool.query(
      "SELECT id, is_active, display_name FROM financial_accounts WHERE restaurant_id = $1",
      [noCashRestId],
    );
    assert.equal(repairedAccounts.rows.length, 1);
    assert.equal(repairedAccounts.rows[0].is_active, true);

    // Verify disabled cafe account remains inactive
    const disabledAccounts = await pool.query(
      "SELECT id, is_active FROM financial_accounts WHERE restaurant_id = $1",
      [disabledRestId],
    );
    assert.equal(disabledAccounts.rows.length, 1);
    assert.equal(disabledAccounts.rows[0].is_active, false);

    // Repeat run of repair must be idempotent (0 newly repaired for these)
    const secondRepair = await repairMissingCashAccounts({ pool, logger: { info() {}, warn() {} } });
    const secondRepairedIds = secondRepair.repairedRestaurants.map((r) => r.id);
    assert.ok(!secondRepairedIds.includes(noCashRestId));
    assert.ok(!secondRepairedIds.includes(disabledRestId));
  });

  it("handles account-name conflicts clearly during cash account repair and scopes to branch", async () => {
    // Create restaurant with a non-cash account named 'Cash'
    const conflictRestRes = await pool.query(
      `INSERT INTO restaurants (name, slug, timezone, currency_code, code)
       VALUES ('Conflict Cafe', 'conflict-cafe', 'Asia/Karachi', 'PKR', 'conflict-cafe')
       RETURNING id`,
    );
    const conflictRestId = conflictRestRes.rows[0].id;
    const branchRes = await pool.query(
      `INSERT INTO branches (restaurant_id, name, code, is_default)
       VALUES ($1, 'Downtown', 'downtown', true)
       RETURNING id`,
      [conflictRestId],
    );
    const branchId = branchRes.rows[0].id;

    // Bank account taking display_name 'Cash'
    await pool.query(
      `INSERT INTO financial_accounts (restaurant_id, branch_id, account_type, display_name, is_active)
       VALUES ($1, $2, 'bank', 'Cash', true)`,
      [conflictRestId, branchId],
    );

    // Run repair
    const repairRes = await repairMissingCashAccounts({ pool, logger: { info() {}, warn() {} } });
    const repairedRow = repairRes.repairedRestaurants.find((r) => r.id === conflictRestId);
    assert.ok(repairedRow, "Conflict restaurant must be repaired");
    assert.equal(repairedRow.branchId, branchId, "Repaired account must scope to default branch");
    assert.equal(repairedRow.accountName, "Cash - Downtown");

    // Verify both accounts exist in DB
    const accounts = await pool.query(
      "SELECT account_type, display_name, is_active FROM financial_accounts WHERE restaurant_id = $1 ORDER BY display_name",
      [conflictRestId],
    );
    assert.equal(accounts.rows.length, 2);
    assert.deepEqual(accounts.rows[0], { account_type: "bank", display_name: "Cash", is_active: true });
    assert.deepEqual(accounts.rows[1], { account_type: "cash", display_name: "Cash - Downtown", is_active: true });
  });

  it("remains safe and idempotent under concurrent repair execution", async () => {
    // Create two new restaurants without cash accounts
    const rest1Res = await pool.query(
      `INSERT INTO restaurants (name, slug, timezone, currency_code, code)
       VALUES ('Concurrent Rest 1', 'concurrent-rest-1', 'Asia/Karachi', 'PKR', 'concurrent-rest-1')
       RETURNING id`,
    );
    const rest1Id = rest1Res.rows[0].id;
    await pool.query(
      `INSERT INTO branches (restaurant_id, name, code, is_default)
       VALUES ($1, 'Main', 'main', true)`,
      [rest1Id],
    );

    const rest2Res = await pool.query(
      `INSERT INTO restaurants (name, slug, timezone, currency_code, code)
       VALUES ('Concurrent Rest 2', 'concurrent-rest-2', 'Asia/Karachi', 'PKR', 'concurrent-rest-2')
       RETURNING id`,
    );
    const rest2Id = rest2Res.rows[0].id;
    await pool.query(
      `INSERT INTO branches (restaurant_id, name, code, is_default)
       VALUES ($1, 'Main', 'main', true)`,
      [rest2Id],
    );

    // Run two repairs concurrently
    const [repair1, repair2] = await Promise.all([
      repairMissingCashAccounts({ pool, logger: { info() {}, warn() {} } }),
      repairMissingCashAccounts({ pool, logger: { info() {}, warn() {} } }),
    ]);

    const totalRepairedForTestRests =
      [...repair1.repairedRestaurants, ...repair2.repairedRestaurants]
        .filter((r) => r.id === rest1Id || r.id === rest2Id).length;

    // Both restaurants must be repaired exactly once in total across the two concurrent runs
    assert.equal(totalRepairedForTestRests, 2);

    const rest1Accounts = await pool.query(
      "SELECT id FROM financial_accounts WHERE restaurant_id = $1 AND account_type = 'cash'",
      [rest1Id],
    );
    assert.equal(rest1Accounts.rows.length, 1);

    const rest2Accounts = await pool.query(
      "SELECT id FROM financial_accounts WHERE restaurant_id = $1 AND account_type = 'cash'",
      [rest2Id],
    );
    assert.equal(rest2Accounts.rows.length, 1);
  });

  it("tests resolveProvisioningDatabaseUrl configuration validation", () => {
    // Production requires CONTROL_DATABASE_URL
    assert.throws(
      () => resolveProvisioningDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: "postgres://user:pass@localhost:5432/db" }),
      (err) => err.code === "CONFIGURATION_INVALID" && /CONTROL_DATABASE_URL is required in production/.test(err.message),
    );

    // Production with CONTROL_DATABASE_URL succeeds
    const prodUrl = resolveProvisioningDatabaseUrl({
      NODE_ENV: "production",
      CONTROL_DATABASE_URL: "postgres://control:pass@localhost:5432/db",
    });
    assert.equal(prodUrl, "postgres://control:pass@localhost:5432/db");

    // Development falls back to DATABASE_URL
    const devUrl = resolveProvisioningDatabaseUrl({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://dev:pass@localhost:5432/db",
    });
    assert.equal(devUrl, "postgres://dev:pass@localhost:5432/db");
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

  it("verifies CLI execution via child process with restricted role vs control role and repair flag", async () => {
    const scriptPath = path.resolve("src/server/bootstrap-first-restaurant.mjs");
    const restrictedUrl = scratchDatabaseUrl(databaseName).replace(/\/\/[^@]+@/, "//pos_integration_app:integration-only@");
    const controlUrl = scratchDatabaseUrl(databaseName).replace(/\/\/[^@]+@/, "//pos_control_test:control-test-only@");

    // 1. CLI with restricted POS role must fail
    await assert.rejects(
      () => execFileAsync("node", [scriptPath], {
        env: {
          ...process.env,
          CONTROL_DATABASE_URL: restrictedUrl,
          RESTAURANT_NAME: "CLI Fail Cafe",
          RESTAURANT_SLUG: "cli-fail-cafe",
          RESTAURANT_TIMEZONE: "Asia/Karachi",
          RESTAURANT_CURRENCY: "PKR",
          OWNER_EMAIL: "clifail@example.com",
          BOOTSTRAP_OWNER_PASSWORD: "secure-password-123",
          PASSWORD_PEPPER: PEPPER,
        },
      }),
      (err) => err.code !== 0 && (err.stderr.includes("UNSUITABLE_PROVISIONING_ROLE") || err.stdout.includes("UNSUITABLE_PROVISIONING_ROLE")),
    );

    // 2. CLI with control role must succeed
    const { stdout } = await execFileAsync("node", [scriptPath], {
      env: {
        ...process.env,
        CONTROL_DATABASE_URL: controlUrl,
        RESTAURANT_NAME: "CLI Success Cafe",
        RESTAURANT_SLUG: "cli-success-cafe",
        RESTAURANT_TIMEZONE: "Asia/Karachi",
        RESTAURANT_CURRENCY: "PKR",
        OWNER_EMAIL: "clisuccess@example.com",
        BOOTSTRAP_OWNER_PASSWORD: "secure-password-123",
        PASSWORD_PEPPER: PEPPER,
      },
    });
    assert.ok(stdout.includes("bootstrap_complete"));

    // 3. CLI --repair-cash-accounts must run and report repair complete
    const { stdout: repairOut } = await execFileAsync("node", [scriptPath, "--repair-cash-accounts"], {
      env: {
        ...process.env,
        CONTROL_DATABASE_URL: controlUrl,
      },
    });
    assert.ok(repairOut.includes("repair_complete"));
  });
});
