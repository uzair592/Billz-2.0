import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  runMigrations,
  verifyMigrationsCurrent,
  getAppliedMigrations,
  ensureMigrationsTable,
  listMigrationFiles,
} from "../src/server/database/migration-runner.mjs";
import {
  ADMIN_DATABASE_URL,
  connectAdmin,
  provisionIntegrationDatabase,
  scratchDatabaseUrl,
} from "./helpers/postgres.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL_MIGRATIONS_DIR = path.join(here, "..", "database", "migrations");
const migrationFiles = await listMigrationFiles(REAL_MIGRATIONS_DIR);

/**
 * Creates a throwaway database so migration tests never touch the
 * shared integration schema.
 */
async function createScratchDatabase() {
  const admin = await connectAdmin();
  const name = `migration_test_${randomUUID().replace(/-/g, "_").slice(0, 24)}`;
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
    max: 2,
  });
}

describe("migration runner", () => {
  let databaseName;
  let pool;

  before(async () => {
    databaseName = await createScratchDatabase();
    pool = scratchPool(databaseName);
  });

  after(async () => {
    await pool.end();
    await dropScratchDatabase(databaseName);
  });

  it("applies all bundled migrations to a clean database", async () => {
    const result = await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger });
    assert.equal(result.applied, migrationFiles.length);
    assert.equal(result.alreadyApplied, 0);

    const applied = await getAppliedMigrations(pool);
    assert.equal(applied.size, migrationFiles.length);
    // The highest version is the partial-refunds migration.
    assert.ok(applied.has(migrationFiles.at(-1).version));
  });

  it("is idempotent on a repeated run", async () => {
    const result = await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger });
    assert.equal(result.applied, 0);
    assert.equal(result.alreadyApplied, migrationFiles.length);
  });

  it("detects a changed checksum and refuses to continue", async () => {
    // Create a scratch migrations directory with a tampered migration.
    const scratchDir = path.join(here, "..", "test-results", `migration-drift-${randomUUID().slice(0, 8)}`);
    await mkdir(scratchDir, { recursive: true });
    try {
      // Copy the real migrations, then alter the last one's content.
      const files = (await import("node:fs/promises")).readdir
        ? await (await import("node:fs/promises")).readdir(REAL_MIGRATIONS_DIR)
        : [];
      const sqlFiles = files.filter((f) => f.endsWith(".sql")).sort();
      for (const file of sqlFiles) {
        const sql = await readFile(path.join(REAL_MIGRATIONS_DIR, file), "utf8");
        await writeFile(path.join(scratchDir, file), sql, "utf8");
      }
      // Tamper with the first migration so its checksum no longer matches
      // the recorded one.
      const first = sqlFiles[0];
      const original = await readFile(path.join(scratchDir, first), "utf8");
      await writeFile(path.join(scratchDir, first), original + "\n-- tampered\n", "utf8");

      await assert.rejects(
        () => runMigrations({ pool, migrationsDir: scratchDir, logger: silentLogger }),
        (error) => error.code === "MIGRATION_CHECKSUM_MISMATCH",
      );
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it("rolls back a failed migration and records nothing", async () => {
    const scratchDir = path.join(here, "..", "test-results", `migration-fail-${randomUUID().slice(0, 8)}`);
    await mkdir(scratchDir, { recursive: true });
    try {
      // A migration that deliberately fails.
      await writeFile(
        path.join(scratchDir, "999_deliberate_failure.sql"),
        "BEGIN;\nCREATE TABLE this_will_fail (id integer PRIMARY KEY);\nINSERT INTO nonexistent_table VALUES (1);\nCOMMIT;\n",
        "utf8",
      );

      const before = await getAppliedMigrations(pool);
      await assert.rejects(
        () => runMigrations({ pool, migrationsDir: scratchDir, logger: silentLogger }),
        (error) => error.code === "MIGRATION_FAILED" || error.failedFile === "999_deliberate_failure.sql",
      );
      const after = await getAppliedMigrations(pool);
      // The failed migration was not recorded.
      assert.equal(after.size, before.size);
      assert.ok(!after.has(999));
      // The table created inside the failed transaction was rolled back.
      const tableCheck = await pool.query(
        "SELECT count(*) AS c FROM information_schema.tables WHERE table_name = 'this_will_fail'",
      );
      assert.equal(Number(tableCheck.rows[0].c), 0);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it("refuses concurrent migration attempts", async () => {
    // Hold the advisory lock manually, then confirm the runner refuses.
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(724191312)");
      await assert.rejects(
        () => runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger }),
        (error) => error.code === "MIGRATION_LOCK_BUSY",
      );
    } finally {
      await client.query("SELECT pg_advisory_unlock(724191312)");
      client.release();
    }
  });

  it("verifies the schema is current after applying", async () => {
    const status = await verifyMigrationsCurrent({ pool, migrationsDir: REAL_MIGRATIONS_DIR });
    assert.equal(status.current, true);
  });

  it("detects pending migrations in verification", async () => {
    // Create a scratch database with no migrations applied.
    const pendingName = await createScratchDatabase();
    const pendingPool = scratchPool(pendingName);
    try {
      const status = await verifyMigrationsCurrent({ pool: pendingPool, migrationsDir: REAL_MIGRATIONS_DIR });
      assert.equal(status.current, false);
      assert.ok(status.pending);
    } finally {
      await pendingPool.end();
      await dropScratchDatabase(pendingName);
    }
  });

  it("creates the migrations history table when absent", async () => {
    const freshName = await createScratchDatabase();
    const freshPool = scratchPool(freshName);
    try {
      await ensureMigrationsTable(freshPool);
      const exists = await freshPool.query(
        "SELECT count(*) AS c FROM information_schema.tables WHERE table_name = 'schema_migrations'",
      );
      assert.equal(Number(exists.rows[0].c), 1);
    } finally {
      await freshPool.end();
      await dropScratchDatabase(freshName);
    }
  });
});

const silentLogger = { info() {}, warn() {}, error() {} };
