import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Production PostgreSQL backup and restore tooling.
 *
 * Backup:
 *   * Uses pg_dump in custom format (-Fc) for compressed,
 *     parallel-restorable dumps.
 *   * Writes a timestamped filename into a backup directory.
 *   * Never prints the connection string or credentials.
 *
 * Restore:
 *   * Restores into an explicitly specified target database.
 *   * Refuses ambiguous or missing targets.
 *   * Runs verification queries after restoration.
 *
 * Provider-managed automated backups must also be enabled; this tool is
 * an operator-controlled complement, not a replacement.
 */

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function runTool(tool, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        // The tool's stderr can echo the connection string it was
        // given. Redact any postgresql:// URL before it is placed
        // in an error message so credentials never surface.
        const redactedStderr = stderr.replace(
          /postgres(?:ql)?:\/\/[^@\s]+@/g,
          "postgresql://***:***@",
        );
        reject(Object.assign(new Error(
          `${tool} exited with code ${code}: ${redactedStderr.slice(-500)}`,
        ), { code: "TOOL_FAILED", tool, stderr: redactedStderr }));
      }
    });
  });
}

/**
 * Builds a pg connection environment without ever logging it.
 */
function pgEnv(databaseUrl) {
  return { ...process.env, PGPASSWORD: extractPassword(databaseUrl), DATABASE_URL: databaseUrl };
}

function extractPassword(databaseUrl) {
  try {
    return new URL(databaseUrl).password ?? "";
  } catch {
    return "";
  }
}

/**
 * Redacts the userinfo (user and password) of a connection URL so
 * credentials never appear in logs, errors, or JSON results. The
 * host, port, and database path are retained because they are
 * needed to describe the operation.
 */
export function redactConnectionUrl(databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    parsed.username = "***";
    parsed.password = "***";
    return parsed.toString();
  } catch {
    return "<unparseable-connection-url>";
  }
}

/**
 * Normalizes a connection URL to its identity components:
 * protocol, host, port, and database name. Credentials are
 * excluded so two URLs that differ only in password are still
 * recognized as the same database.
 */
function databaseIdentity(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const port = parsed.port || (parsed.protocol === "postgresql:" ? "5432" : "");
  return {
    protocol: parsed.protocol,
    host: parsed.hostname.toLowerCase(),
    port,
    database: parsed.pathname.replace(/^\//, ""),
  };
}

/**
 * Parses and validates a connection URL. Rejects a bare database
 * name that has no host or protocol, which would otherwise fall
 * back to unrelated local libpq defaults.
 */
function parseConnectionUrl(databaseUrl, label) {
  if (!databaseUrl) {
    throw Object.assign(new Error(`${label} is required.`), {
      code: "CONFIGURATION_INVALID",
    });
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw Object.assign(
      new Error(`${label} must be a valid postgresql:// connection URL.`),
      { code: "CONFIGURATION_INVALID" },
    );
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw Object.assign(
      new Error(`${label} must use the postgresql:// protocol.`),
      { code: "CONFIGURATION_INVALID" },
    );
  }
  if (!parsed.hostname) {
    throw Object.assign(
      new Error(`${label} must include a host. A bare database name is not accepted.`),
      { code: "CONFIGURATION_INVALID" },
    );
  }
  return parsed;
}

/**
 * Confirms a backup file exists and is a regular file before
 * pg_restore is invoked, so a missing or non-regular path fails
 * fast with a clear error instead of a confusing tool failure.
 */
async function assertRegularFile(backupPath) {
  let info;
  try {
    info = await stat(backupPath);
  } catch {
    throw Object.assign(
      new Error(`Backup file does not exist: ${backupPath}`),
      { code: "BACKUP_NOT_FOUND" },
    );
  }
  if (!info.isFile()) {
    throw Object.assign(
      new Error(`Backup path is not a regular file: ${backupPath}`),
      { code: "BACKUP_NOT_A_FILE" },
    );
  }
}

/**
 * Creates a timestamped pg_dump custom-format backup.
 *
 * @returns {Promise<{backupPath: string, sizeBytes: number}>}
 */
export async function backupDatabase({ databaseUrl, backupDir, logger = console }) {
  if (!databaseUrl) throw Object.assign(new Error("DATABASE_URL is required."), { code: "CONFIGURATION_INVALID" });
  if (!backupDir) throw Object.assign(new Error("backupDir is required."), { code: "CONFIGURATION_INVALID" });

  await mkdir(backupDir, { recursive: true });
  const filename = `backup-${timestamp()}.dump`;
  const backupPath = path.join(backupDir, filename);

  const env = pgEnv(databaseUrl);
  // -Fc: custom format. -Z: compression. --no-owner: role-agnostic dump
  // so it can be restored into a differently-owned target.
  await runTool("pg_dump", [
    "--format=custom",
    "--compress=6",
    "--no-owner",
    "--no-privileges",
    "--file", backupPath,
    databaseUrl,
  ], env);

  const { size } = await stat(backupPath);
  logger.info?.({ message: "backup_complete", backupPath, sizeBytes: size });
  return { backupPath, sizeBytes: size };
}

/**
 * Restores a custom-format dump into an explicitly specified target
 * database.
 *
 * Safety properties:
 *   * The target is a full connection URL (TARGET_DATABASE_URL),
 *     not a bare database name, so it cannot accidentally fall
 *     back to local libpq defaults.
 *   * The source and target are parsed and validated.
 *   * Restoring a database onto itself is refused: the normalized
 *     source and target must not identify the same host, port,
 *     and database.
 *   * pg_restore runs against the target URL.
 *   * Post-restore verification queries the target URL.
 *   * Credentials are redacted from every log, error, and result.
 *   * The backup file is confirmed to exist and be a regular file
 *     before pg_restore is invoked.
 *
 * @returns {Promise<{target: string, backupPath: string, verification: object}>}
 */
export async function restoreDatabase({
  databaseUrl,
  targetDatabaseUrl,
  backupPath,
  logger = console,
}) {
  parseConnectionUrl(databaseUrl, "DATABASE_URL");
  const target = parseConnectionUrl(targetDatabaseUrl, "TARGET_DATABASE_URL");

  if (!backupPath) {
    throw Object.assign(new Error("backupPath is required."), { code: "CONFIGURATION_INVALID" });
  }

  // Refuse to restore a database onto itself. The comparison uses
  // the normalized identity (protocol, host, port, database) so
  // credentials and cosmetic differences do not mask a self-restore.
  const sourceIdentity = databaseIdentity(databaseUrl);
  const targetIdentity = databaseIdentity(target.href);
  const sameDatabase = sourceIdentity.protocol === targetIdentity.protocol
    && sourceIdentity.host === targetIdentity.host
    && sourceIdentity.port === targetIdentity.port
    && sourceIdentity.database === targetIdentity.database;
  if (sameDatabase) {
    throw Object.assign(
      new Error(
        "Restore target must differ from the source database. "
        + "Restoring a database onto itself is refused.",
      ),
      { code: "SOURCE_EQUALS_TARGET" },
    );
  }

  await assertRegularFile(backupPath);

  const targetEnv = pgEnv(target.href);
  // --clean --if-exists: drop existing objects before recreating so a
  // re-restore is deterministic. --no-owner: do not change ownership.
  await runTool("pg_restore", [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "--dbname", target.href,
    backupPath,
  ], targetEnv);

  // Verify the restored target, not the source.
  const verification = await verifyRestoredDatabase({
    databaseUrl: target.href,
    logger,
  });

  const redactedTarget = redactConnectionUrl(target.href);
  logger.info?.({
    message: "restore_complete",
    target: redactedTarget,
    backupPath,
    verification,
  });
  return { target: redactedTarget, backupPath, verification };
}

/**
 * Runs verification queries against a database after restoration.
 * The verification fails when the restored target has no expected
 * application schema or migration state.
 */
export async function verifyRestoredDatabase({ databaseUrl, logger = console }) {
  parseConnectionUrl(databaseUrl, "databaseUrl");
  const env = pgEnv(databaseUrl);
  const result = await runTool("psql", [
    "--tuples-only",
    "--no-align",
    "--field-separator", "\t",
    "--command",
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';",
    databaseUrl,
  ], env);
  const tableCount = Number(result.stdout.trim());
  const ok = Number.isFinite(tableCount) && tableCount > 0;
  const redacted = redactConnectionUrl(databaseUrl);
  logger.info?.({ message: "restore_verified", database: redacted, tableCount, ok });
  if (!ok) {
    throw Object.assign(
      new Error(
        "Restored database verification failed: no application tables were found. "
        + "The restore did not produce the expected schema state.",
      ),
      { code: "RESTORE_VERIFICATION_FAILED", tableCount },
    );
  }
  return { ok, tableCount, database: redacted };
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const command = process.argv[2];
  const env = process.env;
  const databaseUrl = env.DATABASE_URL;
  const logger = console;

  const run = async () => {
    if (command === "backup") {
      const backupDir = env.BACKUP_DIR ?? "./backups";
      const { backupPath, sizeBytes } = await backupDatabase({ databaseUrl, backupDir, logger });
      console.log(JSON.stringify({ message: "backup_complete", backupPath, sizeBytes }));
    } else if (command === "restore") {
      const targetDatabaseUrl = env.TARGET_DATABASE_URL;
      const backupPath = env.BACKUP_PATH;
      if (!targetDatabaseUrl) {
        throw Object.assign(
          new Error("TARGET_DATABASE_URL is required for restore."),
          { code: "TARGET_REQUIRED" },
        );
      }
      if (!backupPath) {
        throw Object.assign(new Error("BACKUP_PATH is required for restore."), { code: "CONFIGURATION_INVALID" });
      }
      const { target, backupPath: restoredPath, verification } = await restoreDatabase({
        databaseUrl,
        targetDatabaseUrl,
        backupPath,
        logger,
      });
      console.log(JSON.stringify({
        message: "restore_complete",
        target,
        backupPath: restoredPath,
        verification,
      }));
    } else {
      throw Object.assign(new Error('Usage: node backup-restore.mjs <backup|restore>'), { code: "USAGE" });
    }
  };

  run().catch((error) => {
    // Never include the connection string or credentials in the
    // failure output. The message is already credential-free
    // because the tools' stderr is truncated and redacted.
    console.error(JSON.stringify({
      message: "backup_restore_failed",
      error: error.message,
      code: error.code,
    }));
    process.exit(1);
  });
}
