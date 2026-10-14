import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { publicAuditMetadata } from "../src/server/subscriptions/platform-admin-portal-service.mjs";
import { buildHttpApp } from "../src/server/http/app.mjs";

test("loading another restaurant prevents edits against stale detail state", async () => {
  const source = await readFile(new URL("../platform-admin/app.js", import.meta.url), "utf8");
  const nodes = new Map();
  const context = vm.createContext({ currentRestaurant: { restaurant: { id: "old" } },
    $: id => { if (!nodes.has(id)) nodes.set(id, { disabled: false, classList: { add() {}, remove() {} } }); return nodes.get(id); },
    showView() {}, apiCall: () => new Promise(() => {}) });
  const viewer = source.slice(source.indexOf("let detailReqId"), source.indexOf('$("close-detail-btn").onclick'));
  vm.runInContext(viewer + '\nviewRestaurant("new");', context);
  assert.equal(context.currentRestaurant, null);
  assert.equal(nodes.get("edit-restaurant-btn").disabled, true);
});

test("user and payment renderers escape every stored text and attribute value", async () => {
  const source = await readFile(
    new URL("../platform-admin/app.js", import.meta.url),
    "utf8",
  );
  const canary = "<img src=x onerror=alert(1)>";
  const context = vm.createContext({
    user: {
      id: canary,
      username: canary,
      displayName: canary,
      role: canary,
      status: canary,
    },
    payment: {
      id: canary,
      externalReference: canary,
      planName: canary,
      currencyCode: canary,
      amountMinor: 100,
      status: "pending",
    },
  });
  const helper = source.slice(0, source.indexOf("async function apiCall"));
  const renderers = source.slice(
    source.indexOf("function usersMarkup("),
    source.indexOf("let detailReqId"),
  );
  const html = vm.runInContext(
    helper + renderers + "\nusersMarkup([user])+paymentsMarkup([payment]);",
    context,
  );
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
});

test("audit DTO strips nested credentials and preserves safe history", () => {
  assert.deepEqual(
    publicAuditMetadata({
      userId: "one",
      passwordHash: "private",
      nested: { sessionToken: "private", safe: true },
      rows: [{ credential: "private", status: "active" }],
    }),
    { userId: "one", nested: { safe: true }, rows: [{ status: "active" }] },
  );
});

test("new admin controls require authentication and validate fields/pagination", async (t) => {
  let loggedIn = false,
    called = 0;
  const app = await buildHttpApp({
    authService: {},
    platformAdminService: {
      authenticate: async () => (loggedIn ? { admin: { id: "admin" } } : null),
    },
    platformAdminPortalService: {
      editRestaurant() {
        called++;
      },
      setUserStatus() {
        called++;
      },
      listAuditLogs() {
        called++;
      },
      listRestaurants() {
        called++;
      },
    },
    billingWebhookService: { handle: async () => ({ accepted: false }) },
    trustedOrigin: "http://localhost:3000",
    serveClient: false,
  });
  t.after(() => app.close());
  const rest = "11111111-1111-4111-8111-111111111111",
    user = "22222222-2222-4222-8222-222222222222";
  for (const [method, url, payload] of [
    ["PATCH", `/platform-admin/api/restaurants/${rest}`, { name: "Cafe" }],
    [
      "POST",
      `/platform-admin/api/restaurants/${rest}/users/${user}/status`,
      { status: "disabled" },
    ],
    ["GET", "/platform-admin/api/audit-logs", undefined],
  ])
    assert.equal((await app.inject({ method, url, payload })).statusCode, 401);
  loggedIn = true;
  for (const [method, url, payload] of [
    ["PATCH", `/platform-admin/api/restaurants/${rest}`, {}],
    ["PATCH", `/platform-admin/api/restaurants/${rest}`, { name: "" }],
    [
      "PATCH",
      `/platform-admin/api/restaurants/${rest}`,
      { contactEmail: "bad" },
    ],
    [
      "POST",
      `/platform-admin/api/restaurants/${rest}/users/${user}/status`,
      { status: "deleted" },
    ],
    ["GET", "/platform-admin/api/audit-logs?page=0", undefined],
    ["GET", "/platform-admin/api/restaurants?limit=101", undefined],
  ])
    assert.equal((await app.inject({ method, url, payload })).statusCode, 400);
  assert.equal(called, 0);
});
