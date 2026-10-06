import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createServer } from "../src/server/main.mjs";
import {
  connectAdmin,
  scratchDatabaseUrl,
} from "./helpers/postgres.mjs";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL
  ?? "postgresql://postgres:validation-only@127.0.0.1:55432/restaurant_pos_test";

const validEnv = {
  DATABASE_URL: adminUrl,
  TRUSTED_ORIGINS: "https://pos.example.com",
  PASSWORD_PEPPER: "a-long-enough-pepper-value",
  SESSION_SECRET: "a-different-session-secret",
  NODE_ENV: "test",
  PAYMENT_PROVIDER: "manual",
};

const silentLogger = { info() {}, warn() {}, error() {} };

async function createScratchDatabase() {
  const admin = await connectAdmin();
  const name = `health_test_${randomUUID().replace(/-/g, "_").slice(0, 24)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return name;
}

async function dropScratchDatabase(name) {
  const admin = await connectAdmin();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
}

describe("health endpoints", () => {
  let server;

  before(async () => {
    server = await createServer({
      env: validEnv,
      migrationsDir: null,
    });
  });

  after(async () => {
    await server.close();
  });

  it("liveness confirms the process is alive without a database query", async () => {
    const response = await server.app.inject({ method: "GET", url: "/health/live" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.status, "ok");
    // Liveness must not expose configuration or secrets.
    const raw = response.body;
    assert.ok(!raw.includes("DATABASE_URL"));
    assert.ok(!raw.includes("PASSWORD_PEPPER"));
    assert.ok(!raw.includes("SESSION_SECRET"));
  });

  it("readiness returns 200 when the database is reachable and migrations are current", async () => {
    // Use a scratch database migrated through the runner so the
    // schema_migrations history is populated and verification passes.
    const scratchName = await createScratchDatabase();
    const scratchPool = new pg.Pool({
      connectionString: scratchDatabaseUrl(scratchName),
      max: 2,
    });
    const { runMigrations } = await import("../src/server/database/migration-runner.mjs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const realDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)), "..", "database", "migrations",
    );
    await runMigrations({ pool: scratchPool, migrationsDir: realDir, logger: silentLogger });

    const readyEnv = {
      ...validEnv,
      DATABASE_URL: scratchDatabaseUrl(scratchName),
    };
    const readyServer = await createServer({
      env: readyEnv,
      migrationsDir: realDir,
    });
    try {
      const response = await readyServer.app.inject({ method: "GET", url: "/health/ready" });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().status, "ready");
    } finally {
      await readyServer.close();
      await scratchPool.end();
      await dropScratchDatabase(scratchName);
    }
  });

  it("readiness returns 503 when the database is unavailable", async () => {
    const unreachableEnv = {
      ...validEnv,
      DATABASE_URL: "postgresql://postgres:validation-only@127.0.0.1:59999/nonexistent",
    };
    // createServer fails fast when the database is unreachable at
    // startup, so build the app directly with a pool that cannot connect.
    const { buildHttpApp } = await import("../src/server/http/app.mjs");
    const { createAuthService } = await import("../src/server/auth/auth-service.mjs");
    const { createPostgresAuthRepository } = await import("../src/server/auth/postgres-auth-repository.mjs");
    const { createLoggingMailer } = await import("../src/server/mail/logging-mailer.mjs");
    const { createTenantContextService } = await import("../src/server/tenancy/tenant-context-service.mjs");
    const { createSubscriptionService } = await import("../src/server/billing/subscription-service.mjs");
    const { createBillingWebhookService } = await import("../src/server/billing/billing-webhook-service.mjs");
    const { createManualPaymentProvider } = await import("../src/server/billing/manual-payment-provider.mjs");
    const { createOrderRefundService } = await import("../src/server/pos/order-refund-service.mjs");
    const { createSalesReportService } = await import("../src/server/pos/sales-report-service.mjs");
    const { createDatabasePool } = await import("../src/server/database/pool.mjs");

    const pool = createDatabasePool(unreachableEnv, { info() {}, error() {} });
    const authService = createAuthService({
      repository: createPostgresAuthRepository(pool),
      mailer: createLoggingMailer({ nodeEnv: "test", log: () => {} }),
      passwordPepper: validEnv.PASSWORD_PEPPER,
    });
    const app = await buildHttpApp({
      authService,
      tenantContextService: createTenantContextService(pool),
      subscriptionService: createSubscriptionService(pool, {
        provider: createManualPaymentProvider(),
        trustedOrigins: ["https://pos.example.com"],
      }),
      billingWebhookService: createBillingWebhookService({
        pool,
        provider: createManualPaymentProvider(),
        graceDays: 7,
        maxAttempts: 8,
        leaseSeconds: 300,
      }),
      orderRefundService: createOrderRefundService(pool),
      salesReportService: createSalesReportService(pool),
      trustedOrigin: "https://pos.example.com",
      secureCookies: true,
      databasePool: pool,
      migrationsDir: null,
      verifyMigrationsCurrent: null,
    });
    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });
      assert.equal(response.statusCode, 503);
      const body = response.json();
      assert.equal(body.status, "not_ready");
      // Must not expose hostnames, credentials, or stack traces.
      assert.ok(!response.body.includes("59999"));
      assert.ok(!response.body.includes("validation-only"));
      assert.ok(!response.body.includes("postgresql://"));
    } finally {
      await app.close();
      await pool.end().catch(() => {});
    }
  });

  it("readiness detects pending migrations", async () => {
    // Build an app wired to a real pool but pointed at a migrations
    // directory that contains an extra pending migration.
    const { buildHttpApp } = await import("../src/server/http/app.mjs");
    const { createAuthService } = await import("../src/server/auth/auth-service.mjs");
    const { createPostgresAuthRepository } = await import("../src/server/auth/postgres-auth-repository.mjs");
    const { createLoggingMailer } = await import("../src/server/mail/logging-mailer.mjs");
    const { createTenantContextService } = await import("../src/server/tenancy/tenant-context-service.mjs");
    const { createSubscriptionService } = await import("../src/server/billing/subscription-service.mjs");
    const { createBillingWebhookService } = await import("../src/server/billing/billing-webhook-service.mjs");
    const { createManualPaymentProvider } = await import("../src/server/billing/manual-payment-provider.mjs");
    const { createOrderRefundService } = await import("../src/server/pos/order-refund-service.mjs");
    const { createSalesReportService } = await import("../src/server/pos/sales-report-service.mjs");
    const { createDatabasePool } = await import("../src/server/database/pool.mjs");
    const { verifyMigrationsCurrent } = await import("../src/server/database/migration-runner.mjs");
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const here = path.dirname(fileURLToPath(import.meta.url));
    const realDir = path.join(here, "..", "database", "migrations");
    const scratchDir = path.join(here, "..", "test-results", `pending-${randomUUID().slice(0, 8)}`);
    await mkdir(scratchDir, { recursive: true });
    try {
      const { readdir, readFile } = await import("node:fs/promises");
      const files = (await readdir(realDir)).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files) {
        const sql = await readFile(path.join(realDir, file), "utf8");
        await writeFile(path.join(scratchDir, file), sql, "utf8");
      }
      // Add a migration that has not been applied.
      await writeFile(
        path.join(scratchDir, "999_pending.sql"),
        "CREATE TABLE pending_marker (id integer PRIMARY KEY);\n",
        "utf8",
      );

      const pool = createDatabasePool(validEnv, { info() {}, error() {} });
      const authService = createAuthService({
        repository: createPostgresAuthRepository(pool),
        mailer: createLoggingMailer({ nodeEnv: "test", log: () => {} }),
        passwordPepper: validEnv.PASSWORD_PEPPER,
      });
      const app = await buildHttpApp({
        authService,
        tenantContextService: createTenantContextService(pool),
        subscriptionService: createSubscriptionService(pool, {
          provider: createManualPaymentProvider(),
          trustedOrigins: ["https://pos.example.com"],
        }),
        billingWebhookService: createBillingWebhookService({
          pool,
          provider: createManualPaymentProvider(),
          graceDays: 7,
          maxAttempts: 8,
          leaseSeconds: 300,
        }),
        orderRefundService: createOrderRefundService(pool),
        salesReportService: createSalesReportService(pool),
        trustedOrigin: "https://pos.example.com",
        secureCookies: true,
        databasePool: pool,
        migrationsDir: scratchDir,
        verifyMigrationsCurrent,
      });
      try {
        const response = await app.inject({ method: "GET", url: "/health/ready" });
        assert.equal(response.statusCode, 503);
        assert.equal(response.json().reason, "migrations_pending");
      } finally {
        await app.close();
        await pool.end().catch(() => {});
      }
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
