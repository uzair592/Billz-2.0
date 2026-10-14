import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

export const BACKUP_TABLES = Object.freeze([
  "schema_migrations", "restaurants", "users", "restaurant_memberships", "plans", "subscriptions",
  "menu_items", "orders", "order_items", "order_payments", "financial_accounts", "expenses",
  "business_settings", "menu_categories", "tenant_catalogs", "inventory_items", "stock_movements", "inventory_movements",
  "suppliers", "purchases", "purchase_items", "platform_administrators", "audit_logs", "manual_payments",
]);

export function connectionEnvironment(databaseUrl) {
  let url;
  try { url = new URL(databaseUrl); } catch { throw new Error("A full PostgreSQL connection URL is required."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2)
    throw new Error("A full PostgreSQL connection URL is required.");
  if (url.searchParams.has("password")) throw new Error("Supply the PostgreSQL password in userinfo, not URL query options.");
  const secret = decodeURIComponent(url.password);
  url.password = "";
  // Keep libpq URL options (including TLS) intact, but never put the password in argv or diagnostics.
  return { ...process.env, PGDATABASE: url.href, PGPASSWORD: secret };
}

export function postgresToolInvocation(args, databaseUrl) {
  const env = connectionEnvironment(databaseUrl);
  // libpq does not expand a connection URI supplied only as an environment
  // default. Pass it explicitly so host/port/TLS select the intended server.
  return { args: ["--dbname", env.PGDATABASE, ...args], env };
}

async function runTool(tool, args, databaseUrl) {
  const invocation = postgresToolInvocation(args, databaseUrl);
  await new Promise((resolve, reject) => {
    const child = spawn(tool, invocation.args, { env: invocation.env, stdio: ["ignore", "ignore", "ignore"] });
    child.on("error", () => reject(new Error(`${tool} could not start. Install PostgreSQL client tools matching the server major version.`)));
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`${tool} failed (exit ${code}). Check client version, database privileges, TLS and disk space; tool output is withheld to protect credentials.`)));
  });
}

async function counts(client) {
  const result = {};
  for (const table of BACKUP_TABLES) result[table] = (await client.query(`SELECT count(*)::text AS count FROM public.${table}`)).rows[0].count;
  return result;
}

export function compareBackupCounts(expected, restored) {
  const mismatches = BACKUP_TABLES.filter(table => !/^\d+$/.test(expected[table]) || !/^\d+$/.test(restored[table]) || expected[table] !== restored[table]);
  if (mismatches.length) throw new Error(`Backup row-count mismatch in: ${mismatches.join(", ")}.`);
  return true;
}

export async function verifyBackup({ databaseUrl, scratchAdminUrl, backupDir }) {
  connectionEnvironment(databaseUrl); connectionEnvironment(scratchAdminUrl);
  if (!backupDir) throw new Error("BACKUP_DIR is required.");
  const databaseName = `billz_verify_${randomUUID().replaceAll("-", "")}`;
  const source = new pg.Client({ connectionString: databaseUrl });
  const admin = new pg.Client({ connectionString: scratchAdminUrl });
  const targetUrl = new URL(scratchAdminUrl); targetUrl.pathname = `/${databaseName}`;
  const restored = new pg.Client({ connectionString: targetUrl.href });
  let created = false, transaction = false;
  const backupPath = path.resolve(backupDir, `${databaseName}.dump`);
  try {
    await source.connect(); await admin.connect();
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); transaction = true;
    // An unsafe tenant-filtered backup fails rather than silently omitting other restaurants.
    await source.query("SET LOCAL row_security=off");
    const snapshot = (await source.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
    const expected = await counts(source);
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    const file = await open(backupPath, "wx", 0o600); await file.close();
    await runTool("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--snapshot", snapshot, "--file", backupPath], databaseUrl);
    await source.query("COMMIT"); transaction = false;
    // Only this newly generated scratch database is ever restored or dropped.
    await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`); created = true;
    await runTool("pg_restore", ["--exit-on-error", "--no-owner", "--no-privileges", backupPath], targetUrl.href);
    await restored.connect(); await restored.query("SET row_security=off");
    const actual = await counts(restored);
    compareBackupCounts(expected, actual);
    return { ok: true, backupPath, sizeBytes: (await stat(backupPath)).size, tables: expected };
  } finally {
    if (transaction) await source.query("ROLLBACK").catch(() => {});
    await restored.end().catch(() => {});
    try {
      if (created) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } finally {
      await source.end().catch(() => {}); await admin.end().catch(() => {});
    }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  verifyBackup({ databaseUrl: process.env.BACKUP_DATABASE_URL, scratchAdminUrl: process.env.BACKUP_SCRATCH_ADMIN_URL, backupDir: process.env.BACKUP_DIR })
    .then(result => console.log(JSON.stringify({ message: "backup_verified", ...result })))
    .catch(() => {
      // Driver errors can include user names, addresses or connection options. Do not print them.
      console.error("Backup verification failed. Check BACKUP_DATABASE_URL, BACKUP_SCRATCH_ADMIN_URL, BACKUP_DIR, privileges and matching PostgreSQL client tools.");
      process.exitCode = 1;
    });
}
