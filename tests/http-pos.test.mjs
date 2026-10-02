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
});
