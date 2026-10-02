import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createOrderHistoryService,
  decodeOrderCursor,
  encodeOrderCursor,
} from "../src/server/pos/order-history-service.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const branchId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-10-02T12:00:00.000Z");

function tenant(overrides = {}) {
  return {
    restaurant: { id: restaurantId, timezone: "Asia/Karachi" },
    membership: { userId, role: "manager", defaultBranchId: branchId },
    ...overrides,
  };
}

function orderRow(overrides = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    order_number: "12",
    order_type: "dine_in",
    order_status: "completed",
    payment_status: "paid",
    table_id: "55555555-5555-4555-8555-555555555555",
    table_number: "4",
    customer_name: "Guest",
    customer_phone: "03001234567",
    rider_name: null,
    subtotal_minor: "1000",
    discount_minor: "100",
    delivery_minor: "0",
    additional_charges_minor: "150",
    total_minor: "1050",
    business_date: "2026-10-02",
    ordered_at: now,
    cancelled_at: null,
    cancellation_reason: null,
    ...overrides,
  };
}

const summaryRow = {
  order_count: "3",
  cancelled_count: "1",
  sales_minor: "2000",
  cost_of_goods_minor: "700",
  paid_minor: "1800",
  due_minor: "200",
};

function fakePool({
  orders = [orderRow()],
  summary = summaryRow,
  detail = null,
  responses = new Map(),
} = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(text, values = []) {
      const normalized = text.replace(/\s+/g, " ").trim();
      calls.push({ text: normalized, values });
      if (normalized.includes("COUNT(*) FILTER")) {
        return { rows: [summary] };
      }
      for (const [fragment, rows] of responses) {
        if (normalized.includes(fragment)) return { rows };
      }
      if (normalized.includes("LEFT JOIN restaurant_tables")) {
        return { rows: detail ? [detail] : orders };
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

describe("order history service", () => {
  it("returns a tenant-scoped page with its revenue summary and next cursor", async () => {
    const pool = fakePool();
    const result = await createOrderHistoryService(pool, { clock: () => now }).list({
      tenant: tenant(),
      filters: { businessDate: "2026-10-02", limit: 2 },
    });

    assert.equal(result.orders.length, 1);
    assert.equal(result.orders[0].orderNumber, 12);
    assert.equal(result.orders[0].tableNumber, "4");
    assert.equal(result.orders[0].totalMinor, 1050);
    assert.equal(result.orders[0].businessDate, "2026-10-02");
    assert.deepEqual(result.summary, {
      orderCount: 3,
      cancelledCount: 1,
      salesMinor: 2000,
      costOfGoodsMinor: 700,
      paidMinor: 1800,
      dueMinor: 200,
    });

    const context = pool.calls.find((call) => (
      call.text.includes("set_config") && call.text.includes("app.restaurant_id")
    ));
    assert.deepEqual(context.values, [restaurantId]);
    const listQuery = pool.calls.find((call) => call.text.includes("FROM orders o"));
    assert.equal(listQuery.values[0], branchId);
    assert.equal(listQuery.values[1], "2026-10-02");
    assert.ok(listQuery.text.includes("o.branch_id = $1"));
    assert.equal(pool.calls.at(-1).text, "COMMIT");
    assert.equal(pool.released, true);
  });

  it("issues a next cursor only when another page exists", async () => {
    const rows = [
      orderRow({ order_number: "12" }),
      orderRow({ id: "66666666-6666-4666-8666-666666666666", order_number: "11" }),
      orderRow({ id: "77777777-7777-4777-8777-777777777777", order_number: "10" }),
    ];
    const pool = fakePool({ orders: rows });

    const page = await createOrderHistoryService(pool, { clock: () => now }).list({
      tenant: tenant(),
      filters: { businessDate: "2026-10-02", limit: 2 },
    });

    assert.equal(page.orders.length, 2);
    assert.deepEqual(decodeOrderCursor(page.nextCursor), {
      businessDate: "2026-10-02",
      orderNumber: 11,
    });
    assert.equal(page.nextCursor, encodeOrderCursor({
      businessDate: "2026-10-02",
      orderNumber: 11,
    }));
  });

  it("scopes the summary to revenue that excludes cancelled orders", async () => {
    const pool = fakePool();
    await createOrderHistoryService(pool, { clock: () => now }).list({
      tenant: tenant(),
      filters: { from: "2026-10-01", to: "2026-10-02" },
    });

    const summaryQuery = pool.calls.find((call) => call.text.includes("COUNT(*) FILTER"));
    assert.ok(
      summaryQuery.text.includes("WHERE o.order_status <> 'cancelled'"),
      "Cancelled orders must not be counted as sales.",
    );
    assert.ok(
      summaryQuery.text.includes("status = 'captured'"),
      "Refunded payments must not be counted as money received.",
    );
    assert.deepEqual(summaryQuery.values.slice(0, 4), [
      branchId, null, "2026-10-01", "2026-10-02",
    ]);
  });

  it("rejects unusable history filters before opening a transaction", async () => {
    const service = createOrderHistoryService(fakePool(), { clock: () => now });
    const cases = [
      [{ businessDate: "2026-10-02", from: "2026-10-01" }, "CONFLICTING_DATE_FILTERS"],
      [{ businessDate: "not-a-date" }, "INVALID_BUSINESS_DATE"],
      [{ from: "2026-10-02", to: "2026-10-01" }, "INVALID_DATE_RANGE"],
      [{ businessDate: "2999-01-01" }, "FUTURE_BUSINESS_DATE"],
      [{ limit: 0 }, "INVALID_PAGE_SIZE"],
      [{ limit: 5000 }, "INVALID_PAGE_SIZE"],
      [{ cursor: "not-base64-json" }, "INVALID_CURSOR"],
    ];

    for (const [filters, code] of cases) {
      await assert.rejects(
        service.list({ tenant: tenant(), filters }),
        (error) => error.code === code,
        `Expected ${code} for ${JSON.stringify(filters)}`,
      );
    }
  });

  it("hides an order that the tenant cannot see", async () => {
    const service = createOrderHistoryService(fakePool({ orders: [] }), { clock: () => now });
    await assert.rejects(
      service.get({ tenant: tenant(), orderId: "88888888-8888-4888-8888-888888888888" }),
      (error) => error.code === "ORDER_NOT_FOUND" && error.statusCode === 404,
    );
  });

  it("returns the immutable order record with its lines, charges, and payments", async () => {
    const detail = {
      ...orderRow({ cancelled_at: now, cancellation_reason: "Wrong table" }),
      discount_type: "percent",
      discount_value: "10",
      cost_of_goods_minor: "400",
      completed_at: now,
      legacy_order_id: "18",
    };
    const responses = new Map([
      ["FROM order_items", [{
        id: "99999999-9999-4999-8999-999999999999",
        menu_item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        item_name_snapshot: "Burger",
        quantity: "2",
        unit_price_minor: "500",
        line_total_minor: "1000",
        unit_cost_minor: "200",
        recipe_snapshot: { items: [] },
        notes: null,
      }]],
      ["FROM order_charges", [{
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        name: "Service",
        charge_type: "percent",
        charge_value: "10",
        amount_minor: "150",
      }]],
      ["FROM order_payments", [{
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        financial_account_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        account_name: "Main Cash",
        payment_method: "cash",
        status: "captured",
        amount_minor: "1050",
        received_at: now,
      }]],
      ["FROM order_edit_events", []],
      ["FROM order_cancellations", []],
    ]);
    const pool = fakePool({ detail, responses });

    const result = await createOrderHistoryService(pool, { clock: () => now }).get({
      tenant: tenant(),
      orderId: detail.id,
    });

    assert.equal(result.order.orderNumber, 12);
    assert.equal(result.order.discountType, "percent");
    assert.equal(result.order.discountValue, 10);
    assert.equal(result.order.costOfGoodsMinor, 400);
    assert.equal(result.order.legacyOrderId, 18);
    assert.equal(result.order.cancellationReason, "Wrong table");
    assert.equal(result.items[0].name, "Burger");
    assert.equal(result.items[0].quantity, 2);
    assert.equal(result.items[0].unitCostMinor, 200);
    assert.equal(result.charges[0].amountMinor, 150);
    assert.equal(result.payments[0].accountName, "Main Cash");
    assert.equal(result.cancellation, null);

    for (const [table, query] of [
      ["order_items", "FROM order_items"],
      ["order_charges", "FROM order_charges"],
      ["order_payments", "FROM order_payments"],
      ["order_edit_events", "FROM order_edit_events"],
      ["order_cancellations", "FROM order_cancellations"],
    ]) {
      const call = pool.calls.find((candidate) => candidate.text.includes(query));
      assert.ok(call, `Expected a ${table} lookup.`);
      assert.ok(
        /WHERE \w*\.?order_id = \$1/.test(call.text),
        `${table} must be read by the requested order identifier.`,
      );
      assert.deepEqual(call.values, [detail.id]);
    }
    assert.equal(pool.calls.at(-1).text, "COMMIT");
    assert.equal(pool.released, true);
  });
});
