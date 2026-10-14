import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createDatabasePool } from "../../src/server/database/pool.mjs";
import { verifyMigrationsCurrent } from "../../src/server/database/migration-runner.mjs";

const CONTROL_TABLES = new Set([
  "users", "sessions", "email_verification_tokens", "password_reset_tokens",
  "restaurants", "branches", "restaurant_memberships", "plans", "plan_prices",
  "subscriptions", "billing_customers", "billing_payments", "webhook_events",
  "provider_tenant_routes", "checkout_attempts", "audit_logs", "login_attempts",
  "platform_administrators", "platform_admin_sessions", "manual_payments",
  "tenant_storage_allowances", "managed_file_assets", "business_settings",
  "receipt_settings", "financial_accounts",
]);
const PUBLIC_READ_TABLES = new Set(["plans", "plan_prices", "schema_migrations"]);
const identifier = value => '"' + value.replaceAll('"', '""') + '"';

function configuration(env) {
  const roles = [env.APP_DATABASE_ROLE || "billz_pos", env.CONTROL_DATABASE_ROLE || "billz_control"];
  const passwords = [env.APP_DATABASE_PASSWORD, env.CONTROL_DATABASE_PASSWORD];
  if (roles.some(role => !/^[a-z_][a-z0-9_]{0,62}$/.test(role)) || roles[0] === roles[1]) {
    throw new Error("Set distinct APP_DATABASE_ROLE and CONTROL_DATABASE_ROLE names (lowercase SQL identifiers).");
  }
  if (passwords.some(password => !/^[!-~]{32,200}$/.test(password || ""))) {
    throw new Error("Set APP_DATABASE_PASSWORD and CONTROL_DATABASE_PASSWORD to 32–200 printable ASCII characters without spaces.");
  }
  return roles.map((name, i) => ({ name, password: passwords[i], bypass: i === 1 }));
}

export function scramVerifier(password) {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

// Mirrors the test helper's metadata-based grants, but excludes control-only
// authentication tables and gives the POS read-only access to global catalogs.
export async function grantRuntimePrivileges(client, { appRole, controlRole }) {
  const tables = (await client.query(`SELECT relname, relrowsecurity FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') ORDER BY relname`)).rows;
  const database = (await client.query("SELECT current_database() AS name")).rows[0].name;
  await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  for (const role of [appRole, controlRole]) {
    const quoted = identifier(role);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${quoted}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${quoted}`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${quoted}`);
    await client.query(`REVOKE ALL ON SCHEMA public FROM ${quoted}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${quoted}`);
    await client.query(`GRANT CONNECT ON DATABASE ${identifier(database)} TO ${quoted}`);
    await client.query(`GRANT EXECUTE ON FUNCTION current_restaurant_id(), current_user_id() TO ${quoted}`);
  }
  for (const table of tables) {
    const target = `public.${identifier(table.relname)}`;
    if (table.relrowsecurity && table.relname !== "login_attempts") {
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${target} TO ${identifier(appRole)}`);
    } else if (PUBLIC_READ_TABLES.has(table.relname)) {
      await client.query(`GRANT SELECT ON ${target} TO ${identifier(appRole)}`);
    } else if (table.relname === "provider_tenant_routes") {
      // Existing checkout code publishes opaque provider references, not secrets.
      await client.query(`GRANT SELECT, INSERT, UPDATE ON ${target} TO ${identifier(appRole)}`);
    }
    if (CONTROL_TABLES.has(table.relname)) {
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${target} TO ${identifier(controlRole)}`);
    } else if (table.relname === "schema_migrations") {
      await client.query(`GRANT SELECT ON ${target} TO ${identifier(controlRole)}`);
    }
  }
  const sequences = (await client.query(`SELECT DISTINCT s.relname, t.relname AS table_name
    FROM pg_class s JOIN pg_depend d ON d.objid=s.oid AND d.classid='pg_class'::regclass
      AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
    JOIN pg_class t ON t.oid=d.refobjid
    WHERE s.relnamespace='public'::regnamespace AND s.relkind='S'`)).rows;
  for (const sequence of sequences) {
    for (const role of [appRole, controlRole]) {
      const table = tables.find(table => table.relname === sequence.table_name);
      const allowed = role === appRole
        ? table?.relrowsecurity && table.relname !== "login_attempts"
        : CONTROL_TABLES.has(sequence.table_name);
      if (allowed) await client.query(`GRANT USAGE, SELECT ON SEQUENCE public.${identifier(sequence.relname)} TO ${identifier(role)}`);
    }
  }
}

export async function provisionRuntimeRoles({ pool, env = process.env }) {
  const roles = configuration(env);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(724191313)");
    for (const role of roles) {
      const existing = (await client.query(`SELECT r.*, r.rolname IN (current_user,session_user)
        OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid)
        OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid)
        OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid)
        OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid)
        OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid) AS unsafe
        FROM pg_roles r WHERE rolname=$1`, [role.name])).rows[0];
      if (existing?.unsafe) throw new Error("Runtime roles must be dedicated: no object ownership, role memberships or migration-account reuse.");
      if (!existing) await client.query(`CREATE ROLE ${identifier(role.name)}`);
      // Only alter special attributes when necessary, allowing a provider/DBA
      // to pre-create safe roles on a managed database with restricted privileges.
      const flags = [];
      for (const [attribute, enabled, disabled, desired] of [
        ["rolsuper", "SUPERUSER", "NOSUPERUSER", false],
        ["rolcreatedb", "CREATEDB", "NOCREATEDB", false],
        ["rolcreaterole", "CREATEROLE", "NOCREATEROLE", false],
        ["rolreplication", "REPLICATION", "NOREPLICATION", false],
        ["rolbypassrls", "BYPASSRLS", "NOBYPASSRLS", role.bypass],
      ]) if ((existing?.[attribute] ?? false) !== desired) flags.push(desired ? enabled : disabled);
      // SQL contains a SCRAM verifier, never the plaintext environment password.
      const verifier = scramVerifier(role.password);
      await client.query(`ALTER ROLE ${identifier(role.name)} LOGIN NOINHERIT ${flags.join(" ")} PASSWORD '${verifier}'`);
    }
    await grantRuntimePrivileges(client, { appRole: roles[0].name, controlRole: roles[1].name });
    await client.query("COMMIT");
    return { appRole: roles[0].name, controlRole: roles[1].name };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

const direct = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (direct) {
  let pool;
  try {
    if (!process.env.MIGRATION_DATABASE_URL) throw new Error("MIGRATION_DATABASE_URL is required for role provisioning.");
    configuration(process.env);
    pool = createDatabasePool({ ...process.env, DATABASE_URL: process.env.MIGRATION_DATABASE_URL });
    const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
    if (!(await verifyMigrationsCurrent({ pool, migrationsDir })).current) throw new Error("Apply all migrations before provisioning runtime roles.");
    await provisionRuntimeRoles({ pool });
    console.log("Dedicated POS and control roles provisioned; runtime grants refreshed.");
  } catch (error) {
    // PostgreSQL error messages may contain query text; do not echo SQL or env.
    console.error("Runtime role provisioning failed. Check migrations, dedicated role names, password variables and provider permission to manage BYPASSRLS roles.", error.code || "CONFIGURATION_INVALID");
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
