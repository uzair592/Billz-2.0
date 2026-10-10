import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOrderCancellationService } from "../src/server/pos/order-cancellation-service.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const branchId = "33333333-3333-4333-8333-333333333333";
const orderId = "44444444-4444-4444-8444-444444444444";
const paymentId = "55555555-5555-4555-8555-555555555555";
const accountId = "66666666-6666-4666-8666-666666666666";
const stockItemId = "77777777-7777-4777-8777-777777777777";
const idempotencyKey = "88888888-8888-4888-8888-888888888888";
const now = new Date("2026-10-02T12:00:00.000Z");

function tenant() {
  return {
    restaurant: { id: restaurantId, timezone: "Asia/Karachi" },
    membership: { userId, role: "manager", defaultBranchId: branchId },
  };
}

function orderRow(overrides = {}) {
  return {
    id: orderId,
    branch_id: branchId,
    order_number: "12",
    order_status: "completed",
    payment_status: "paid",
    total_minor: "1050",
    ...overrides,
  };
}

function fakePool({
  order = orderRow(),
  reversals = [{ stock_item_id: stockItemId, quantity_delta: "1.5" }],
  payments = [],
  existingCancellation = null,
} = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(text, values = []) {
      const normalized = text.replace(/\s+/g, " ").trim();
      calls.push({ text: normalized, values });
      if (normalized.includes("FROM orders") && normalized.includes("FOR UPDATE")) {
        return { rows: order ? [order] : [] };
      }
      if (normalized.includes("FROM order_cancellations")) {
        return { rows: existingCancellation ? [existingCancellation] : [] };
      }
      if (normalized.startsWith("WITH sales AS")) {
        return { rows: reversals };
      }
      if (normalized.startsWith("UPDATE order_payments")) {
        return { rows: payments };
      }
      if (normalized.startsWith("INSERT INTO order_cancellations")) {
        return {
          rows: [{
            cancelled_at: now,
            reason: values[3],
            refunded_minor: String(values[6]),
            restocked: JSON.parse(values[7]),
          }],
        };
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

function cancel(pool, overrides = {}) {
  return createOrderCancellationService(pool, { clock: () => now }).cancel({
    tenant: tenant(),
    userId,
    orderId,
    reason: "Customer left",
    idempotencyKey,
    ...overrides,
  });
}

describe("order cancellation service", () => {
  it("restocks consumed stock, excludes revenue, and records the audit trail", async () => {
    const pool = fakePool();
    const result = await cancel(pool);

    assert.equal(result.replayed, false);
    assert.equal(result.order.orderStatus, "cancelled");
    assert.equal(result.order.paymentStatus, "paid");
    assert.equal(result.cancellation.refundedMinor, 0);
    assert.deepEqual(result.cancellation.restocked, [
      { stockItemId, quantityBaseUnits: 1.5 },
    ]);

    const restock = pool.calls.find((call) => call.text.startsWith("UPDATE inventory_balances"));
    assert.deepEqual(restock.values, [
      restaurantId, branchId, stockItemId, "1.5", now,
    ]);

    const orderUpdate = pool.calls.find((call) => call.text.startsWith("UPDATE orders"));
    assert.match(orderUpdate.text, /SET order_status = 'cancelled'/);
    assert.deepEqual(orderUpdate.values, [
      restaurantId, orderId, "paid", now, "Customer left", userId,
    ]);

    const event = pool.calls.find((call) => call.text.startsWith("INSERT INTO order_edit_events"));
    const changes = JSON.parse(event.values[3]);
    assert.equal(changes[0].to, "cancelled");
    assert.equal(changes[1].to, 0);
    assert.match(event.values[4], /Reason: Customer left/);
    assert.match(event.values[4], /Restocked/);
    assert.equal(pool.calls.at(-1).text, "COMMIT");
    assert.equal(pool.released, true);
  });

  it("refunds captured payments into the same account and reverses the ledger", async () => {
    const pool = fakePool({
      payments: [{
        id: paymentId,
        financial_account_id: accountId,
        amount_minor: "1050",
      }],
    });
    const result = await cancel(pool);

    assert.equal(result.order.paymentStatus, "refunded");
    assert.equal(result.cancellation.refundedMinor, 1050);

    const refund = pool.calls.find((call) => call.text.startsWith("UPDATE order_payments"));
    assert.match(refund.text, /SET status = 'refunded'/);
    assert.match(refund.text, /status IN \('captured', 'partially_refunded'\)/);

    const ledger = pool.calls.find((call) => call.text.startsWith("INSERT INTO ledger_entries"));
    assert.match(ledger.text, /'debit'/);
    assert.match(ledger.text, /'refund'/);
    assert.match(ledger.text, /ON CONFLICT DO NOTHING/);
    assert.deepEqual(ledger.values, [
      restaurantId, branchId, accountId, paymentId, 1050,
      "Refund / Cancelled Order #12", `refund:${orderId}:${paymentId}`, now,
    ]);
  });

  it("reverses each consumed stock item exactly once", async () => {
    const pool = fakePool();
    await cancel(pool);

    const reversal = pool.calls.find((call) => call.text.startsWith("WITH sales AS"));
    assert.match(reversal.text, /movement_type = 'sale'/);
    assert.match(reversal.text, /'sale_reversal'/);
    assert.match(reversal.text, /idempotency_key/);
    assert.match(reversal.text, /DO NOTHING/);
    assert.deepEqual(reversal.values, [
      restaurantId, orderId, branchId, now, userId,
    ]);
    assert.equal(
      pool.calls.filter((call) => call.text.startsWith("UPDATE inventory_balances")).length,
      1,
    );
  });

  it("returns the stored cancellation instead of compensating twice", async () => {
    const pool = fakePool({
      existingCancellation: {
        cancelled_at: now,
        reason: "Customer left",
        refunded_minor: "1050",
        restocked: [{ stockItemId, quantityBaseUnits: 1.5 }],
      },
    });
    const result = await cancel(pool);

    assert.equal(result.replayed, true);
    assert.equal(result.cancellation.refundedMinor, 1050);
    assert.equal(
      pool.calls.some((call) => call.text.startsWith("WITH sales AS")),
      false,
      "A replay must not reverse stock again.",
    );
    assert.equal(
      pool.calls.some((call) => call.text.startsWith("UPDATE inventory_balances")),
      false,
    );
    assert.equal(pool.calls.at(-1).text, "COMMIT");
  });

  it("refuses to cancel an order from another restaurant", async () => {
    const pool = fakePool({ order: null });
    await assert.rejects(
      cancel(pool),
      (error) => error.code === "ORDER_NOT_FOUND" && error.statusCode === 404,
    );
    assert.equal(
      pool.calls.some((call) => call.text.startsWith("WITH sales AS")),
      false,
    );
    assert.equal(pool.calls.at(-1).text, "ROLLBACK");
  });

  it("rolls back and exposes no compensation when stock reversal fails", async () => {
    const calls = [];
    const client = {
      async query(text, values = []) {
        const normalized = text.replace(/\s+/g, " ").trim();
        calls.push({ text: normalized, values });
        if (normalized.includes("FOR UPDATE")) return { rows: [orderRow()] };
        if (normalized.includes("FROM order_cancellations")) return { rows: [] };
        if (normalized.startsWith("WITH sales AS")) throw new Error("deadlock detected");
        return { rows: [] };
      },
      release() {},
    };
    await assert.rejects(
      createOrderCancellationService({ async connect() { return client; } }, { clock: () => now })
        .cancel({ tenant: tenant(), userId, orderId, idempotencyKey }),
      /deadlock detected/,
    );
    assert.equal(
      calls.some((call) => call.text.startsWith("UPDATE orders")),
      false,
    );
    assert.equal(calls.at(-1).text, "ROLLBACK");
  });

  it("does not duplicate an order status update for a foreign cancellation record", async () => {
    const pool = fakePool({ order: orderRow({ order_status: "cancelled" }) });
    await assert.rejects(
      cancel(pool),
      (error) => error.code === "ORDER_ALREADY_CANCELLED" && error.statusCode === 409,
    );
    assert.equal(pool.calls.at(-1).text, "ROLLBACK");
  });
});
