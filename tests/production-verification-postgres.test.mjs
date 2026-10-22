import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { provisionIntegrationDatabase, createAppPool, createControlPool, connectAdmin, seedPlan, ADMIN_DATABASE_URL, APP_DATABASE_URL } from "./helpers/postgres.mjs";
import { createServer } from "../src/server/main.mjs";
import { createPlatformAdminService } from "../src/server/auth/platform-admin-service.mjs";
import { createPlatformAdminRepository } from "../src/server/auth/platform-admin-repository.mjs";
import { createPlatformAdminPortalService } from "../src/server/subscriptions/platform-admin-portal-service.mjs";
import { runLoadTest } from "../scripts/load-test.mjs";
import { verifyBackup } from "../src/server/database/backup-verify.mjs";

test("production security, real HTTP load and snapshot backup restoration", { timeout: 180000 }, async t => {
  await provisionIntegrationDatabase();
  const pool = await createAppPool(), control = await createControlPool(), admin = await connectAdmin();
  const backupDir = await mkdtemp(path.join(os.tmpdir(), "billz-backup-verification-"));
  const env = { NODE_ENV: "production", DATABASE_URL: APP_DATABASE_URL, PASSWORD_PEPPER: randomBytes(32).toString("hex"),
    SESSION_SECRET: randomBytes(32).toString("hex"), TRUSTED_ORIGINS: "https://pos.example.com", PAYMENT_PROVIDER: "manual", TRUST_PROXY: "true", TRUSTED_PROXY_CIDRS: "127.0.0.1/32" };
  let server;
  t.after(async () => { await server?.close(); await pool.end(); await control.end(); await admin.end(); await rm(backupDir, { recursive: true, force: true }); });
  const start = overrides => createServer({ pool, controlPool: control, env: { ...env, ...overrides } });
  await t.test("production boot rejects unsafe origins, secrets, proxies and database roles", async () => {
    for (const origins of ["https://localhost:3000", "http://pos.example.com"]) await assert.rejects(start({ TRUSTED_ORIGINS: origins }), /localhost|HTTPS/);
    await assert.rejects(start({ PASSWORD_PEPPER: "replace-with-a-secret" }), /placeholder/);
    await assert.rejects(start({ SESSION_SECRET: "replace-with-at-least-32-random-bytes" }), /placeholder/);
    await assert.rejects(start({ TRUSTED_PROXY_CIDRS: "" }), /TRUSTED_PROXY_CIDRS/);
    await assert.rejects(createServer({ pool: admin, controlPool: control, env }), error => error.code === "UNSAFE_DATABASE_ROLE");
  });
  await seedPlan(control, { code: "LOAD", provider: "manual" });
  const administrator = await createPlatformAdminService({ repository: createPlatformAdminRepository(control), passwordPepper: env.PASSWORD_PEPPER })
    .bootstrapAdmin({ username: "productionadmin", password: "AdminPassword123!" });
  const portal = createPlatformAdminPortalService({ pool: control, passwordPepper: env.PASSWORD_PEPPER });
  const fixtures = [];
  server = await start({});
  for (let index = 0; index < 10; index++) {
    const fixture = { restaurantCode: `load-${index}`, username: `load_owner_${index}`, password: "OwnerPassword123!" };
    const restaurant = await portal.createRestaurant({ adminId: administrator.admin.id, name: `Load cafe ${index}`, code: fixture.restaurantCode,
      ownerUsername: fixture.username, ownerPassword: fixture.password, planCode: "LOAD" });
    const login = await server.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.17",
      payload: { restaurantCode: fixture.restaurantCode, username: fixture.username, password: fixture.password } });
    assert.equal(login.statusCode, 200, login.body);
    for (const attribute of [/Secure/, /HttpOnly/, /SameSite=Lax/]) assert.match(login.headers["set-cookie"], attribute);
    assert.match(login.headers["strict-transport-security"], /max-age=/);
    const cookie = login.headers["set-cookie"].split(";")[0];
    const catalog = { pos_categories: ["Load"], pos_subcategories: {}, pos_category_offers: {},
      pos_menu: [{ id: 1, itemNumber: 1, name: "Load burger", category: "Load", price: 100, otherCost: 20 }],
      pos_stock_item_defs: {}, pos_ingredient_stock: {}, pos_softdrink_stock: {}, pos_softdrink_threshold: 0,
      pos_icecream_stock: {}, pos_icecream_threshold: 0, pos_total_tables: 1, pos_halls_list: ["Main"], pos_bank_accounts: [], expectedRevision: 0 };
    const imported = await server.app.inject({ method: "POST", url: "/api/pos/import/legacy-catalog", remoteAddress: "198.51.100.17",
      payload: catalog, headers: { cookie, "x-restaurant-id": restaurant.id } });
    assert.equal(imported.statusCode, 200, imported.body);
    await server.app.inject({ method: "POST", url: "/api/auth/logout", remoteAddress: "198.51.100.17", headers: { cookie } });
    fixtures.push(fixture);
  }
  await t.test("real production server is ready and preserves the admin security headers", async () => {
    assert.equal((await server.app.inject("/health/ready")).statusCode, 200);
    const response = await server.app.inject({ method: "POST", url: "/platform-admin/api/auth/login", payload: { username: "productionadmin", password: "AdminPassword123!" } });
    assert.equal(response.statusCode, 200, response.body);
    for (const attribute of [/Secure/, /HttpOnly/, /SameSite=Lax/]) assert.match(response.headers["set-cookie"], attribute);
    assert.ok(response.headers["strict-transport-security"]); assert.ok(response.headers["content-security-policy"]);
  });
  await t.test("50 concurrent logins, 200 orders/minute and reports complete without errors", async () => {
    const baseUrl = await server.app.listen({ host: "127.0.0.1", port: 0 });
    const result = await runLoadTest({ baseUrl, fixtures });
    console.log(JSON.stringify(result)); // Results contain timings/counts only, never credentials or bodies.
    assert.equal(result.skipped, null);
    for (const [kind, count] of [["login", 50], ["order", 200], ["report", 12]]) {
      assert.equal(result.results[kind].requests, count); assert.equal(result.results[kind].errors, 0, JSON.stringify(result));
    }
    assert.equal((await control.query("SELECT count(*) FROM orders")).rows[0].count, "200");
    assert.equal((await control.query("SELECT count(*) FROM sessions WHERE revoked_at IS NULL")).rows[0].count, "0");
    // p95 > 500ms is reported/flagged, not hidden by a machine-dependent CI assertion.
  });
  await t.test("backup restores every main table into scratch and cannot bypass tenant RLS accidentally", async (subT) => {
    const probe = spawnSync("pg_dump", ["--version"], { stdio: "ignore" });
    if (probe.error) {
      subT.skip("PostgreSQL client tools (pg_dump) are not installed on workstation");
      return;
    }
    const before = (await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'billz_verify_%' ORDER BY datname")).rows;
    const result = await verifyBackup({ databaseUrl: ADMIN_DATABASE_URL, scratchAdminUrl: ADMIN_DATABASE_URL, backupDir });
    assert.equal(result.ok, true); assert.equal(result.tables.orders, "200"); assert.equal(result.tables.restaurants, "10");
    assert.ok(result.sizeBytes > 0);
    if (process.platform !== "win32") {
      assert.equal((await stat(result.backupPath)).mode & 0o077, 0);
    }
    assert.deepEqual((await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'billz_verify_%' ORDER BY datname")).rows, before);
    await assert.rejects(verifyBackup({ databaseUrl: APP_DATABASE_URL, scratchAdminUrl: ADMIN_DATABASE_URL, backupDir }));
    assert.equal((await admin.query("SELECT count(*) FROM orders")).rows[0].count, "200");
  });
});
