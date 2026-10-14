import test from "node:test";
import assert from "node:assert/strict";
import { BACKUP_TABLES, compareBackupCounts, connectionEnvironment } from "../src/server/database/backup-verify.mjs";
import { latencySummary, runLoadTest, validateLoadFixtures } from "../scripts/load-test.mjs";

test("backup verification compares every required table and never puts passwords in libpq URL", () => {
  const expected = Object.fromEntries(BACKUP_TABLES.map(table => [table, "42"]));
  assert.equal(compareBackupCounts(expected, { ...expected }), true);
  assert.throws(() => compareBackupCounts(expected, { ...expected, orders: "41" }), /orders/);
  assert.throws(() => compareBackupCounts(expected, {}), /mismatch/);
  const env = connectionEnvironment("postgresql://backup:p%40ssword@db.example/test?sslmode=verify-full");
  assert.equal(env.PGPASSWORD, "p@ssword");
  assert.equal(new URL(env.PGDATABASE).password, "");
  assert.equal(new URL(env.PGDATABASE).searchParams.get("sslmode"), "verify-full");
  assert.throws(() => connectionEnvironment("postgres"), /full PostgreSQL/);
  assert.throws(() => connectionEnvironment("https://example.com/db"), /full PostgreSQL/);
});

test("load metrics report percentiles, failures and the 500ms p95 threshold", () => {
  const result = latencySummary(Array.from({ length: 100 }, (_value, index) => ({ ms: index + 1, ok: index >= 5 })));
  assert.deepEqual(result, { requests: 100, errors: 5, errorRate: 0.05, p50Ms: 50, p95Ms: 95, p99Ms: 99, slow: false });
  assert.equal(latencySummary([{ ms: 501, ok: true }]).slow, true);
  assert.equal(latencySummary([]).p95Ms, null);
});

test("load workload uses 50 logins across ten restaurants, retries no orders and logs out all sessions", async () => {
  const fixtures = Array.from({ length: 10 }, (_value, index) => ({ restaurantCode: `load-${index}`, username: "owner", password: "private-credential-canary" }));
  const requests = [], loggedIn = new Map();
  const result = await runLoadTest({ baseUrl: "http://127.0.0.1:3000", fixtures, orderCount: 200, durationMs: 0,
    fetchImpl: async (url, options) => {
      const pathname = url.pathname; requests.push({ pathname, options });
      let status = 200, body = {}, headers = {};
      if (pathname === "/api/auth/login") {
        const input = JSON.parse(options.body); loggedIn.set(input.restaurantCode, (loggedIn.get(input.restaurantCode) || 0) + 1);
        headers = { "set-cookie": `session=t${requests.length}; Secure; HttpOnly; SameSite=Lax` };
      } else if (pathname === "/api/auth/me") body = { restaurants: [{ restaurantId: "tenant-id" }] };
      else if (pathname === "/api/pos/menu") body = { items: [{ id: "menu-id", priceMinor: 100 }] };
      else if (pathname === "/api/pos/orders") status = requests.filter(row => row.pathname === pathname).length === 1 ? 500 : 201;
      return new Response(JSON.stringify(body), { status, headers });
    } });
  assert.equal(loggedIn.size, 10); assert.ok([...loggedIn.values()].every(value => value === 5));
  assert.equal(result.results.login.requests, 50); assert.equal(result.results.order.requests, 200);
  assert.equal(result.results.order.errors, 1); assert.equal(result.results.report.requests, 12); assert.equal(result.flagged, true);
  const orders = requests.filter(row => row.pathname === "/api/pos/orders").map(row => JSON.parse(row.options.body));
  assert.equal(new Set(orders.map(order => order.idempotencyKey)).size, 200);
  assert.ok(requests.filter(row => row.pathname === "/api/pos/reports/sales").every(row => row.options.headers["x-restaurant-id"] === "tenant-id"));
  assert.equal(requests.filter(row => row.pathname === "/api/auth/logout").length, 50);
  assert.equal(JSON.stringify(result).includes("private-credential-canary"), false);
  assert.equal(JSON.stringify(result).includes("session=t"), false);
  assert.throws(() => validateLoadFixtures(fixtures.slice(1)), /exactly 10/);
  assert.throws(() => validateLoadFixtures(fixtures.map(row => ({ ...row, restaurantCode: "same" }))), /distinct/);
});

test("load failures cannot silently skip workloads or send credentials to an insecure remote host", async () => {
  const fixtures = Array.from({ length: 10 }, (_value, index) => ({ restaurantCode: `load-${index}`, username: "owner", password: "secret" }));
  const result = await runLoadTest({ baseUrl: "http://localhost:3000", fixtures, durationMs: 0,
    fetchImpl: async () => new Response(JSON.stringify({ error: "private-server-details" }), { status: 401 }) });
  assert.equal(result.results.login.errors, 50); assert.equal(result.results.order.requests, 0);
  assert.ok(result.skipped); assert.equal(result.flagged, true); assert.equal(JSON.stringify(result).includes("private-server-details"), false);
  await assert.rejects(runLoadTest({ baseUrl: "http://remote.example.com", fixtures }), /HTTPS/);
});
