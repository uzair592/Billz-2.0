import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

export function latencySummary(samples) {
  const sorted = samples.map(sample => sample.ms).sort((a, b) => a - b);
  const percentile = percent => sorted.length ? Math.round(sorted[Math.ceil(sorted.length * percent) - 1] * 100) / 100 : null;
  const errors = samples.filter(sample => !sample.ok).length;
  const summary = { requests: samples.length, errors, errorRate: samples.length ? errors / samples.length : 0,
    p50Ms: percentile(0.50), p95Ms: percentile(0.95), p99Ms: percentile(0.99) };
  return { ...summary, slow: summary.p95Ms > 500 };
}

export function validateLoadFixtures(fixtures) {
  if (!Array.isArray(fixtures) || fixtures.length !== 10 || new Set(fixtures.map(row => row.restaurantCode)).size !== 10)
    throw new Error("Provide exactly 10 distinct staging restaurant credentials.");
  for (const row of fixtures) if (![row.restaurantCode, row.username, row.password].every(value => typeof value === "string" && value.length > 0))
    throw new Error("Every staging fixture requires restaurantCode, username and password.");
}

export async function runLoadTest({ baseUrl, fixtures, orderCount = 200, durationMs = 60000, reportCount = 12, fetchImpl = fetch }) {
  validateLoadFixtures(fixtures);
  const base = new URL(baseUrl);
  if (!(["https:", "http:"].includes(base.protocol)) || base.username || base.password || base.pathname !== "/")
    throw new Error("LOAD_BASE_URL must be an HTTP(S) origin without credentials or a path.");
  if (base.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    throw new Error("Use HTTPS for remote load tests.");
  if (!Number.isInteger(orderCount) || orderCount < 1 || !Number.isInteger(reportCount) || reportCount < 1 || durationMs < 0)
    throw new Error("Invalid load-test workload.");
  const samples = { login: [], order: [], report: [] }, sessions = [], cookies = [];
  async function request(kind, url, options = {}) {
    const start = performance.now(); let ok = false, status = null, data = null, cookie = null;
    try {
      const response = await fetchImpl(new URL(url, base), { ...options, signal: AbortSignal.timeout(30000) });
      status = response.status; cookie = response.headers.get("set-cookie")?.split(";")[0];
      data = await response.json(); ok = response.ok;
    } catch { /* Record only timing/status. Response bodies and credentials never enter results. */ }
    const sample = { ms: performance.now() - start, ok, status };
    samples[kind]?.push(sample);
    return { ok, data, cookie, sample };
  }
  await Promise.all(Array.from({ length: 50 }, async (_value, index) => {
    const fixture = fixtures[index % 10];
    const result = await request("login", "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ restaurantCode: fixture.restaurantCode, username: fixture.username, password: fixture.password }) });
    if (result.ok && result.cookie) {
      cookies.push(result.cookie);
      const membership = await request(null, "/api/auth/me", { headers: { cookie: result.cookie } });
      const restaurantId = membership.data?.restaurants?.[0]?.restaurantId;
      if (membership.ok && restaurantId) sessions[index] = { cookie: result.cookie, restaurantId };
      else result.sample.ok = false;
    } else result.sample.ok = false;
  }));
  const session = sessions.find((value, index) => value && index % 10 === 0);
  let skipped = null;
  if (!session) skipped = "No session for the first restaurant; order/report workloads were not run.";
  else {
    const headers = { cookie: session.cookie, "x-restaurant-id": session.restaurantId, "content-type": "application/json" };
    const menu = await request(null, "/api/pos/menu", { headers });
    const item = Array.isArray(menu.data?.items) ? menu.data.items.find(item => item.isActive !== false && item.isAvailable !== false) : null;
    if (!menu.ok || !item) skipped = "First restaurant has no available menu item; order/report workloads were not run.";
    else {
      const start = performance.now();
      const at = async ms => { const delay = start + ms - performance.now(); if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay)); };
      const date = new Date().toISOString().slice(0, 10);
      await Promise.all([
        ...Array.from({ length: orderCount }, async (_value, index) => {
          await at(index * durationMs / orderCount);
          await request("order", "/api/pos/orders", { method: "POST", headers, body: JSON.stringify({
            idempotencyKey: randomUUID(), orderType: "takeaway", businessDate: date,
            customerName: "Staging load verification", items: [{ menuItemId: item.id, quantity: 1 }],
            ...(item.priceMinor > 0 ? { payment: { method: "cash", amountReceivedMinor: item.priceMinor } } : {}),
          }) });
        }),
        ...Array.from({ length: reportCount }, async (_value, index) => {
          await at(index * durationMs / reportCount);
          await request("report", `/api/pos/reports/sales?startDate=${date}&endDate=${date}`, { headers });
        }),
      ]);
    }
  }
  // Logout every successful session, including those not used by the order workload.
  await Promise.all(cookies.map(cookie => request(null, "/api/auth/logout", { method: "POST", headers: { cookie } })));
  const results = Object.fromEntries(Object.entries(samples).map(([kind, values]) => [kind, latencySummary(values)]));
  return { message: "load_test_results", workload: { concurrentLogins: 50, restaurants: 10, orders: orderCount, durationMs, reports: reportCount },
    results, skipped, flagged: Boolean(skipped) || Object.values(results).some(result => result.slow || result.errors > 0) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  (async () => {
    if (process.env.LOAD_CONFIRM_STAGING !== "true") throw new Error("Set LOAD_CONFIRM_STAGING=true: this test creates real orders in disposable staging restaurants.");
    // Credentials come from a secret-manager pipe, never a persisted fixture file or CLI arguments.
    if (process.stdin.isTTY) throw new Error("Pipe the staging credentials JSON from your secret manager into stdin.");
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (input.length > 65536) throw new Error("Staging credentials input is too large.");
    }
    const fixtures = JSON.parse(input);
    const result = await runLoadTest({ baseUrl: process.env.LOAD_BASE_URL, fixtures });
    console.log(JSON.stringify(result)); process.exitCode = result.flagged ? 2 : 0;
  })().catch(() => {
    console.error("Load test could not start. Check LOAD_CONFIRM_STAGING=true, LOAD_BASE_URL, and stdin JSON from your secret manager containing 10 distinct staging restaurant credentials.");
    process.exitCode = 1;
  });
}
