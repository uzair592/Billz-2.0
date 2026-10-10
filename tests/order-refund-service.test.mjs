import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOrderRefundService } from "../src/server/pos/order-refund-service.mjs";

const RESTAURANT_ID = "11111111-1111-4111-a111-111111111111";
const BRANCH_ID = "22222222-2222-4222-a222-222222222222";
const USER_ID = "33333333-3333-4333-a333-333333333333";
const ORDER_ID = "44444444-4444-4444-a444-444444444444";
const ORDER_ITEM_ID = "55555555-5555-4555-a555-555555555555";
const ORDER_ITEM_ID_2 = "55555555-5555-4555-a555-555555555556";
const PAYMENT_ID = "66666666-6666-4666-a666-666666666666";
const PAYMENT_ID_2 = "66666666-6666-4666-a666-666666666667";
const ACCOUNT_ID = "77777777-7777-4777-a777-777777777777";
const STOCK_ITEM_ID = "88888888-8888-4888-a888-888888888888";

function createMockPool({ order, orderItems = [], payments = [], existingRefunds = [], orderCharges = [], failOnSql = null } = {}) {
  const state = {
    order: order ? { ...order } : null,
    orderItems: orderItems.map((i) => ({ ...i })),
    payments: payments.map((p) => ({ ...p })),
    refunds: existingRefunds.map((r) => ({ ...r })),
    refundItems: [],
    refundTenders: [],
    ledgerEntries: [],
    stockMovements: [],
    inventoryBalances: new Map(),
    editEvents: [],
    orderCharges: orderCharges.map((c) => ({ ...c })),
  };

  const pool = {
    async connect() {
      // Transaction snapshot so ROLLBACK genuinely undoes writes,
      // mirroring real PostgreSQL transaction semantics.
      let snapshot = null;
      return {
        async query(sql, params = []) {
          const lowerSql = sql.toLowerCase();
          const trimmed = lowerSql.trim();

          if (trimmed === "begin") {
            snapshot = structuredClone(state);
            return { rows: [] };
          }
          if (trimmed === "rollback") {
            if (snapshot) {
              for (const key of Object.keys(state)) delete state[key];
              Object.assign(state, structuredClone(snapshot));
              snapshot = null;
            }
            return { rows: [] };
          }
          if (trimmed === "commit") {
            snapshot = null;
            return { rows: [] };
          }

          if (failOnSql && lowerSql.includes(failOnSql)) {
            throw new Error("injected failure");
          }

          if (lowerSql.includes("pg_advisory_xact_lock")) {
            return { rows: [] };
          }

          if (lowerSql.includes("from orders") && lowerSql.includes("where id =")) {
            if (!state.order || state.order.id !== params[0]) {
              return { rows: [] };
            }
            return { rows: [state.order] };
          }

          if (lowerSql.includes("from order_refunds") && lowerSql.includes("idempotency_key = $2")) {
            const match = state.refunds.find((r) => r.idempotency_key === params[1]);
            return { rows: match ? [match] : [] };
          }

          if (lowerSql.includes("from order_refunds") && lowerSql.includes("sum(total_refunded_minor)")) {
            const total = state.refunds
              .filter((r) => r.order_id === params[1] && r.status === "completed")
              .reduce((sum, r) => sum + (Number(r.total_refunded_minor) || 0), 0);
            return { rows: [{ total_refunded: total }] };
          }

          if (lowerSql.includes("from order_items") && lowerSql.includes("where restaurant_id =")) {
            const items = state.orderItems.filter((i) => i.order_id === params[1]);
            return { rows: items };
          }

          if (lowerSql.includes("from order_charges")) {
            const total = state.orderCharges
              .filter((c) => c.order_id === params[1] && /tax/i.test(c.name))
              .reduce((sum, c) => sum + (Number(c.amount_minor) || 0), 0);
            return { rows: [{ tax_minor: total }] };
          }

          if (lowerSql.includes("from order_refund_items") && lowerSql.includes("group by ri.order_item_id")) {
            const map = new Map();
            for (const ri of state.refundItems) {
              map.set(ri.order_item_id, (map.get(ri.order_item_id) || 0) + Number(ri.quantity));
            }
            const rows = Array.from(map.entries()).map(([order_item_id, qty_refunded]) => ({
              order_item_id,
              qty_refunded,
            }));
            return { rows };
          }

          if (lowerSql.includes("from order_payments") && lowerSql.includes("where restaurant_id =")) {
            const p = state.payments.filter((p) => p.order_id === params[1]);
            return { rows: p };
          }

          if (lowerSql.includes("from order_refund_tenders") && lowerSql.includes("group by order_payment_id")) {
            const map = new Map();
            for (const rt of state.refundTenders) {
              map.set(rt.order_payment_id, (map.get(rt.order_payment_id) || 0) + Number(rt.amount_minor));
            }
            const rows = Array.from(map.entries()).map(([order_payment_id, refunded_minor]) => ({
              order_payment_id,
              refunded_minor,
            }));
            return { rows };
          }

          if (lowerSql.includes("from order_refund_tenders") && lowerSql.includes("refund_id =")) {
            const rows = state.refundTenders
              .filter((t) => t.refund_id === params[1])
              .map((t) => ({
                id: t.id,
                order_payment_id: t.order_payment_id,
                financial_account_id: t.financial_account_id,
                payment_method: t.payment_method,
                amount_minor: t.amount_minor,
              }));
            return { rows };
          }

          if (lowerSql.includes("select count(*)::int as count from order_refunds")) {
            const count = state.refunds.filter((r) => r.order_id === params[1]).length;
            return { rows: [{ count }] };
          }

          if (lowerSql.includes("insert into order_refunds")) {
            const refund = {
              id: "99999999-9999-4999-a999-999999999999",
              restaurant_id: params[0],
              order_id: params[1],
              branch_id: params[2],
              refund_number: params[3],
              idempotency_key: params[4],
              payload_hash: params[5],
              status: "completed",
              reason: params[6],
              notes: params[7],
              subtotal_refunded_minor: params[8],
              tax_refunded_minor: params[9],
              discount_refunded_minor: params[10],
              charge_refunded_minor: params[11],
              total_refunded_minor: params[12],
              is_full_refund: params[13],
              created_by_user_id: params[14],
              created_at: params[15],
            };
            state.refunds.push(refund);
            return { rows: [{ id: refund.id, refund_number: refund.refund_number, created_at: refund.created_at }] };
          }

          if (lowerSql.includes("insert into order_refund_items")) {
            const item = {
              id: `00000000-0000-4000-a000-00000000000${state.refundItems.length + 1}`,
              restaurant_id: params[0],
              refund_id: params[1],
              order_item_id: params[2],
              quantity: params[3],
              unit_price_minor: params[4],
              line_total_minor: params[5],
              restock: params[6],
              created_at: params[7],
            };
            state.refundItems.push(item);
            return { rows: [{ id: item.id }] };
          }

          if (lowerSql.includes("insert into order_refund_tenders")) {
            const tender = {
              id: `00000000-0000-4000-b000-00000000000${state.refundTenders.length + 1}`,
              restaurant_id: params[0],
              refund_id: params[1],
              order_payment_id: params[2],
              financial_account_id: params[3],
              payment_method: params[4],
              amount_minor: params[5],
              created_at: params[6],
            };
            state.refundTenders.push(tender);
            return { rows: [{ id: tender.id }] };
          }

          if (lowerSql.includes("insert into ledger_entries")) {
            state.ledgerEntries.push(params);
            return { rows: [] };
          }

          if (lowerSql.includes("insert into stock_movements")) {
            state.stockMovements.push(params);
            return { rows: [] };
          }

          if (lowerSql.includes("update inventory_balances")) {
            return { rows: [] };
          }

          if (lowerSql.includes("update order_payments")) {
            return { rows: [] };
          }

          if (lowerSql.includes("update orders")) {
            if (state.order) {
              state.order.payment_status = params[2];
            }
            return { rows: [] };
          }

          if (lowerSql.includes("insert into order_edit_events")) {
            state.editEvents.push(params);
            return { rows: [] };
          }

          return { rows: [] };
        },
        release() {},
      };
    },
  };

  return { pool, state };
}

describe("Order Refund Service (Unit Tests)", () => {
  const tenant = {
    restaurant: { id: RESTAURANT_ID, name: "Test Cafe", currencyCode: "PKR" },
    membership: { userId: USER_ID, role: "owner", defaultBranchId: BRANCH_ID },
  };

  const sampleOrder = {
    id: ORDER_ID,
    restaurant_id: RESTAURANT_ID,
    branch_id: BRANCH_ID,
    order_number: 101,
    order_status: "completed",
    payment_status: "paid",
    subtotal_minor: 100000,
    discount_minor: 10000,
    delivery_minor: 0,
    additional_charges_minor: 0,
    total_minor: 90000,
  };

  const sampleItems = [
    {
      id: ORDER_ITEM_ID,
      restaurant_id: RESTAURANT_ID,
      order_id: ORDER_ID,
      item_name_snapshot: "Burger",
      quantity: 2,
      unit_price_minor: 50000,
      line_total_minor: 100000,
      recipe_snapshot: [
        { stockItemId: STOCK_ITEM_ID, quantityBaseUnits: 200 },
      ],
    },
  ];

  const samplePayments = [
    {
      id: PAYMENT_ID,
      restaurant_id: RESTAURANT_ID,
      order_id: ORDER_ID,
      financial_account_id: ACCOUNT_ID,
      payment_method: "cash",
      status: "captured",
      amount_minor: 90000,
    },
  ];

  it("creates a partial item refund with stock restock", async () => {
    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);
    const res = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "11111111-1111-4111-b111-111111111111",
        reason: "Customer disliked 1 burger",
        items: [
          { orderItemId: ORDER_ITEM_ID, quantity: 1, restock: true },
        ],
      },
    });

    assert.equal(res.replayed, false);
    assert.equal(res.refund.refundNumber, "REF-101-1");
    assert.equal(res.refund.totalRefundedMinor, 45000);
    assert.equal(res.refund.subtotalRefundedMinor, 50000);
    assert.equal(res.refund.discountRefundedMinor, 5000);
    assert.equal(res.order.paymentStatus, "partially_refunded");
    assert.equal(state.stockMovements.length, 1);
    assert.equal(state.ledgerEntries.length, 1);
    // Audit trail recorded the payment-status change.
    assert.equal(state.editEvents.length, 1);
  });

  it("creates an amount-only refund without restocking stock", async () => {
    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);
    const res = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "22222222-2222-4222-b222-222222222222",
        reason: "Goodwill discount refund",
        amountMinor: 20000,
      },
    });

    assert.equal(res.refund.totalRefundedMinor, 20000);
    assert.equal(state.stockMovements.length, 0);
  });

  it("rejects over-refunding when amount exceeds refundable balance", async () => {
    const { pool } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);
    await assert.rejects(
      async () => {
        await service.createRefund({
          tenant,
          userId: tenant.membership.userId,
          orderId: sampleOrder.id,
          input: {
            idempotencyKey: "33333333-3333-4333-b333-333333333333",
            reason: "Over refund attempt",
            amountMinor: 100000,
          },
        });
      },
      (err) => err.code === "AMOUNT_EXCEEDS_REFUNDABLE" && err.statusCode === 409,
    );
  });

  it("rejects a missing refund reason", async () => {
    const { pool } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);
    await assert.rejects(
      async () => {
        await service.createRefund({
          tenant,
          userId: tenant.membership.userId,
          orderId: sampleOrder.id,
          input: {
            idempotencyKey: "44444444-4444-4444-b444-444444444444",
            reason: "   ",
            amountMinor: 1000,
          },
        });
      },
      (err) => err.code === "MISSING_REFUND_REASON" && err.statusCode === 400,
    );
  });

  it("rejects an item quantity beyond the refundable quantity", async () => {
    const { pool } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);
    await assert.rejects(
      async () => {
        await service.createRefund({
          tenant,
          userId: tenant.membership.userId,
          orderId: sampleOrder.id,
          input: {
            idempotencyKey: "55555555-5555-4555-b555-555555555555",
            reason: "Too many",
            items: [{ orderItemId: ORDER_ITEM_ID, quantity: 5, restock: false }],
          },
        });
      },
      (err) => err.code === "QUANTITY_EXCEEDS_REFUNDABLE" && err.statusCode === 409,
    );
  });

  it("rejects a non-positive item quantity", async () => {
    const { pool } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);
    await assert.rejects(
      async () => {
        await service.createRefund({
          tenant,
          userId: tenant.membership.userId,
          orderId: sampleOrder.id,
          input: {
            idempotencyKey: "66666666-6666-4666-b666-666666666666",
            reason: "Zero quantity",
            items: [{ orderItemId: ORDER_ITEM_ID, quantity: 0, restock: false }],
          },
        });
      },
      (err) => err.code === "INVALID_REFUND_QUANTITY" && err.statusCode === 400,
    );
  });

  it("completes a full refund that settles the order to zero", async () => {
    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);
    const res = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "77777777-7777-4777-b777-777777777777",
        reason: "Full return",
        items: [{ orderItemId: ORDER_ITEM_ID, quantity: 2, restock: true }],
      },
    });

    assert.equal(res.refund.isFullRefund, true);
    assert.equal(res.refund.totalRefundedMinor, 90000);
    assert.equal(res.order.paymentStatus, "refunded");
    assert.equal(res.order.remainingRefundableMinor, 0);
    assert.equal(state.stockMovements.length, 1);
  });

  it("accumulates repeated partial refunds against the order total", async () => {
    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);

    const first = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "88888888-8888-4888-b888-888888888888",
        reason: "First partial",
        items: [{ orderItemId: ORDER_ITEM_ID, quantity: 1, restock: false }],
      },
    });
    assert.equal(first.refund.totalRefundedMinor, 45000);

    const second = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "99999999-9999-4999-b999-999999999999",
        reason: "Second partial",
        items: [{ orderItemId: ORDER_ITEM_ID, quantity: 1, restock: false }],
      },
    });
    assert.equal(second.refund.totalRefundedMinor, 45000);
    assert.equal(second.refund.isFullRefund, true);
    assert.equal(second.order.paymentStatus, "refunded");
    assert.equal(second.order.remainingRefundableMinor, 0);

    // A third refund is now impossible.
    await assert.rejects(
      async () => {
        await service.createRefund({
          tenant,
          userId: tenant.membership.userId,
          orderId: sampleOrder.id,
          input: {
            idempotencyKey: "aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa",
            reason: "Should fail",
            amountMinor: 100,
          },
        });
      },
      (err) => err.code === "ORDER_FULLY_REFUNDED" && err.statusCode === 409,
    );
  });

  it("allocates a refund proportionally across split tenders", async () => {
    const splitPayments = [
      {
        id: PAYMENT_ID,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "cash",
        status: "captured",
        amount_minor: 50000,
      },
      {
        id: PAYMENT_ID_2,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "bank_account",
        status: "captured",
        amount_minor: 40000,
      },
    ];

    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: splitPayments,
    });

    const service = createOrderRefundService(pool);
    const res = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
        reason: "Split tender refund",
        amountMinor: 60000,
      },
    });

    assert.equal(res.refund.totalRefundedMinor, 60000);
    // Proportional allocation across the 50000/40000 split: the cash
    // tender holds 5/9 of the captured balance and the bank tender 4/9.
    // Exact shares are 33333.33 and 26666.67; the floors sum to 59999,
    // and the largest-remainder rule gives the leftover unit to the bank
    // tender (the larger fractional part), yielding 33333 and 26667.
    // Both are integers, neither exceeds its captured balance, and they
    // sum exactly to the refund amount.
    assert.equal(state.refundTenders.length, 2);
    const cashTender = state.refundTenders.find((t) => t.order_payment_id === PAYMENT_ID);
    const bankTender = state.refundTenders.find((t) => t.order_payment_id === PAYMENT_ID_2);
    assert.equal(Number(cashTender.amount_minor), 33333);
    assert.equal(Number(bankTender.amount_minor), 26667);
    assert.equal(
      Number(cashTender.amount_minor) + Number(bankTender.amount_minor),
      60000,
    );
    // Both tenders produced compensating ledger entries.
    assert.equal(state.ledgerEntries.length, 2);
  });

  it("allocates tax, discount and additional charges proportionally", async () => {
    // Order with a 10000 tax charge and a 5000 delivery charge so
    // the allocation of tax and charges can be observed.
    const chargedOrder = {
      ...sampleOrder,
      additional_charges_minor: 15000,
      total_minor: 105000,
    };
    const charges = [
      { order_id: ORDER_ID, name: "Tax", amount_minor: 10000 },
      { order_id: ORDER_ID, name: "Delivery fee", amount_minor: 5000 },
    ];
    const chargedPayments = [
      {
        id: PAYMENT_ID,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "cash",
        status: "captured",
        amount_minor: 105000,
      },
    ];

    const { pool, state } = createMockPool({
      order: chargedOrder,
      orderItems: sampleItems,
      payments: chargedPayments,
      orderCharges: charges,
    });

    const service = createOrderRefundService(pool);
    const res = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "cccccccc-cccc-4ccc-bccc-cccccccccccc",
        reason: "Allocation test",
        items: [{ orderItemId: ORDER_ITEM_ID, quantity: 1, restock: false }],
      },
    });

    // 1 of 2 items: 50000 gross. Discount share: 50000/100000 * 10000 = 5000.
    assert.equal(res.refund.subtotalRefundedMinor, 50000);
    assert.equal(res.refund.discountRefundedMinor, 5000);
    // Charge share: 50000/100000 * 15000 = 7500.
    assert.equal(res.refund.chargeRefundedMinor, 7500);
    // Tax share of the charge allocation: 7500/15000 * 10000 = 5000.
    assert.equal(res.refund.taxRefundedMinor, 5000);
    // Net: 50000 - 5000 + 7500 = 52500.
    assert.equal(res.refund.totalRefundedMinor, 52500);
  });

  it("absorbs the exact remaining balance on the final refund", async () => {
    const { pool } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);

    // Refund one item first (45000), leaving 45000.
    await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "dddddddd-dddd-4ddd-bddd-dddddddddddd",
        reason: "First",
        items: [{ orderItemId: ORDER_ITEM_ID, quantity: 1, restock: false }],
      },
    });

    // Final refund of the remaining item absorbs the exact remainder.
    const final = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee",
        reason: "Final",
        items: [{ orderItemId: ORDER_ITEM_ID, quantity: 1, restock: false }],
      },
    });

    assert.equal(final.refund.totalRefundedMinor, 45000);
    assert.equal(final.order.remainingRefundableMinor, 0);
    assert.equal(final.order.paymentStatus, "refunded");
  });

  it("replays identical request when same idempotency key is submitted", async () => {
    const { pool } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);
    const input = {
      idempotencyKey: "ffffffff-ffff-4fff-bfff-ffffffffffff",
      reason: "Item returned",
      items: [{ orderItemId: ORDER_ITEM_ID, quantity: 1, restock: false }],
    };

    const res1 = await service.createRefund({ tenant, userId: tenant.membership.userId, orderId: sampleOrder.id, input });
    assert.equal(res1.replayed, false);

    const res2 = await service.createRefund({ tenant, userId: tenant.membership.userId, orderId: sampleOrder.id, input });
    assert.equal(res2.replayed, true);
    assert.equal(res2.refund.id, res1.refund.id);
  });

  it("rejects idempotency key reuse with different payload", async () => {
    const { pool } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);
    const idempotencyKey = "11111111-1111-4111-b111-111111111112";

    await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: { idempotencyKey, reason: "Original reason", amountMinor: 10000 },
    });

    await assert.rejects(
      async () => {
        await service.createRefund({
          tenant,
          userId: tenant.membership.userId,
          orderId: sampleOrder.id,
          input: { idempotencyKey, reason: "Changed reason payload", amountMinor: 20000 },
        });
      },
      (err) => err.code === "IDEMPOTENCY_PAYLOAD_MISMATCH" && err.statusCode === 409,
    );
  });

  it("rolls back every write when a later statement fails", async () => {
    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
      failOnSql: "insert into ledger_entries",
    });

    const service = createOrderRefundService(pool);
    await assert.rejects(
      async () => {
        await service.createRefund({
          tenant,
          userId: tenant.membership.userId,
          orderId: sampleOrder.id,
          input: {
            idempotencyKey: "22222222-2222-4222-b222-222222222223",
            reason: "Atomicity test",
            amountMinor: 5000,
          },
        });
      },
      (err) => err.message === "injected failure",
    );

    // Nothing persisted: no refund row, no tender, no ledger entry,
    // no payment-status change.
    assert.equal(state.refunds.length, 0);
    assert.equal(state.refundTenders.length, 0);
    assert.equal(state.ledgerEntries.length, 0);
    assert.equal(state.order.payment_status, "paid");
  });

  it("rejects a refund for a cancelled order", async () => {
    const { pool } = createMockPool({
      order: { ...sampleOrder, order_status: "cancelled" },
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);
    await assert.rejects(
      async () => {
        await service.createRefund({
          tenant,
          userId: tenant.membership.userId,
          orderId: sampleOrder.id,
          input: {
            idempotencyKey: "33333333-3333-4333-b333-333333333334",
            reason: "Cancelled order",
            amountMinor: 1000,
          },
        });
      },
      (err) => err.code === "ORDER_INELIGIBLE" && err.statusCode === 409,
    );
  });

  it("rejects a refund for an unknown order", async () => {
    const { pool } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);
    await assert.rejects(
      async () => {
        await service.createRefund({
          tenant,
          userId: tenant.membership.userId,
          orderId: "00000000-0000-4000-a000-000000000000",
          input: {
            idempotencyKey: "44444444-4444-4444-b444-444444444445",
            reason: "Unknown order",
            amountMinor: 1000,
          },
        });
      },
      (err) => err.code === "ORDER_NOT_FOUND" && err.statusCode === 404,
    );
  });

  it("rejects duplicate items in a single refund request", async () => {
    const { pool } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);
    await assert.rejects(
      async () => {
        await service.createRefund({
          tenant,
          userId: tenant.membership.userId,
          orderId: sampleOrder.id,
          input: {
            idempotencyKey: "55555555-5555-4555-b555-555555555557",
            reason: "Duplicate items",
            items: [
              { orderItemId: ORDER_ITEM_ID, quantity: 1, restock: false },
              { orderItemId: ORDER_ITEM_ID, quantity: 1, restock: false },
            ],
          },
        });
      },
      (err) => err.code === "DUPLICATE_REFUND_ITEM" && err.statusCode === 400,
    );
  });

  it("rejects an item that does not belong to the order", async () => {
    const { pool } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);
    await assert.rejects(
      async () => {
        await service.createRefund({
          tenant,
          userId: tenant.membership.userId,
          orderId: sampleOrder.id,
          input: {
            idempotencyKey: "66666666-6666-4666-b666-666666666668",
            reason: "Foreign item",
            items: [{ orderItemId: ORDER_ITEM_ID_2, quantity: 1, restock: false }],
          },
        });
      },
      (err) => err.code === "INVALID_REFUND_ITEM" && err.statusCode === 400,
    );
  });

  it("restores stock using the frozen recipe snapshot proportionally", async () => {
    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);
    await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "77777777-7777-4777-b777-777777777779",
        reason: "Restock test",
        items: [{ orderItemId: ORDER_ITEM_ID, quantity: 1, restock: true }],
      },
    });

    // Recipe snapshot: 200 base units per item, 2 items sold.
    // Refunding 1 of 2 restores the frozen per-unit 200 base units.
    assert.equal(state.stockMovements.length, 1);
    const movement = state.stockMovements[0];
    // params: [restaurantId, branchId, stockItemId, orderId, quantityDelta, movementKey, occurredAt, userId]
    assert.equal(movement[0], RESTAURANT_ID);
    assert.equal(movement[2], STOCK_ITEM_ID);
    assert.equal(movement[3], ORDER_ID);
    assert.equal(Number(movement[4]), 200);
    assert.equal(movement[7], USER_ID);
  });

  it("does not restore stock when restock is false", async () => {
    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);
    await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "88888888-8888-4888-b888-888888888890",
        reason: "No restock",
        items: [{ orderItemId: ORDER_ITEM_ID, quantity: 1, restock: false }],
      },
    });

    assert.equal(state.stockMovements.length, 0);
  });

  it("records the authenticated actor on the refund and audit event", async () => {
    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: samplePayments,
    });

    const service = createOrderRefundService(pool);
    const res = await service.createRefund({
      tenant,
      userId: USER_ID,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "99999999-9999-4999-b999-999999999991",
        reason: "Actor test",
        amountMinor: 1000,
      },
    });

    assert.equal(res.refund.createdByUserId, USER_ID);
    // The refund row and the audit event both carry the actor.
    assert.equal(state.refunds[0].created_by_user_id, USER_ID);
    assert.equal(state.editEvents[0][2], USER_ID);
  });

  it("rejects ineligible order and payment states with ORDER_INELIGIBLE", async () => {
    const ineligibleStates = [
      { orderStatus: "new", paymentStatus: "unpaid" },
      { orderStatus: "preparing", paymentStatus: "unpaid" },
      { orderStatus: "ready", paymentStatus: "unpaid" },
      { orderStatus: "served", paymentStatus: "unpaid" },
      { orderStatus: "completed", paymentStatus: "unpaid" },
      { orderStatus: "completed", paymentStatus: "partially_paid" },
      { orderStatus: "cancelled", paymentStatus: "paid" },
    ];

    for (const state of ineligibleStates) {
      const { pool } = createMockPool({
        order: { ...sampleOrder, order_status: state.orderStatus, payment_status: state.paymentStatus },
        orderItems: sampleItems,
        payments: samplePayments,
      });

      const service = createOrderRefundService(pool);
      await assert.rejects(
        async () => {
          await service.createRefund({
            tenant,
            userId: tenant.membership.userId,
            orderId: sampleOrder.id,
            input: {
              idempotencyKey: "aaaaaaaa-0000-4000-8000-000000000000",
              reason: "Ineligible state",
              amountMinor: 1000,
            },
          });
        },
        (err) => err.code === "ORDER_INELIGIBLE" && err.statusCode === 409,
        `order_status=${state.orderStatus} payment_status=${state.paymentStatus} must be rejected`,
      );
    }
  });

  it("accepts eligible paid and partially_refunded payment states", async () => {
    for (const paymentStatus of ["paid", "partially_refunded"]) {
      const { pool } = createMockPool({
        order: { ...sampleOrder, payment_status: paymentStatus },
        orderItems: sampleItems,
        payments: samplePayments,
      });

      const service = createOrderRefundService(pool);
      const res = await service.createRefund({
        tenant,
        userId: tenant.membership.userId,
        orderId: sampleOrder.id,
        input: {
          idempotencyKey: "bbbbbbbb-0000-4000-8000-000000000000",
          reason: "Eligible state",
          amountMinor: 1000,
        },
      });
      assert.equal(res.refund.totalRefundedMinor, 1000);
    }
  });

  it("rejects a refund that exceeds the captured payment balance", async () => {
    // Order total 90000 but only 40000 captured: a refund must
    // never exceed money actually captured.
    const { pool } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: [
        {
          id: PAYMENT_ID,
          restaurant_id: RESTAURANT_ID,
          order_id: ORDER_ID,
          financial_account_id: ACCOUNT_ID,
          payment_method: "cash",
          status: "captured",
          amount_minor: 40000,
        },
      ],
    });

    const service = createOrderRefundService(pool);
    await assert.rejects(
      async () => {
        await service.createRefund({
          tenant,
          userId: tenant.membership.userId,
          orderId: sampleOrder.id,
          input: {
            idempotencyKey: "cccccccc-0000-4000-8000-000000000000",
            reason: "Over-captured refund",
            amountMinor: 50000,
          },
        });
      },
      (err) => err.code === "AMOUNT_EXCEEDS_REFUNDABLE" && err.statusCode === 409,
      "a refund larger than the captured balance must be rejected",
    );
  });

  it("allocates a partial refund proportionally across split tenders", async () => {
    const splitPayments = [
      {
        id: PAYMENT_ID,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "cash",
        status: "captured",
        amount_minor: 50000,
      },
      {
        id: PAYMENT_ID_2,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "bank_account",
        status: "captured",
        amount_minor: 40000,
      },
    ];

    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: splitPayments,
    });

    const service = createOrderRefundService(pool);
    const res = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "dddddddd-0000-4000-8000-000000000000",
        reason: "Proportional split tender",
        amountMinor: 60000,
      },
    });

    assert.equal(res.refund.totalRefundedMinor, 60000);
    assert.equal(state.refundTenders.length, 2);
    const cashTender = state.refundTenders.find((t) => t.order_payment_id === PAYMENT_ID);
    const bankTender = state.refundTenders.find((t) => t.order_payment_id === PAYMENT_ID_2);
    // Exact shares: 60000 * 50000/90000 = 33333.33 (cash) and
    // 60000 * 40000/90000 = 26666.67 (bank). Floors sum to 59999;
    // the largest-remainder rule gives the leftover unit to the bank
    // tender (the larger fractional part).
    assert.equal(Number(cashTender.amount_minor), 33333);
    assert.equal(Number(bankTender.amount_minor), 26667);
    // Integer allocations that sum exactly to the refund amount.
    assert.equal(
      Number(cashTender.amount_minor) + Number(bankTender.amount_minor),
      60000,
    );
    // No payment is over-refunded beyond its captured balance.
    assert.ok(Number(cashTender.amount_minor) <= 50000);
    assert.ok(Number(bankTender.amount_minor) <= 40000);
  });

  it("replays a proportional allocation identically", async () => {
    const splitPayments = [
      {
        id: PAYMENT_ID,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "cash",
        status: "captured",
        amount_minor: 50000,
      },
      {
        id: PAYMENT_ID_2,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "bank_account",
        status: "captured",
        amount_minor: 40000,
      },
    ];

    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: splitPayments,
    });

    const service = createOrderRefundService(pool);
    const input = {
      idempotencyKey: "eeeeeeee-0000-4000-8000-000000000000",
      reason: "Replay proportional",
      amountMinor: 60000,
    };
    const first = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input,
    });
    const replay = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input,
    });

    assert.equal(replay.replayed, true);
    // The replayed allocation is identical to the original.
    const firstCash = first.refund.tenders.find((t) => t.orderPaymentId === PAYMENT_ID);
    const replayCash = replay.refund.tenders.find((t) => t.orderPaymentId === PAYMENT_ID);
    const firstBank = first.refund.tenders.find((t) => t.orderPaymentId === PAYMENT_ID_2);
    const replayBank = replay.refund.tenders.find((t) => t.orderPaymentId === PAYMENT_ID_2);
    assert.equal(Number(replayCash.amountMinor), Number(firstCash.amountMinor));
    assert.equal(Number(replayBank.amountMinor), Number(firstBank.amountMinor));
    assert.equal(Number(replayCash.amountMinor), 33333);
    assert.equal(Number(replayBank.amountMinor), 26667);
    // Only one refund was persisted (the replay returned the stored one).
    assert.equal(state.refunds.length, 1);
  });

  it("allocates a full refund exactly across split tenders", async () => {
    const splitPayments = [
      {
        id: PAYMENT_ID,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "cash",
        status: "captured",
        amount_minor: 50000,
      },
      {
        id: PAYMENT_ID_2,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "bank_account",
        status: "captured",
        amount_minor: 40000,
      },
    ];

    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: splitPayments,
    });

    const service = createOrderRefundService(pool);
    const res = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "ffffffff-0000-4000-8000-000000000000",
        reason: "Full split tender refund",
        amountMinor: 90000,
      },
    });

    assert.equal(res.refund.totalRefundedMinor, 90000);
    assert.equal(res.order.paymentStatus, "refunded");
    // A full refund returns each tender its entire captured balance.
    const cashTender = state.refundTenders.find((t) => t.order_payment_id === PAYMENT_ID);
    const bankTender = state.refundTenders.find((t) => t.order_payment_id === PAYMENT_ID_2);
    assert.equal(Number(cashTender.amount_minor), 50000);
    assert.equal(Number(bankTender.amount_minor), 40000);
    assert.equal(
      Number(cashTender.amount_minor) + Number(bankTender.amount_minor),
      90000,
    );
  });

  it("excludes zero-value tender inserts for a one-minor-unit refund across two equal tenders", async () => {
    // Two equal tenders of 50000 each. A 1-minor-unit refund
    // allocates 1 to the first tender and 0 to the second.
    // The zero allocation must NOT be inserted.
    const splitPayments = [
      {
        id: PAYMENT_ID,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "cash",
        status: "captured",
        amount_minor: 50000,
      },
      {
        id: PAYMENT_ID_2,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "bank_account",
        status: "captured",
        amount_minor: 50000,
      },
    ];

    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: splitPayments,
    });

    const service = createOrderRefundService(pool);
    const res = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "11111111-0000-4000-8000-000000000001",
        reason: "One minor unit across equal tenders",
        amountMinor: 1,
      },
    });

    assert.equal(res.refund.totalRefundedMinor, 1);
    // Only the non-zero allocation is inserted.
    assert.equal(state.refundTenders.length, 1, "only one tender row must be inserted");
    const insertedTender = state.refundTenders[0];
    assert.equal(Number(insertedTender.amount_minor), 1);
    assert.ok(Number(insertedTender.amount_minor) > 0, "no zero-value tender may be inserted");
    // The positive allocations still sum exactly to the refund.
    const sum = state.refundTenders.reduce((s, t) => s + Number(t.amount_minor), 0);
    assert.equal(sum, 1);
  });

  it("excludes zero-value tender inserts when the refund is smaller than the number of tenders", async () => {
    // Three tenders; a 2-minor-unit refund allocates to only
    // two of them. The third (zero) allocation is excluded.
    const threePayments = [
      {
        id: PAYMENT_ID,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "cash",
        status: "captured",
        amount_minor: 30000,
      },
      {
        id: PAYMENT_ID_2,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "bank_account",
        status: "captured",
        amount_minor: 30000,
      },
      {
        id: "66666666-6666-4666-a666-666666666668",
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "other",
        status: "captured",
        amount_minor: 30000,
      },
    ];

    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: threePayments,
    });

    const service = createOrderRefundService(pool);
    const res = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "22222222-0000-4000-8000-000000000001",
        reason: "Refund smaller than tender count",
        amountMinor: 2,
      },
    });

    assert.equal(res.refund.totalRefundedMinor, 2);
    // Two non-zero allocations, one zero excluded.
    assert.equal(state.refundTenders.length, 2, "two tender rows must be inserted");
    for (const tender of state.refundTenders) {
      assert.ok(Number(tender.amount_minor) > 0, "no zero-value tender may be inserted");
    }
    const sum = state.refundTenders.reduce((s, t) => s + Number(t.amount_minor), 0);
    assert.equal(sum, 2, "positive allocations must sum exactly to the refund");
  });

  it("allocates an uneven three-tender refund without zero rows", async () => {
    // 10000 across 30000/30000/40000 (total 100000):
    // exact shares are 3000/3000/4000 — all non-zero.
    const unevenPayments = [
      {
        id: PAYMENT_ID,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "cash",
        status: "captured",
        amount_minor: 30000,
      },
      {
        id: PAYMENT_ID_2,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "bank_account",
        status: "captured",
        amount_minor: 30000,
      },
      {
        id: "66666666-6666-4666-a666-666666666668",
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "other",
        status: "captured",
        amount_minor: 40000,
      },
    ];

    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: unevenPayments,
    });

    const service = createOrderRefundService(pool);
    const res = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "33333333-0000-4000-8000-000000000001",
        reason: "Uneven three-tender refund",
        amountMinor: 10000,
      },
    });

    assert.equal(res.refund.totalRefundedMinor, 10000);
    assert.equal(state.refundTenders.length, 3);
    const amounts = state.refundTenders
      .map((t) => Number(t.amount_minor))
      .sort((a, b) => a - b);
    assert.deepEqual(amounts, [3000, 3000, 4000]);
    const sum = amounts.reduce((s, a) => s + a, 0);
    assert.equal(sum, 10000);
  });

  it("writes no zero-value ledger entries for excluded tenders", async () => {
    const splitPayments = [
      {
        id: PAYMENT_ID,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "cash",
        status: "captured",
        amount_minor: 50000,
      },
      {
        id: PAYMENT_ID_2,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "bank_account",
        status: "captured",
        amount_minor: 50000,
      },
    ];

    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: splitPayments,
    });

    const service = createOrderRefundService(pool);
    await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input: {
        idempotencyKey: "44444444-0000-4000-8000-000000000001",
        reason: "No zero ledger entries",
        amountMinor: 1,
      },
    });

    // Only one ledger entry (for the single non-zero tender).
    assert.equal(state.ledgerEntries.length, 1);
    // The ledger entry amount is positive.
    assert.ok(Number(state.ledgerEntries[0][4]) > 0);
  });

  it("replays a zero-excluded allocation deterministically", async () => {
    const splitPayments = [
      {
        id: PAYMENT_ID,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "cash",
        status: "captured",
        amount_minor: 50000,
      },
      {
        id: PAYMENT_ID_2,
        restaurant_id: RESTAURANT_ID,
        order_id: ORDER_ID,
        financial_account_id: ACCOUNT_ID,
        payment_method: "bank_account",
        status: "captured",
        amount_minor: 50000,
      },
    ];

    const { pool, state } = createMockPool({
      order: sampleOrder,
      orderItems: sampleItems,
      payments: splitPayments,
    });

    const service = createOrderRefundService(pool);
    const input = {
      idempotencyKey: "55555555-0000-4000-8000-000000000001",
      reason: "Replay zero-excluded",
      amountMinor: 1,
    };
    const first = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input,
    });
    const replay = await service.createRefund({
      tenant,
      userId: tenant.membership.userId,
      orderId: sampleOrder.id,
      input,
    });

    assert.equal(replay.replayed, true);
    // The replayed tender allocation is identical.
    assert.equal(first.refund.tenders.length, 1);
    assert.equal(replay.refund.tenders.length, 1);
    assert.equal(
      Number(replay.refund.tenders[0].amountMinor),
      Number(first.refund.tenders[0].amountMinor),
    );
    assert.equal(Number(replay.refund.tenders[0].amountMinor), 1);
    // Only one refund was persisted.
    assert.equal(state.refunds.length, 1);
    // Only one tender row was persisted.
    assert.equal(state.refundTenders.length, 1);
  });
});
