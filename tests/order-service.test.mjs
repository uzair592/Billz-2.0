import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOrderService } from "../src/server/pos/order-service.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const branchId = "33333333-3333-4333-8333-333333333333";
const menuItemId = "44444444-4444-4444-8444-444444444444";
const stockItemId = "55555555-5555-4555-8555-555555555555";
const accountId = "66666666-6666-4666-8666-666666666666";
const idempotencyKey = "77777777-7777-4777-8777-777777777777";
const componentItemId = "99999999-9999-4999-8999-999999999999";
const now = new Date("2026-10-02T12:00:00.000Z");

function tenant() {
  return {
    restaurant: { id: restaurantId, timezone: "Asia/Karachi" },
    membership: { defaultBranchId: branchId },
  };
}

function input(overrides = {}) {
  return {
    idempotencyKey,
    orderType: "takeaway",
    items: [{ menuItemId, quantity: 2 }],
    discount: { type: "percent", value: 10 },
    deliveryMinor: 100,
    additionalCharges: [{ name: "Service", type: "percent", value: 10 }],
    payment: { method: "cash", amountReceivedMinor: 600 },
    ...overrides,
  };
}

function fakePool({ existingOrder = null, stockQuantity = 10, menuRows = null } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(text, values = []) {
      const normalized = text.replace(/\s+/g, " ").trim();
      calls.push({ text: normalized, values });
      if (normalized.includes("FROM orders") && normalized.includes("idempotency_key")) {
        return { rows: existingOrder ? [existingOrder] : [] };
      }
      if (normalized.includes("FROM menu_items")) {
        return { rows: menuRows ?? [{
          id: menuItemId,
          name: "Burger",
          item_type: "standard",
          price_minor: "500",
          other_cost_minor: "10",
          recipe: [{ stockItemId, quantityBaseUnits: "0.5" }],
          components: [],
        }] };
      }
      if (normalized.includes("FROM inventory_balances")) {
        return { rows: [{
          stock_item_id: stockItemId,
          quantity_base_units: String(stockQuantity),
          average_cost_minor_per_base_unit: "25.5",
        }] };
      }
      if (normalized.startsWith("INSERT INTO order_sequences")) {
        return { rows: [{ order_number: "7" }] };
      }
      if (normalized.startsWith("INSERT INTO orders")) {
        return { rows: [{
          id: values[0],
          order_number: values[4],
          order_type: values[5],
          order_status: "completed",
          payment_status: values[6],
          subtotal_minor: values[11],
          discount_minor: values[14],
          delivery_minor: values[15],
          additional_charges_minor: values[16],
          total_minor: values[17],
          business_date: values[19],
          ordered_at: values[20],
        }] };
      }
      if (normalized.includes("FROM financial_accounts") && normalized.includes("account_type = 'cash'")) {
        return { rows: [{ id: accountId }] };
      }
      return { rows: [] };
    },
    release() { released = true; },
  };
  return {
    calls,
    get released() { return released; },
    async connect() { return client; },
  };
}

describe("transactional order service", () => {
  it("prices, costs, reserves stock, records payment, and commits atomically", async () => {
    const pool = fakePool();
    const result = await createOrderService(pool, { clock: () => now }).create({
      tenant: tenant(),
      userId,
      input: input(),
    });

    assert.equal(result.replayed, false);
    assert.equal(result.order.orderNumber, 7);
    assert.equal(result.order.subtotalMinor, 1000);
    assert.equal(result.order.discountMinor, 100);
    assert.equal(result.order.totalMinor, 1100);
    assert.equal(result.order.paymentStatus, "partially_paid");
    assert.equal(result.order.businessDate, "2026-10-02");

    const orderInsert = pool.calls.find((call) => call.text.startsWith("INSERT INTO orders"));
    const itemInsert = pool.calls.find((call) => call.text.startsWith("INSERT INTO order_items"));
    const stockUpdate = pool.calls.find((call) => call.text.startsWith("UPDATE inventory_balances"));
    assert.equal(orderInsert.values[18], 46);
    assert.equal(itemInsert.values[8], 23);
    assert.deepEqual(JSON.parse(itemInsert.values[9]), {
      items: [{ stockItemId, quantityBaseUnits: 0.5 }],
      components: [],
      offer: null,
    });
    assert.equal(stockUpdate.values[3], 1);
    assert.ok(pool.calls.some((call) => call.text.startsWith("INSERT INTO order_payments")));
    assert.ok(pool.calls.some((call) => call.text.startsWith("INSERT INTO ledger_entries")));
    assert.equal(pool.calls.at(-1).text, "COMMIT");
    assert.equal(pool.released, true);
  });

  it("returns the original response for a repeated idempotency key", async () => {
    const existingOrder = {
      id: "88888888-8888-4888-8888-888888888888",
      order_number: "9",
      order_type: "takeaway",
      order_status: "completed",
      payment_status: "paid",
      subtotal_minor: "500",
      discount_minor: "0",
      delivery_minor: "0",
      additional_charges_minor: "0",
      total_minor: "500",
      business_date: "2026-10-02",
      ordered_at: now,
    };
    const pool = fakePool({ existingOrder });
    const result = await createOrderService(pool, { clock: () => now }).create({
      tenant: tenant(), userId, input: input(),
    });

    assert.equal(result.replayed, true);
    assert.equal(result.order.id, existingOrder.id);
    assert.equal(result.order.orderNumber, 9);
    assert.equal(pool.calls.some((call) => call.text.includes("FROM menu_items")), false);
    assert.equal(pool.calls.at(-1).text, "COMMIT");
  });

  it("rolls back without creating an order when recipe stock is insufficient", async () => {
    const pool = fakePool({ stockQuantity: 0.5 });
    await assert.rejects(
      createOrderService(pool, { clock: () => now }).create({
        tenant: tenant(), userId, input: input(),
      }),
      (error) => error.code === "INSUFFICIENT_STOCK" && error.statusCode === 409,
    );

    assert.equal(pool.calls.some((call) => call.text.startsWith("INSERT INTO orders")), false);
    assert.equal(pool.calls.at(-1).text, "ROLLBACK");
    assert.equal(pool.released, true);
  });

  it("recursively expands deal components into stock, cost, and immutable snapshots", async () => {
    const pool = fakePool({
      menuRows: [
        {
          id: menuItemId,
          name: "Burger Deal",
          item_type: "deal",
          price_minor: "900",
          other_cost_minor: "5",
          recipe: [],
          components: [{ menuItemId: componentItemId, quantity: "2" }],
        },
        {
          id: componentItemId,
          name: "Burger",
          item_type: "standard",
          price_minor: "500",
          other_cost_minor: "10",
          recipe: [{ stockItemId, quantityBaseUnits: "0.5" }],
          components: [],
        },
      ],
    });
    const result = await createOrderService(pool, { clock: () => now }).create({
      tenant: tenant(), userId, input: input(),
    });

    assert.equal(result.replayed, false);
    const orderInsert = pool.calls.find((call) => call.text.startsWith("INSERT INTO orders"));
    const itemInsert = pool.calls.find((call) => call.text.startsWith("INSERT INTO order_items"));
    const stockUpdate = pool.calls.find((call) => call.text.startsWith("UPDATE inventory_balances"));
    const snapshot = JSON.parse(itemInsert.values[9]);
    assert.equal(stockUpdate.values[3], 2);
    assert.equal(itemInsert.values[8], 51);
    assert.equal(orderInsert.values[18], 102);
    assert.equal(snapshot.components[0].menuItemId, componentItemId);
    assert.equal(snapshot.components[0].quantity, 2);
    assert.equal(snapshot.items[0].quantityBaseUnits, 1);
  });

  it("applies an active server-side item offer before category offers", async () => {
    const pool = fakePool({
      menuRows: [{
        id: menuItemId,
        name: "Burger",
        item_type: "standard",
        price_minor: "500",
        other_cost_minor: "10",
        offer_price_minor: "350",
        category_discount_type: "percent",
        category_discount_percent: "50",
        category_discount_minor: null,
        recipe: [{ stockItemId, quantityBaseUnits: "0.5" }],
        components: [],
      }],
    });
    await createOrderService(pool, { clock: () => now }).create({
      tenant: tenant(), userId, input: input({ discount: undefined }),
    });

    const menuQuery = pool.calls.find((call) => call.text.includes("FROM menu_items"));
    const itemInsert = pool.calls.find((call) => call.text.startsWith("INSERT INTO order_items"));
    const snapshot = JSON.parse(itemInsert.values[9]);
    assert.deepEqual(menuQuery.values, ["2026-10-02"]);
    assert.equal(itemInsert.values[6], 350);
    assert.equal(snapshot.offer.type, "item");
    assert.equal(snapshot.offer.regularPriceMinor, 500);
  });

  it("calculates category percentage offers with integer minor-unit rounding", async () => {
    const pool = fakePool({
      menuRows: [{
        id: menuItemId,
        name: "Burger",
        item_type: "standard",
        price_minor: "505",
        other_cost_minor: "10",
        offer_price_minor: null,
        category_discount_type: "percent",
        category_discount_percent: "10",
        category_discount_minor: null,
        recipe: [{ stockItemId, quantityBaseUnits: "0.5" }],
        components: [],
      }],
    });
    await createOrderService(pool, { clock: () => now }).create({
      tenant: tenant(), userId, input: input({ discount: undefined }),
    });

    const itemInsert = pool.calls.find((call) => call.text.startsWith("INSERT INTO order_items"));
    const snapshot = JSON.parse(itemInsert.values[9]);
    assert.equal(itemInsert.values[6], 454);
    assert.equal(snapshot.offer.type, "category");
    assert.equal(snapshot.offer.discountPercent, 10);
  });

  it("rolls back a circular deal component graph", async () => {
    const pool = fakePool({
      menuRows: [
        {
          id: menuItemId, name: "Deal A", item_type: "deal", price_minor: "900",
          other_cost_minor: "0", recipe: [],
          components: [{ menuItemId: componentItemId, quantity: "1" }],
        },
        {
          id: componentItemId, name: "Deal B", item_type: "deal", price_minor: "800",
          other_cost_minor: "0", recipe: [],
          components: [{ menuItemId, quantity: "1" }],
        },
      ],
    });
    await assert.rejects(
      createOrderService(pool, { clock: () => now }).create({
        tenant: tenant(), userId, input: input(),
      }),
      (error) => error.code === "INVALID_DEAL_CONFIGURATION" && error.statusCode === 409,
    );
    assert.equal(pool.calls.at(-1).text, "ROLLBACK");
  });
});
