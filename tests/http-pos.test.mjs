import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildHttpApp } from "../src/server/http/app.mjs";

const apps = [];
const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

function tenant(role = "owner", subscriptionStatus = "active") {
  return {
    restaurant: { id: restaurantId, name: "Example Cafe", status: "active" },
    membership: { userId, role, status: "active", defaultBranchId: "branch-1" },
    subscription: {
      status: subscriptionStatus,
      currentPeriodEnd: "2999-01-01T00:00:00Z",
    },
  };
}

async function makeApp({ role = "owner", subscriptionStatus = "active" } = {}) {
  const calls = [];
  const app = await buildHttpApp({
    trustedOrigin: "https://pos.example.com",
    secureCookies: true,
    authService: {
      async authenticate(token) {
        return token ? { user: { id: userId, email: "owner@example.com" } } : null;
      },
      async register() {}, async verifyEmail() {}, async login() {}, async logout() {},
    },
    tenantContextService: {
      async load() { return tenant(role, subscriptionStatus); },
    },
    menuService: {
      async list(input) {
        calls.push(["menu", input]);
        return { categories: [], subcategories: [], items: [] };
      },
    },
    businessSettingsService: {
      async get(input) {
        calls.push(["settings:get", input]);
        return { businessName: "Example Cafe", currencyCode: "PKR" };
      },
      async update(input) {
        calls.push(["settings:update", input]);
        return { businessName: input.changes.businessName, currencyCode: "PKR" };
      },
    },
    orderService: {
      async create(input) {
        calls.push(["order:create", input]);
        return {
          order: { id: "order-1", orderNumber: 1, totalMinor: 1250 },
          replayed: false,
        };
      },
    },
    orderHistoryService: {
      async list(input) {
        calls.push(["orders:list", input]);
        return { orders: [{ id: "order-1" }], summary: { orderCount: 1 }, nextCursor: null };
      },
      async get(input) {
        calls.push(["orders:get", input]);
        return { order: { id: input.orderId }, items: [], charges: [], payments: [] };
      },
    },
    orderCancellationService: {
      async cancel(input) {
        calls.push(["order:cancel", input]);
        return {
          order: { id: input.orderId, orderStatus: "cancelled" },
          cancellation: { refundedMinor: 1250, restocked: [] },
          replayed: false,
        };
      },
    },
    catalogImportService: {
      async import(input) {
        calls.push(["catalog:import", input]);
        return { counts: { categories: 1, subcategories: 0, menuItems: 1 } };
      },
    },
  });
  apps.push(app);
  return { app, calls };
}

const authenticatedHeaders = {
  cookie: `pos_session=${"s".repeat(43)}`,
  "x-restaurant-id": restaurantId,
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("tenant-protected POS HTTP endpoints", () => {
  it("serves the menu only through trusted tenant context", async () => {
    const { app, calls } = await makeApp({ role: "cashier" });
    const response = await app.inject({
      method: "GET",
      url: "/api/pos/menu",
      headers: authenticatedHeaders,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(calls[0][0], "menu");
    assert.deepEqual(calls[0][1], { restaurantId, userId });
  });

  it("does not let cashiers read owner business settings", async () => {
    const { app, calls } = await makeApp({ role: "cashier" });
    const response = await app.inject({
      method: "GET",
      url: "/api/pos/settings/business",
      headers: authenticatedHeaders,
    });

    assert.equal(response.statusCode, 403);
    assert.equal(calls.length, 0);
  });

  it("validates and updates owner business settings", async () => {
    const { app, calls } = await makeApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/pos/settings/business",
      headers: { ...authenticatedHeaders, origin: "https://pos.example.com" },
      payload: { businessName: "Updated Cafe" },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().businessName, "Updated Cafe");
    assert.equal(calls[0][0], "settings:update");
  });

  it("blocks all POS endpoints when subscription access has expired", async () => {
    const { app, calls } = await makeApp({ subscriptionStatus: "expired" });
    const response = await app.inject({
      method: "GET",
      url: "/api/pos/menu",
      headers: authenticatedHeaders,
    });

    assert.equal(response.statusCode, 402);
    assert.equal(calls.length, 0);
  });

  it("validates and creates an order from trusted tenant context", async () => {
    const { app, calls } = await makeApp({ role: "cashier" });
    const response = await app.inject({
      method: "POST",
      url: "/api/pos/orders",
      headers: { ...authenticatedHeaders, origin: "https://pos.example.com" },
      payload: {
        idempotencyKey: "33333333-3333-4333-8333-333333333333",
        orderType: "takeaway",
        items: [{
          menuItemId: "44444444-4444-4444-8444-444444444444",
          quantity: 2,
        }],
        payment: { method: "cash", amountReceivedMinor: 1250 },
      },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(calls.at(-1)[0], "order:create");
    assert.equal(calls.at(-1)[1].tenant.restaurant.id, restaurantId);
    assert.equal(calls.at(-1)[1].userId, userId);
    assert.equal(calls.at(-1)[1].input.deliveryMinor, 0);
  });

  it("rejects client-supplied prices from the order contract", async () => {
    const { app, calls } = await makeApp({ role: "cashier" });
    const response = await app.inject({
      method: "POST",
      url: "/api/pos/orders",
      headers: { ...authenticatedHeaders, origin: "https://pos.example.com" },
      payload: {
        idempotencyKey: "33333333-3333-4333-8333-333333333333",
        orderType: "takeaway",
        items: [{
          menuItemId: "44444444-4444-4444-8444-444444444444",
          quantity: 1,
          priceMinor: 1,
        }],
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  it("allows managers to import a validated legacy catalog", async () => {
    const { app, calls } = await makeApp({ role: "manager" });
    const response = await app.inject({
      method: "POST",
      url: "/api/pos/import/legacy-catalog",
      headers: { ...authenticatedHeaders, origin: "https://pos.example.com" },
      payload: {
        pos_categories: ["Burgers"],
        pos_subcategories: {},
        pos_category_offers: {},
        pos_menu: [{ id: 1, category: "Burgers", name: "Zinger", price: 500 }],
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(calls.at(-1)[0], "catalog:import");
    assert.equal(calls.at(-1)[1].restaurantId, restaurantId);
  });
  it("does not allow cashiers to import a catalog", async () => {
    const { app, calls } = await makeApp({ role: "cashier" });
    const response = await app.inject({
      method: "POST",
      url: "/api/pos/import/legacy-catalog",
      headers: { ...authenticatedHeaders, origin: "https://pos.example.com" },
      payload: {
        pos_categories: [], pos_subcategories: {}, pos_category_offers: {}, pos_menu: [],
      },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(calls.length, 0);
  });

  it("lets any order-reading role page through tenant-scoped order history", async () => {
    const { app, calls } = await makeApp({ role: "waiter" });
    const response = await app.inject({
      method: "GET",
      url: "/api/pos/orders?businessDate=2026-10-02&limit=25",
      headers: authenticatedHeaders,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(calls.at(-1)[0], "orders:list");
    assert.equal(calls.at(-1)[1].tenant.restaurant.id, restaurantId);
    assert.deepEqual(calls.at(-1)[1].filters, { businessDate: "2026-10-02", limit: 25 });
  });

  it("rejects unusable history query parameters before the service runs", async () => {
    const { app, calls } = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/pos/orders?orderStatus=deleted",
      headers: authenticatedHeaders,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  it("requires a real order identifier for the detail route", async () => {
    const { app, calls } = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/pos/orders/not-a-uuid",
      headers: authenticatedHeaders,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  it("serves one order with its lines, charges, and payments", async () => {
    const { app, calls } = await makeApp({ role: "cashier" });
    const orderId = "44444444-4444-4444-8444-444444444444";
    const response = await app.inject({
      method: "GET",
      url: `/api/pos/orders/${orderId}`,
      headers: authenticatedHeaders,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(calls.at(-1)[0], "orders:get");
    assert.equal(calls.at(-1)[1].orderId, orderId);
  });

  it("lets managers cancel an order through trusted tenant context", async () => {
    const { app, calls } = await makeApp({ role: "manager" });
    const orderId = "44444444-4444-4444-8444-444444444444";
    const response = await app.inject({
      method: "POST",
      url: `/api/pos/orders/${orderId}/cancel`,
      headers: { ...authenticatedHeaders, origin: "https://pos.example.com" },
      payload: {
        reason: "Customer left",
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
      },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().order.orderStatus, "cancelled");
    assert.equal(calls.at(-1)[0], "order:cancel");
    assert.equal(calls.at(-1)[1].tenant.restaurant.id, restaurantId);
    assert.equal(calls.at(-1)[1].userId, userId);
    assert.equal(calls.at(-1)[1].reason, "Customer left");
  });

  it("does not let waiters cancel an order", async () => {
    const { app, calls } = await makeApp({ role: "waiter" });
    const response = await app.inject({
      method: "POST",
      url: "/api/pos/orders/44444444-4444-4444-8444-444444444444/cancel",
      headers: { ...authenticatedHeaders, origin: "https://pos.example.com" },
      payload: { idempotencyKey: "55555555-5555-4555-8555-555555555555" },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(calls.length, 0);
  });

  it("requires an idempotency key to cancel an order", async () => {
    const { app, calls } = await makeApp({ role: "manager" });
    const response = await app.inject({
      method: "POST",
      url: "/api/pos/orders/44444444-4444-4444-8444-444444444444/cancel",
      headers: { ...authenticatedHeaders, origin: "https://pos.example.com" },
      payload: { reason: "Customer left" },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(calls.length, 0);
  });
});
