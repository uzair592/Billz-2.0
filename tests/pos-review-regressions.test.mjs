import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createCloudSessionClient } from "../src/client/cloud-session.mjs";
import { createLegacyCloudAdapter, CLOUD_CONTEXT_KEY } from "../src/client/legacy-cloud-adapter.mjs";
import { createPostgresAuthRepository } from "../src/server/auth/postgres-auth-repository.mjs";
import { createAuthService } from "../src/server/auth/auth-service.mjs";
import { hashPassword } from "../src/server/auth/passwords.mjs";
import { buildHttpApp } from "../src/server/http/app.mjs";
import { readLegacyApp, extractInlineScript, extractDeclaration } from "./helpers/legacy-source.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const itemId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const password = "RegressionPassword123!";
function storage(seed = {}) { const values = new Map(Object.entries(seed)); return { get: async key => structuredClone(values.get(key)), set: async (key,value) => values.set(key,structuredClone(value)) }; }
const order = { orderType: "Takeaway", date: "2026-10-14", items: [{ id: 7, qty: 1 }], totalBill: 100, paymentStatus: "Paid", paymentMethod: "Cash" };
function adapter({ store = storage(), fetchImpl, currentUser = async () => ({ user: { id: userId }, restaurantId }) } = {}) {
  return createLegacyCloudAdapter({ storage: store, session: { currentUser }, fetchImpl, outbox: { enqueue: async () => {}, flush: async () => [] } });
}

test("visible username-only sign-in reaches the actual HTTP login schema", async t => {
  let credentials;
  const app = await buildHttpApp({ trustedOrigin: "http://localhost:3000", serveClient: false, authService: {
    login: async input => { credentials = input; return { user: { id: userId }, token: "fixture", expiresAt: new Date(Date.now()+60000) }; },
    authenticate: async () => ({ user: { id: userId } }), restaurantsForUser: async () => [{ restaurantId }],
  } });
  t.after(() => app.close());
  const client = createCloudSessionClient({ storage: storage(), fetchImpl: async (url,options = {}) => {
    const response = await app.inject({ url, method: options.method ?? "GET", headers: options.headers, payload: options.body });
    return { ok: response.statusCode === 200, status: response.statusCode, json: async () => response.json() };
  } });
  await client.signIn({ username: " owner ", password });
  assert.equal(credentials.username, "owner"); assert.equal(credentials.restaurantCode, undefined);
  assert.equal(await client.activeRestaurant(), restaurantId);
});

test("ambiguous usernames fail closed even when both tenant accounts share a password", async () => {
  const hash = await hashPassword(password, "regression-pepper");
  let created = false;
  const repository = createPostgresAuthRepository({ connect: async () => {}, query: async () => ({ rows: [
    { id: userId, username: "owner", password_hash: hash, status: "active" },
    { id: itemId, username: "owner", password_hash: hash, status: "active" },
  ] }) });
  const service = createAuthService({ repository: { findUserByUsernameOnly: repository.findUserByUsernameOnly, createSession: async () => { created = true; } }, mailer: { sendVerification: async () => {} }, passwordPepper: "regression-pepper" });
  await assert.rejects(service.login({ username: "owner", password }), error => error.code === "INVALID_CREDENTIALS");
  assert.equal(created, false);
});

test("missing cashier mappings are recovered by reading, without importing or overwriting a local draft", async () => {
  const store = storage({ pos_menu: [{ id: 7, name: "Local draft" }] }), calls = [];
  const client = adapter({ store, fetchImpl: async (url,options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => url === "/api/pos/catalog"
      ? { revision: 5, mappings: { menuItems: { 7: itemId }, tables: {}, financialAccounts: {} } }
      : { order: { id: "saved-sale" } } };
  } });
  assert.equal((await client.checkoutOnline(order)).order.id, "saved-sale");
  assert.deepEqual(calls.map(call => call.url), ["/api/pos/catalog", "/api/pos/orders"]);
  assert.equal(calls[0].options.method, undefined);
  assert.equal((await store.get(CLOUD_CONTEXT_KEY)).revision, 5);
  assert.equal((await store.get("pos_menu"))[0].name, "Local draft");
  assert.equal(JSON.parse(calls[1].options.body).items[0].menuItemId, itemId);
});

test("catalog recovery preserves authorization errors rather than hiding them", async () => {
  await assert.rejects(adapter({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ code: "FORBIDDEN", error: "Access denied." }) }) }).checkoutOnline(order),
    error => error.status === 403 && error.code === "FORBIDDEN" && error.message === "Access denied.");
});

test("catalog recovery rejects a tenant change before persisting mappings or sending an order", async () => {
  const store = storage(); let users = 0, requests = 0;
  const client = adapter({ store, currentUser: async () => ({ user: { id: userId }, restaurantId: ++users === 1 ? restaurantId : itemId }),
    fetchImpl: async () => { requests++; return { ok: true, status: 200, json: async () => ({ revision: 1, mappings: { menuItems: { 7: itemId } } }) }; } });
  await assert.rejects(client.checkoutOnline(order), error => error.code === "CLOUD_TENANT_MISMATCH");
  assert.equal(await store.get(CLOUD_CONTEXT_KEY), undefined); assert.equal(requests, 1);
});

test("unpublished menus stop checkout with an owner setup instruction and no catalog write", async () => {
  let requests = 0;
  const client = adapter({ fetchImpl: async () => { requests++; return { ok: true, status: 200, json: async () => ({ snapshot: null, mappings: null }) }; } });
  await assert.rejects(client.checkoutOnline(order), error => error.code === "CATALOG_NOT_READY" && /owner to save menu/.test(error.message));
  assert.equal(requests, 1);
});

test("credential username conflicts roll back and return a clear 409", async () => {
  const queries = [];
  const repository = createPostgresAuthRepository({ connect: async () => ({ release() {}, query: async sql => {
    queries.push(sql);
    if (sql.startsWith("SELECT id, restaurant_id")) return { rows: [{ id: userId, restaurant_id: restaurantId, password_hash: "fixture" }] };
    if (sql.startsWith("SELECT id FROM sessions")) return { rows: [{ id: "session" }] };
    if (sql.startsWith("UPDATE users")) throw Object.assign(new Error("duplicate"), { code: "23505", constraint: "users_global_username_unique" });
    return { rows: [] };
  } }) });
  await assert.rejects(repository.changePassword({ userId, sessionTokenHash: "current", passwordHash: "fixture", verifyCurrentPassword: async () => true, now: new Date(), newUsername: "taken" }),
    error => error.statusCode === 409 && error.code === "USERNAME_EXISTS");
  assert.equal(queries.at(-1), "ROLLBACK"); assert.equal(queries.some(sql => sql.startsWith("UPDATE sessions")), false);
});

test("managed Reports use shared reports and Stock opens backend inventory", async () => {
  const script = extractInlineScript(await readLegacyApp());
  const switchScreen = extractDeclaration(script, "function switchScreen(screenId)", "function applySettingsValuesToSettingsScreen()");
  let shared = 0, local = 0, inventory = 0;
  const classes = { add() {}, remove() {} };
  const context = vm.createContext({ window: { BILLZ_MANAGED: true, showCloudSalesReport: () => shared++ },
    AppState: { session: {} }, document: { querySelectorAll: () => [], querySelector: () => ({ classList: classes }), getElementById: () => ({ classList: classes }) },
    closeMobileDrawer() {}, updateProfessionalAppHeader() {}, calculateAndRenderBusinessReports: () => local++,
    globalThis: { BiteTechInventory: { mount: async () => inventory++ } },
  });
  vm.runInContext(switchScreen, context);
  context.switchScreen("reports"); context.switchScreen("kitchen-stock");
  assert.equal(shared, 1); assert.equal(local, 0); assert.equal(inventory, 1);
  assert.equal(context.AppState.session.currentScreen, "inventory");
});
