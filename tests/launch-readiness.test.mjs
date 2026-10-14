import assert from "node:assert/strict";
import test from "node:test";
import { refreshSharedCatalog, catalogFingerprint } from "../src/client/cloud-catalog.mjs";
import { escapeFinanceText } from "../src/client/finance-ui.mjs";
import { createPlatformAdminPortalService } from "../src/server/subscriptions/platform-admin-portal-service.mjs";
import { buildHttpApp } from "../src/server/http/app.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
function store(records = {}) {
  const values = new Map(Object.entries(records)); const writes = [];
  return { values, writes, async get(key) { return values.get(key); }, async setMany(data) { writes.push(data); for (const entry of Object.entries(data)) values.set(...entry); } };
}
const snapshot = { pos_menu: [{ id: 1, name: "Burger", price: 100 }], pos_categories: ["Burgers"], pos_subcategories: {}, pos_category_offers: {} };
const response = async () => ({ ok: true, json: async () => ({ revision: 2, snapshot: { ...snapshot, pos_orders: ["must not overwrite"], password: "not public" }, mappings: { menuItems: { 1: userId } } }) });

test("a new device loads the shared catalog and mappings in one atomic storage write", async () => {
  const storage = store({ pos_orders: ["local order"] });
  assert.equal((await refreshSharedCatalog({ storage, restaurantId, fetchImpl: response })).status, "refreshed");
  assert.equal(storage.writes.length, 1);
  assert.equal(storage.values.get("pos_cloud_context_v1").revision, 2);
  assert.equal(storage.values.get("pos_cloud_context_v1").mappings.menuItems[1], userId);
  assert.deepEqual(storage.values.get("pos_orders"), ["local order"]);
  assert.equal(storage.values.has("password"), false);
});

test("refresh preserves an unpublished local menu draft and its old revision", async () => {
  const storage = store({ ...snapshot, pos_menu: [{ id: 1, name: "Unsaved edit" }], pos_catalog_baseline: catalogFingerprint(snapshot), pos_cloud_context_v1: { restaurantId, revision: 1 } });
  assert.equal((await refreshSharedCatalog({ storage, restaurantId, fetchImpl: response })).status, "local_draft");
  assert.equal(storage.values.get("pos_cloud_context_v1").revision, 1);
  assert.equal(storage.writes.length, 0);
  await refreshSharedCatalog({ storage, restaurantId, fetchImpl: response, force: true });
  assert.equal(storage.values.get("pos_menu")[0].name, "Burger");
});

test("subscription/authentication errors cannot silently replace a catalog with local data", async () => {
  for (const status of [401, 402, 403, 500]) {
    const storage = store();
    await assert.rejects(refreshSharedCatalog({ storage, restaurantId, fetchImpl: async () => ({ ok: false, status, json: async () => ({ error: "Access blocked" }) }) }), error => error.status === status);
    assert.equal(storage.writes.length, 0);
  }
});

test("a catalog response from before a restaurant switch cannot contaminate the new tenant", async () => {
  const storage = store({ pos_cloud_session_v1: { restaurantId: userId } });
  await assert.rejects(refreshSharedCatalog({ storage, restaurantId, fetchImpl: response }), /Restaurant changed/);
  assert.equal(storage.writes.length, 0);
});

test("cloud expense text is escaped in every HTML and attribute context", () => {
  assert.equal(escapeFinanceText('<img src=x onerror="alert(1)"> & \'test\''), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;test&#39;');
});

test("an unknown subscription plan rolls back restaurant creation instead of silently assigning another plan", async () => {
  const queries = [];
  const client = { async query(sql) { queries.push(sql); return { rows: [] }; }, release() {} };
  const service = createPlatformAdminPortalService({ pool: { connect: async () => client }, passwordPepper: "test-pepper-at-least-16" });
  await assert.rejects(service.createRestaurant({ code: "cafe", name: "Cafe", ownerUsername: "owner", ownerPassword: "OwnerPassword123!", planCode: "UNKNOWN" }), error => error.code === "PLAN_NOT_FOUND");
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.equal(queries.some(sql => sql.includes("INSERT INTO restaurants")), false);
});

test("admin staff/plans/payment queue endpoints enforce authentication and reject malformed mutations", async t => {
  let authenticated = false; const calls = [];
  const app = await buildHttpApp({ authService: {}, trustedOrigin: "http://localhost:3000", serveClient: false,
    platformAdminService: { authenticate: async () => authenticated ? { admin: { id: "admin" } } : null },
    platformAdminPortalService: {
      createUser: async input => { calls.push(input); return { user: { id: userId } }; },
      editUser: async input => { calls.push(input); return { updated: true }; },
      listPlans: async () => ({ plans: [] }), listPayments: async () => ({ payments: [] }),
    } });
  t.after(() => app.close());
  const base = `/platform-admin/api/restaurants/${restaurantId}/users`;
  for (const [method, url, payload] of [["POST", base, {}], ["PATCH", `${base}/${userId}`, {}], ["GET", "/platform-admin/api/plans"], ["GET", "/platform-admin/api/payments"]]) {
    assert.equal((await app.inject({ method, url, payload })).statusCode, 401);
  }
  authenticated = true;
  for (const payload of [{ username: "a", displayName: "User", role: "cashier", password: "Password123!" }, { username: "valid", displayName: "User", role: "platform_admin", password: "Password123!" }, { username: "valid", displayName: "User", role: "cashier", password: "short" }]) {
    assert.equal((await app.inject({ method: "POST", url: base, payload })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: "PATCH", url: `${base}/${userId}`, payload: {} })).statusCode, 400);
  assert.equal((await app.inject("/platform-admin/api/payments?page=0")).statusCode, 400);
  assert.equal(calls.length, 0);
  assert.equal((await app.inject({ method: "POST", url: base, payload: { username: "cashier", displayName: "User", role: "cashier", password: "Password123!" } })).statusCode, 201);
  assert.equal(calls[0].restaurantId, restaurantId);
  assert.equal((await app.inject({ method: "PATCH", url: `${base}/${userId}`, payload: { username: "renamed" } })).statusCode, 200);
});

test("finance endpoints require an active tenant, reject cashier writes and validate business dates", async t => {
  let role = "owner"; const calls = [];
  const app = await buildHttpApp({ authService: { authenticate: async token => token ? { user: { id: userId } } : null }, trustedOrigin: "http://localhost:3000", serveClient: false,
    tenantContextService: { load: async () => ({ restaurant: { id: restaurantId, status: "active", timezone: "Asia/Karachi" }, membership: { userId, role, status: "active", defaultBranchId: restaurantId }, subscription: { status: "active", currentPeriodEnd: "2999-01-01" } }) },
    financeService: { createExpense: async input => { calls.push(input); return { expense: { id: userId }, replayed: false }; }, listExpenses: async () => ({}), accounts: async () => ({}), profitLoss: async () => ({}) } });
  t.after(() => app.close());
  assert.equal((await app.inject("/api/pos/reports/profit-loss")).statusCode, 401);
  const headers = { cookie: `pos_session=${"s".repeat(43)}`, "x-restaurant-id": restaurantId };
  const payload = { idempotencyKey: userId, categoryName: "Rent", amountMinor: 10000, businessDate: "2026-10-13", financialAccountId: restaurantId };
  assert.equal((await app.inject({ method: "POST", url: "/api/pos/expenses", payload, headers })).statusCode, 201);
  for (const bad of [{ ...payload, amountMinor: 0 }, { ...payload, businessDate: "2026-02-30" }, { ...payload, restaurantId: userId }]) assert.equal((await app.inject({ method: "POST", url: "/api/pos/expenses", payload: bad, headers })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/pos/reports/profit-loss?startDate=2026-10-20&endDate=2026-10-13", headers })).statusCode, 400);
  role = "cashier";
  assert.equal((await app.inject({ method: "POST", url: "/api/pos/expenses", payload, headers })).statusCode, 403);
  assert.equal((await app.inject({ url: "/api/pos/reports/profit-loss", headers })).statusCode, 403);
  assert.equal(calls.length, 1);
});

test("waiters can create unpaid orders but cannot bypass payment permissions through checkout", async t => {
  let writes = 0;
  const app = await buildHttpApp({ trustedOrigin: "http://localhost:3000", serveClient: false,
    authService: { authenticate: async () => ({ user: { id: userId } }) },
    tenantContextService: { load: async () => ({ restaurant: { id: restaurantId, status: "active" }, membership: { userId, role: "waiter", status: "active", defaultBranchId: restaurantId }, subscription: { status: "active", currentPeriodEnd: "2999-01-01" } }) },
    orderService: { create: async () => { writes++; return { order: { id: userId }, replayed: false }; } },
    businessSettingsService: { get: async () => ({ businessName: "Cafe", phone: "03001234567", address: "Peshawar", defaultBranchId: "private", logoObjectKey: "private" }) } });
  t.after(() => app.close());
  const headers = { cookie: `pos_session=${"s".repeat(43)}`, "x-restaurant-id": restaurantId };
  const input = { idempotencyKey: userId, orderType: "takeaway", items: [{ menuItemId: restaurantId, quantity: 1 }] };
  assert.equal((await app.inject({ method: "POST", url: "/api/pos/orders", headers, payload: { ...input, payment: { method: "cash", amountReceivedMinor: 10000 } } })).statusCode, 403);
  assert.equal(writes, 0);
  assert.equal((await app.inject({ method: "POST", url: "/api/pos/orders", headers, payload: input })).statusCode, 201);
  assert.deepEqual((await app.inject({ url: "/api/pos/receipt-business", headers })).json(), { businessName: "Cafe", phone: "03001234567", address: "Peshawar" });
  assert.equal((await app.inject({ url: "/api/pos/settings/business", headers })).statusCode, 403);
});

test("non-restocked refunded quantities retain frozen usage in both inventory ledgers", async () => {
  const { nonRestockedRefundUsage } = await import("../src/server/pos/inventory-sale-snapshot.mjs");
  const client = { query: async () => ({ rows: [
    { refunded_quantity: "2", recipe_snapshot: { version: 2, items: [{ stockItemId: "dough", quantityBaseUnits: 100 }], inventoryItems: [{ inventoryItemId: "cheese", quantityPerUnit: 30 }] } },
    { refunded_quantity: "1", recipe_snapshot: { version: 2, items: [{ stockItemId: "dough", quantityBaseUnits: 50 }], inventoryItems: [{ inventoryItemId: "cheese", quantityPerUnit: 10 }] } },
  ] }) };
  const result = await nonRestockedRefundUsage(client, { restaurantId, orderId: userId });
  assert.equal(result.legacy.get("dough"), 250);
  assert.equal(result.inventory.get("cheese"), 70);
});
