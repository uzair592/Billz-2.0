import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCloudOrderPayload,
  CLOUD_CONTEXT_KEY,
  createLegacyCloudAdapter,
} from "../src/client/legacy-cloud-adapter.mjs";
import { createOrderOutbox } from "../src/client/order-outbox.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const menuId = "22222222-2222-4222-8222-222222222222";
const tableId = "33333333-3333-4333-8333-333333333333";
const accountId = "44444444-4444-4444-8444-444444444444";

function memoryStorage() {
  const values = new Map();
  return {
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value) { values.set(key, structuredClone(value)); },
  };
}

const mappings = {
  menuItems: { 7: menuId },
  tables: { 4: tableId },
  financialAccounts: { 9: accountId },
};

function legacyOrder(overrides = {}) {
  return {
    id: 18,
    date: "2026-10-02",
    orderType: "Dine-In",
    tableNumber: 4,
    customerName: "Guest",
    customerPhone: "03001234567",
    deliveryCharges: 0,
    discountType: "percent",
    discountValue: 10,
    additionalCharges: [{ name: "Tax", type: "percent", value: 5, enabled: true }],
    totalBill: 945,
    paymentStatus: "Paid",
    paymentMethod: "Bank Account",
    paymentAccountId: 9,
    items: [{ id: 7, name: "Burger", price: 1, qty: 2 }],
    ...overrides,
  };
}

describe("legacy cloud adapter", () => {
  it("maps local identifiers while excluding browser prices", () => {
    const payload = buildCloudOrderPayload(legacyOrder(), mappings);
    assert.deepEqual(payload.items, [{ menuItemId: menuId, quantity: 2 }]);
    assert.equal(payload.tableId, tableId);
    assert.equal(payload.payment.financialAccountId, accountId);
    assert.equal(payload.payment.amountReceivedMinor, 94_500);
    assert.equal(payload.discount.value, 10);
    assert.equal(payload.items[0].price, undefined);
  });

  it("refuses orders with unmapped legacy identifiers", () => {
    assert.throws(
      () => buildCloudOrderPayload(legacyOrder({ items: [{ id: 99, qty: 1 }] }), mappings),
      (error) => error.code === "LEGACY_MAPPING_MISSING" && error.retriable === false,
    );
  });

  it("persists mappings only after a successful catalog import", async () => {
    const storage = memoryStorage();
    let request;
    const adapter = createLegacyCloudAdapter({
      storage,
      outbox: { async enqueue() {}, async flush() { return []; } },
      async fetchImpl(url, options) {
        request = { url, options };
        return { ok: true, status: 200, async json() { return { ...mappings, counts: {} }; } };
      },
    });
    await adapter.importCatalog({ restaurantId, snapshot: { pos_menu: [] } });

    const context = await storage.get(CLOUD_CONTEXT_KEY);
    assert.equal(request.url, "/api/pos/import/legacy-catalog");
    assert.equal(request.options.headers["x-restaurant-id"], restaurantId);
    assert.equal(context.restaurantId, restaurantId);
    assert.deepEqual(context.mappings, mappings);
  });

  it("does not enqueue until catalog mappings have been accepted", async () => {
    let enqueues = 0;
    const adapter = createLegacyCloudAdapter({
      storage: memoryStorage(),
      outbox: {
        async enqueue() { enqueues += 1; },
        async flush() { return []; },
      },
    });
    assert.deepEqual(await adapter.enqueueLegacyOrder(legacyOrder()), { status: "not_configured" });
    assert.equal(enqueues, 0);
  });

  it("serializes two tab flushes under one browser lock", async () => {
    const storage = memoryStorage();
    await storage.set(CLOUD_CONTEXT_KEY, { restaurantId, mappings });
    let lockQueue = Promise.resolve();
    const withLock = (operation) => {
      const result = lockQueue.then(operation, operation);
      lockQueue = result.catch(() => undefined);
      return result;
    };
    let sends = 0;
    const makeOutbox = () => createOrderOutbox({
      storage,
      transport: { async send() { sends += 1; return { order: { id: "cloud-order" } }; } },
      withLock,
      createId: () => "55555555-5555-4555-8555-555555555555",
    });
    const first = createLegacyCloudAdapter({ storage, outbox: makeOutbox() });
    const second = createLegacyCloudAdapter({ storage, outbox: makeOutbox() });
    await Promise.all([
      first.enqueueLegacyOrder(legacyOrder()),
      second.enqueueLegacyOrder(legacyOrder()),
    ]);
    assert.equal(sends, 1);
  });

  it("imports this device's own catalog for the signed-in restaurant", async () => {
    const storage = memoryStorage();
    await storage.set("pos_stock_item_defs", { Dough: { label: "Dough", buyUnit: "kg", sellUnit: "kg" } });
    await storage.set("pos_ingredient_stock", { Dough: { stockGrams: 5_000 } });
    await storage.set("pos_menu", [{ id: 7, category: "Burgers", name: "Burger", price: 500 }]);
    await storage.set("pos_categories", ["Burgers"]);

    let request;
    const adapter = createLegacyCloudAdapter({
      storage,
      outbox: { async enqueue() {}, async flush() { return []; } },
      session: { async activeRestaurant() { return restaurantId; } },
      async fetchImpl(url, options) {
        request = { url, options };
        return { ok: true, status: 200, async json() { return { ...mappings, counts: {} }; } };
      },
    });

    const { context } = await adapter.importCatalog();
    const payload = JSON.parse(request.options.body);

    assert.equal(request.options.headers["x-restaurant-id"], restaurantId);
    assert.equal(context.restaurantId, restaurantId);
    assert.deepEqual(payload.pos_menu, [{
      id: 7,
      category: "Burgers",
      subcategory: null,
      name: "Burger",
      desc: "",
      price: 500,
    }]);
    assert.deepEqual(payload.pos_stock_item_defs, {
      Dough: { label: "Dough", buyUnit: "kg", sellUnit: "kg" },
    });
  });

  it("refuses to import before a restaurant has been chosen", async () => {
    let requests = 0;
    const adapter = createLegacyCloudAdapter({
      storage: memoryStorage(),
      outbox: { async enqueue() {}, async flush() { return []; } },
      session: { async activeRestaurant() { return null; } },
      async fetchImpl() { requests += 1; },
    });

    await assert.rejects(
      adapter.importCatalog(),
      (error) => error.code === "RESTAURANT_REQUIRED" && error.retriable === false,
    );
    assert.equal(requests, 0);
  });

  it("does not activate cloud ordering when the import is rejected", async () => {
    const storage = memoryStorage();
    const adapter = createLegacyCloudAdapter({
      storage,
      outbox: { async enqueue() {}, async flush() { return []; } },
      session: { async activeRestaurant() { return restaurantId; } },
      async fetchImpl() {
        return {
          ok: false,
          status: 400,
          async json() {
            return { error: "Menu item 7 references an unknown category.", code: "INVALID_LEGACY_CATALOG" };
          },
        };
      },
    });

    await assert.rejects(
      adapter.importCatalog({ snapshot: { pos_menu: [] } }),
      (error) => error.code === "INVALID_LEGACY_CATALOG" && error.retriable === false,
    );
    assert.equal(await storage.get(CLOUD_CONTEXT_KEY), undefined);
  });
});
