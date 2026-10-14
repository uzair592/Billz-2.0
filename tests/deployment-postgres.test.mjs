import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { provisionIntegrationDatabase, connectAdmin, ADMIN_DATABASE_URL } from "./helpers/postgres.mjs";
import { provisionRuntimeRoles } from "../database/ops/create-runtime-roles.mjs";
import { createServer } from "../src/server/main.mjs";
import { createPlatformAdminService } from "../src/server/auth/platform-admin-service.mjs";
import { createPlatformAdminRepository } from "../src/server/auth/platform-admin-repository.mjs";

test("clean deployment provisions safe roles, bootstraps admin and restaurant, and gates readiness", async t => {
  await provisionIntegrationDatabase();
  const owner = await connectAdmin();
  const suffix = randomBytes(6).toString("hex");
  const env = { APP_DATABASE_ROLE: `deploy_pos_${suffix}`, CONTROL_DATABASE_ROLE: `deploy_control_${suffix}`,
    APP_DATABASE_PASSWORD: randomBytes(32).toString("hex"), CONTROL_DATABASE_PASSWORD: randomBytes(32).toString("hex") };
  let appPool, control, server;
  t.after(async () => {
    await server?.close(); await appPool?.end(); await control?.end();
    for (const name of [env.APP_DATABASE_ROLE, env.CONTROL_DATABASE_ROLE]) {
      if (!(await owner.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [name])).rows.length) continue;
      await owner.query(`DROP OWNED BY "${name}"`);
      await owner.query(`DROP ROLE "${name}"`);
    }
    await owner.end();
  });
  await provisionRuntimeRoles({ pool: owner, env });
  await owner.query(`ALTER ROLE "${env.APP_DATABASE_ROLE}" BYPASSRLS`);
  await provisionRuntimeRoles({ pool: owner, env });
  const connect = (role, password) => {
    const url = new URL(ADMIN_DATABASE_URL); url.username = role; url.password = password;
    return new pg.Pool({ connectionString: url.toString() });
  };
  appPool = connect(env.APP_DATABASE_ROLE, env.APP_DATABASE_PASSWORD);
  control = connect(env.CONTROL_DATABASE_ROLE, env.CONTROL_DATABASE_PASSWORD);
  const invalid = connect(env.APP_DATABASE_ROLE, "wrong-runtime-password");
  try { await assert.rejects(invalid.query("SELECT 1"), error => error.code === "28P01"); }
  finally { await invalid.end(); }
  for (const [pool, bypass] of [[appPool, false], [control, true]]) {
    const role = (await pool.query("SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user")).rows[0];
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: bypass, rolcreatedb: false, rolcreaterole: false });
  }
  for (const table of ["users", "platform_administrators", "login_attempts"]) {
    await assert.rejects(appPool.query(`SELECT * FROM ${table}`), error => error.code === "42501");
  }
  await assert.rejects(appPool.query("CREATE TABLE forbidden_deployment_table(id integer)"), error => error.code === "42501");
  await assert.rejects(appPool.query("SELECT * FROM user_login_identifiers"), error => error.code === "42501");
  await assert.rejects(control.query("SELECT * FROM user_login_identifiers"), error => error.code === "42501");
  await assert.rejects(appPool.query("INSERT INTO plans(code,name) VALUES('FORBIDDEN','Forbidden')"), error => error.code === "42501");
  const hashes = (await owner.query("SELECT rolpassword FROM pg_authid WHERE rolname=ANY($1)", [[env.APP_DATABASE_ROLE, env.CONTROL_DATABASE_ROLE]])).rows;
  assert.ok(hashes.every(row => row.rolpassword.startsWith("SCRAM-SHA-256$")));
  assert.ok(hashes.every(row => !row.rolpassword.includes(env.APP_DATABASE_PASSWORD) && !row.rolpassword.includes(env.CONTROL_DATABASE_PASSWORD)));
  const pepper = randomBytes(32).toString("hex");
  await createPlatformAdminService({ repository: createPlatformAdminRepository(control), passwordPepper: pepper })
    .bootstrapAdmin({ username: "deployadmin", password: "AdminPassword123!" });
  server = await createServer({ pool: appPool, controlPool: control, env: { NODE_ENV: "production",
    DATABASE_URL: "postgresql://unused/test", PASSWORD_PEPPER: pepper, SESSION_SECRET: randomBytes(32).toString("hex"),
    TRUSTED_ORIGINS: "https://pos.example.com", PAYMENT_PROVIDER: "manual", TRUST_PROXY: "false" } });
  const send = (method, url, payload, cookie, restaurantId) => server.app.inject({ method, url, payload,
    headers: { ...(cookie ? { cookie } : {}), ...(restaurantId ? { "x-restaurant-id": restaurantId } : {}) } });
  assert.equal((await send("GET", "/health/ready")).statusCode, 200);
  const adminLogin = await send("POST", "/platform-admin/api/auth/login", { username: "deployadmin", password: "AdminPassword123!" });
  assert.equal(adminLogin.statusCode, 200, adminLogin.body);
  assert.match(adminLogin.headers["set-cookie"], /Secure/);
  assert.match(adminLogin.headers["set-cookie"], /HttpOnly/);
  assert.match(adminLogin.headers["set-cookie"], /SameSite=Lax/);
  assert.ok(adminLogin.headers["strict-transport-security"]);
  const adminCookie = adminLogin.headers["set-cookie"].split(";")[0];
  const plan = await send("POST", "/platform-admin/api/plans", { name: "Launch plan", code: "LAUNCH", billingInterval: "month",
    amountMinor: 500000, currencyCode: "PKR", maxDevices: 8, trialDays: 14, isActive: true }, adminCookie);
  assert.equal(plan.statusCode, 201, plan.body);
  const restaurant = await send("POST", "/platform-admin/api/restaurants", { name: "Launch cafe", code: "launch-cafe",
    ownerUsername: "owner", ownerPassword: "OwnerPassword123!", planCode: "LAUNCH" }, adminCookie);
  assert.equal(restaurant.statusCode, 201, restaurant.body);
  const login = await send("POST", "/api/auth/login", { restaurantCode: "launch-cafe", username: "owner", password: "OwnerPassword123!" });
  assert.equal(login.statusCode, 200, login.body);
  const ownerCookie = login.headers["set-cookie"].split(";")[0];
  const settings = await send("GET", "/api/pos/settings/business", undefined, ownerCookie, restaurant.json().id);
  assert.equal(settings.statusCode, 200, settings.body);
  const migration = (await owner.query("DELETE FROM schema_migrations WHERE version=21 RETURNING *")).rows[0];
  try {
    const ready = await send("GET", "/health/ready");
    assert.equal(ready.statusCode, 503);
    assert.equal(ready.json().reason, "migrations_pending");
  } finally {
    await owner.query("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES($1,$2,$3,$4)",
      [migration.version, migration.name, migration.checksum, migration.applied_at]);
  }
  assert.equal((await send("GET", "/health/ready")).statusCode, 200);
  await owner.query(`GRANT "${env.CONTROL_DATABASE_ROLE}" TO "${env.APP_DATABASE_ROLE}"`);
  try { await assert.rejects(provisionRuntimeRoles({ pool: owner, env }), /no object ownership, role memberships/); }
  finally { await owner.query(`REVOKE "${env.CONTROL_DATABASE_ROLE}" FROM "${env.APP_DATABASE_ROLE}"`); }
});
