import { createHash } from "node:crypto";
import { withTenantTransaction } from "../database/tenant-transaction.mjs";
import { apiError } from "./business-date.mjs";

function minor(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Deterministic minor-unit proportion with an explicit half-up rounding rule.
 * Every money figure in this service is an integer count of minor units —
 * no floating-point money arithmetic ever reaches the database.
 */
function proportionalMinor(baseMinor, numerator, denominator) {
  if (!denominator) return 0;
  return Math.floor((baseMinor * numerator) / denominator + 0.5);
}

function hashPayload(payload) {
  return createHash("sha256")
    .update(JSON.stringify(payload ?? {}))
    .digest("hex");
}

/**
 * Deterministic proportional allocation of `totalMinor` across payment
 * balances using the largest-remainder method.
 *
 * Each payment's ideal share is `totalMinor * remaining / totalRemaining`.
 * The integer floor of each share is assigned first; the leftover minor
 * units (at most one per payment) are distributed to the payments with
 * the largest fractional remainders, tie-broken by the payment's
 * position in the input array (which is already deterministically
 * ordered by created_at, then id).
 *
 * Guarantees:
 *   - every allocation is an integer,
 *   - no payment is allocated more than its remaining balance,
 *   - the allocations sum exactly to `totalMinor`,
 *   - the same inputs always produce the same allocation.
 *
 * `balances` is an array of objects with `remainingMinor` (number) and
 * is mutated only to attach `amountMinor`. Returns the same array with
 * `amountMinor` set on each entry that receives an allocation.
 */
function allocateProportional(totalMinor, balances) {
  const totalRemaining = balances.reduce((sum, b) => sum + b.remainingMinor, 0);
  if (totalRemaining <= 0 || totalMinor <= 0) {
    return balances.map((b) => ({ ...b, amountMinor: 0 }));
  }

  // Exact rational shares: floor + fractional remainder.
  const floors = balances.map((b) => {
    const exact = (totalMinor * b.remainingMinor) / totalRemaining;
    const floor = Math.floor(exact);
    // A payment can never receive more than its remaining balance.
    return { floor: Math.min(floor, b.remainingMinor), exact };
  });

  let allocated = floors.reduce((sum, f) => sum + f.floor, 0);
  let remainder = totalMinor - allocated;

  // Distribute the leftover units to the largest fractional remainders.
  // Sorting is stable and deterministic: index order breaks ties.
  const byRemainder = floors
    .map((f, index) => ({ index, fractional: f.exact - f.floor }))
    .sort((a, b) => b.fractional - a.fractional || a.index - b.index);

  const result = balances.map((b, index) => ({
    ...b,
    amountMinor: floors[index].floor,
  }));

  for (const { index } of byRemainder) {
    if (remainder <= 0) break;
    if (result[index].amountMinor < result[index].remainingMinor) {
      result[index].amountMinor += 1;
      remainder -= 1;
    }
  }

  // If any remainder is left (only possible when every payment hit its
  // balance cap), assign it to the first payment with remaining capacity.
  for (const entry of result) {
    if (remainder <= 0) break;
    if (entry.amountMinor < entry.remainingMinor) {
      entry.amountMinor += 1;
      remainder -= 1;
    }
  }

  return result;
}

function mapRefund(row, items = [], tenders = []) {
  return {
    id: row.id,
    refundNumber: row.refund_number,
    orderId: row.order_id,
    branchId: row.branch_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    reason: row.reason,
    notes: row.notes ?? null,
    subtotalRefundedMinor: minor(row.subtotal_refunded_minor),
    taxRefundedMinor: minor(row.tax_refunded_minor),
    discountRefundedMinor: minor(row.discount_refunded_minor),
    chargeRefundedMinor: minor(row.charge_refunded_minor),
    totalRefundedMinor: minor(row.total_refunded_minor),
    isFullRefund: Boolean(row.is_full_refund),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    items,
    tenders,
  };
}

export function createOrderRefundService(pool, { clock = () => new Date() } = {}) {
  return Object.freeze({
    /**
     * Executes a production-grade partial or full order refund within a single
     * tenant transaction. Locks order/payment/refund rows, enforces tenant isolation,
     * allocates tenders and compensating accounting entries, handles stock restock using
     * original frozen recipe snapshots, and enforces strict idempotency.
     */
    async createRefund({ tenant, userId, orderId, input }) {
      const restaurantId = tenant.restaurant.id;
      const now = clock();

      const normalizedInput = {
        items: (input.items ?? []).map((item) => ({
          orderItemId: item.orderItemId,
          quantity: Number(item.quantity),
          restock: Boolean(item.restock),
        })),
        amountMinor: input.amountMinor !== undefined && input.amountMinor !== null
          ? minor(input.amountMinor)
          : null,
        reason: (input.reason ?? "").trim(),
        notes: input.notes ? String(input.notes).trim() : null,
      };

      if (!normalizedInput.reason) {
        throw apiError("A refund reason is required.", "MISSING_REFUND_REASON", 400);
      }

      const payloadHash = hashPayload(normalizedInput);
      const idempotencyKey = input.idempotencyKey;

      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          // Advisory xact lock on idempotency key to prevent concurrent replay races
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            [idempotencyKey],
          );

          // Lock order row for update
          const orderResult = await client.query(
            `SELECT id, branch_id, order_number, order_status, payment_status,
                    subtotal_minor, discount_minor, delivery_minor,
                    additional_charges_minor, total_minor
               FROM orders
              WHERE id = $1
              FOR UPDATE`,
            [orderId],
          );
          const order = orderResult.rows[0];
          if (!order) throw apiError("Order not found.", "ORDER_NOT_FOUND", 404);

          // Server-side eligibility: a refund is only valid for a completed
          // order whose payment state is paid, partially_refunded, or
          // refunded. The client hides the refund button for other states,
          // but the server must not rely on that — draft, held, open,
          // cancelled, unpaid, and any other ineligible state is rejected
          // here with ORDER_INELIGIBLE.
          const eligibleOrderStatus = order.order_status === "completed";
          const eligiblePaymentStatus = ["paid", "partially_refunded", "refunded"].includes(
            order.payment_status,
          );
          if (!eligibleOrderStatus || !eligiblePaymentStatus) {
            throw apiError(
              "Only completed orders with a paid or partially refunded payment state can be refunded.",
              "ORDER_INELIGIBLE",
              409,
            );
          }

          // Check for existing idempotency key match (tenant-scoped explicitly)
          const existingRefundResult = await client.query(
            `SELECT id, refund_number, order_id, branch_id, idempotency_key,
                    payload_hash, status, reason, notes, subtotal_refunded_minor,
                    tax_refunded_minor, discount_refunded_minor, charge_refunded_minor,
                    total_refunded_minor, is_full_refund, created_by_user_id, created_at
               FROM order_refunds
              WHERE restaurant_id = $1 AND idempotency_key = $2`,
            [restaurantId, idempotencyKey],
          );
          const existing = existingRefundResult.rows[0];
          if (existing) {
            if (existing.payload_hash !== payloadHash) {
              throw apiError(
                "Idempotency key was previously used with a different payload.",
                "IDEMPOTENCY_PAYLOAD_MISMATCH",
                409,
              );
            }

            const itemsRes = await client.query(
              `SELECT id, order_item_id, quantity, unit_price_minor, line_total_minor, restock
                 FROM order_refund_items
                WHERE restaurant_id = $1 AND refund_id = $2`,
              [restaurantId, existing.id],
            );
            const tendersRes = await client.query(
              `SELECT id, order_payment_id, financial_account_id, payment_method, amount_minor
                 FROM order_refund_tenders
                WHERE restaurant_id = $1 AND refund_id = $2`,
              [restaurantId, existing.id],
            );

            // Return existing replayed response
            return {
              refund: mapRefund(
                existing,
                itemsRes.rows.map((r) => ({
                  id: r.id,
                  orderItemId: r.order_item_id,
                  quantity: Number(r.quantity),
                  unitPriceMinor: minor(r.unit_price_minor),
                  lineTotalMinor: minor(r.line_total_minor),
                  restock: Boolean(r.restock),
                })),
                tendersRes.rows.map((t) => ({
                  id: t.id,
                  orderPaymentId: t.order_payment_id,
                  financialAccountId: t.financial_account_id,
                  paymentMethod: t.payment_method,
                  amountMinor: minor(t.amount_minor),
                })),
              ),
              order: {
                id: order.id,
                orderNumber: Number(order.order_number),
                orderStatus: order.order_status,
                paymentStatus: order.payment_status,
              },
              replayed: true,
            };
          }

          // Calculate cumulative refunded amount so far across all previous refunds for this order
          const sumRes = await client.query(
            `SELECT COALESCE(SUM(total_refunded_minor), 0) AS total_refunded
               FROM order_refunds
              WHERE restaurant_id = $1 AND order_id = $2 AND status = 'completed'`,
            [restaurantId, orderId],
          );
          const totalAlreadyRefunded = minor(sumRes.rows[0].total_refunded);
          const orderTotalMinor = minor(order.total_minor);
          const remainingRefundableMinor = Math.max(0, orderTotalMinor - totalAlreadyRefunded);

          if (remainingRefundableMinor <= 0) {
            throw apiError(
              "This order is already fully refunded.",
              "ORDER_FULLY_REFUNDED",
              409,
            );
          }

          let subtotalRefundedMinor = 0;
          let discountRefundedMinor = 0;
          let chargeRefundedMinor = 0;
          let taxRefundedMinor = 0;
          let totalRefundedMinor = 0;
          const processedItems = [];
          // Aggregated stock restock deltas: stockItemId -> quantity delta.
          const restockByStockItem = new Map();

          if (normalizedInput.items.length > 0) {
            // Item-level partial refund
            const itemIds = normalizedInput.items.map((i) => i.orderItemId);
            if (new Set(itemIds).size !== itemIds.length) {
              throw apiError("Duplicate items in refund request.", "DUPLICATE_REFUND_ITEM", 400);
            }

            const orderItemsRes = await client.query(
              `SELECT id, menu_item_id, item_name_snapshot, quantity, unit_price_minor,
                      line_total_minor, recipe_snapshot
                 FROM order_items
                WHERE restaurant_id = $1 AND order_id = $2`,
              [restaurantId, orderId],
            );
            const orderItemsMap = new Map(orderItemsRes.rows.map((row) => [row.id, row]));

            // Query previously refunded quantities per item
            const prevItemRefundsRes = await client.query(
              `SELECT ri.order_item_id, SUM(ri.quantity) AS qty_refunded
                 FROM order_refund_items ri
                 JOIN order_refunds r ON r.id = ri.refund_id
                WHERE r.restaurant_id = $1 AND r.order_id = $2 AND r.status = 'completed'
                GROUP BY ri.order_item_id`,
              [restaurantId, orderId],
            );
            const prevItemRefundsMap = new Map(
              prevItemRefundsRes.rows.map((r) => [r.order_item_id, Number(r.qty_refunded)]),
            );

            const orderSubtotalMinor = minor(order.subtotal_minor);
            const orderDiscountMinor = minor(order.discount_minor);
            const orderChargesMinor = minor(order.additional_charges_minor);

            // Tax is modelled as an additional charge named "tax" on this POS.
            // Allocation is a proportional sub-share of the charge allocation,
            // computed in integer minor units only.
            const taxRes = await client.query(
              `SELECT COALESCE(SUM(amount_minor), 0) AS tax_minor
                 FROM order_charges
                WHERE restaurant_id = $1 AND order_id = $2 AND lower(name) LIKE '%tax%'`,
              [restaurantId, orderId],
            );
            const orderTaxMinor = minor(taxRes.rows[0]?.tax_minor);

            for (const requestedItem of normalizedInput.items) {
              const orderItem = orderItemsMap.get(requestedItem.orderItemId);
              if (!orderItem) {
                throw apiError(
                  `Order item ${requestedItem.orderItemId} does not belong to this order.`,
                  "INVALID_REFUND_ITEM",
                  400,
                );
              }

              const origQty = Number(orderItem.quantity);
              const prevQtyRefunded = prevItemRefundsMap.get(orderItem.id) ?? 0;
              const availableQty = Math.max(0, origQty - prevQtyRefunded);

              if (requestedItem.quantity <= 0) {
                throw apiError(
                  `Item refund quantity must be positive.`,
                  "INVALID_REFUND_QUANTITY",
                  400,
                );
              }

              if (requestedItem.quantity > availableQty + 0.000001) {
                throw apiError(
                  `Requested quantity (${requestedItem.quantity}) exceeds refundable quantity (${availableQty}) for item '${orderItem.item_name_snapshot}'.`,
                  "QUANTITY_EXCEEDS_REFUNDABLE",
                  409,
                );
              }

              const unitPriceMinor = minor(orderItem.unit_price_minor);
              const rawLineSubtotalMinor = Math.round(unitPriceMinor * requestedItem.quantity);

              // Proportional discount and additional charge allocation
              const lineDiscountMinor = orderSubtotalMinor > 0
                ? Math.floor((rawLineSubtotalMinor * orderDiscountMinor) / orderSubtotalMinor)
                : 0;
              const lineChargeMinor = orderSubtotalMinor > 0
                ? Math.floor((rawLineSubtotalMinor * orderChargesMinor) / orderSubtotalMinor)
                : 0;
              const lineTaxMinor = orderChargesMinor > 0
                ? Math.floor((lineChargeMinor * orderTaxMinor) / orderChargesMinor)
                : 0;
              const lineNetTotalMinor = rawLineSubtotalMinor - lineDiscountMinor + lineChargeMinor;

              subtotalRefundedMinor += rawLineSubtotalMinor;
              discountRefundedMinor += lineDiscountMinor;
              chargeRefundedMinor += lineChargeMinor;
              taxRefundedMinor += lineTaxMinor;
              totalRefundedMinor += lineNetTotalMinor;

              processedItems.push({
                orderItemId: orderItem.id,
                orderItem,
                quantity: requestedItem.quantity,
                unitPriceMinor,
                lineTotalMinor: lineNetTotalMinor,
                restock: requestedItem.restock,
              });
            }

            // Adjust rounding remainders if this refund completes all remaining refundable balance
            if (totalRefundedMinor > remainingRefundableMinor) {
              throw apiError(
                "Refund amount exceeds remaining refundable balance for this order.",
                "AMOUNT_EXCEEDS_REFUNDABLE",
                409,
              );
            }

            // Deterministic exact remainder: when this refund returns every
            // remaining item quantity, absorb the exact remaining balance
            // (delivery charges and integer-allocation rounding) so a fully
            // refunded order always settles at precisely zero refundable.
            const allItemsFullyRefunded = Array.from(orderItemsMap.values()).every((item) => {
              const prev = prevItemRefundsMap.get(item.id) ?? 0;
              const req = processedItems.find((p) => p.orderItemId === item.id)?.quantity ?? 0;
              return Math.abs(Number(item.quantity) - (prev + req)) < 0.0001;
            });
            if (allItemsFullyRefunded && totalRefundedMinor < remainingRefundableMinor) {
              totalRefundedMinor = remainingRefundableMinor;
            }
          } else if (normalizedInput.amountMinor !== null) {
            // Amount-only partial refund (no items specified, restock is strictly disallowed)
            if (normalizedInput.amountMinor <= 0) {
              throw apiError("Refund amount must be positive.", "INVALID_REFUND_AMOUNT", 422);
            }
            if (normalizedInput.amountMinor > remainingRefundableMinor) {
              throw apiError(
                "Refund amount exceeds remaining refundable balance.",
                "AMOUNT_EXCEEDS_REFUNDABLE",
                409,
              );
            }

            totalRefundedMinor = normalizedInput.amountMinor;
            subtotalRefundedMinor = normalizedInput.amountMinor;
            discountRefundedMinor = 0;
            chargeRefundedMinor = 0;
            taxRefundedMinor = 0;
          } else {
            throw apiError(
              "Either items or a positive refund amount must be specified.",
              "INVALID_REFUND_REQUEST",
              422,
            );
          }

          if (totalRefundedMinor <= 0) {
            throw apiError("Calculated refund total must be greater than zero.", "INVALID_REFUND_AMOUNT", 400);
          }

          const isFullRefund = totalAlreadyRefunded + totalRefundedMinor >= orderTotalMinor;

          // Deterministic PROPORTIONAL tender allocation across captured
          // payments, matching the documented contract. Each payment receives
          // a share of the refund proportional to its remaining captured
          // balance. Shares are computed in integer minor units with a
          // deterministic largest-remainder distribution so:
          //   - every allocation is an integer,
          //   - no payment is over-refunded beyond its remaining balance,
          //   - the allocations sum exactly to the refund amount,
          //   - repeated/replayed requests produce the same allocation
          //     (payments are ordered by created_at, then id).
          //
          // The maximum refund is bounded by BOTH the remaining order
          // balance and the total remaining captured tender balance, so a
          // refund can never exceed money actually captured.
          const paymentsRes = await client.query(
            `SELECT id, financial_account_id, payment_method, amount_minor
               FROM order_payments
              WHERE restaurant_id = $1 AND order_id = $2
                AND status IN ('captured', 'partially_refunded', 'refunded')
              ORDER BY created_at ASC, id ASC`,
            [restaurantId, orderId],
          );

          const tenderRefundsRes = await client.query(
            `SELECT order_payment_id, SUM(amount_minor) AS refunded_minor
               FROM order_refund_tenders
              WHERE restaurant_id = $1 AND refund_id IN (
                SELECT id FROM order_refunds WHERE restaurant_id = $1 AND order_id = $2 AND status = 'completed'
              )
              GROUP BY order_payment_id`,
            [restaurantId, orderId],
          );
          const tenderRefundsMap = new Map(
            tenderRefundsRes.rows.map((r) => [r.order_payment_id, minor(r.refunded_minor)]),
          );

          // Remaining captured balance per payment, in a deterministic order.
          const paymentBalances = paymentsRes.rows
            .map((payment) => {
              const paymentAmount = minor(payment.amount_minor);
              const prevRefundedOnPayment = tenderRefundsMap.get(payment.id) ?? 0;
              return {
                orderPaymentId: payment.id,
                financialAccountId: payment.financial_account_id,
                paymentMethod: payment.payment_method,
                capturedMinor: paymentAmount,
                refundedMinor: prevRefundedOnPayment,
                remainingMinor: Math.max(0, paymentAmount - prevRefundedOnPayment),
              };
            })
            .filter((p) => p.remainingMinor > 0);

          const totalRemainingCapturedMinor = paymentBalances.reduce(
            (sum, p) => sum + p.remainingMinor,
            0,
          );

          // The refund must never exceed money actually captured. The order
          // balance check already capped totalRefundedMinor at the remaining
          // order balance; the captured-tender balance is the harder bound
          // when an order total exceeds its captured payments.
          if (totalRefundedMinor > totalRemainingCapturedMinor) {
            throw apiError(
              "Refund amount exceeds the remaining captured payment balance.",
              "AMOUNT_EXCEEDS_REFUNDABLE",
              409,
            );
          }

          // Largest-remainder proportional allocation in integer minor units.
          const allocatedTenders = allocateProportional(
            totalRefundedMinor,
            paymentBalances,
          );

          if (allocatedTenders.reduce((sum, t) => sum + t.amountMinor, 0) !== totalRefundedMinor) {
            throw apiError(
              "Unable to allocate refund across captured payments.",
              "PAYMENT_ALLOCATION_FAILED",
              409,
            );
          }

          // Count existing refunds for human-readable refund reference
          const countRes = await client.query(
            `SELECT COUNT(*)::int AS count FROM order_refunds WHERE restaurant_id = $1 AND order_id = $2`,
            [restaurantId, orderId],
          );
          const refundSeq = (countRes.rows[0]?.count ?? 0) + 1;
          const refundNumber = `REF-${order.order_number}-${refundSeq}`;

          // Insert order_refunds record
          const refundInsertRes = await client.query(
            `INSERT INTO order_refunds (
               id, restaurant_id, order_id, branch_id, refund_number,
               idempotency_key, payload_hash, status, reason, notes,
               subtotal_refunded_minor, tax_refunded_minor, discount_refunded_minor,
               charge_refunded_minor, total_refunded_minor, is_full_refund,
               created_by_user_id, created_at, updated_at
             ) VALUES (
               gen_random_uuid(), $1, $2, $3, $4,
               $5, $6, 'completed', $7, $8,
               $9, $10, $11,
               $12, $13, $14,
               $15, $16, $16
             )
             RETURNING id, refund_number, created_at`,
            [
              restaurantId, orderId, order.branch_id, refundNumber,
              idempotencyKey, payloadHash, normalizedInput.reason, normalizedInput.notes,
              subtotalRefundedMinor, taxRefundedMinor,
              discountRefundedMinor, chargeRefundedMinor, totalRefundedMinor, isFullRefund,
              userId, now,
            ],
          );
          const refundId = refundInsertRes.rows[0].id;
          const createdAt = refundInsertRes.rows[0].created_at;

          // Insert order_refund_items and execute inventory restock if requested
          const insertedItems = [];
          for (const item of processedItems) {
            const itemInsRes = await client.query(
              `INSERT INTO order_refund_items (
                 id, restaurant_id, refund_id, order_item_id, quantity,
                 unit_price_minor, line_total_minor, restock, created_at
               ) VALUES (
                 gen_random_uuid(), $1, $2, $3, $4,
                 $5, $6, $7, $8
               )
               RETURNING id`,
              [
                restaurantId, refundId, item.orderItemId, item.quantity,
                item.unitPriceMinor, item.lineTotalMinor, item.restock, now,
              ],
            );
            insertedItems.push({
              id: itemInsRes.rows[0].id,
              orderItemId: item.orderItemId,
              quantity: item.quantity,
              unitPriceMinor: item.unitPriceMinor,
              lineTotalMinor: item.lineTotalMinor,
              restock: item.restock,
            });

            // Inventory restock using frozen recipe snapshot
            if (item.restock) {
              const recipe = Array.isArray(item.orderItem.recipe_snapshot)
                ? item.orderItem.recipe_snapshot
                : typeof item.orderItem.recipe_snapshot === "object" && item.orderItem.recipe_snapshot !== null
                  ? (item.orderItem.recipe_snapshot.items ?? [])
                  : [];

              const origQty = Number(item.orderItem.quantity);
              for (const recipeItem of recipe) {
                const stockItemId = recipeItem.stockItemId;
                const baseQtyPerUnit = Number(recipeItem.quantityBaseUnits ?? 0);
                if (!stockItemId || baseQtyPerUnit <= 0 || origQty <= 0) continue;

                const restockQtyDelta = (baseQtyPerUnit * item.quantity) / origQty;
                const movementKey = `${refundId}:${item.orderItemId}:${stockItemId}`;

                await client.query(
                  `INSERT INTO stock_movements (
                     id, restaurant_id, branch_id, stock_item_id, order_id,
                     movement_type, quantity_delta, idempotency_key, occurred_at,
                     created_by_user_id
                   ) VALUES (
                     gen_random_uuid(), $1, $2, $3, $4,
                     'sale_reversal', $5, md5($6::text)::uuid, $7,
                     $8
                   )
                   ON CONFLICT (restaurant_id, idempotency_key) DO NOTHING`,
                  [
                    restaurantId, order.branch_id, stockItemId, orderId,
                    restockQtyDelta, movementKey, now, userId,
                  ],
                );

                await client.query(
                  `UPDATE inventory_balances
                      SET quantity_base_units = quantity_base_units + $4,
                          version = version + 1,
                          updated_at = $5
                    WHERE restaurant_id = $1 AND branch_id = $2 AND stock_item_id = $3`,
                  [restaurantId, order.branch_id, stockItemId, restockQtyDelta, now],
                );
              }
            }
          }

          // Insert order_refund_tenders and ledger compensating entries
          const insertedTenders = [];
          for (const tender of allocatedTenders) {
            const tenderInsRes = await client.query(
              `INSERT INTO order_refund_tenders (
                 id, restaurant_id, refund_id, order_payment_id,
                 financial_account_id, payment_method, amount_minor, created_at
               ) VALUES (
                 gen_random_uuid(), $1, $2, $3,
                 $4, $5, $6, $7
               )
               RETURNING id`,
              [
                restaurantId, refundId, tender.orderPaymentId,
                tender.financialAccountId, tender.paymentMethod, tender.amountMinor, now,
              ],
            );
            insertedTenders.push({
              id: tenderInsRes.rows[0].id,
              orderPaymentId: tender.orderPaymentId,
              financialAccountId: tender.financialAccountId,
              paymentMethod: tender.paymentMethod,
              amountMinor: tender.amountMinor,
            });

            if (tender.financialAccountId) {
              await client.query(
                `INSERT INTO ledger_entries (
                   id, restaurant_id, branch_id, financial_account_id,
                   order_payment_id, entry_type, amount_minor, description,
                   source_type, source_key, occurred_at
                 ) VALUES (
                   gen_random_uuid(), $1, $2, $3,
                   $4, 'debit', $5, $6,
                   'refund', $7, $8
                 )
                 ON CONFLICT DO NOTHING`,
                [
                  restaurantId, order.branch_id, tender.financialAccountId,
                  tender.orderPaymentId, tender.amountMinor,
                  `Refund ${refundNumber} / Order #${order.order_number}`,
                  `refund:${refundId}:${tender.orderPaymentId}`, now,
                ],
              );
            }

            // A payment is fully refunded when this allocation exhausts its
            // remaining captured balance.
            const fullyRefunded = tender.amountMinor >= tender.remainingMinor;
            if (fullyRefunded) {
              await client.query(
                `UPDATE order_payments
                    SET status = 'refunded'
                  WHERE restaurant_id = $1 AND id = $2`,
                [restaurantId, tender.orderPaymentId],
              );
            } else {
              await client.query(
                `UPDATE order_payments
                    SET status = 'partially_refunded'
                  WHERE restaurant_id = $1 AND id = $2 AND status = 'captured'`,
                [restaurantId, tender.orderPaymentId],
              );
            }
          }

          // Update order payment status
          const newTotalRefunded = totalAlreadyRefunded + totalRefundedMinor;
          const newPaymentStatus = newTotalRefunded >= orderTotalMinor
            ? "refunded"
            : "partially_refunded";

          await client.query(
            `UPDATE orders
                SET payment_status = $3,
                    version = version + 1,
                    updated_by_user_id = $4,
                    updated_at = $5
              WHERE restaurant_id = $1 AND id = $2`,
            [restaurantId, orderId, newPaymentStatus, userId, now],
          );

          // Insert order edit event for audit trail
          await client.query(
            `INSERT INTO order_edit_events (
               id, restaurant_id, order_id, actor_user_id,
               event_type, changes, note
             ) VALUES (
               gen_random_uuid(), $1, $2, $3, 'refunded', $4::jsonb, $5
             )`,
            [
              restaurantId, orderId, userId,
              JSON.stringify([
                { label: "Payment status", from: order.payment_status, to: newPaymentStatus },
                { label: "Refund amount", from: 0, to: totalRefundedMinor },
                { label: "Refund number", from: "", to: refundNumber },
              ]),
              `Refund ${refundNumber}\nReason: ${normalizedInput.reason}${
                normalizedInput.notes ? `\nNotes: ${normalizedInput.notes}` : ""
              }`,
            ],
          );

          const resultRefund = {
            id: refundId,
            refundNumber,
            orderId,
            branchId: order.branch_id,
            idempotencyKey,
            status: "completed",
            reason: normalizedInput.reason,
            notes: normalizedInput.notes,
            subtotalRefundedMinor,
            taxRefundedMinor,
            discountRefundedMinor,
            chargeRefundedMinor,
            totalRefundedMinor,
            isFullRefund,
            createdByUserId: userId,
            createdAt,
            items: insertedItems,
            tenders: insertedTenders,
          };

          return {
            refund: resultRefund,
            order: {
              id: order.id,
              orderNumber: Number(order.order_number),
              orderStatus: order.order_status,
              paymentStatus: newPaymentStatus,
              totalMinor: orderTotalMinor,
              remainingRefundableMinor: Math.max(0, orderTotalMinor - newTotalRefunded),
            },
            replayed: false,
          };
        },
      );
    },

    async listRefunds({ tenant, orderId }) {
      const restaurantId = tenant.restaurant.id;
      return withTenantTransaction(
        pool,
        { restaurantId, userId: tenant.membership.userId },
        async (client) => {
          const refundsRes = await client.query(
            `SELECT id, refund_number, order_id, branch_id, idempotency_key,
                    status, reason, notes, subtotal_refunded_minor, tax_refunded_minor,
                    discount_refunded_minor, charge_refunded_minor, total_refunded_minor,
                    is_full_refund, created_by_user_id, created_at
               FROM order_refunds
              WHERE restaurant_id = $1 AND order_id = $2
              ORDER BY created_at DESC`,
            [restaurantId, orderId],
          );

          const refunds = [];
          for (const row of refundsRes.rows) {
            const itemsRes = await client.query(
              `SELECT ri.id, ri.order_item_id, ri.quantity, ri.unit_price_minor, ri.line_total_minor, ri.restock,
                      oi.item_name_snapshot
                 FROM order_refund_items ri
                 JOIN order_items oi ON oi.id = ri.order_item_id
                WHERE ri.restaurant_id = $1 AND ri.refund_id = $2`,
              [restaurantId, row.id],
            );
            const tendersRes = await client.query(
              `SELECT id, order_payment_id, financial_account_id, payment_method, amount_minor
                 FROM order_refund_tenders
                WHERE restaurant_id = $1 AND refund_id = $2`,
              [restaurantId, row.id],
            );

            refunds.push(
              mapRefund(
                row,
                itemsRes.rows.map((r) => ({
                  id: r.id,
                  orderItemId: r.order_item_id,
                  itemNameSnapshot: r.item_name_snapshot,
                  quantity: Number(r.quantity),
                  unitPriceMinor: minor(r.unit_price_minor),
                  lineTotalMinor: minor(r.line_total_minor),
                  restock: Boolean(r.restock),
                })),
                tendersRes.rows.map((t) => ({
                  id: t.id,
                  orderPaymentId: t.order_payment_id,
                  financialAccountId: t.financial_account_id,
                  paymentMethod: t.payment_method,
                  amountMinor: minor(t.amount_minor),
                })),
              ),
            );
          }
          return refunds;
        },
      );
    },

    async getRefund({ tenant, refundId }) {
      const restaurantId = tenant.restaurant.id;
      return withTenantTransaction(
        pool,
        { restaurantId, userId: tenant.membership.userId },
        async (client) => {
          const refundRes = await client.query(
            `SELECT id, refund_number, order_id, branch_id, idempotency_key,
                    status, reason, notes, subtotal_refunded_minor, tax_refunded_minor,
                    discount_refunded_minor, charge_refunded_minor, total_refunded_minor,
                    is_full_refund, created_by_user_id, created_at
               FROM order_refunds
              WHERE restaurant_id = $1 AND id = $2`,
            [restaurantId, refundId],
          );
          const row = refundRes.rows[0];
          if (!row) throw apiError("Refund not found.", "REFUND_NOT_FOUND", 404);

          const itemsRes = await client.query(
            `SELECT ri.id, ri.order_item_id, ri.quantity, ri.unit_price_minor, ri.line_total_minor, ri.restock,
                    oi.item_name_snapshot
               FROM order_refund_items ri
               JOIN order_items oi ON oi.id = ri.order_item_id
              WHERE ri.restaurant_id = $1 AND ri.refund_id = $2`,
            [restaurantId, row.id],
          );
          const tendersRes = await client.query(
            `SELECT id, order_payment_id, financial_account_id, payment_method, amount_minor
               FROM order_refund_tenders
              WHERE restaurant_id = $1 AND refund_id = $2`,
            [restaurantId, row.id],
          );

          return mapRefund(
            row,
            itemsRes.rows.map((r) => ({
              id: r.id,
              orderItemId: r.order_item_id,
              itemNameSnapshot: r.item_name_snapshot,
              quantity: Number(r.quantity),
              unitPriceMinor: minor(r.unit_price_minor),
              lineTotalMinor: minor(r.line_total_minor),
              restock: Boolean(r.restock),
            })),
            tendersRes.rows.map((t) => ({
              id: t.id,
              orderPaymentId: t.order_payment_id,
              financialAccountId: t.financial_account_id,
              paymentMethod: t.payment_method,
              amountMinor: minor(t.amount_minor),
            })),
          );
        },
      );
    },
  });
}
