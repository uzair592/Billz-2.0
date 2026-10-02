import { withTenantTransaction } from "../database/tenant-transaction.mjs";
import { apiError } from "./business-date.mjs";

function minor(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function mapCancellation(row) {
  return {
    cancelledAt: row.cancelled_at,
    reason: row.reason ?? null,
    refundedMinor: minor(row.refunded_minor),
    restocked: row.restocked ?? [],
  };
}

export function createOrderCancellationService(pool, { clock = () => new Date() } = {}) {
  return Object.freeze({
    /**
     * Cancelling is the compensating transaction for a completed sale. It
     * returns consumed stock to the branch balance, refunds captured payments
     * into the same financial accounts, and excludes the order from revenue,
     * which is exactly what the standalone POS did locally.
     *
     * The whole compensation is one transaction and is safe to replay: the
     * order row is locked, an existing cancellation record is returned as-is,
     * stock reversals collide on a partial unique index, and ledger debits
     * collide on their source key.
     */
    async cancel({ tenant, userId, orderId, reason, idempotencyKey }) {
      const restaurantId = tenant.restaurant.id;
      const now = clock();

      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          const orderResult = await client.query(
            `SELECT id, branch_id, order_number, order_status, payment_status, total_minor
               FROM orders
              WHERE id = $1
              FOR UPDATE`,
            [orderId],
          );
          const order = orderResult.rows[0];
          if (!order) throw apiError("Order not found.", "ORDER_NOT_FOUND", 404);

          const existingResult = await client.query(
            `SELECT cancelled_at, reason, refunded_minor, restocked
               FROM order_cancellations
              WHERE order_id = $1`,
            [orderId],
          );
          if (existingResult.rows[0]) {
            return {
              order: {
                id: order.id,
                orderNumber: Number(order.order_number),
                orderStatus: "cancelled",
                paymentStatus: order.payment_status,
                cancelledAt: existingResult.rows[0].cancelled_at,
              },
              cancellation: mapCancellation(existingResult.rows[0]),
              replayed: true,
            };
          }
          if (order.order_status === "cancelled") {
            throw apiError(
              "This order was cancelled outside the recorded cancellation flow.",
              "ORDER_ALREADY_CANCELLED",
              409,
            );
          }

          const reversalResult = await client.query(
            `WITH sales AS (
               SELECT stock_item_id, SUM(-quantity_delta) AS quantity
                 FROM stock_movements
                WHERE restaurant_id = $1 AND order_id = $2 AND movement_type = 'sale'
                GROUP BY stock_item_id
             ), reversals AS (
               SELECT stock_item_id, SUM(quantity_delta) AS quantity
                 FROM stock_movements
                WHERE restaurant_id = $1 AND order_id = $2
                  AND movement_type = 'sale_reversal'
                GROUP BY stock_item_id
             )
             INSERT INTO stock_movements (
               id, restaurant_id, branch_id, stock_item_id, order_id,
               movement_type, quantity_delta, idempotency_key, occurred_at,
               created_by_user_id
             )
             SELECT gen_random_uuid(), $1, $3, s.stock_item_id, $2,
                    'sale_reversal', s.quantity + COALESCE(r.quantity, 0),
                    gen_random_uuid(), $4, $5
               FROM sales s
               LEFT JOIN reversals r ON r.stock_item_id = s.stock_item_id
              WHERE s.quantity + COALESCE(r.quantity, 0) <> 0
             ON CONFLICT (restaurant_id, order_id, stock_item_id)
               WHERE movement_type = 'sale_reversal'
             DO NOTHING
             RETURNING stock_item_id, quantity_delta`,
            [restaurantId, orderId, order.branch_id, now, userId],
          );

          const restocked = [];
          for (const movement of reversalResult.rows) {
            await client.query(
              `UPDATE inventory_balances
                  SET quantity_base_units = quantity_base_units + $4,
                      version = version + 1, updated_at = $5
                WHERE restaurant_id = $1 AND branch_id = $2 AND stock_item_id = $3`,
              [
                restaurantId, order.branch_id, movement.stock_item_id,
                movement.quantity_delta, now,
              ],
            );
            restocked.push({
              stockItemId: movement.stock_item_id,
              quantityBaseUnits: Number(movement.quantity_delta),
            });
          }

          const paymentResult = await client.query(
            `UPDATE order_payments
                SET status = 'refunded'
              WHERE restaurant_id = $1 AND order_id = $2 AND status = 'captured'
              RETURNING id, financial_account_id, amount_minor`,
            [restaurantId, orderId],
          );

          let refundedMinor = 0;
          for (const payment of paymentResult.rows) {
            refundedMinor += minor(payment.amount_minor);
            if (!payment.financial_account_id) continue;
            await client.query(
              `INSERT INTO ledger_entries (
                 id, restaurant_id, branch_id, financial_account_id,
                 order_payment_id, entry_type, amount_minor, description,
                 source_type, source_key, occurred_at
               ) VALUES (
                 gen_random_uuid(), $1, $2, $3, $4, 'debit', $5, $6,
                 'refund', $7, $8
               )
               ON CONFLICT DO NOTHING`,
              [
                restaurantId, order.branch_id, payment.financial_account_id,
                payment.id, payment.amount_minor,
                `Refund / Cancelled Order #${order.order_number}`,
                `refund:${orderId}:${payment.id}`, now,
              ],
            );
          }

          const paymentStatus = refundedMinor > 0 ? "refunded" : order.payment_status;
          await client.query(
            `UPDATE orders
                SET order_status = 'cancelled',
                    payment_status = $3,
                    cancelled_at = $4,
                    cancellation_reason = $5,
                    version = version + 1,
                    updated_by_user_id = $6,
                    updated_at = $4
              WHERE restaurant_id = $1 AND id = $2`,
            [restaurantId, orderId, paymentStatus, now, reason ?? null, userId],
          );

          const restockedSummary = restocked.length
            ? restocked
              .map((entry) => `${entry.stockItemId} +${entry.quantityBaseUnits}`)
              .join("; ")
            : "Nothing restocked";
          const cancellationResult = await client.query(
            `INSERT INTO order_cancellations (
               id, restaurant_id, order_id, branch_id, reason,
               cancelled_by_user_id, cancelled_at, refunded_minor, restocked,
               idempotency_key
             ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
             ON CONFLICT DO NOTHING
             RETURNING cancelled_at, reason, refunded_minor, restocked`,
            [
              restaurantId, orderId, order.branch_id, reason ?? null, userId,
              now, refundedMinor, JSON.stringify(restocked), idempotencyKey,
            ],
          );

          await client.query(
            `INSERT INTO order_edit_events (
               id, restaurant_id, order_id, actor_user_id,
               event_type, changes, note
             ) VALUES (gen_random_uuid(), $1, $2, $3, 'cancelled', $4::jsonb, $5)`,
            [
              restaurantId, orderId, userId,
              JSON.stringify([
                { label: "Order status", from: order.order_status, to: "cancelled" },
                {
                  label: "Revenue effect",
                  from: order.total_minor,
                  to: 0,
                },
                { label: "Refunded", from: 0, to: refundedMinor },
              ]),
              `Reason: ${reason || "not given"}\nRestocked: ${restockedSummary}`,
            ],
          );

          const cancellation = cancellationResult.rows[0];
          if (cancellation) {
            return {
              order: {
                id: order.id,
                orderNumber: Number(order.order_number),
                orderStatus: "cancelled",
                paymentStatus,
                cancelledAt: cancellation.cancelled_at,
              },
              cancellation: mapCancellation(cancellation),
              replayed: false,
            };
          }

          // A concurrent request committed the same cancellation first. Return
          // the stored record instead of a second compensation.
          const storedResult = await client.query(
            `SELECT cancelled_at, reason, refunded_minor, restocked
               FROM order_cancellations
              WHERE order_id = $1`,
            [orderId],
          );
          return {
            order: {
              id: order.id,
              orderNumber: Number(order.order_number),
              orderStatus: "cancelled",
              paymentStatus,
              cancelledAt: storedResult.rows[0]?.cancelled_at ?? now,
            },
            cancellation: mapCancellation(storedResult.rows[0] ?? {
              cancelled_at: now,
              reason: reason ?? null,
              refunded_minor: refundedMinor,
              restocked,
            }),
            replayed: true,
          };
        },
      );
    },
  });
}
