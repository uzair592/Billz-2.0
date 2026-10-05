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
} from "../src/server/database/backup-restore.mjs";
import {
  connectAdmin,
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

function connectionString(databaseName) {
  return `postgresql://postgres:validation-only@127.0.0.1:55432/${databaseName}`;
}

// pg_dump/pg_restore/psql must be available for these tests.
let toolsAvailable = true;
try {
  // eslint-disable-next-line no-empty
} catch {
  toolsAvailable = false;
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
    const pool = new pg.Pool({ connectionString: connectionString(sourceName), max: 2 });
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
      databaseUrl: connectionString(sourceName),
      backupDir,
      logger: { info() {} },
    });
    assert.ok(backupPath.endsWith(".dump"));
    assert.ok(backupPath.includes("backup-"));
    assert.ok(sizeBytes > 0);
    await stat(backupPath);
  });

  it("restores into a separately specified target database", { skip: !clientToolsAvailable }, async () => {
    const { backupPath } = await backupDatabase({
      databaseUrl: connectionString(sourceName),
      backupDir,
      logger: { info() {} },
    });

    await restoreDatabase({
      databaseUrl: connectionString(targetName),
      targetDatabase: targetName,
      backupPath,
      logger: { info() {} },
    });

    const verification = await verifyRestoredDatabase({
      databaseUrl: connectionString(targetName),
      logger: { info() {} },
    });
    assert.equal(verification.ok, true);
    assert.ok(verification.tableCount > 0);
  });

  it("refuses a missing target database", { skip: !clientToolsAvailable }, async () => {
    const { backupPath } = await backupDatabase({
      databaseUrl: connectionString(sourceName),
      backupDir,
      logger: { info() {} },
    });

    await assert.rejects(
      () => restoreDatabase({
        databaseUrl: connectionString(targetName),
        targetDatabase: "",
        backupPath,
        logger: { info() {} },
      }),
      (error) => error.code === "TARGET_REQUIRED",
    );
  });

  it("refuses a missing backup path", { skip: !clientToolsAvailable }, async () => {
    await assert.rejects(
      () => restoreDatabase({
        databaseUrl: connectionString(targetName),
        targetDatabase: targetName,
        backupPath: "",
        logger: { info() {} },
      }),
      (error) => error.code === "CONFIGURATION_INVALID",
    );
  });
});
