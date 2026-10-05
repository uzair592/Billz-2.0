import { withTenantTransaction } from "../database/tenant-transaction.mjs";
import { businessDateInTimezone } from "./business-date.mjs";

function minor(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function sanitizeCsvValue(value) {
  if (value === null || value === undefined) return '""';
  const str = String(value);
  // Formula injection defense for characters =, +, -, @
  let safeStr = str;
  if (/^[=+\-@]/.test(safeStr)) {
    safeStr = "'" + safeStr;
  }
  return `"${safeStr.replace(/"/g, '""')}"`;
}

/**
 * Accumulates positional query parameters and hands out correctly
 * numbered placeholders ($1, $2, ...) so every dynamically built
 * WHERE clause stays consistent with its parameter array.
 */
function queryParams() {
  const values = [];
  return {
    add(value) {
      values.push(value);
      return `$${values.length}`;
    },
    get values() {
      return values;
    },
  };
}

/**
 * Applies the authoritative filtered-order scope to a parameter
 * accumulator. The scope is the single source of truth shared by every
 * report output (summary, cancelled/refunded metrics, payment breakdown,
 * order-type breakdown, trends, detailed rows, detailed-row count, CSV).
 *
 * `orderType` filters on orders.order_type.
 *
 * `paymentMethod` uses an EXISTS subquery against order_payments rather
 * than a JOIN. A JOIN would duplicate an order that has multiple
 * payments (split tender), inflating every SUM/COUNT in the report.
 * EXISTS evaluates once per order regardless of how many tenders the
 * order was paid with, so a split-tender order is counted exactly once
 * while still being included when any of its captured payments matches
 * the requested method.
 *
 * `tableName` lets the same scope be applied to an aliased orders table
 * (for example `o.restaurant_id` when orders is joined under alias `o`).
 */
function applyFilteredOrderScope(params, { restaurantId, startDate, endDate, orderType, paymentMethod, tableName = "orders" }) {
  const restaurantParam = params.add(restaurantId);
  const startParam = params.add(startDate);
  const endParam = params.add(endDate);

  let clause = `${tableName}.restaurant_id = ${restaurantParam} AND ${tableName}.business_date >= ${startParam} AND ${tableName}.business_date <= ${endParam}`;

  if (orderType) {
    const orderTypeParam = params.add(orderType);
    clause += ` AND ${tableName}.order_type = ${orderTypeParam}`;
  }

  if (paymentMethod) {
    const paymentMethodParam = params.add(paymentMethod);
    clause += ` AND EXISTS (
      SELECT 1
        FROM order_payments op
       WHERE op.restaurant_id = ${restaurantParam}
         AND op.order_id = ${tableName}.id
         AND op.payment_method = ${paymentMethodParam}
         AND op.status IN ('captured', 'partially_refunded', 'refunded')
    )`;
  }

  return clause;
}

export function createSalesReportService(pool, { clock = () => new Date() } = {}) {
  return Object.freeze({
    /**
     * Generates server-authoritative sales reports for the active tenant.
     * Enforces tenant isolation under PostgreSQL RLS, computes exact monetary metrics in integer minor units,
     * reconciles partial/full refunds against net sales, and provides trend breakdowns.
     *
     * Every output section applies the same filtered-order scope
     * (date range + orderType + paymentMethod), so summary metrics,
     * breakdowns, trends, detailed rows, and the detailed-row count
     * always agree with one another.
     */
    async getSalesReport({ tenant, filters = {} }) {
      const restaurantId = tenant.restaurant.id;
      const timezone = filters.timezone || tenant.restaurant.timezone || "Asia/Karachi";
      const now = clock();
      const todayStr = businessDateInTimezone(now, timezone);

      const startDate = filters.startDate || todayStr;
      const endDate = filters.endDate || todayStr;
      const orderType = filters.orderType || null;
      const paymentMethod = filters.paymentMethod || null;
      const groupBy = ["day", "week", "month"].includes(filters.groupBy) ? filters.groupBy : "day";
      const page = Math.max(1, Number(filters.page) || 1);
      const limit = Math.min(200, Math.max(1, Number(filters.limit) || 50));
      const offset = (page - 1) * limit;

      return withTenantTransaction(
        pool,
        { restaurantId, userId: tenant.membership.userId },
        async (client) => {
          // The single authoritative filtered scope. Every section below
          // derives its WHERE clause from this so no output can disagree.
          const scopeParams = queryParams();
          const scopeWhere = applyFilteredOrderScope(scopeParams, {
            restaurantId,
            startDate,
            endDate,
            orderType,
            paymentMethod,
          });
          const scopeValues = scopeParams.values;

          // 1. Completed Orders Summary (filtered scope)
          const completedSummaryRes = await client.query(
            `SELECT COUNT(*)::int AS order_count,
                    COALESCE(SUM(subtotal_minor), 0) AS gross_subtotal,
                    COALESCE(SUM(discount_minor), 0) AS total_discounts,
                    COALESCE(SUM(delivery_minor), 0) AS total_delivery,
                    COALESCE(SUM(additional_charges_minor), 0) AS total_charges,
                    COALESCE(SUM(total_minor), 0) AS total_completed
               FROM orders
              WHERE ${scopeWhere} AND order_status = 'completed'`,
            scopeValues,
          );
          const summaryRow = completedSummaryRes.rows[0];
          const completedOrderCount = Number(summaryRow.order_count);
          const grossSubtotalMinor = minor(summaryRow.gross_subtotal);
          const discountsMinor = minor(summaryRow.total_discounts);
          const deliveryMinor = minor(summaryRow.total_delivery);
          const additionalChargesMinor = minor(summaryRow.total_charges);
          const completedSalesMinor = minor(summaryRow.total_completed);
          const grossSalesMinor = grossSubtotalMinor + deliveryMinor + additionalChargesMinor;

          // 2. Cancelled Orders Summary (filtered scope; cancelled metrics
          //    follow the same orderType/paymentMethod selection so the
          //    cancelled figures describe the same population as the rest).
          const cancelledSummaryRes = await client.query(
            `SELECT COUNT(*)::int AS count,
                    COALESCE(SUM(total_minor), 0) AS total_minor
               FROM orders
              WHERE ${scopeWhere} AND order_status = 'cancelled'`,
            scopeValues,
          );
          const cancelledSalesMinor = minor(cancelledSummaryRes.rows[0].total_minor);
          const cancelledOrderCount = Number(cancelledSummaryRes.rows[0].count);

          // 3. Refund Summary within Date Range (filtered scope). Refunds are
          //    attributed through the order's business date and inherit the
          //    order's orderType/paymentMethod selection.
          const refundScopeParams = queryParams();
          const refundScopeWhere = applyFilteredOrderScope(refundScopeParams, {
            restaurantId,
            startDate,
            endDate,
            orderType,
            paymentMethod,
            tableName: "o",
          });
          const refundsSummaryRes = await client.query(
            `SELECT COALESCE(SUM(r.total_refunded_minor), 0) AS refund_total,
                    COUNT(DISTINCT r.order_id)::int AS refunded_order_count
               FROM order_refunds r
               JOIN orders o ON o.id = r.order_id AND o.restaurant_id = r.restaurant_id
              WHERE r.restaurant_id = $1
                AND r.status = 'completed'
                AND ${refundScopeWhere}`,
            refundScopeParams.values,
          );
          const refundTotalMinor = minor(refundsSummaryRes.rows[0].refund_total);
          const refundedOrderCount = Number(refundsSummaryRes.rows[0].refunded_order_count);

          const netSalesMinor = Math.max(0, completedSalesMinor - refundTotalMinor);
          const averageOrderValueMinor = completedOrderCount > 0
            ? Math.round(netSalesMinor / completedOrderCount)
            : 0;

          // 4. Payment / Tender Breakdown.
          //
          // Refund tenders are PRE-AGGREGATED per order_payment in a
          // subquery before the join. Joining order_payments directly to
          // order_refund_tenders fans out one payment row per refund tender,
          // so a payment with two partial refunds would have its captured
          // amount_minor counted twice and inflate captured totals. The
          // pre-aggregated subquery guarantees each payment's captured
          // amount is counted exactly once and the refunded amount is the
          // exact sum of its refund tenders.
          //
          // The payment-method filter (when present) is applied directly on
          // op.payment_method here: the breakdown groups by payment method,
          // so filtering the rows to the requested method yields exactly one
          // group for that method.
          const paymentParams = queryParams();
          const paymentScopeWhere = applyFilteredOrderScope(paymentParams, {
            restaurantId,
            startDate,
            endDate,
            orderType,
            paymentMethod: null,
            tableName: "o",
          });
          const paymentMethodFilterParam = paymentMethod
            ? paymentParams.add(paymentMethod)
            : null;
          const paymentBreakdownRes = await client.query(
            `SELECT op.payment_method,
                    COALESCE(SUM(op.amount_minor), 0) AS captured_minor,
                    COALESCE(SUM(rt.refunded_minor), 0) AS refunded_minor
               FROM order_payments op
               JOIN orders o ON o.id = op.order_id AND o.restaurant_id = op.restaurant_id
          LEFT JOIN (
                  SELECT order_payment_id, SUM(amount_minor) AS refunded_minor
                    FROM order_refund_tenders
                   WHERE restaurant_id = $1
                   GROUP BY order_payment_id
               ) rt ON rt.order_payment_id = op.id
              WHERE ${paymentScopeWhere}
                AND op.status IN ('captured', 'partially_refunded', 'refunded')
                ${paymentMethodFilterParam ? `AND op.payment_method = ${paymentMethodFilterParam}` : ""}
              GROUP BY op.payment_method
              ORDER BY op.payment_method`,
            paymentParams.values,
          );
          const paymentBreakdown = paymentBreakdownRes.rows.map((row) => {
            const captured = minor(row.captured_minor);
            const ref = minor(row.refunded_minor);
            return {
              paymentMethod: row.payment_method,
              capturedMinor: captured,
              refundedMinor: ref,
              netMinor: Math.max(0, captured - ref),
            };
          });

          // 5. Order Type Breakdown (filtered scope)
          const orderTypeBreakdownRes = await client.query(
            `SELECT order_type,
                    COUNT(*)::int AS count,
                    COALESCE(SUM(total_minor), 0) AS total_minor
               FROM orders
              WHERE ${scopeWhere} AND order_status = 'completed'
              GROUP BY order_type
              ORDER BY order_type`,
            scopeValues,
          );
          const orderTypeBreakdown = orderTypeBreakdownRes.rows.map((row) => ({
            orderType: row.order_type,
            count: Number(row.count),
            totalMinor: minor(row.total_minor),
          }));

          // 6. Trend Grouping (Daily / Weekly / Monthly) — filtered scope.
          //    Both CTEs share one parameter list. The orders CTE numbers the
          //    scope placeholders ($1..$N) and the date_trunc unit ($N+1); the
          //    refunds CTE reuses those same placeholders because its filter
          //    values are identical, so no second numbering pass is needed.
          let dateTruncUnit = "day";
          if (groupBy === "week") dateTruncUnit = "week";
          if (groupBy === "month") dateTruncUnit = "month";

          const trendParams = queryParams();
          const trendScopeWhere = applyFilteredOrderScope(trendParams, {
            restaurantId,
            startDate,
            endDate,
            orderType,
            paymentMethod,
          });
          const trendValues = trendParams.values;
          const dateTruncParam = `$${trendValues.length + 1}`;
          // The refunds CTE filters the joined orders table under alias `o`
          // with the same values, so it reuses the orders CTE placeholders
          // by rewriting the table name in the already-numbered clause.
          const trendRefundScopeWhere = trendScopeWhere.replace(
            /\borders\./g,
            "o.",
          );

          const trendsRes = await client.query(
            `WITH daily_orders AS (
               SELECT date_trunc(${dateTruncParam}, business_date::timestamp)::date AS period_date,
                      COUNT(*)::int AS order_count,
                      COALESCE(SUM(subtotal_minor + delivery_minor + additional_charges_minor), 0) AS gross_sales,
                      COALESCE(SUM(discount_minor), 0) AS discounts,
                      COALESCE(SUM(total_minor), 0) AS completed_sales
                 FROM orders
                WHERE ${trendScopeWhere} AND order_status = 'completed'
                GROUP BY 1
             ), daily_refunds AS (
               SELECT date_trunc(${dateTruncParam}, o.business_date::timestamp)::date AS period_date,
                      COALESCE(SUM(r.total_refunded_minor), 0) AS refund_total
                 FROM order_refunds r
                 JOIN orders o ON o.id = r.order_id AND o.restaurant_id = r.restaurant_id
                WHERE r.restaurant_id = $1
                  AND r.status = 'completed'
                  AND ${trendRefundScopeWhere}
                GROUP BY 1
             )
             SELECT COALESCE(o.period_date, r.period_date) AS date,
                    COALESCE(o.order_count, 0) AS order_count,
                    COALESCE(o.gross_sales, 0) AS gross_sales_minor,
                    COALESCE(o.discounts, 0) AS discount_minor,
                    COALESCE(o.completed_sales, 0) AS completed_sales_minor,
                    COALESCE(r.refund_total, 0) AS refund_total_minor
               FROM daily_orders o
          FULL OUTER JOIN daily_refunds r ON r.period_date = o.period_date
               ORDER BY date ASC`,
            [...trendValues, dateTruncUnit],
          );

          const trends = trendsRes.rows.map((row) => {
            const dateStr = row.date ? new Date(row.date).toISOString().substring(0, 10) : "";
            const completed = minor(row.completed_sales_minor);
            const ref = minor(row.refund_total_minor);
            return {
              date: dateStr,
              orderCount: Number(row.order_count),
              grossSalesMinor: minor(row.gross_sales_minor),
              discountMinor: minor(row.discount_minor),
              completedSalesMinor: completed,
              refundTotalMinor: ref,
              netSalesMinor: Math.max(0, completed - ref),
            };
          });

          // 7. Paginated Detailed Rows (filtered scope)
          const detailParams = queryParams();
          const detailScopeWhere = applyFilteredOrderScope(detailParams, {
            restaurantId,
            startDate,
            endDate,
            orderType,
            paymentMethod,
            tableName: "o",
          });
          const detailValues = detailParams.values;
          const detailedRowsRes = await client.query(
            `SELECT o.id, o.order_number, o.order_type, o.order_status, o.payment_status,
                    o.total_minor, o.business_date, o.ordered_at,
                    COALESCE(ref.refund_total, 0) AS refunded_minor
               FROM orders o
          LEFT JOIN (
                  SELECT order_id, SUM(total_refunded_minor) AS refund_total
                    FROM order_refunds
                   WHERE restaurant_id = $1 AND status = 'completed'
                   GROUP BY order_id
               ) ref ON ref.order_id = o.id
              WHERE ${detailScopeWhere}
              ORDER BY o.business_date DESC, o.order_number DESC
              LIMIT $${detailValues.length + 1} OFFSET $${detailValues.length + 2}`,
            [...detailValues, limit, offset],
          );

          // Detailed-row count uses the identical filtered scope so the
          // pagination totals always agree with the rows returned.
          const countParams = queryParams();
          const countScopeWhere = applyFilteredOrderScope(countParams, {
            restaurantId,
            startDate,
            endDate,
            orderType,
            paymentMethod,
          });
          const detailedRowsCountRes = await client.query(
            `SELECT COUNT(*)::int AS total_rows
               FROM orders
              WHERE ${countScopeWhere}`,
            countParams.values,
          );

          const totalDetailedRows = Number(detailedRowsCountRes.rows[0]?.total_rows ?? 0);
          const detailedRows = detailedRowsRes.rows.map((row) => {
            const total = minor(row.total_minor);
            const ref = minor(row.refunded_minor);
            return {
              id: row.id,
              orderNumber: Number(row.order_number),
              orderType: row.order_type,
              orderStatus: row.order_status,
              paymentStatus: row.payment_status,
              totalMinor: total,
              refundedMinor: ref,
              netMinor: row.order_status === "cancelled" ? 0 : Math.max(0, total - ref),
              businessDate: row.business_date,
              orderedAt: row.ordered_at,
            };
          });

          return {
            restaurant: {
              id: tenant.restaurant.id,
              name: tenant.restaurant.name,
              currencyCode: tenant.restaurant.currencyCode || "PKR",
              timezone,
            },
            filters: {
              startDate,
              endDate,
              orderType,
              paymentMethod,
              groupBy,
            },
            metrics: {
              completedOrderCount,
              cancelledOrderCount,
              refundedOrderCount,
              grossSubtotalMinor,
              discountsMinor,
              deliveryMinor,
              additionalChargesMinor,
              grossSalesMinor,
              completedSalesMinor,
              cancelledSalesMinor,
              refundTotalMinor,
              netSalesMinor,
              averageOrderValueMinor,
            },
            paymentBreakdown,
            orderTypeBreakdown,
            trends,
            detailedRows: {
              rows: detailedRows,
              pagination: {
                page,
                limit,
                totalRows: totalDetailedRows,
                totalPages: Math.ceil(totalDetailedRows / limit),
              },
            },
          };
        },
      );
    },

    /**
     * Streams every detailed row in the filtered range in bounded pages so
     * the CSV export is complete regardless of how many orders match. The
     * interactive endpoint keeps its 200-row cap; the export paginates
     * internally with its own page size and never weakens that cap.
     *
     * Pagination is keyset-based on the deterministic total ordering
     * (business_date ASC, order_number ASC, id ASC). The `id` column is
     * a UUID and therefore unique, so the ordering is a total order even
     * when two orders share a business_date and order_number (for example
     * across branches). Keyset pagination cannot skip or duplicate a row
     * when a concurrent insert lands between pages, unlike OFFSET, which
     * shifts the window and can drop or repeat rows.
     */
    async *iterSalesReportRows({ tenant, filters = {} }) {
      const restaurantId = tenant.restaurant.id;
      const startDate = filters.startDate;
      const endDate = filters.endDate;
      const orderType = filters.orderType || null;
      const paymentMethod = filters.paymentMethod || null;
      const pageSize = 500;

      // Keyset cursor: the last (business_date, order_number, id) seen.
      // Null on the first page, which has no lower bound.
      let cursor = null;

      for (;;) {
        const rows = await withTenantTransaction(
          pool,
          { restaurantId, userId: tenant.membership.userId },
          async (client) => {
            const params = queryParams();
            const scopeWhere = applyFilteredOrderScope(params, {
              restaurantId,
              startDate,
              endDate,
              orderType,
              paymentMethod,
              tableName: "o",
            });
            const values = params.values;

            // Keyset predicate: strictly after the cursor in the
            // total ordering (business_date, order_number, id).
            // Each column is compared with an explicit cast so the
            // bound is exact even when business_date or order_number
            // repeat across branches. The id is a UUID and therefore
            // unique, making the ordering a total order.
            let keysetClause = "";
            if (cursor) {
              const dateParam = params.add(cursor.businessDate);
              const numberParam = params.add(cursor.orderNumber);
              const idParam = params.add(cursor.id);
              keysetClause = ` AND (
                   o.business_date > ${dateParam}
                   OR (o.business_date = ${dateParam} AND o.order_number > ${numberParam}::bigint)
                   OR (o.business_date = ${dateParam} AND o.order_number = ${numberParam}::bigint AND o.id > ${idParam}::uuid)
                 )`;
            }

            const res = await client.query(
              `SELECT o.id, o.order_number, o.order_type, o.order_status, o.payment_status,
                      o.total_minor, o.business_date, o.ordered_at,
                      COALESCE(ref.refund_total, 0) AS refunded_minor
                 FROM orders o
           LEFT JOIN (
                     SELECT order_id, SUM(total_refunded_minor) AS refund_total
                       FROM order_refunds
                      WHERE restaurant_id = $1 AND status = 'completed'
                      GROUP BY order_id
                  ) ref ON ref.order_id = o.id
                WHERE ${scopeWhere}${keysetClause}
                ORDER BY o.business_date ASC, o.order_number ASC, o.id ASC
                LIMIT $${values.length + 1}`,
              [...values, pageSize],
            );
            return res.rows;
          },
        );

        if (rows.length === 0) return;
        yield rows;
        if (rows.length < pageSize) return;

        // Advance the cursor to the last row of this page.
        const last = rows[rows.length - 1];
        cursor = {
          businessDate: last.business_date,
          orderNumber: last.order_number,
          id: last.id,
        };
      }
    },

    /**
     * Generates a safe UTF-8 CSV export string for sales reports with formula-injection defenses.
     * The export paginates through the complete filtered range via
     * iterSalesReportRows, so it never truncates at the interactive
     * endpoint's 200-row limit.
     *
     * The filtered scope is resolved ONCE here and reused for the
     * metrics report, the row iterator, and the CSV date-range
     * heading. When the caller omits startDate/endDate, the
     * restaurant's current business day (in its configured timezone)
     * is resolved up front so the metrics, the streamed rows, and the
     * heading all describe the same range instead of the metrics
     * defaulting to today while the iterator receives undefined.
     */
    async exportSalesReportCsv({ tenant, filters = {} }) {
      const timezone = filters.timezone || tenant.restaurant.timezone || "Asia/Karachi";
      const todayStr = businessDateInTimezone(clock(), timezone);

      // Resolve the export scope once. Omitted dates default to the
      // restaurant's current business day, exactly as the interactive
      // report does, so the iterator and the heading agree with the
      // metrics.
      const resolvedFilters = {
        ...filters,
        startDate: filters.startDate || todayStr,
        endDate: filters.endDate || todayStr,
        orderType: filters.orderType || null,
        paymentMethod: filters.paymentMethod || null,
      };

      // Metrics, breakdowns, and trends come from the same filtered scope.
      const report = await this.getSalesReport({
        tenant,
        filters: { ...resolvedFilters, page: 1, limit: 50 },
      });

      const lines = [];
      // BOM for UTF-8 compatibility in MS Excel
      lines.push("﻿Sales Report Export");
      lines.push(`Restaurant,${sanitizeCsvValue(report.restaurant.name)}`);
      lines.push(`Date Range,${sanitizeCsvValue(resolvedFilters.startDate)} to ${sanitizeCsvValue(resolvedFilters.endDate)}`);
      lines.push(`Generated At,${sanitizeCsvValue(clock().toISOString())}`);
      lines.push("");

      lines.push("METRICS SUMMARY");
      lines.push("Metric,Amount (PKR)");
      lines.push(`Gross Subtotal,${(report.metrics.grossSubtotalMinor / 100).toFixed(2)}`);
      lines.push(`Discounts,${(report.metrics.discountsMinor / 100).toFixed(2)}`);
      lines.push(`Delivery Fees,${(report.metrics.deliveryMinor / 100).toFixed(2)}`);
      lines.push(`Additional Charges,${(report.metrics.additionalChargesMinor / 100).toFixed(2)}`);
      lines.push(`Completed Sales,${(report.metrics.completedSalesMinor / 100).toFixed(2)}`);
      lines.push(`Total Refunds,${(report.metrics.refundTotalMinor / 100).toFixed(2)}`);
      lines.push(`Net Sales,${(report.metrics.netSalesMinor / 100).toFixed(2)}`);
      lines.push(`Cancelled Sales Total,${(report.metrics.cancelledSalesMinor / 100).toFixed(2)}`);
      lines.push(`Completed Order Count,${report.metrics.completedOrderCount}`);
      lines.push(`Cancelled Order Count,${report.metrics.cancelledOrderCount}`);
      lines.push(`Refunded Order Count,${report.metrics.refundedOrderCount}`);
      lines.push(`Average Order Value,${(report.metrics.averageOrderValueMinor / 100).toFixed(2)}`);
      lines.push("");

      lines.push("PAYMENT METHOD BREAKDOWN");
      lines.push("Payment Method,Captured (PKR),Refunded (PKR),Net Sales (PKR)");
      for (const p of report.paymentBreakdown) {
        lines.push(
          `${sanitizeCsvValue(p.paymentMethod)},${(p.capturedMinor / 100).toFixed(2)},${(p.refundedMinor / 100).toFixed(2)},${(p.netMinor / 100).toFixed(2)}`,
        );
      }
      lines.push("");

      lines.push("ORDER TYPE BREAKDOWN");
      lines.push("Order Type,Order Count,Total (PKR)");
      for (const t of report.orderTypeBreakdown) {
        lines.push(
          `${sanitizeCsvValue(t.orderType)},${t.count},${(t.totalMinor / 100).toFixed(2)}`,
        );
      }
      lines.push("");

      // Detailed rows stream from the export-specific paginated iterator,
      // which is not bounded by the interactive 200-row limit.
      lines.push("DETAILED SALES ROWS");
      lines.push("Order Number,Business Date,Order Type,Order Status,Payment Status,Total (PKR),Refunded (PKR),Net (PKR)");
      for await (const rows of this.iterSalesReportRows({ tenant, filters: resolvedFilters })) {
        for (const row of rows) {
          const total = minor(row.total_minor);
          // The iterator aliases the refund sum as `refunded_minor`;
          // read that same property so the refunded and net columns
          // reflect the actual refund total for the order.
          const ref = minor(row.refunded_minor);
          const net = row.order_status === "cancelled" ? 0 : Math.max(0, total - ref);
          lines.push(
            [
              sanitizeCsvValue(Number(row.order_number)),
              sanitizeCsvValue(row.business_date),
              sanitizeCsvValue(row.order_type),
              sanitizeCsvValue(row.order_status),
              sanitizeCsvValue(row.payment_status),
              (total / 100).toFixed(2),
              (ref / 100).toFixed(2),
              (net / 100).toFixed(2),
            ].join(","),
          );
        }
      }

      return lines.join("\n");
    },
  });
}
