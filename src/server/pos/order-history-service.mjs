import { withTenantTransaction } from "../database/tenant-transaction.mjs";
import { apiError, businessDateInTimezone } from "./business-date.mjs";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR_PATTERN = /^([0-9]{4}-[0-9]{2}-[0-9]{2})\.(\d{1,19})$/;
const MAX_PAGE_SIZE = 200;

function minor(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function mapSummary(row) {
  return {
    orderCount: Number(row.order_count),
    cancelledCount: Number(row.cancelled_count),
    salesMinor: minor(row.sales_minor),
    costOfGoodsMinor: minor(row.cost_of_goods_minor),
    paidMinor: minor(row.paid_minor),
    dueMinor: minor(row.due_minor),
  };
}

function mapOrderRow(row) {
  return {
    id: row.id,
    orderNumber: Number(row.order_number),
    orderType: row.order_type,
    orderStatus: row.order_status,
    paymentStatus: row.payment_status,
    tableId: row.table_id ?? null,
    tableNumber: row.table_number ?? null,
    customerName: row.customer_name ?? null,
    customerPhone: row.customer_phone ?? null,
    riderName: row.rider_name ?? null,
    subtotalMinor: minor(row.subtotal_minor),
    discountMinor: minor(row.discount_minor),
    deliveryMinor: minor(row.delivery_minor),
    additionalChargesMinor: minor(row.additional_charges_minor),
    totalMinor: minor(row.total_minor),
    businessDate: row.business_date,
    orderedAt: row.ordered_at,
    cancelledAt: row.cancelled_at ?? null,
    cancellationReason: row.cancellation_reason ?? null,
  };
}

export function encodeOrderCursor(order) {
  return Buffer.from(`${order.businessDate}.${order.orderNumber}`, "utf8")
    .toString("base64url");
}

export function decodeOrderCursor(cursor) {
  if (typeof cursor !== "string" || cursor.length > 120) {
    throw apiError("The pagination cursor is not valid.", "INVALID_CURSOR");
  }
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const match = CURSOR_PATTERN.exec(decoded);
  if (!match) {
    throw apiError("The pagination cursor is not valid.", "INVALID_CURSOR");
  }
  return { businessDate: match[1], orderNumber: Number(match[2]) };
}

function normalizeFilters(filters, today) {
  const businessDate = filters.businessDate ?? null;
  const from = filters.from ?? null;
  const to = filters.to ?? null;
  for (const value of [businessDate, from, to]) {
    if (value !== null && !DATE_PATTERN.test(value)) {
      throw apiError("Business dates must use YYYY-MM-DD.", "INVALID_BUSINESS_DATE");
    }
  }
  if (from && to && from > to) {
    throw apiError("The start date cannot be after the end date.", "INVALID_DATE_RANGE");
  }
  if (businessDate && (from || to)) {
    throw apiError(
      "Use either a single business date or a date range, not both.",
      "CONFLICTING_DATE_FILTERS",
    );
  }
  if (businessDate && businessDate > today) {
    throw apiError("Orders cannot be requested for a future date.", "FUTURE_BUSINESS_DATE");
  }
  if ((from && from > today) || (to && to > today)) {
    throw apiError("Orders cannot be requested for a future date.", "FUTURE_BUSINESS_DATE");
  }

  const limit = filters.limit === undefined ? 50 : Number(filters.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw apiError(`The page size must be between 1 and ${MAX_PAGE_SIZE}.`, "INVALID_PAGE_SIZE");
  }

  return {
    businessDate,
    from,
    to,
    limit,
    orderStatus: filters.orderStatus ?? null,
    paymentStatus: filters.paymentStatus ?? null,
    search: typeof filters.search === "string" && filters.search.trim()
      ? filters.search.trim().slice(0, 160)
      : null,
    cursor: filters.cursor ? decodeOrderCursor(filters.cursor) : null,
  };
}

function historyFilters(values) {
  return [
    values.branchId,
    values.businessDate,
    values.from,
    values.to,
    values.orderStatus,
    values.paymentStatus,
    values.search ? `%${values.search}%` : null,
  ];
}

export function createOrderHistoryService(pool, { clock = () => new Date() } = {}) {
  return Object.freeze({
    async list({ tenant, filters = {} }) {
      const today = businessDateInTimezone(
        clock(),
        tenant.restaurant.timezone ?? "UTC",
      );
      const values = {
        ...normalizeFilters(filters, today),
        branchId: tenant.membership.defaultBranchId,
      };
      const parameters = historyFilters(values);

      return withTenantTransaction(
        pool,
        { restaurantId: tenant.restaurant.id, userId: tenant.membership.userId },
        async (client) => {
          const orderResult = await client.query(
            `SELECT o.id, o.order_number, o.order_type, o.order_status,
                    o.payment_status, o.table_id, t.table_number,
                    o.customer_name, o.customer_phone, o.rider_name,
                    o.subtotal_minor, o.discount_minor, o.delivery_minor,
                    o.additional_charges_minor, o.total_minor,
                    to_char(o.business_date, 'YYYY-MM-DD') AS business_date,
                    o.ordered_at,
                    o.cancelled_at, o.cancellation_reason
               FROM orders o
               LEFT JOIN restaurant_tables t
                 ON t.restaurant_id = o.restaurant_id
                AND t.id = o.table_id
              WHERE o.branch_id = $1
                AND ($2::date IS NULL OR o.business_date = $2::date)
                AND ($3::date IS NULL OR o.business_date >= $3::date)
                AND ($4::date IS NULL OR o.business_date <= $4::date)
                AND ($5::text IS NULL OR o.order_status = $5::text)
                AND ($6::text IS NULL OR o.payment_status = $6::text)
                AND ($7::text IS NULL
                     OR o.customer_name ILIKE $7
                     OR o.customer_phone ILIKE $7)
                AND ($8::date IS NULL
                     OR (o.business_date, o.order_number) < ($8::date, $9::bigint))
              ORDER BY o.business_date DESC, o.order_number DESC
              LIMIT $10`,
            [
              ...parameters,
              values.cursor?.businessDate ?? null,
              values.cursor?.orderNumber ?? null,
              values.limit + 1,
            ],
          );

          const rows = orderResult.rows.slice(0, values.limit);
          const last = rows.at(-1);
          const hasMore = orderResult.rows.length > values.limit;

          const summaryResult = await client.query(
            `SELECT COUNT(*) AS order_count,
                    COUNT(*) FILTER (WHERE o.order_status = 'cancelled') AS cancelled_count,
                    COALESCE(SUM(o.total_minor) FILTER (WHERE o.order_status <> 'cancelled'), 0)
                      AS sales_minor,
                    COALESCE(SUM(o.cost_of_goods_minor) FILTER (WHERE o.order_status <> 'cancelled'), 0)
                      AS cost_of_goods_minor,
                    COALESCE(SUM(p.received_minor), 0) AS paid_minor,
                    COALESCE(SUM(o.total_minor) FILTER (WHERE o.order_status <> 'cancelled'), 0)
                      - COALESCE(SUM(p.received_minor), 0) AS due_minor
               FROM orders o
               LEFT JOIN LATERAL (
                 SELECT SUM(amount_minor) AS received_minor
                   FROM order_payments
                  WHERE order_id = o.id AND status = 'captured'
               ) p ON true
              WHERE o.branch_id = $1
                AND ($2::date IS NULL OR o.business_date = $2::date)
                AND ($3::date IS NULL OR o.business_date >= $3::date)
                AND ($4::date IS NULL OR o.business_date <= $4::date)
                AND ($5::text IS NULL OR o.order_status = $5::text)
                AND ($6::text IS NULL OR o.payment_status = $6::text)
                AND ($7::text IS NULL
                     OR o.customer_name ILIKE $7
                     OR o.customer_phone ILIKE $7)`,
            parameters,
          );

          return {
            orders: rows.map(mapOrderRow),
            summary: mapSummary(summaryResult.rows[0] ?? {}),
            nextCursor: hasMore && last
              ? encodeOrderCursor({ businessDate: last.business_date, orderNumber: last.order_number })
              : null,
          };
        },
      );
    },

    async get({ tenant, orderId }) {
      const restaurantId = tenant.restaurant.id;
      return withTenantTransaction(
        pool,
        { restaurantId, userId: tenant.membership.userId },
        async (client) => {
          // Row-level security hides other restaurants' orders here: a foreign
          // order identifier is indistinguishable from a missing one.
          const orderResult = await client.query(
            `SELECT o.id, o.order_number, o.order_type, o.order_status,
                    o.payment_status, o.table_id, t.table_number,
                    o.customer_name, o.customer_phone, o.rider_name,
                    o.subtotal_minor, o.discount_type, o.discount_value, o.discount_minor,
                    o.delivery_minor, o.additional_charges_minor, o.total_minor,
                    o.cost_of_goods_minor,
                    to_char(o.business_date, 'YYYY-MM-DD') AS business_date,
                    o.ordered_at, o.completed_at,
                    o.cancelled_at, o.cancellation_reason, o.legacy_order_id
               FROM orders o
               LEFT JOIN restaurant_tables t
                 ON t.restaurant_id = o.restaurant_id
                AND t.id = o.table_id
              WHERE o.id = $1`,
            [orderId],
          );
          const row = orderResult.rows[0];
          if (!row) throw apiError("Order not found.", "ORDER_NOT_FOUND", 404);

          const [itemResult, chargeResult, paymentResult, eventResult, cancellationResult] =
            await Promise.all([
              client.query(
                `SELECT id, menu_item_id, item_name_snapshot, quantity,
                        unit_price_minor, line_total_minor, unit_cost_minor,
                        recipe_snapshot, notes, sort_order
                   FROM order_items
                  WHERE order_id = $1
                  ORDER BY sort_order, created_at`,
                [orderId],
              ),
              client.query(
                `SELECT id, name, charge_type, charge_value, amount_minor
                   FROM order_charges
                  WHERE order_id = $1
                  ORDER BY created_at`,
                [orderId],
              ),
              client.query(
                `SELECT p.id, p.financial_account_id, a.display_name AS account_name,
                        p.payment_method, p.status, p.amount_minor, p.received_at
                   FROM order_payments p
                   LEFT JOIN financial_accounts a
                     ON a.restaurant_id = p.restaurant_id
                    AND a.id = p.financial_account_id
                  WHERE p.order_id = $1
                  ORDER BY p.received_at, p.id`,
                [orderId],
              ),
              client.query(
                `SELECT id, event_type, changes, note, created_at
                   FROM order_edit_events
                  WHERE order_id = $1
                  ORDER BY created_at`,
                [orderId],
              ),
              client.query(
                `SELECT cancelled_at, reason, refunded_minor, restocked
                   FROM order_cancellations
                  WHERE order_id = $1`,
                [orderId],
              ),
            ]);

          const cancellation = cancellationResult.rows[0];
          return {
            order: {
              ...mapOrderRow(row),
              discountType: row.discount_type ?? null,
              discountValue: Number(row.discount_value ?? 0),
              costOfGoodsMinor: minor(row.cost_of_goods_minor),
              completedAt: row.completed_at ?? null,
              legacyOrderId: row.legacy_order_id === null || row.legacy_order_id === undefined
                ? null
                : Number(row.legacy_order_id),
            },
            items: itemResult.rows.map((item) => ({
              id: item.id,
              menuItemId: item.menu_item_id ?? null,
              name: item.item_name_snapshot,
              quantity: Number(item.quantity),
              unitPriceMinor: minor(item.unit_price_minor),
              lineTotalMinor: minor(item.line_total_minor),
              unitCostMinor: minor(item.unit_cost_minor),
              recipe: item.recipe_snapshot ?? {},
              notes: item.notes ?? null,
            })),
            charges: chargeResult.rows.map((charge) => ({
              id: charge.id,
              name: charge.name,
              type: charge.charge_type,
              value: Number(charge.charge_value),
              amountMinor: minor(charge.amount_minor),
            })),
            payments: paymentResult.rows.map((payment) => ({
              id: payment.id,
              method: payment.payment_method,
              status: payment.status,
              amountMinor: minor(payment.amount_minor),
              financialAccountId: payment.financial_account_id ?? null,
              accountName: payment.account_name ?? null,
              receivedAt: payment.received_at,
            })),
            events: eventResult.rows.map((event) => ({
              id: event.id,
              type: event.event_type,
              changes: event.changes ?? [],
              note: event.note ?? null,
              createdAt: event.created_at,
            })),
            cancellation: cancellation
              ? {
                  cancelledAt: cancellation.cancelled_at,
                  reason: cancellation.reason ?? null,
                  refundedMinor: minor(cancellation.refunded_minor),
                  restocked: cancellation.restocked ?? [],
                }
              : null,
          };
        },
      );
    },
  });
}
