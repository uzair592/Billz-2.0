import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMigrationPool } from "../src/server/database/migration-runner.mjs";
import { loadServerConfiguration } from "../src/server/config/environment.mjs";
import { createServer } from "../src/server/main.mjs";
import { provisionRuntimeRoles, grantRuntimePrivileges } from "../database/ops/create-runtime-roles.mjs";

test("release migrations prefer the migration account and honor TLS settings", async t => {
  const pool = createMigrationPool({ MIGRATION_DATABASE_URL: "postgresql://owner@localhost/db",
    DATABASE_URL: "postgresql://pos@localhost/db", DATABASE_SSL_MODE: "verify-full", DATABASE_SSL_CA: "test-ca" });
  t.after(() => pool.end());
  assert.equal(pool.options.connectionString, "postgresql://owner@localhost/db");
  assert.equal(pool.options.max, 1);
  assert.deepEqual(pool.options.ssl, { rejectUnauthorized: true, ca: "test-ca" });
  assert.throws(() => createMigrationPool({}), /MIGRATION_DATABASE_URL/);
  assert.throws(() => createMigrationPool({ MIGRATION_DATABASE_URL: "postgresql://owner@localhost/db", DATABASE_SSL_MODE: "invalid" }), /DATABASE_SSL_MODE/);
});

test("production logs the unsafe connection and refuses RLS-bypassing POS roles", async () => {
  for (const appRole of [{ rolsuper: true, rolbypassrls: false }, { rolsuper: false, rolbypassrls: true }]) {
    const logs = [];
    await assert.rejects(createServer({
      env: { NODE_ENV: "production", DATABASE_URL: "postgresql://private-user:private-password@localhost/db",
        TRUSTED_ORIGINS: "https://pos.example.com", PASSWORD_PEPPER: "a".repeat(40), SESSION_SECRET: "b".repeat(40), PAYMENT_PROVIDER: "manual" },
      pool: { query: async () => ({ rows: [appRole] }) },
      controlPool: { query: async () => ({ rows: [{ rolsuper: false, rolbypassrls: true }] }) },
      logger: { error: entry => logs.push(entry) },
    }), error => error.code === "UNSAFE_DATABASE_ROLE");
    assert.equal(logs[0].connection, "DATABASE_URL");
    assert.equal(JSON.stringify(logs).includes("private-password"), false);
  }
});

test("proxy diagnostics state the required variables and reject arbitrary-client trust", () => {
  const env = { DATABASE_URL: "postgresql://unused/db", PASSWORD_PEPPER: "a".repeat(40), SESSION_SECRET: "b".repeat(40),
    TRUSTED_ORIGINS: "https://pos.example.com", NODE_ENV: "production", TRUST_PROXY: "true" };
  assert.throws(() => loadServerConfiguration(env), /Set TRUSTED_PROXY_CIDRS.*TRUST_PROXY=false/);
  for (const cidr of ["0.0.0.0/0", "::/0"]) assert.throws(() => loadServerConfiguration({ ...env, TRUSTED_PROXY_CIDRS: cidr }), /must not trust every client/);
});

test("runtime role input is validated before any database mutation", async () => {
  const pool = { connect: async () => { throw new Error("must not connect"); } };
  await assert.rejects(provisionRuntimeRoles({ pool, env: { APP_DATABASE_ROLE: "same", CONTROL_DATABASE_ROLE: "same" } }), /distinct/);
  await assert.rejects(provisionRuntimeRoles({ pool, env: { APP_DATABASE_PASSWORD: "short", CONTROL_DATABASE_PASSWORD: "short" } }), /32–200/);
});

test("runtime grants keep authentication and administrator tables out of the POS role", async () => {
  const calls = [];
  const client = { query: async sql => {
    calls.push(sql);
    if (sql.includes("SELECT relname")) return { rows: [
      { relname: "orders", relrowsecurity: true }, { relname: "login_attempts", relrowsecurity: true },
      { relname: "users", relrowsecurity: false }, { relname: "platform_administrators", relrowsecurity: false },
      { relname: "plans", relrowsecurity: false }, { relname: "schema_migrations", relrowsecurity: false },
    ] };
    if (sql.includes("current_database()")) return { rows: [{ name: "billz" }] };
    return { rows: [] };
  } };
  await grantRuntimePrivileges(client, { appRole: "billz_pos", controlRole: "billz_control" });
  const posGrants = calls.filter(sql => sql.startsWith("GRANT") && sql.endsWith('TO "billz_pos"'));
  assert.ok(posGrants.some(sql => sql.includes('SELECT, INSERT, UPDATE, DELETE ON public."orders"')));
  assert.ok(posGrants.some(sql => sql.includes('GRANT SELECT ON public."plans"')));
  for (const name of ["users", "platform_administrators", "login_attempts"]) {
    assert.equal(posGrants.some(sql => sql.includes(`public."${name}"`)), false);
  }
  assert.equal(posGrants.some(sql => /TRUNCATE|CREATE ON SCHEMA|ALL PRIVILEGES/.test(sql)), false);
});

test("Render wires migrations and grant refresh as an ordered release step", async () => {
  const source = await readFile(new URL("../render.yaml", import.meta.url), "utf8");
  assert.match(source, /preDeployCommand: node src\/server\/database\/migration-runner\.mjs && node database\/ops\/create-runtime-roles\.mjs/);
  assert.match(source, /key: MIGRATION_DATABASE_URL/);
  for (const file of ["DEPLOYMENT.md", "deployment-guide.md", "environment-variables.md", "pilot-launch-checklist.md"]) {
    const old = await readFile(new URL(`../docs/${file}`, import.meta.url), "utf8");
    assert.match(old, /\[DEPLOY_FROM_ZERO\.md\]\(DEPLOY_FROM_ZERO\.md\)/);
  }
});
