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

export function createSalesReportService(pool, { clock = () => new Date() } = {}) {
  return Object.freeze({
    /**
     * Generates server-authoritative sales reports for the active tenant.
     * Enforces tenant isolation under PostgreSQL RLS, computes exact monetary metrics in integer minor units,
     * reconciles partial/full refunds against net sales, and provides trend breakdowns.
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
          // 1. Completed Orders Summary
          const orderWhereParams = [restaurantId, startDate, endDate];
          let orderWhereClause = `restaurant_id = $1 AND business_date >= $2 AND business_date <= $3 AND order_status = 'completed'`;

          if (orderType) {
            orderWhereParams.push(orderType);
            orderWhereClause += ` AND order_type = $${orderWhereParams.length}`;
          }

          const completedSummaryRes = await client.query(
            `SELECT COUNT(*)::int AS order_count,
                    COALESCE(SUM(subtotal_minor), 0) AS gross_subtotal,
                    COALESCE(SUM(discount_minor), 0) AS total_discounts,
                    COALESCE(SUM(delivery_minor), 0) AS total_delivery,
                    COALESCE(SUM(additional_charges_minor), 0) AS total_charges,
                    COALESCE(SUM(total_minor), 0) AS total_completed
               FROM orders
              WHERE ${orderWhereClause}`,
            orderWhereParams,
          );
          const summaryRow = completedSummaryRes.rows[0];
          const completedOrderCount = Number(summaryRow.order_count);
          const grossSubtotalMinor = minor(summaryRow.gross_subtotal);
          const discountsMinor = minor(summaryRow.total_discounts);
          const deliveryMinor = minor(summaryRow.total_delivery);
          const additionalChargesMinor = minor(summaryRow.total_charges);
          const completedSalesMinor = minor(summaryRow.total_completed);
          const grossSalesMinor = grossSubtotalMinor + deliveryMinor + additionalChargesMinor;

          // 2. Cancelled Orders Summary
          const cancelledSummaryRes = await client.query(
            `SELECT COUNT(*)::int AS count,
                    COALESCE(SUM(total_minor), 0) AS total_minor
               FROM orders
              WHERE restaurant_id = $1 AND business_date >= $2 AND business_date <= $3 AND order_status = 'cancelled'`,
            [restaurantId, startDate, endDate],
          );
          const cancelledSalesMinor = minor(cancelledSummaryRes.rows[0].total_minor);
          const cancelledOrderCount = Number(cancelledSummaryRes.rows[0].count);

          // 3. Refund Summary within Date Range
          const refundsSummaryRes = await client.query(
            `SELECT COALESCE(SUM(r.total_refunded_minor), 0) AS refund_total,
                    COUNT(DISTINCT r.order_id)::int AS refunded_order_count
               FROM order_refunds r
               JOIN orders o ON o.id = r.order_id AND o.restaurant_id = r.restaurant_id
              WHERE r.restaurant_id = $1 AND o.business_date >= $2 AND o.business_date <= $3 AND r.status = 'completed'`,
            [restaurantId, startDate, endDate],
          );
          const refundTotalMinor = minor(refundsSummaryRes.rows[0].refund_total);
          const refundedOrderCount = Number(refundsSummaryRes.rows[0].refunded_order_count);

          const netSalesMinor = Math.max(0, completedSalesMinor - refundTotalMinor);
          const averageOrderValueMinor = completedOrderCount > 0
            ? Math.round(netSalesMinor / completedOrderCount)
            : 0;

          // 4. Payment / Tender Breakdown
          const paymentBreakdownRes = await client.query(
            `SELECT op.payment_method,
                    COALESCE(SUM(op.amount_minor), 0) AS captured_minor,
                    COALESCE(SUM(rt.amount_minor), 0) AS refunded_minor
               FROM order_payments op
               JOIN orders o ON o.id = op.order_id AND o.restaurant_id = op.restaurant_id
          LEFT JOIN order_refund_tenders rt ON rt.order_payment_id = op.id AND rt.restaurant_id = op.restaurant_id
              WHERE op.restaurant_id = $1 AND o.business_date >= $2 AND o.business_date <= $3 AND op.status IN ('captured', 'paid', 'refunded', 'partially_refunded')
              GROUP BY op.payment_method
              ORDER BY op.payment_method`,
            [restaurantId, startDate, endDate],
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

          // 5. Order Type Breakdown
          const orderTypeBreakdownRes = await client.query(
            `SELECT order_type,
                    COUNT(*)::int AS count,
                    COALESCE(SUM(total_minor), 0) AS total_minor
               FROM orders
              WHERE restaurant_id = $1 AND business_date >= $2 AND business_date <= $3 AND order_status = 'completed'
              GROUP BY order_type
              ORDER BY order_type`,
            [restaurantId, startDate, endDate],
          );
          const orderTypeBreakdown = orderTypeBreakdownRes.rows.map((row) => ({
            orderType: row.order_type,
            count: Number(row.count),
            totalMinor: minor(row.total_minor),
          }));

          // 6. Trend Grouping (Daily / Weekly / Monthly)
          let dateTruncUnit = "day";
          if (groupBy === "week") dateTruncUnit = "week";
          if (groupBy === "month") dateTruncUnit = "month";

          const trendsRes = await client.query(
            `WITH daily_orders AS (
               SELECT date_trunc($4, business_date::timestamp)::date AS period_date,
                      COUNT(*)::int AS order_count,
                      COALESCE(SUM(subtotal_minor + delivery_minor + additional_charges_minor), 0) AS gross_sales,
                      COALESCE(SUM(discount_minor), 0) AS discounts,
                      COALESCE(SUM(total_minor), 0) AS completed_sales
                 FROM orders
                WHERE restaurant_id = $1 AND business_date >= $2 AND business_date <= $3 AND order_status = 'completed'
                GROUP BY 1
             ), daily_refunds AS (
               SELECT date_trunc($4, o.business_date::timestamp)::date AS period_date,
                      COALESCE(SUM(r.total_refunded_minor), 0) AS refund_total
                 FROM order_refunds r
                 JOIN orders o ON o.id = r.order_id AND o.restaurant_id = r.restaurant_id
                WHERE r.restaurant_id = $1 AND o.business_date >= $2 AND o.business_date <= $3 AND r.status = 'completed'
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
            [restaurantId, startDate, endDate, dateTruncUnit],
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

          // 7. Paginated Detailed Rows
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
              WHERE o.restaurant_id = $1 AND o.business_date >= $2 AND o.business_date <= $3
              ORDER BY o.business_date DESC, o.order_number DESC
              LIMIT $4 OFFSET $5`,
            [restaurantId, startDate, endDate, limit, offset],
          );

          const detailedRowsCountRes = await client.query(
            `SELECT COUNT(*)::int AS total_rows
               FROM orders
              WHERE restaurant_id = $1 AND business_date >= $2 AND business_date <= $3`,
            [restaurantId, startDate, endDate],
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
     * Generates a safe UTF-8 CSV export string for sales reports with formula-injection defenses.
     */
    async exportSalesReportCsv({ tenant, filters = {} }) {
      const report = await this.getSalesReport({
        tenant,
        filters: { ...filters, limit: 10000, page: 1 },
      });

      const lines = [];
      // BOM for UTF-8 compatibility in MS Excel
      lines.push("\uFEFFSales Report Export");
      lines.push(`Restaurant,${sanitizeCsvValue(report.restaurant.name)}`);
      lines.push(`Date Range,${sanitizeCsvValue(report.filters.startDate)} to ${sanitizeCsvValue(report.filters.endDate)}`);
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

      lines.push("DETAILED SALES ROWS");
      lines.push("Order Number,Business Date,Order Type,Order Status,Payment Status,Total (PKR),Refunded (PKR),Net (PKR)");
      for (const row of report.detailedRows.rows) {
        lines.push(
          [
            sanitizeCsvValue(row.orderNumber),
            sanitizeCsvValue(row.businessDate),
            sanitizeCsvValue(row.orderType),
            sanitizeCsvValue(row.orderStatus),
            sanitizeCsvValue(row.paymentStatus),
            (row.totalMinor / 100).toFixed(2),
            (row.refundedMinor / 100).toFixed(2),
            (row.netMinor / 100).toFixed(2),
          ].join(","),
        );
      }

      return lines.join("\n");
    },
  });
}
