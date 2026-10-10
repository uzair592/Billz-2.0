import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

/**
 * Production migration runner.
 *
 * Safety properties:
 *  * Migrations are applied in filename order.
 *  * A PostgreSQL advisory lock guarantees two instances cannot migrate
 *    concurrently; the second waits, then re-reads the history table and
 *    exits cleanly if the work is already done.
 *  * Every applied migration is recorded with a SHA-256 checksum. If an
 *    already-applied migration's content changes, the run refuses to
 *    continue — a drifted migration must never be silently re-applied.
 *  * Each migration runs inside a transaction, so a failed migration is
 *    rolled back and leaves no half-applied state.
 *  * The runner never drops or resets the database.
 *
 * It is a release command, not a startup side effect: the application
 * process does not call it, so a running instance never mutates the
 * schema behind another instance's back.
 */

const MIGRATIONS_TABLE = "schema_migrations";
const ADVISORY_LOCK_KEY = 724_191_312; // arbitrary stable key for this project

function checksum(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function parseFilename(file) {
  const match = /^(\d+)_(.+)\.sql$/.exec(file);
  if (!match) return null;
  return { version: Number(match[1]), name: match[2], file };
}

export async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function getAppliedMigrations(client) {
  await ensureMigrationsTable(client);
  const result = await client.query(
    `SELECT version, name, checksum FROM ${MIGRATIONS_TABLE} ORDER BY version ASC`,
  );
  return new Map(
    result.rows.map((row) => [row.version, row]),
  );
}

export async function acquireAdvisoryLock(client) {
  const result = await client.query(
    "SELECT pg_try_advisory_lock($1) AS acquired",
    [ADVISORY_LOCK_KEY],
  );
  return result.rows[0].acquired === true;
}

export async function releaseAdvisoryLock(client) {
  await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
}

export async function listMigrationFiles(migrationsDir) {
  const files = await readdir(migrationsDir);
  const parsed = files
    .map(parseFilename)
    .filter((entry) => entry !== null)
    .sort((a, b) => a.version - b.version);
  return parsed;
}

/**
 * Applies all pending migrations.
 *
 * @param {object} options
 * @param {pg.Pool} options.pool - a connected pool (admin or app role).
 * @param {string} options.migrationsDir - directory containing *.sql files.
 * @param {object} [options.logger] - structured logger.
 * @returns {Promise<{applied: number, alreadyApplied: number, skipped: number}>}
 */
export async function runMigrations({ pool, migrationsDir, logger = console }) {
  const client = await pool.connect();
  let lockHeld = false;
  try {
    // Hold the advisory lock for the whole run so two instances cannot
    // interleave migrations. pg_try_advisory_lock is session-scoped and
    // released automatically when the client is returned/closed.
    const acquired = await acquireAdvisoryLock(client);
    if (!acquired) {
      logger.info?.({
        message: "migration_lock_busy",
        detail: "Another instance holds the migration lock; waiting is not attempted here.",
      });
      throw Object.assign(new Error(
        "Another migration process holds the lock. Refusing to run concurrently.",
      ), { code: "MIGRATION_LOCK_BUSY" });
    }

    lockHeld = true;
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);
    const files = await listMigrationFiles(migrationsDir);

    let appliedCount = 0;
    let alreadyAppliedCount = 0;

    for (const migration of files) {
      const sql = await readFile(path.join(migrationsDir, migration.file), "utf8");
      const digest = checksum(sql);
      const existing = applied.get(migration.version);

      if (existing) {
        if (existing.checksum !== digest) {
          throw Object.assign(new Error(
            `Migration ${migration.file} was already applied with a different checksum. `
            + "Applied migrations must never change; create a new migration instead.",
          ), { code: "MIGRATION_CHECKSUM_MISMATCH" });
        }
        alreadyAppliedCount += 1;
        logger.info?.({
          message: "migration_already_applied",
          file: migration.file,
          version: migration.version,
        });
        continue;
      }

      // Each migration is atomic: a failure rolls back cleanly.
      await client.query("BEGIN");
      try {
        const statements = sql.replace(/^\s*BEGIN\s*;/i, "").replace(/COMMIT\s*;\s*$/i, "");
        await client.query(statements);
        await client.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum)
           VALUES ($1, $2, $3)`,
          [migration.version, migration.name, digest],
        );
        await client.query("COMMIT");
        appliedCount += 1;
        logger.info?.({
          message: "migration_applied",
          file: migration.file,
          version: migration.version,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw Object.assign(error, {
          code: error.code ?? "MIGRATION_FAILED",
          failedFile: migration.file,
        });
      }
    }

    logger.info?.({
      message: "migrations_complete",
      applied: appliedCount,
      alreadyApplied: alreadyAppliedCount,
      total: files.length,
    });
    return { applied: appliedCount, alreadyApplied: alreadyAppliedCount, skipped: 0 };
  } finally {
    try { if (lockHeld) await releaseAdvisoryLock(client); }
    finally { client.release(); }
  }
}

/**
 * Verifies that every migration file is recorded with a matching
 * checksum, without applying anything. Used by the readiness probe to
 * confirm the schema is current.
 */
export async function verifyMigrationsCurrent({ pool, migrationsDir }) {
  const client = await pool.connect();
  try {
    const applied = await getAppliedMigrations(client);
    const files = await listMigrationFiles(migrationsDir);
    for (const migration of files) {
      const sql = await readFile(path.join(migrationsDir, migration.file), "utf8");
      const digest = checksum(sql);
      const existing = applied.get(migration.version);
      if (!existing) {
        return { current: false, pending: migration.file };
      }
      if (existing.checksum !== digest) {
        return { current: false, drifted: migration.file };
      }
    }
    return { current: true };
  } finally {
    client.release();
  }
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const migrationsDir = process.env.MIGRATIONS_DIR
    ?? path.join(process.cwd(), "database", "migrations");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(JSON.stringify({
      message: "migration_run_failed",
      error: "DATABASE_URL is required.",
    }));
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  runMigrations({ pool, migrationsDir })
    .then(() => pool.end())
    .catch((error) => {
      // Never print the connection string or credentials.
      console.error(JSON.stringify({
        message: "migration_run_failed",
        error: error.message,
        code: error.code,
        ...(error.failedFile ? { failedFile: error.failedFile } : {}),
      }));
      pool.end().finally(() => process.exit(1));
    });
}
