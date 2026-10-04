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

    const todayStr = (
      await admin.query("SELECT CURRENT_DATE::text AS today")
    ).rows[0].today;
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

  it("applies orderType and paymentMethod filters authoritatively across every output", async () => {
    const reportService = createSalesReportService(pool);

    // A delivery order paid by bank_account, so the paymentMethod and
    // orderType filters can be exercised together on a distinct population.
    const deliveryOrderRes = await admin.query(
      `INSERT INTO orders (
         id, restaurant_id, branch_id, order_number, order_type, order_status,
         payment_status, subtotal_minor, discount_minor, delivery_minor,
         additional_charges_minor, total_minor, business_date, ordered_at,
         idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, 1003, 'delivery', 'completed',
         'paid', 40000, 0, 0, 0, 40000, CURRENT_DATE, now(),
         gen_random_uuid(), $3
       ) RETURNING id`,
      [tenantA.restaurantId, tenantA.branchId, tenantA.userId],
    );
    const deliveryOrderId = deliveryOrderRes.rows[0].id;
    await admin.query(
      `INSERT INTO order_payments (
         id, restaurant_id, order_id, financial_account_id, payment_method,
         status, amount_minor, idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, 'bank_account', 'captured', 40000,
         gen_random_uuid(), $4
       )`,
      [tenantA.restaurantId, deliveryOrderId, cashAccountIdA, tenantA.userId],
    );

    const tenantAContext = {
      restaurant: {
        id: tenantA.restaurantId,
        name: "Restaurant Alpha",
        currencyCode: "PKR",
        timezone: "Asia/Karachi",
      },
      membership: { userId: tenantA.userId, role: "owner" },
    };
    // Use the database's own current date so the seeded orders and the
    // report's date range always agree regardless of timezone.
    const todayStr = (
      await admin.query("SELECT CURRENT_DATE::text AS today")
    ).rows[0].today;

    // Filter by orderType=delivery: every output must describe only the
    // delivery order.
    const byType = await reportService.getSalesReport({
      tenant: tenantAContext,
      filters: { startDate: todayStr, endDate: todayStr, orderType: "delivery" },
    });
    assert.equal(byType.metrics.completedOrderCount, 1);
    assert.equal(byType.metrics.completedSalesMinor, 40000);
    assert.equal(byType.orderTypeBreakdown.length, 1);
    assert.equal(byType.orderTypeBreakdown[0].orderType, "delivery");
    assert.equal(byType.detailedRows.rows.length, 1);
    assert.equal(byType.detailedRows.rows[0].orderType, "delivery");
    assert.equal(byType.detailedRows.pagination.totalRows, 1);
    assert.equal(byType.trends.reduce((s, t) => s + t.orderCount, 0), 1);

    // Filter by paymentMethod=bank_account: the EXISTS strategy must
    // include the delivery order exactly once even though it has a
    // single payment, and exclude the cash orders.
    const byMethod = await reportService.getSalesReport({
      tenant: tenantAContext,
      filters: { startDate: todayStr, endDate: todayStr, paymentMethod: "bank_account" },
    });
    assert.equal(byMethod.metrics.completedOrderCount, 1);
    assert.equal(byMethod.metrics.completedSalesMinor, 40000);
    assert.equal(byMethod.detailedRows.pagination.totalRows, 1);
    assert.equal(byMethod.paymentBreakdown.length, 1);
    assert.equal(byMethod.paymentBreakdown[0].paymentMethod, "bank_account");
    assert.equal(Number(byMethod.paymentBreakdown[0].capturedMinor), 40000);

    // Both filters together.
    const byBoth = await reportService.getSalesReport({
      tenant: tenantAContext,
      filters: {
        startDate: todayStr,
        endDate: todayStr,
        orderType: "delivery",
        paymentMethod: "bank_account",
      },
    });
    assert.equal(byBoth.metrics.completedOrderCount, 1);
    assert.equal(byBoth.metrics.completedSalesMinor, 40000);
    assert.equal(byBoth.detailedRows.pagination.totalRows, 1);

    // A split-tender order in a dedicated restaurant: two cash payments
    // on one order. The paymentMethod filter must count the order exactly
    // once (EXISTS, not a JOIN), so the completed order count and sales
    // total are not doubled.
    const splitTenant = await seedRestaurant(admin, { name: "Split Tender Check" });
    const splitAccountRes = await admin.query(
      `INSERT INTO financial_accounts (restaurant_id, branch_id, account_type, display_name)
       VALUES ($1, $2, 'cash', 'Register Cash') RETURNING id`,
      [splitTenant.restaurantId, splitTenant.branchId],
    );
    const splitAccountId = splitAccountRes.rows[0].id;

    const splitOrderRes = await admin.query(
      `INSERT INTO orders (
         id, restaurant_id, branch_id, order_number, order_type, order_status,
         payment_status, subtotal_minor, discount_minor, delivery_minor,
         additional_charges_minor, total_minor, business_date, ordered_at,
         idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, 1004, 'dine_in', 'completed',
         'paid', 60000, 0, 0, 0, 60000, CURRENT_DATE, now(),
         gen_random_uuid(), $3
       ) RETURNING id`,
      [splitTenant.restaurantId, splitTenant.branchId, splitTenant.userId],
    );
    const splitOrderId = splitOrderRes.rows[0].id;
    for (const amount of [35000, 25000]) {
      await admin.query(
        `INSERT INTO order_payments (
           id, restaurant_id, order_id, financial_account_id, payment_method,
           status, amount_minor, idempotency_key, created_by_user_id
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, 'cash', 'captured', $4,
           gen_random_uuid(), $5
         )`,
        [splitTenant.restaurantId, splitOrderId, splitAccountId, amount, splitTenant.userId],
      );
    }

    const splitContext = {
      restaurant: {
        id: splitTenant.restaurantId,
        name: "Split Tender Check",
        currencyCode: "PKR",
        timezone: "Asia/Karachi",
      },
      membership: { userId: splitTenant.userId, role: "owner" },
    };
    const splitReport = await reportService.getSalesReport({
      tenant: splitContext,
      filters: { startDate: todayStr, endDate: todayStr, paymentMethod: "cash" },
    });
    // The split-tender order is counted once, not twice: its 60000 total
    // appears exactly once in completed sales, and the order count is 1
    // (one matching order), not 2 (the number of payments).
    assert.equal(splitReport.metrics.completedOrderCount, 1);
    assert.equal(splitReport.metrics.completedSalesMinor, 60000);
    assert.equal(splitReport.detailedRows.pagination.totalRows, 1);
    // The cash captured total is the sum of both cash payments on the
    // single order: 35000 + 25000 = 60000.
    const cashRow = splitReport.paymentBreakdown.find((p) => p.paymentMethod === "cash");
    assert.equal(Number(cashRow.capturedMinor), 35000 + 25000);
  });

  it("does not fan out captured amounts when one payment has two partial refunds", async () => {
    const refundService = createOrderRefundService(pool);
    const reportService = createSalesReportService(pool);

    // A dedicated restaurant so the cash breakdown isolates the fan-out
    // payment from every other seeded order.
    const fanTenant = await seedRestaurant(admin, { name: "Fanout Check" });
    const fanAccountRes = await admin.query(
      `INSERT INTO financial_accounts (restaurant_id, branch_id, account_type, display_name)
       VALUES ($1, $2, 'cash', 'Register Cash') RETURNING id`,
      [fanTenant.restaurantId, fanTenant.branchId],
    );
    const fanAccountId = fanAccountRes.rows[0].id;

    // A single captured payment of 100000.
    const fanOrderRes = await admin.query(
      `INSERT INTO orders (
         id, restaurant_id, branch_id, order_number, order_type, order_status,
         payment_status, subtotal_minor, discount_minor, delivery_minor,
         additional_charges_minor, total_minor, business_date, ordered_at,
         idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, 1005, 'dine_in', 'completed',
         'paid', 100000, 0, 0, 0, 100000, CURRENT_DATE, now(),
         gen_random_uuid(), $3
       ) RETURNING id`,
      [fanTenant.restaurantId, fanTenant.branchId, fanTenant.userId],
    );
    const fanOrderId = fanOrderRes.rows[0].id;
    const fanPaymentRes = await admin.query(
      `INSERT INTO order_payments (
         id, restaurant_id, order_id, financial_account_id, payment_method,
         status, amount_minor, idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, 'cash', 'captured', 100000,
         gen_random_uuid(), $4
       ) RETURNING id`,
      [fanTenant.restaurantId, fanOrderId, fanAccountId, fanTenant.userId],
    );
    const fanPaymentId = fanPaymentRes.rows[0].id;

    const fanContext = {
      restaurant: {
        id: fanTenant.restaurantId,
        name: "Fanout Check",
        currencyCode: "PKR",
        timezone: "Asia/Karachi",
      },
      membership: { userId: fanTenant.userId, role: "owner" },
    };

    // Two partial refunds against the same payment: 30000 then 20000.
    await refundService.createRefund({
      tenant: fanContext,
      userId: fanTenant.userId,
      orderId: fanOrderId,
      input: {
        idempotencyKey: "aaaaaaaa-0001-4000-8000-000000000001",
        reason: "First partial refund",
        amountMinor: 30000,
      },
    });
    await refundService.createRefund({
      tenant: fanContext,
      userId: fanTenant.userId,
      orderId: fanOrderId,
      input: {
        idempotencyKey: "aaaaaaaa-0002-4000-8000-000000000002",
        reason: "Second partial refund",
        amountMinor: 20000,
      },
    });

    const todayStr = (
      await admin.query("SELECT CURRENT_DATE::text AS today")
    ).rows[0].today;
    const report = await reportService.getSalesReport({
      tenant: fanContext,
      filters: { startDate: todayStr, endDate: todayStr },
    });

    const cashRow = report.paymentBreakdown.find((p) => p.paymentMethod === "cash");
    // Captured amount is counted exactly once (100000), not duplicated
    // by the two refund tenders.
    assert.equal(Number(cashRow.capturedMinor), 100000);
    // Refunded amount is the exact sum of the two refund tenders.
    assert.equal(Number(cashRow.refundedMinor), 50000);
    // Net equals captured minus refunded.
    assert.equal(Number(cashRow.netMinor), 50000);

    // The refund tender rows confirm two distinct tenders on one payment.
    const tenderRes = await admin.query(
      `SELECT order_payment_id, SUM(amount_minor) AS refunded, COUNT(*)::int AS tender_count
         FROM order_refund_tenders
        WHERE restaurant_id = $1 AND order_payment_id = $2
        GROUP BY order_payment_id`,
      [fanTenant.restaurantId, fanPaymentId],
    );
    assert.equal(tenderRes.rows.length, 1);
    assert.equal(Number(tenderRes.rows[0].refunded), 50000);
    assert.equal(Number(tenderRes.rows[0].tender_count), 2);
  });

  it("exports every eligible row exactly once when there are more than 200 orders", async () => {
    const reportService = createSalesReportService(pool);

    // A dedicated restaurant so the 250 seeded orders do not interfere
    // with the other scenarios' counts.
    const exportTenant = await seedRestaurant(admin, { name: "Export Volume" });
    const exportAccountRes = await admin.query(
      `INSERT INTO financial_accounts (restaurant_id, branch_id, account_type, display_name)
       VALUES ($1, $2, 'cash', 'Register Cash') RETURNING id`,
      [exportTenant.restaurantId, exportTenant.branchId],
    );
    const exportAccountId = exportAccountRes.rows[0].id;

    const totalOrders = 250;
    for (let i = 1; i <= totalOrders; i += 1) {
      const orderRes = await admin.query(
        `INSERT INTO orders (
           id, restaurant_id, branch_id, order_number, order_type, order_status,
           payment_status, subtotal_minor, discount_minor, delivery_minor,
           additional_charges_minor, total_minor, business_date, ordered_at,
           idempotency_key, created_by_user_id
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, 'dine_in', 'completed',
           'paid', 1000, 0, 0, 0, 1000, CURRENT_DATE, now(),
           gen_random_uuid(), $4
         ) RETURNING id`,
        [exportTenant.restaurantId, exportTenant.branchId, 5000 + i, exportTenant.userId],
      );
      await admin.query(
        `INSERT INTO order_payments (
           id, restaurant_id, order_id, financial_account_id, payment_method,
           status, amount_minor, idempotency_key, created_by_user_id
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, 'cash', 'captured', 1000,
           gen_random_uuid(), $4
         )`,
        [exportTenant.restaurantId, orderRes.rows[0].id, exportAccountId, exportTenant.userId],
      );
    }

    const exportContext = {
      restaurant: {
        id: exportTenant.restaurantId,
        name: "Export Volume",
        currencyCode: "PKR",
        timezone: "Asia/Karachi",
      },
      membership: { userId: exportTenant.userId, role: "owner" },
    };
    const todayStr = (
      await admin.query("SELECT CURRENT_DATE::text AS today")
    ).rows[0].today;

    const csv = await reportService.exportSalesReportCsv({
      tenant: exportContext,
      filters: { startDate: todayStr, endDate: todayStr },
    });

    // Count the detailed-row lines: each carries the order number in
    // the 5000+ range, wrapped in CSV quotes. Every eligible order
    // must appear exactly once.
    const parseOrderNumber = (cell) => Number(cell.replace(/^"|"$/g, ""));
    const rowLines = csv.split("\n").filter((line) => {
      const cells = line.split(",");
      if (cells.length < 8) return false;
      const orderNumber = parseOrderNumber(cells[0]);
      return Number.isInteger(orderNumber) && orderNumber > 5000 && orderNumber <= 5000 + totalOrders;
    });
    assert.equal(rowLines.length, totalOrders, "every eligible order must appear exactly once in the CSV");

    // No order number is duplicated.
    const seen = new Set();
    for (const line of rowLines) {
      const orderNumber = parseOrderNumber(line.split(",")[0]);
      assert.ok(!seen.has(orderNumber), `order ${orderNumber} must appear exactly once`);
      seen.add(orderNumber);
    }
    assert.equal(seen.size, totalOrders);
  });

  it("rejects ineligible order and payment states with ORDER_INELIGIBLE", async () => {
    const refundService = createOrderRefundService(pool);
    const tenantAContext = {
      restaurant: { id: tenantA.restaurantId },
      membership: { userId: tenantA.userId, role: "owner" },
    };

    const ineligibleStates = [
      { orderStatus: "new", paymentStatus: "unpaid", label: "new" },
      { orderStatus: "preparing", paymentStatus: "unpaid", label: "preparing" },
      { orderStatus: "ready", paymentStatus: "unpaid", label: "ready" },
      { orderStatus: "served", paymentStatus: "unpaid", label: "served" },
      { orderStatus: "completed", paymentStatus: "unpaid", label: "unpaid" },
      { orderStatus: "completed", paymentStatus: "partially_paid", label: "partially_paid" },
      { orderStatus: "cancelled", paymentStatus: "paid", label: "cancelled" },
    ];

    for (const [index, state] of ineligibleStates.entries()) {
      const res = await admin.query(
        `INSERT INTO orders (
           id, restaurant_id, branch_id, order_number, order_type, order_status,
           payment_status, subtotal_minor, discount_minor, delivery_minor,
           additional_charges_minor, total_minor, business_date, ordered_at,
           idempotency_key, created_by_user_id
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, 'dine_in', $4, $5,
           10000, 0, 0, 0, 10000, CURRENT_DATE, now(),
           gen_random_uuid(), $6
         ) RETURNING id`,
        [tenantA.restaurantId, tenantA.branchId, 9000 + index, state.orderStatus, state.paymentStatus, tenantA.userId],
      );
      const ineligibleOrderId = res.rows[0].id;
      await admin.query(
        `INSERT INTO order_payments (
           id, restaurant_id, order_id, financial_account_id, payment_method,
           status, amount_minor, idempotency_key, created_by_user_id
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, 'cash', 'captured', 10000,
           gen_random_uuid(), $4
         )`,
        [tenantA.restaurantId, ineligibleOrderId, cashAccountIdA, tenantA.userId],
      );

      await assert.rejects(
        async () => {
          await refundService.createRefund({
            tenant: tenantAContext,
            userId: tenantA.userId,
            orderId: ineligibleOrderId,
            input: {
              idempotencyKey: `bbbbbbbb-${String(index).padStart(4, "0")}-4000-8000-00000000000${index}`,
              reason: "Ineligible state attempt",
              amountMinor: 1000,
            },
          });
        },
        (err) => err.code === "ORDER_INELIGIBLE" && err.statusCode === 409,
        `${state.label} order must be rejected with ORDER_INELIGIBLE`,
      );
    }
  });

  it("rejects a refund that exceeds the captured payment amount", async () => {
    const refundService = createOrderRefundService(pool);

    // An order whose total (100000) exceeds its captured payment (40000),
    // for example a partially-captured authorization. A refund must never
    // exceed money actually captured.
    const overOrderRes = await admin.query(
      `INSERT INTO orders (
         id, restaurant_id, branch_id, order_number, order_type, order_status,
         payment_status, subtotal_minor, discount_minor, delivery_minor,
         additional_charges_minor, total_minor, business_date, ordered_at,
         idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, 1006, 'dine_in', 'completed',
         'paid', 100000, 0, 0, 0, 100000, CURRENT_DATE, now(),
         gen_random_uuid(), $3
       ) RETURNING id`,
      [tenantA.restaurantId, tenantA.branchId, tenantA.userId],
    );
    const overOrderId = overOrderRes.rows[0].id;
    await admin.query(
      `INSERT INTO order_payments (
         id, restaurant_id, order_id, financial_account_id, payment_method,
         status, amount_minor, idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, 'cash', 'captured', 40000,
         gen_random_uuid(), $4
       )`,
      [tenantA.restaurantId, overOrderId, cashAccountIdA, tenantA.userId],
    );

    const tenantAContext = {
      restaurant: { id: tenantA.restaurantId },
      membership: { userId: tenantA.userId, role: "owner" },
    };

    await assert.rejects(
      async () => {
        await refundService.createRefund({
          tenant: tenantAContext,
          userId: tenantA.userId,
          orderId: overOrderId,
          input: {
            idempotencyKey: "cccccccc-0001-4000-8000-000000000001",
            reason: "Over-captured refund attempt",
            amountMinor: 50000,
          },
        });
      },
      (err) => err.code === "AMOUNT_EXCEEDS_REFUNDABLE" && err.statusCode === 409,
      "a refund larger than the captured balance must be rejected",
    );
  });

  it("allocates a partial refund proportionally across split tenders", async () => {
    const refundService = createOrderRefundService(pool);

    // A completed order with two captured tenders: 50000 cash and 40000
    // bank_account (total captured 90000).
    const splitOrderRes = await admin.query(
      `INSERT INTO orders (
         id, restaurant_id, branch_id, order_number, order_type, order_status,
         payment_status, subtotal_minor, discount_minor, delivery_minor,
         additional_charges_minor, total_minor, business_date, ordered_at,
         idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, 1007, 'dine_in', 'completed',
         'paid', 90000, 0, 0, 0, 90000, CURRENT_DATE, now(),
         gen_random_uuid(), $3
       ) RETURNING id`,
      [tenantA.restaurantId, tenantA.branchId, tenantA.userId],
    );
    const splitOrderId = splitOrderRes.rows[0].id;
    const cashPaymentRes = await admin.query(
      `INSERT INTO order_payments (
         id, restaurant_id, order_id, financial_account_id, payment_method,
         status, amount_minor, idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, 'cash', 'captured', 50000,
         gen_random_uuid(), $4
       ) RETURNING id`,
      [tenantA.restaurantId, splitOrderId, cashAccountIdA, tenantA.userId],
    );
    const bankPaymentRes = await admin.query(
      `INSERT INTO order_payments (
         id, restaurant_id, order_id, financial_account_id, payment_method,
         status, amount_minor, idempotency_key, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, 'bank_account', 'captured', 40000,
         gen_random_uuid(), $4
       ) RETURNING id`,
      [tenantA.restaurantId, splitOrderId, cashAccountIdA, tenantA.userId],
    );

    const tenantAContext = {
      restaurant: { id: tenantA.restaurantId },
      membership: { userId: tenantA.userId, role: "owner" },
    };

    // A 60000 refund across the 50000/40000 split: exact shares are
    // 33333.33 (cash) and 26666.67 (bank). The floors sum to 59999 and
    // the largest-remainder rule gives the leftover unit to the bank
    // tender (the larger fractional part), yielding 33333 and 26667.
    const result = await refundService.createRefund({
      tenant: tenantAContext,
      userId: tenantA.userId,
      orderId: splitOrderId,
      input: {
        idempotencyKey: "dddddddd-0001-4000-8000-000000000001",
        reason: "Proportional split-tender refund",
        amountMinor: 60000,
      },
    });

    assert.equal(result.refund.totalRefundedMinor, 60000);
    assert.equal(result.refund.tenders.length, 2);
    const cashTender = result.refund.tenders.find((t) => t.orderPaymentId === cashPaymentRes.rows[0].id);
    const bankTender = result.refund.tenders.find((t) => t.orderPaymentId === bankPaymentRes.rows[0].id);
    assert.equal(Number(cashTender.amountMinor), 33333);
    assert.equal(Number(bankTender.amountMinor), 26667);
    // Integer allocations that sum exactly to the refund amount.
    assert.equal(
      Number(cashTender.amountMinor) + Number(bankTender.amountMinor),
      60000,
    );
    // No payment is over-refunded beyond its captured balance.
    assert.ok(Number(cashTender.amountMinor) <= 50000);
    assert.ok(Number(bankTender.amountMinor) <= 40000);

    // A replay with the same idempotency key returns the same allocation.
    const replay = await refundService.createRefund({
      tenant: tenantAContext,
      userId: tenantA.userId,
      orderId: splitOrderId,
      input: {
        idempotencyKey: "dddddddd-0001-4000-8000-000000000001",
        reason: "Proportional split-tender refund",
        amountMinor: 60000,
      },
    });
    assert.equal(replay.replayed, true);
    const replayCash = replay.refund.tenders.find((t) => t.orderPaymentId === cashPaymentRes.rows[0].id);
    const replayBank = replay.refund.tenders.find((t) => t.orderPaymentId === bankPaymentRes.rows[0].id);
    assert.equal(Number(replayCash.amountMinor), 33333);
    assert.equal(Number(replayBank.amountMinor), 26667);
  });
});
