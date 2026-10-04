import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { createOrderRefundService } from "../src/server/pos/order-refund-service.mjs";
import { createSalesReportService } from "../src/server/pos/sales-report-service.mjs";
import {
  createAppPool,
  connectAdmin,
  isDatabaseAvailable,
  provisionIntegrationDatabase,
  seedRestaurant,
} from "./helpers/postgres.mjs";

const available = await isDatabaseAvailable();
const describeDatabase = available ? describe : describe.skip;

if (!available) {
  console.warn(
    "[skipped] PostgreSQL integration tests: no database. "
    + "Run `docker compose -f compose.test-database.yaml up -d` then `npm run test:integration`.",
  );
}

/**
 * Wraps a pool so that any statement matching `failOnSql` throws after
 * `failAfter` matching statements. Used to prove that a mid-transaction
 * failure rolls every earlier statement back. The wrapper delegates to
 * the real client without mutating it, so pooled connections are never
 * permanently altered.
 */
function injectFailure(pool, failOnSql, failAfter = 0) {
  let matches = 0;
  return {
    async connect() {
      const client = await pool.connect();
      return {
        query: async (sql, params) => {
          if (String(sql).toLowerCase().includes(failOnSql)) {
            if (matches++ >= failAfter) {
              throw new Error("injected failure");
            }
          }
          return client.query(sql, params);
        },
        release: () => client.release(),
      };
    },
  };
}

describeDatabase("Partial Refunds & Sales Reporting PostgreSQL Integration Tests", () => {
  let admin;
  let pool;
  let tenantA;
  let tenantB;
  let orderIdA;
  let orderIdA2;
  let orderIdB;
  let orderItemIdA;
  let paymentIdA;
  let stockItemIdA;
  let cashAccountIdA;

  before(async () => {
    await provisionIntegrationDatabase();
    admin = await connectAdmin();
    pool = await createAppPool();

    tenantA = await seedRestaurant(admin, { name: "Restaurant Alpha" });
    tenantB = await seedRestaurant(admin, { name: "Restaurant Beta" });

    // A real stock item so restock movements satisfy the foreign key.
    const stockRes = await admin.query(
      `INSERT INTO stock_items (restaurant_id, name, stock_type, base_unit)
       VALUES ($1, 'Pizza Dough', 'ingredient', 'gram') RETURNING id`,
      [tenantA.restaurantId],
    );
    stockItemIdA = stockRes.rows[0].id;

    // A cash account so refund compensation writes a ledger entry.
    const accountRes = await admin.query(
      `INSERT INTO financial_accounts (restaurant_id, branch_id, account_type, display_name)
       VALUES ($1, $2, 'cash', 'Register Cash') RETURNING id`,
      [tenantA.restaurantId, tenantA.branchId],
    );
    cashAccountIdA = accountRes.rows[0].id;

    // Seed a completed order for Tenant A: subtotal 100000, discount 10000,
    // total 90000 (PKR 900.00), paid in full by a single cash payment.
    const orderResA = await admin.query(
      `INSERT INTO orders (
         id, restaurant_id, branch_id, order_number, order_type, order_status,
         payment_status, subtotal_minor, discount_minor, delivery_minor,
         additional_charges_minor, total_minor, business_date, ordered_at,
         idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, 1001, 'dine_in', 'completed',
         'paid', 100000, 10000, 0, 0, 90000, CURRENT_DATE, now(),
         gen_random_uuid(), $3
       ) RETURNING id`,
      [tenantA.restaurantId, tenantA.branchId, tenantA.userId],
    );
    orderIdA = orderResA.rows[0].id;

    const paymentResA = await admin.query(
      `INSERT INTO order_payments (
         id, restaurant_id, order_id, financial_account_id, payment_method,
         status, amount_minor, idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, 'cash', 'captured', 90000,
         gen_random_uuid(), $4
       ) RETURNING id`,
      [tenantA.restaurantId, orderIdA, cashAccountIdA, tenantA.userId],
    );
    paymentIdA = paymentResA.rows[0].id;

    const itemResA = await admin.query(
      `INSERT INTO order_items (
         id, restaurant_id, order_id, item_name_snapshot, quantity,
         unit_price_minor, line_total_minor, recipe_snapshot
       ) VALUES (
         gen_random_uuid(), $1, $2, 'Pizza', 2, 50000, 100000,
         $3::jsonb
       ) RETURNING id`,
      [
        tenantA.restaurantId,
        orderIdA,
        JSON.stringify({
          items: [{ stockItemId: stockItemIdA, quantityBaseUnits: 200 }],
        }),
      ],
    );
    orderItemIdA = itemResA.rows[0].id;

    // A second completed order for Tenant A, reserved for the
    // idempotency, over-refund and rollback scenarios so they never
    // touch the item-refund order above.
    const orderResA2 = await admin.query(
      `INSERT INTO orders (
         id, restaurant_id, branch_id, order_number, order_type, order_status,
         payment_status, subtotal_minor, discount_minor, delivery_minor,
         additional_charges_minor, total_minor, business_date, ordered_at,
         idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, 1002, 'takeaway', 'completed',
         'paid', 50000, 0, 0, 0, 50000, CURRENT_DATE, now(),
         gen_random_uuid(), $3
       ) RETURNING id`,
      [tenantA.restaurantId, tenantA.branchId, tenantA.userId],
    );
    orderIdA2 = orderResA2.rows[0].id;

    await admin.query(
      `INSERT INTO order_payments (
         id, restaurant_id, order_id, financial_account_id, payment_method,
         status, amount_minor, idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, 'cash', 'captured', 50000,
         gen_random_uuid(), $4
       )`,
      [tenantA.restaurantId, orderIdA2, cashAccountIdA, tenantA.userId],
    );

    // Seed a completed order for Tenant B.
    const orderResB = await admin.query(
      `INSERT INTO orders (
         id, restaurant_id, branch_id, order_number, order_type, order_status,
         payment_status, subtotal_minor, discount_minor, delivery_minor,
         additional_charges_minor, total_minor, business_date, ordered_at,
         idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, 2001, 'takeaway', 'completed',
         'paid', 50000, 0, 0, 0, 50000, CURRENT_DATE, now(),
         gen_random_uuid(), $3
       ) RETURNING id`,
      [tenantB.restaurantId, tenantB.branchId, tenantB.userId],
    );
    orderIdB = orderResB.rows[0].id;
  });

  it("provisions database with migration 011 and seeds test data", async () => {
    const constraintRes = await admin.query(
      `SELECT conname FROM pg_constraint
        WHERE conname = 'order_refunds_restaurant_id_idempotency_key_key'`,
    );
    assert.ok(
      constraintRes.rows.some((r) => r.conname.includes("idempotency_key")),
      "order_refunds idempotency uniqueness constraint must exist",
    );

    const rlsRes = await admin.query(
      `SELECT c.relname AS tablename, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN ('order_refunds', 'order_refund_items', 'order_refund_tenders')
        ORDER BY c.relname`,
    );
    assert.equal(rlsRes.rows.length, 3);
    for (const row of rlsRes.rows) {
      assert.equal(row.relrowsecurity, true, `${row.tablename} must enable RLS`);
      assert.equal(row.relforcerowsecurity, true, `${row.tablename} must force RLS`);
    }

    assert.ok(orderIdA && orderIdB && orderItemIdA && paymentIdA);
  });

  it("enforces RLS isolation — Tenant B cannot view or refund Tenant A order", async () => {
    const refundService = createOrderRefundService(pool);

    const tenantBContext = {
      restaurant: { id: tenantB.restaurantId },
      membership: { userId: tenantB.userId, role: "owner" },
    };

    await assert.rejects(
      async () => {
        await refundService.createRefund({
          tenant: tenantBContext,
          userId: tenantB.userId,
          orderId: orderIdA,
          input: {
            idempotencyKey: "88888888-8888-4888-b888-888888888888",
            reason: "Cross tenant attempt",
            amountMinor: 10000,
          },
        });
      },
      (err) => err.code === "ORDER_NOT_FOUND" && err.statusCode === 404,
    );

    // Tenant B also cannot list Tenant A's refunds.
    const refunds = await refundService.listRefunds({
      tenant: tenantBContext,
      orderId: orderIdA,
    });
    assert.equal(refunds.length, 0);
  });

  it("executes a partial item refund with proportional discount allocation", async () => {
    const refundService = createOrderRefundService(pool);
    const tenantAContext = {
      restaurant: { id: tenantA.restaurantId },
      membership: { userId: tenantA.userId, role: "owner" },
    };

    const result = await refundService.createRefund({
      tenant: tenantAContext,
      userId: tenantA.userId,
      orderId: orderIdA,
      input: {
        idempotencyKey: "11111111-1111-4111-b111-111111111111",
        reason: "Customer returned one pizza",
        items: [{ orderItemId: orderItemIdA, quantity: 1, restock: true }],
      },
    });

    assert.equal(result.replayed, false);
    // 1 of 2 pizzas: 50000 gross, 10% discount => 45000 minor.
    assert.equal(result.refund.totalRefundedMinor, 45000);
    assert.equal(result.refund.subtotalRefundedMinor, 50000);
    assert.equal(result.refund.discountRefundedMinor, 5000);
    assert.equal(result.refund.isFullRefund, false);
    assert.equal(result.order.paymentStatus, "partially_refunded");
    assert.equal(result.order.remainingRefundableMinor, 45000);

    // Inventory restock used the frozen recipe snapshot.
    const movementRes = await admin.query(
      `SELECT quantity_delta FROM stock_movements
        WHERE restaurant_id = $1 AND order_id = $2 AND movement_type = 'sale_reversal'`,
      [tenantA.restaurantId, orderIdA],
    );
    assert.equal(movementRes.rows.length, 1);
    assert.equal(Number(movementRes.rows[0].quantity_delta), 100);

    // Compensating ledger entry was recorded against the cash account.
    const ledgerRes = await admin.query(
      `SELECT amount_minor, entry_type FROM ledger_entries
        WHERE restaurant_id = $1 AND source_type = 'refund'`,
      [tenantA.restaurantId],
    );
    assert.equal(ledgerRes.rows.length, 1);
    assert.equal(Number(ledgerRes.rows[0].amount_minor), 45000);

    // The captured payment is now partially refunded.
    const paymentRes = await admin.query(
      `SELECT status FROM order_payments WHERE id = $1`,
      [paymentIdA],
    );
    assert.equal(paymentRes.rows[0].status, "partially_refunded");
  });

  it("rejects an item quantity that exceeds the remaining refundable quantity", async () => {
    const refundService = createOrderRefundService(pool);
    const tenantAContext = {
      restaurant: { id: tenantA.restaurantId },
      membership: { userId: tenantA.userId, role: "owner" },
    };

    await assert.rejects(
      async () => {
        await refundService.createRefund({
          tenant: tenantAContext,
          userId: tenantA.userId,
          orderId: orderIdA,
          input: {
            idempotencyKey: "22222222-2222-4222-b222-222222222222",
            reason: "Trying to refund too many",
            items: [{ orderItemId: orderItemIdA, quantity: 5, restock: false }],
          },
        });
      },
      (err) => err.code === "QUANTITY_EXCEEDS_REFUNDABLE" && err.statusCode === 409,
    );
  });

  it("completes a full refund of the remaining balance and settles the order", async () => {
    const refundService = createOrderRefundService(pool);
    const tenantAContext = {
      restaurant: { id: tenantA.restaurantId },
      membership: { userId: tenantA.userId, role: "owner" },
    };

    const result = await refundService.createRefund({
      tenant: tenantAContext,
      userId: tenantA.userId,
      orderId: orderIdA,
      input: {
        idempotencyKey: "33333333-3333-4333-b333-333333333333",
        reason: "Customer returned the second pizza",
        items: [{ orderItemId: orderItemIdA, quantity: 1, restock: false }],
      },
    });

    assert.equal(result.refund.totalRefundedMinor, 45000);
    assert.equal(result.refund.isFullRefund, true);
    assert.equal(result.order.paymentStatus, "refunded");
    assert.equal(result.order.remainingRefundableMinor, 0);

    const paymentRes = await admin.query(
      `SELECT status FROM order_payments WHERE id = $1`,
      [paymentIdA],
    );
    assert.equal(paymentRes.rows[0].status, "refunded");

    // A further refund is now impossible.
    await assert.rejects(
      async () => {
        await refundService.createRefund({
          tenant: tenantAContext,
          userId: tenantA.userId,
          orderId: orderIdA,
          input: {
            idempotencyKey: "44444444-4444-4444-b444-444444444444",
            reason: "Should fail",
            amountMinor: 100,
          },
        });
      },
      (err) => err.code === "ORDER_FULLY_REFUNDED" && err.statusCode === 409,
    );
  });

  it("replays an identical request with the same idempotency key", async () => {
    const refundService = createOrderRefundService(pool);
    const tenantAContext = {
      restaurant: { id: tenantA.restaurantId },
      membership: { userId: tenantA.userId, role: "owner" },
    };

    const input = {
      idempotencyKey: "55555555-5555-4555-b555-555555555555",
      reason: "Replay test",
      amountMinor: 1000,
    };

    const first = await refundService.createRefund({
      tenant: tenantAContext,
      userId: tenantA.userId,
      orderId: orderIdA2,
      input,
    });
    assert.equal(first.replayed, false);

    const second = await refundService.createRefund({
      tenant: tenantAContext,
      userId: tenantA.userId,
      orderId: orderIdA2,
      input,
    });
    assert.equal(second.replayed, true);
    assert.equal(second.refund.id, first.refund.id);
    assert.equal(second.refund.totalRefundedMinor, first.refund.totalRefundedMinor);
  });

  it("rejects the same idempotency key with a different payload", async () => {
    const refundService = createOrderRefundService(pool);
    const tenantAContext = {
      restaurant: { id: tenantA.restaurantId },
      membership: { userId: tenantA.userId, role: "owner" },
    };

    const idempotencyKey = "66666666-6666-4666-b666-666666666666";
    await refundService.createRefund({
      tenant: tenantAContext,
      userId: tenantA.userId,
      orderId: orderIdA2,
      input: { idempotencyKey, reason: "Original", amountMinor: 1000 },
    });

    await assert.rejects(
      async () => {
        await refundService.createRefund({
          tenant: tenantAContext,
          userId: tenantA.userId,
          orderId: orderIdA2,
          input: { idempotencyKey, reason: "Changed", amountMinor: 2000 },
        });
      },
      (err) => err.code === "IDEMPOTENCY_PAYLOAD_MISMATCH" && err.statusCode === 409,
    );
  });

  it("rejects a refund that exceeds the remaining refundable balance", async () => {
    const refundService = createOrderRefundService(pool);
    const tenantAContext = {
      restaurant: { id: tenantA.restaurantId },
      membership: { userId: tenantA.userId, role: "owner" },
    };

    // orderIdA2 total is 50000; 2000 already refunded above.
    await assert.rejects(
      async () => {
        await refundService.createRefund({
          tenant: tenantAContext,
          userId: tenantA.userId,
          orderId: orderIdA2,
          input: {
            idempotencyKey: "77777777-7777-4777-b777-777777777777",
            reason: "Over refund",
            amountMinor: 100000,
          },
        });
      },
      (err) => err.code === "AMOUNT_EXCEEDS_REFUNDABLE" && err.statusCode === 409,
    );
  });

  it("requires a refund reason", async () => {
    const refundService = createOrderRefundService(pool);
    const tenantAContext = {
      restaurant: { id: tenantA.restaurantId },
      membership: { userId: tenantA.userId, role: "owner" },
    };

    await assert.rejects(
      async () => {
        await refundService.createRefund({
          tenant: tenantAContext,
          userId: tenantA.userId,
          orderId: orderIdA2,
          input: {
            idempotencyKey: "99999999-9999-4999-b999-999999999999",
            reason: "   ",
            amountMinor: 100,
          },
        });
      },
      (err) => err.code === "MISSING_REFUND_REASON" && err.statusCode === 400,
    );
  });

  it("rolls back every write when a later statement fails", async () => {
    const refundService = createOrderRefundService(
      injectFailure(pool, "insert into ledger_entries"),
    );
    const tenantAContext = {
      restaurant: { id: tenantA.restaurantId },
      membership: { userId: tenantA.userId, role: "owner" },
    };

    const beforeRefundCount = (
      await admin.query(
        `SELECT COUNT(*)::int AS count FROM order_refunds WHERE restaurant_id = $1`,
        [tenantA.restaurantId],
      )
    ).rows[0].count;

    const beforeLedgerCount = (
      await admin.query(
        `SELECT COUNT(*)::int AS count FROM ledger_entries
          WHERE restaurant_id = $1 AND source_type = 'refund'`,
        [tenantA.restaurantId],
      )
    ).rows[0].count;

    const beforePaymentStatus = (
      await admin.query(
        `SELECT payment_status FROM orders WHERE id = $1`,
        [orderIdA2],
      )
    ).rows[0].payment_status;

    await assert.rejects(
      async () => {
        await refundService.createRefund({
          tenant: tenantAContext,
          userId: tenantA.userId,
          orderId: orderIdA2,
          input: {
            idempotencyKey: "aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa",
            reason: "Atomicity test",
            amountMinor: 500,
          },
        });
      },
      (err) => err.message === "injected failure",
    );

    const afterRefundCount = (
      await admin.query(
        `SELECT COUNT(*)::int AS count FROM order_refunds WHERE restaurant_id = $1`,
        [tenantA.restaurantId],
      )
    ).rows[0].count;
    assert.equal(afterRefundCount, beforeRefundCount, "refund row must roll back");

    const afterLedgerCount = (
      await admin.query(
        `SELECT COUNT(*)::int AS count FROM ledger_entries
          WHERE restaurant_id = $1 AND source_type = 'refund'`,
        [tenantA.restaurantId],
      )
    ).rows[0].count;
    assert.equal(
      afterLedgerCount,
      beforeLedgerCount,
      "compensating ledger entry must roll back with the refund",
    );

    // The order's payment status must be untouched by the failed attempt.
    const afterPaymentStatus = (
      await admin.query(
        `SELECT payment_status FROM orders WHERE id = $1`,
        [orderIdA2],
      )
    ).rows[0].payment_status;
    assert.equal(
      afterPaymentStatus,
      beforePaymentStatus,
      "failed refund must not alter payment status",
    );
  });

  it("serializes simultaneous refunds so the order never over-refunds", async () => {
    // Fresh order for the concurrency test.
    const orderRes = await admin.query(
      `INSERT INTO orders (
         id, restaurant_id, branch_id, order_number, order_type, order_status,
         payment_status, subtotal_minor, discount_minor, delivery_minor,
         additional_charges_minor, total_minor, business_date, ordered_at,
         idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, 3001, 'dine_in', 'completed',
         'paid', 100000, 0, 0, 0, 100000, CURRENT_DATE, now(),
         gen_random_uuid(), $3
       ) RETURNING id`,
      [tenantA.restaurantId, tenantA.branchId, tenantA.userId],
    );
    const concurrentOrderId = orderRes.rows[0].id;

    await admin.query(
      `INSERT INTO order_payments (
         id, restaurant_id, order_id, payment_method, status, amount_minor,
         idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, 'cash', 'captured', 100000,
         gen_random_uuid(), $3
       )`,
      [tenantA.restaurantId, concurrentOrderId, tenantA.userId],
    );

    const refundService = createOrderRefundService(pool);
    const tenantAContext = {
      restaurant: { id: tenantA.restaurantId },
      membership: { userId: tenantA.userId, role: "owner" },
    };

    // Two concurrent full-refund attempts with different keys: exactly one
    // may succeed; the other must observe the exhausted balance.
    const attempts = await Promise.allSettled([
      refundService.createRefund({
        tenant: tenantAContext,
        userId: tenantA.userId,
        orderId: concurrentOrderId,
        input: {
          idempotencyKey: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
          reason: "Concurrent refund A",
          amountMinor: 100000,
        },
      }),
      refundService.createRefund({
        tenant: tenantAContext,
        userId: tenantA.userId,
        orderId: concurrentOrderId,
        input: {
          idempotencyKey: "cccccccc-cccc-4ccc-bccc-cccccccccccc",
          reason: "Concurrent refund B",
          amountMinor: 100000,
        },
      }),
    ]);

    const fulfilled = attempts.filter((a) => a.status === "fulfilled");
    const rejected = attempts.filter((a) => a.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one concurrent refund may succeed");
    assert.equal(rejected.length, 1);

    const rejectedError = rejected[0].reason;
    assert.ok(
      rejectedError.code === "ORDER_FULLY_REFUNDED"
        || rejectedError.code === "AMOUNT_EXCEEDS_REFUNDABLE",
      `unexpected rejection code: ${rejectedError.code}`,
    );

    const totalRefunded = (
      await admin.query(
        `SELECT COALESCE(SUM(total_refunded_minor), 0) AS total
           FROM order_refunds WHERE restaurant_id = $1 AND order_id = $2`,
        [tenantA.restaurantId, concurrentOrderId],
      )
    ).rows[0].total;
    assert.equal(Number(totalRefunded), 100000, "cumulative refunds must equal the order total");
  });

  it("serializes concurrent item-quantity refunds without over-refunding an item", async () => {
    const orderRes = await admin.query(
      `INSERT INTO orders (
         id, restaurant_id, branch_id, order_number, order_type, order_status,
         payment_status, subtotal_minor, discount_minor, delivery_minor,
         additional_charges_minor, total_minor, business_date, ordered_at,
         idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, 3002, 'dine_in', 'completed',
         'paid', 200000, 0, 0, 0, 200000, CURRENT_DATE, now(),
         gen_random_uuid(), $3
       ) RETURNING id`,
      [tenantA.restaurantId, tenantA.branchId, tenantA.userId],
    );
    const qtyOrderId = orderRes.rows[0].id;

    await admin.query(
      `INSERT INTO order_payments (
         id, restaurant_id, order_id, payment_method, status, amount_minor,
         idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, 'cash', 'captured', 200000,
         gen_random_uuid(), $3
       )`,
      [tenantA.restaurantId, qtyOrderId, tenantA.userId],
    );

    // Two items: the contested "Burger" (2 x 50000) plus a separate
    // "Fries" line (100000) so refunding every burger does NOT exhaust
    // the order total — the loser must fail on item quantity, not on
    // the order balance.
    const itemRes = await admin.query(
      `INSERT INTO order_items (
         id, restaurant_id, order_id, item_name_snapshot, quantity,
         unit_price_minor, line_total_minor
       ) VALUES (
         gen_random_uuid(), $1, $2, 'Burger', 2, 50000, 100000
       ) RETURNING id`,
      [tenantA.restaurantId, qtyOrderId],
    );
    const qtyItemId = itemRes.rows[0].id;

    await admin.query(
      `INSERT INTO order_items (
         id, restaurant_id, order_id, item_name_snapshot, quantity,
         unit_price_minor, line_total_minor
       ) VALUES (
         gen_random_uuid(), $1, $2, 'Fries', 1, 100000, 100000
       )`,
      [tenantA.restaurantId, qtyOrderId],
    );

    const refundService = createOrderRefundService(pool);
    const tenantAContext = {
      restaurant: { id: tenantA.restaurantId },
      membership: { userId: tenantA.userId, role: "owner" },
    };

    // Both attempts try to refund the full burger quantity (2). Only one wins.
    const attempts = await Promise.allSettled([
      refundService.createRefund({
        tenant: tenantAContext,
        userId: tenantA.userId,
        orderId: qtyOrderId,
        input: {
          idempotencyKey: "dddddddd-dddd-4ddd-bddd-dddddddddddd",
          reason: "Quantity race A",
          items: [{ orderItemId: qtyItemId, quantity: 2, restock: false }],
        },
      }),
      refundService.createRefund({
        tenant: tenantAContext,
        userId: tenantA.userId,
        orderId: qtyOrderId,
        input: {
          idempotencyKey: "eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee",
          reason: "Quantity race B",
          items: [{ orderItemId: qtyItemId, quantity: 2, restock: false }],
        },
      }),
    ]);

    const fulfilled = attempts.filter((a) => a.status === "fulfilled");
    const rejected = attempts.filter((a) => a.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one quantity refund may succeed");
    assert.equal(rejected.length, 1);
    assert.equal(
      rejected[0].reason.code,
      "QUANTITY_EXCEEDS_REFUNDABLE",
      "the loser must observe the exhausted item quantity",
    );

    const refundedQty = (
      await admin.query(
        `SELECT COALESCE(SUM(quantity), 0) AS qty FROM order_refund_items ri
           JOIN order_refunds r ON r.id = ri.refund_id
          WHERE r.restaurant_id = $1 AND r.order_id = $2`,
        [tenantA.restaurantId, qtyOrderId],
      )
    ).rows[0].qty;
    assert.equal(Number(refundedQty), 2, "cumulative refunded quantity must equal the sold quantity");
  });

  it("reconciles sales report metrics against completed orders and refunds", async () => {
    const reportService = createSalesReportService(pool);
    const tenantAContext = {
      restaurant: {
        id: tenantA.restaurantId,
        name: "Restaurant Alpha",
        currencyCode: "PKR",
        timezone: "Asia/Karachi",
      },
      membership: { userId: tenantA.userId, role: "owner" },
    };

    const todayStr = new Date().toISOString().substring(0, 10);

    // Compute the authoritative figures straight from the database so
    // the report is verified against real state, not hardcoded guesses.
    const expected = (
      await admin.query(
        `SELECT
           COUNT(*)::int AS order_count,
           COALESCE(SUM(total_minor), 0) AS completed_sales
          FROM orders
         WHERE restaurant_id = $1 AND business_date = $2
           AND order_status = 'completed'`,
        [tenantA.restaurantId, todayStr],
      )
    ).rows[0];

    const expectedRefunds = (
      await admin.query(
        `SELECT COALESCE(SUM(r.total_refunded_minor), 0) AS refund_total
           FROM order_refunds r
          WHERE r.restaurant_id = $1 AND r.status = 'completed'`,
        [tenantA.restaurantId],
      )
    ).rows[0];

    const report = await reportService.getSalesReport({
      tenant: tenantAContext,
      filters: { startDate: todayStr, endDate: todayStr },
    });

    assert.equal(
      report.metrics.completedOrderCount,
      Number(expected.order_count),
      "completed order count must reconcile",
    );
    assert.equal(
      report.metrics.completedSalesMinor,
      Number(expected.completed_sales),
      "completed sales must reconcile",
    );
    assert.equal(
      report.metrics.refundTotalMinor,
      Number(expectedRefunds.refund_total),
      "refund total must reconcile",
    );
    assert.equal(
      report.metrics.netSalesMinor,
      Number(expected.completed_sales) - Number(expectedRefunds.refund_total),
      "net sales must equal completed sales minus refunds",
    );

    // Tenant B sees none of Tenant A's data.
    const tenantBContext = {
      restaurant: {
        id: tenantB.restaurantId,
        name: "Restaurant Beta",
        currencyCode: "PKR",
        timezone: "Asia/Karachi",
      },
      membership: { userId: tenantB.userId, role: "owner" },
    };
    const reportB = await reportService.getSalesReport({
      tenant: tenantBContext,
      filters: { startDate: todayStr, endDate: todayStr },
    });
    assert.equal(reportB.metrics.completedOrderCount, 1);
    assert.equal(reportB.metrics.completedSalesMinor, 50000);
    assert.equal(reportB.metrics.refundTotalMinor, 0);
  });

  it("exports a CSV that neutralizes formula injection", async () => {
    const reportService = createSalesReportService(pool);
    const tenantAContext = {
      restaurant: {
        id: tenantA.restaurantId,
        name: "Restaurant Alpha",
        currencyCode: "PKR",
        timezone: "Asia/Karachi",
      },
      membership: { userId: tenantA.userId, role: "owner" },
    };

    const todayStr = new Date().toISOString().substring(0, 10);
    const csv = await reportService.exportSalesReportCsv({
      tenant: tenantAContext,
      filters: { startDate: todayStr, endDate: todayStr },
    });

    assert.ok(csv.startsWith("﻿"), "CSV must carry a UTF-8 BOM");
    assert.ok(csv.includes("Restaurant Alpha"));
    // No raw value may begin with a formula-triggering character.
    for (const line of csv.split("\n")) {
      for (const cell of line.split(",")) {
        assert.ok(
          !/^[=+\-@]/.test(cell.trim()),
          `CSV cell must be formula-neutralized: ${cell}`,
        );
      }
    }
  });
});
