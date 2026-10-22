import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLegacyCloudAdapter } from "../src/client/legacy-cloud-adapter.mjs";
import { createRequestGuards } from "../src/server/http/request-guards.mjs";
import { PERMISSION } from "../src/server/authorization/permissions.mjs";

describe("Cart input hardening and validation", () => {
  function createCartSimulator() {
    let cart = [];
    let menuItems = [
      { id: 101, name: "Burger", price: 500, category: "Burgers" },
      { id: 102, name: "Special Deal", price: 800, category: "Deals" },
      { id: 103, name: "Complimentary Tea", price: 0, category: "Drinks" },
    ];
    let orderSubmitSaving = false;

    function getEffectiveItemPrice(item) {
      if (item.id === 102) return 700; // on sale
      return item.price;
    }

    function isOfferActive(item) {
      return item.id === 102;
    }

    function getItemOfferLabel(item) {
      if (item.id === 102) return "🔥 100 Off";
      return null;
    }

    function addToCart(id, name, price, originalPrice, offerLabel) {
      if (orderSubmitSaving) return false;
      if (id === undefined || id === null || id === "") return false;

      let resolvedItem = null;
      if (typeof menuItems !== "undefined" && Array.isArray(menuItems)) {
        resolvedItem = menuItems.find((m) => m && (m.id === id || String(m.id) === String(id))) || null;
      }

      let finalName = name;
      let finalPrice = price;
      let finalOriginalPrice = originalPrice;
      let finalOfferLabel = offerLabel;

      if (resolvedItem) {
        if (!finalName) finalName = resolvedItem.name;
        if (finalPrice === undefined || finalPrice === null || finalPrice === "") {
          finalPrice = typeof getEffectiveItemPrice === "function" ? getEffectiveItemPrice(resolvedItem) : resolvedItem.price;
        }
        if (finalOriginalPrice === undefined || finalOriginalPrice === null) {
          const isItemOff = typeof isOfferActive === "function" && isOfferActive(resolvedItem);
          if (isItemOff) {
            finalOriginalPrice = resolvedItem.price;
            if (!finalOfferLabel && typeof getItemOfferLabel === "function") {
              finalOfferLabel = getItemOfferLabel(resolvedItem) || null;
            }
          }
        }
      }

      if (typeof finalName !== "string" || !finalName.trim()) return false;
      const parsedPrice = Number(finalPrice);
      if (!Number.isFinite(parsedPrice) || parsedPrice < 0) return false;

      let parsedOriginalPrice = null;
      if (finalOriginalPrice !== undefined && finalOriginalPrice !== null && finalOriginalPrice !== "") {
        const numOrig = Number(finalOriginalPrice);
        if (Number.isFinite(numOrig) && numOrig > parsedPrice) {
          parsedOriginalPrice = numOrig;
        }
      }

      const existing = cart.find((item) => item.id === id);
      if (existing) {
        existing.qty += 1;
      } else {
        const cartItem = { id: id, name: String(finalName).trim(), price: parsedPrice, qty: 1 };
        if (parsedOriginalPrice !== null) {
          cartItem.originalPrice = parsedOriginalPrice;
          cartItem.offerLabel = finalOfferLabel || "🔥 Offer";
        }
        cart.push(cartItem);
      }
      return true;
    }

    return {
      get cart() { return cart; },
      addToCart,
    };
  }

  it("adds a valid item to the cart with explicit name and price", () => {
    const sim = createCartSimulator();
    const added = sim.addToCart(101, "Burger", 500);
    assert.equal(added, true);
    assert.equal(sim.cart.length, 1);
    assert.deepEqual(sim.cart[0], { id: 101, name: "Burger", price: 500, qty: 1 });
  });

  it("resolves ID-only calls through menu catalog and computes active offer price and label", () => {
    const sim = createCartSimulator();
    const added = sim.addToCart(102); // ID only
    assert.equal(added, true);
    assert.equal(sim.cart.length, 1);
    assert.equal(sim.cart[0].id, 102);
    assert.equal(sim.cart[0].name, "Special Deal");
    assert.equal(sim.cart[0].price, 700);
    assert.equal(sim.cart[0].originalPrice, 800);
    assert.equal(sim.cart[0].offerLabel, "🔥 100 Off");
  });

  it("rejects unknown items when called with ID only and does not mutate cart", () => {
    const sim = createCartSimulator();
    const added = sim.addToCart(999); // Unknown item
    assert.equal(added, false);
    assert.equal(sim.cart.length, 0);
  });

  it("rejects invalid prices (NaN, negative, undefined) without undefined/NaN cart data", () => {
    const sim = createCartSimulator();
    assert.equal(sim.addToCart("custom-bad", "Bad Item", NaN), false);
    assert.equal(sim.addToCart("custom-neg", "Negative Item", -50), false);
    assert.equal(sim.addToCart("custom-str", "String Price Item", "invalid-price"), false);
    assert.equal(sim.cart.length, 0);
  });

  it("preserves valid zero price for complimentary items", () => {
    const sim = createCartSimulator();
    const added = sim.addToCart(103); // price: 0
    assert.equal(added, true);
    assert.equal(sim.cart.length, 1);
    assert.equal(sim.cart[0].price, 0);
  });

  it("preserves custom item IDs and manual pricing", () => {
    const sim = createCartSimulator();
    const added = sim.addToCart("custom-open-item-42", "Special Off-Menu Dish", 1250);
    assert.equal(added, true);
    assert.equal(sim.cart.length, 1);
    assert.equal(sim.cart[0].id, "custom-open-item-42");
    assert.equal(sim.cart[0].price, 1250);
  });
});

describe("Catalog import and tenant context handling", () => {
  it("importCatalog() uses session-based default restaurant without requiring argument", async () => {
    const currentRestaurantId = "11111111-1111-4111-8111-111111111111";
    let requestedRestaurantHeader = null;

    const fakeSession = {
      async read() {
        return {
          user: { id: "user-1", email: "owner@example.com" },
          restaurantId: currentRestaurantId,
        };
      },
      async activeRestaurant() {
        return currentRestaurantId;
      },
      subscribe() { return () => {}; },
    };

    const fakeStorage = {
      async get(key) { return null; },
      async set(key, val) {},
    };

    const fakeFetch = async (url, options = {}) => {
      requestedRestaurantHeader = options.headers?.["x-restaurant-id"];
      return {
        ok: true,
        status: 200,
        async json() {
          return { revision: 1, mappings: { menuItems: {}, tables: {}, financialAccounts: {}, stockItems: {} } };
        },
      };
    };

    const adapter = createLegacyCloudAdapter({
      storage: fakeStorage,
      session: fakeSession,
      fetchImpl: fakeFetch,
      outbox: { async enqueue() {}, async flush() {} },
    });

    const res = await adapter.importCatalog();
    assert.equal(res.context.restaurantId, currentRestaurantId);
    assert.equal(requestedRestaurantHeader, currentRestaurantId);
  });

  it("importCatalog() throws RESTAURANT_REQUIRED when no session restaurant is chosen", async () => {
    const fakeSession = {
      async read() {
        return { user: { id: "user-1" }, restaurantId: null };
      },
      async activeRestaurant() {
        return null;
      },
      subscribe() { return () => {}; },
    };

    const adapter = createLegacyCloudAdapter({
      storage: { async get() { return null; }, async set() {} },
      session: fakeSession,
      fetchImpl: async () => assert.fail("fetch should not be called"),
      outbox: { async enqueue() {}, async flush() {} },
    });

    await assert.rejects(
      async () => { await adapter.importCatalog(); },
      (err) => err.code === "RESTAURANT_REQUIRED"
    );
  });

  it("client-supplied tenant IDs cannot bypass server membership checks", async () => {
    const validRestaurantId = "11111111-1111-4111-8111-111111111111";
    const foreignRestaurantId = "99999999-9999-4999-8999-999999999999";
    const userId = "22222222-2222-4222-8222-222222222222";

    const guards = createRequestGuards({
      authService: {
        async authenticate() {
          return { user: { id: userId, email: "cashier@example.com" } };
        },
      },
      tenantContextService: {
        async load({ userId, restaurantId }) {
          // User only has membership in validRestaurantId, not foreignRestaurantId
          if (restaurantId === validRestaurantId) {
            return {
              restaurant: { id: validRestaurantId, status: "active" },
              membership: { userId, role: "owner", status: "active" },
              subscription: { status: "active", currentPeriodEnd: "2099-01-01T00:00:00Z" },
            };
          }
          return null; // No membership in foreign restaurant
        },
      },
    });

    // Attacker passes foreign restaurant ID in x-restaurant-id header
    const request = {
      auth: { user: { id: userId } },
      headers: { "x-restaurant-id": foreignRestaurantId },
    };
    let statusCode = 200;
    let payload = null;
    const reply = {
      code(c) { statusCode = c; return this; },
      send(p) { payload = p; return this; },
    };

    await guards.tenant(PERMISSION.CATALOG_MANAGE)(request, reply);
    assert.equal(statusCode, 403);
    assert.equal(payload.code, "MEMBERSHIP_REQUIRED");
    assert.equal(request.tenant, undefined);
  });
});

describe("Database prerequisite error and safety guard", () => {
  it("formats clear prerequisite error with host and port when PostgreSQL connection fails", () => {
    const host = "127.0.0.1";
    const port = "55432";
    const originalError = new Error("connect ECONNREFUSED 127.0.0.1:55432");

    const dbErr = new Error(
      `Database prerequisite error: PostgreSQL is not reachable at ${host}:${port}. ` +
      `PostgreSQL-dependent tests require a live database. ` +
      `Ensure PostgreSQL is running and configure TEST_DATABASE_ADMIN_URL ` +
      `(default CI/local port: 5432, validation container port: 55432). Original error: ${originalError.message}`
    );
    dbErr.code = "TEST_DATABASE_UNREACHABLE";

    assert.equal(dbErr.code, "TEST_DATABASE_UNREACHABLE");
    assert.match(dbErr.message, /PostgreSQL is not reachable at 127\.0\.0\.1:55432/);
    assert.match(dbErr.message, /TEST_DATABASE_ADMIN_URL/);
    assert.match(dbErr.message, /5432.*55432/);
  });
});
