import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backupDatabase,
  restoreDatabase,
  verifyRestoredDatabase,
  redactConnectionUrl,
} from "../src/server/database/backup-restore.mjs";
import {
  connectAdmin,
  scratchDatabaseUrl,
} from "./helpers/postgres.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// The backup/restore tooling shells out to pg_dump, pg_restore, and
// psql. Those client binaries ship with the PostgreSQL installation on
// the CI runners but may be absent on a developer workstation. When
// they are missing the tests are skipped rather than failing, so the
// suite stays green locally while still exercising the real tools in
// CI.
function hasPostgresClientTools() {
  for (const tool of ["pg_dump", "pg_restore", "psql"]) {
    const probe = spawnSync(tool, ["--version"], { stdio: "ignore" });
    if (probe.error) return false;
  }
  return true;
}

const clientToolsAvailable = hasPostgresClientTools();

async function createScratchDatabase() {
  const admin = await connectAdmin();
  const name = `backup_test_${randomUUID().replace(/-/g, "_").slice(0, 24)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return name;
}

async function dropScratchDatabase(name) {
  const admin = await connectAdmin();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
}

function sourceUrl(databaseName) {
  return scratchDatabaseUrl(databaseName);
}

function targetUrl(databaseName) {
  return scratchDatabaseUrl(databaseName);
}

// A capturing logger that records every structured entry so the
// tests can assert that credentials never appear in any output.
function capturingLogger() {
  const entries = [];
  return {
    entries,
    info(entry) { entries.push(JSON.stringify(entry)); },
    error(entry) { entries.push(JSON.stringify(entry)); },
    warn(entry) { entries.push(JSON.stringify(entry)); },
  };
}

describe("backup and restore", () => {
  let sourceName;
  let targetName;
  let backupDir;

  before(async () => {
    if (!clientToolsAvailable) return;
    sourceName = await createScratchDatabase();
    targetName = await createScratchDatabase();
    backupDir = path.join(here, "..", "test-results", `backups-${randomUUID().slice(0, 8)}`);
    // Seed the source with the real migrations so the backup has
    // content to restore.
    const { runMigrations } = await import("../src/server/database/migration-runner.mjs");
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: sourceUrl(sourceName), max: 2 });
    const realDir = path.join(here, "..", "database", "migrations");
    await runMigrations({ pool, migrationsDir: realDir, logger: { info() {} } });
    await pool.end();
  });

  after(async () => {
    if (!clientToolsAvailable) return;
    await dropScratchDatabase(sourceName);
    await dropScratchDatabase(targetName);
  });

  it("creates a timestamped custom-format backup", { skip: !clientToolsAvailable }, async () => {
    const { backupPath, sizeBytes } = await backupDatabase({
      databaseUrl: sourceUrl(sourceName),
      backupDir,
      logger: { info() {} },
    });
    assert.ok(backupPath.endsWith(".dump"));
    assert.ok(backupPath.includes("backup-"));
    assert.ok(sizeBytes > 0);
    await stat(backupPath);
  });

  it("restores into a separately specified target database and verifies the target", { skip: !clientToolsAvailable }, async () => {
    const { backupPath } = await backupDatabase({
      databaseUrl: sourceUrl(sourceName),
      backupDir,
      logger: { info() {} },
    });

    const logger = capturingLogger();
    const result = await restoreDatabase({
      databaseUrl: sourceUrl(sourceName),
      targetDatabaseUrl: targetUrl(targetName),
      backupPath,
      logger,
    });

    // Verification queried the target and found the restored schema.
    assert.equal(result.verification.ok, true);
    assert.ok(result.verification.tableCount > 0);
    // The result and every log entry are credential-free.
    const serialized = JSON.stringify(result) + logger.entries.join("\n");
    assert.ok(!serialized.includes("validation-only"), "password must not appear");
    assert.ok(!serialized.includes("postgres:validation-only"), "credentialed URL must not appear");
  });

  it("refuses a missing target connection URL", { skip: !clientToolsAvailable }, async () => {
    const { backupPath } = await backupDatabase({
      databaseUrl: sourceUrl(sourceName),
      backupDir,
      logger: { info() {} },
    });

    await assert.rejects(
      () => restoreDatabase({
        databaseUrl: sourceUrl(sourceName),
        targetDatabaseUrl: "",
        backupPath,
        logger: { info() {} },
      }),
      (error) => error.code === "CONFIGURATION_INVALID",
    );
  });

  it("refuses a bare database name as the target", { skip: !clientToolsAvailable }, async () => {
    const { backupPath } = await backupDatabase({
      databaseUrl: sourceUrl(sourceName),
      backupDir,
      logger: { info() {} },
    });

    await assert.rejects(
      () => restoreDatabase({
        databaseUrl: sourceUrl(sourceName),
        targetDatabaseUrl: targetName,
        backupPath,
        logger: { info() {} },
      }),
      (error) => error.code === "CONFIGURATION_INVALID" && /postgresql/.test(error.message),
    );
  });

  it("refuses to restore a database onto itself", { skip: !clientToolsAvailable }, async () => {
    const { backupPath } = await backupDatabase({
      databaseUrl: sourceUrl(sourceName),
      backupDir,
      logger: { info() {} },
    });

    await assert.rejects(
      () => restoreDatabase({
        databaseUrl: sourceUrl(sourceName),
        targetDatabaseUrl: sourceUrl(sourceName),
        backupPath,
        logger: { info() {} },
      }),
      (error) => error.code === "SOURCE_EQUALS_TARGET",
    );
  });

  it("refuses a source and target that differ only in credentials", { skip: !clientToolsAvailable }, async () => {
    const { backupPath } = await backupDatabase({
      databaseUrl: sourceUrl(sourceName),
      backupDir,
      logger: { info() {} },
    });

    // Same host, port, and database, but a different password.
    const sameDatabaseDifferentPassword = sourceUrl(sourceName).replace(
      "validation-only",
      "different-password",
    );

    await assert.rejects(
      () => restoreDatabase({
        databaseUrl: sourceUrl(sourceName),
        targetDatabaseUrl: sameDatabaseDifferentPassword,
        backupPath,
        logger: { info() {} },
      }),
      (error) => error.code === "SOURCE_EQUALS_TARGET",
    );
  });

  it("refuses a missing backup path", { skip: !clientToolsAvailable }, async () => {
    await assert.rejects(
      () => restoreDatabase({
        databaseUrl: sourceUrl(sourceName),
        targetDatabaseUrl: targetUrl(targetName),
        backupPath: "",
        logger: { info() {} },
      }),
      (error) => error.code === "CONFIGURATION_INVALID",
    );
  });

  it("refuses a backup path that does not exist", { skip: !clientToolsAvailable }, async () => {
    await assert.rejects(
      () => restoreDatabase({
        databaseUrl: sourceUrl(sourceName),
        targetDatabaseUrl: targetUrl(targetName),
        backupPath: path.join(backupDir, "does-not-exist.dump"),
        logger: { info() {} },
      }),
      (error) => error.code === "BACKUP_NOT_FOUND",
    );
  });

  it("verification fails when the target has no application schema", { skip: !clientToolsAvailable }, async () => {
    // Create an empty scratch database with no tables.
    const emptyName = await createScratchDatabase();
    try {
      await assert.rejects(
        () => verifyRestoredDatabase({
          databaseUrl: targetUrl(emptyName),
          logger: { info() {} },
        }),
        (error) => error.code === "RESTORE_VERIFICATION_FAILED",
      );
    } finally {
      await dropScratchDatabase(emptyName);
    }
  });

  it("redacts credentials from a connection URL", () => {
    const redacted = redactConnectionUrl(
      "postgresql://postgres:validation-only@127.0.0.1:55432/restaurant_pos_test",
    );
    assert.ok(!redacted.includes("validation-only"));
    assert.ok(!redacted.includes("postgres:"));
    assert.ok(redacted.includes("127.0.0.1:55432"));
    assert.ok(redacted.includes("restaurant_pos_test"));
  });

  it("redacts credentials from a tool failure message", { skip: !clientToolsAvailable }, async () => {
    // Force a pg_restore failure against an unreachable target and
    // confirm the resulting error message carries no credentials.
    const { backupPath } = await backupDatabase({
      databaseUrl: sourceUrl(sourceName),
      backupDir,
      logger: { info() {} },
    });
    const unreachableTarget = "postgresql://postgres:validation-only@127.0.0.1:59999/nonexistent";
    let message = "";
    try {
      await restoreDatabase({
        databaseUrl: sourceUrl(sourceName),
        targetDatabaseUrl: unreachableTarget,
        backupPath,
        logger: { info() {} },
      });
    } catch (error) {
      message = error.message;
    }
    assert.ok(message.length > 0, "a failure message was expected");
    assert.ok(!message.includes("validation-only"), "password must not appear in the error");
    assert.ok(!message.includes("postgres:validation-only"), "credentialed URL must not appear");
  });
});
