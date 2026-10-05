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
      else reject(Object.assign(new Error(
        `${tool} exited with code ${code}: ${stderr.slice(-500)}`,
      ), { code: "TOOL_FAILED", tool, stderr }));
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
 * database. The target must be provided and must differ from any
 * ambiguous default.
 */
export async function restoreDatabase({ databaseUrl, targetDatabase, backupPath, logger = console }) {
  if (!databaseUrl) throw Object.assign(new Error("DATABASE_URL is required."), { code: "CONFIGURATION_INVALID" });
  if (!targetDatabase) throw Object.assign(new Error(
    "A target database must be specified explicitly. Refusing to restore into an ambiguous target.",
  ), { code: "TARGET_REQUIRED" });
  if (!backupPath) throw Object.assign(new Error("backupPath is required."), { code: "CONFIGURATION_INVALID" });

  const env = pgEnv(databaseUrl);
  // --clean --if-exists: drop existing objects before recreating so a
  // re-restore is deterministic. --no-owner: do not change ownership.
  await runTool("pg_restore", [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "--dbname", targetDatabase,
    backupPath,
  ], env);

  logger.info?.({ message: "restore_complete", targetDatabase, backupPath });
  return { targetDatabase, backupPath };
}

/**
 * Runs verification queries against a database after restoration.
 */
export async function verifyRestoredDatabase({ databaseUrl, logger = console }) {
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
  logger.info?.({ message: "restore_verified", tableCount, ok });
  return { ok, tableCount };
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
      const targetDatabase = env.TARGET_DATABASE;
      const backupPath = env.BACKUP_PATH;
      if (!targetDatabase) {
        throw Object.assign(new Error("TARGET_DATABASE is required for restore."), { code: "TARGET_REQUIRED" });
      }
      if (!backupPath) {
        throw Object.assign(new Error("BACKUP_PATH is required for restore."), { code: "CONFIGURATION_INVALID" });
      }
      await restoreDatabase({ databaseUrl, targetDatabase, backupPath, logger });
      const verification = await verifyRestoredDatabase({ databaseUrl, logger });
      console.log(JSON.stringify({ message: "restore_complete", targetDatabase, verification }));
    } else {
      throw Object.assign(new Error('Usage: node backup-restore.mjs <backup|restore>'), { code: "USAGE" });
    }
  };

  run().catch((error) => {
    console.error(JSON.stringify({
      message: "backup_restore_failed",
      error: error.message,
      code: error.code,
    }));
    process.exit(1);
  });
}
