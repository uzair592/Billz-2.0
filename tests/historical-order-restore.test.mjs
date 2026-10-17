import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { normalizeRestoredOrder, legacyOrderRestoreSchema } from "../src/server/pos/legacy-order-restore-service.mjs";
import { buildHttpApp } from "../src/server/http/app.mjs";
import { createLegacyCloudAdapter } from "../src/client/legacy-cloud-adapter.mjs";
import { clampBillWidth } from "../src/client/workspace-layout.mjs";
const fixture = JSON.parse(await readFile(new URL("./fixtures/santex-cafe-reproduction-backup.json", import.meta.url), "utf8"));
const restaurantId = "11111111-1111-4111-8111-111111111111", userId = "22222222-2222-4222-8222-222222222222";

test("the supplied three historical bills preserve totals and identify estimated costs", () => {
  assert.equal(fixture.pos_orders.length, 3);
  const records = fixture.pos_orders.map(order => normalizeRestoredOrder(order, "2026-10-17"));
  assert.deepEqual(records.map(order => order.total), [79900,159800,65000]);
  assert.ok(records.every(order => order.incompleteCosting));
  assert.equal(records[0].date, "2026-10-02");
  assert.equal(records[0].time, "03:19:57");
  assert.equal(records[0].paid, 79900);
});

test("malformed dates, future dates, inconsistent money and invalid quantities fail before any writes", () => {
  for (const patch of [{ date: "2026-02-30" }, { date: "2099-01-01" }, { totalBill: -1 }, { totalBill: 1 }, { items: [{ name: "Bad", qty: 0, price: 10 }] }, { time: "32:00:00" }]) {
    assert.throws(() => normalizeRestoredOrder({ ...fixture.pos_orders[0], ...patch }, "2026-10-17"), error => error.code === "INVALID_BACKUP_ORDER");
  }
  assert.throws(() => legacyOrderRestoreSchema.parse({ orders: Array(251).fill({}) }));
  assert.equal(normalizeRestoredOrder({ ...fixture.pos_orders[0], time: "3:19 PM" }, "2026-10-17").time, "15:19:00");
});

test("historical restore requires a valid session, authorized role and subscription; tenant comes from the server", async t => {
  let role = "owner", status = "active", seen;
  const tenant = () => ({ restaurant: { id: restaurantId, status: "active", timezone: "Asia/Karachi" }, membership: { userId, role, defaultBranchId: userId }, subscription: { status, currentPeriodEnd: new Date(Date.now()+86400000).toISOString() } });
  const app = await buildHttpApp({ trustedOrigin: "http://localhost:3000", serveClient: false,
    authService: { authenticate: async token => token === "valid" ? { user: { id: userId } } : null },
    tenantContextService: { load: async ({ restaurantId: requested }) => requested === restaurantId ? tenant() : null },
    legacyOrderRestoreService: { restore: async input => { seen = input; return { imported: 3, skipped: 0 }; } },
  });
  t.after(() => app.close());
  const send = (headers = {}, payload = { orders: fixture.pos_orders }) => app.inject({ method: "POST", url: "/api/pos/import/legacy-orders", headers: { "x-restaurant-id": restaurantId, ...headers }, payload });
  assert.equal((await send()).statusCode, 401);
  const headers = { cookie: "pos_session=valid" };
  role = "cashier"; assert.equal((await send(headers)).statusCode, 403);
  role = "accountant"; assert.equal((await send(headers)).statusCode, 403);
  role = "owner"; status = "expired"; assert.equal((await send(headers)).statusCode, 402);
  status = "active"; assert.equal((await send({ ...headers, "x-restaurant-id": userId })).statusCode, 403);
  assert.equal((await send(headers, { orders: fixture.pos_orders, restaurantId: userId })).statusCode, 200);
  assert.equal(seen.tenant.restaurant.id, restaurantId); assert.equal(seen.userId, userId);
});

test("client restores in bounded batches and stops when the selected restaurant changes", async () => {
  let selected = restaurantId, calls = 0;
  const adapter = createLegacyCloudAdapter({ storage: { get: async () => null, set: async () => {} }, outbox: { enqueue: async () => {}, flush: async () => {} },
    session: { currentUser: async () => ({ user: { id: userId }, restaurantId }), activeRestaurant: async () => selected },
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/pos/import/legacy-orders");
      assert.equal(JSON.parse(options.body).orders.length, 250);
      assert.equal(options.headers["x-restaurant-id"], restaurantId);
      calls++; selected = userId;
      return { ok: true, json: async () => ({ imported: 250, skipped: 0 }) };
    } });
  await assert.rejects(adapter.restoreOrders(Array(251).fill(fixture.pos_orders[0])), error => error.code === "CLOUD_TENANT_MISMATCH");
  assert.equal(calls, 1);
});

test("bill resize keeps room for both the menu and the bill", () => {
  assert.equal(clampBillWidth(900, 1000), 680);
  assert.equal(clampBillWidth(100, 1000), 340);
  assert.equal(clampBillWidth(420, 1000), 420);
  assert.ok(clampBillWidth(900, 750) <= 470);
});
