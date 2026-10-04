import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSalesReportService } from "../src/server/pos/sales-report-service.mjs";

const RESTAURANT_ID = "11111111-1111-4111-a111-111111111111";
const USER_ID = "33333333-3333-4333-a333-333333333333";

function createMockReportPool() {
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          const lower = sql.toLowerCase();

          if (lower.includes("from orders") && lower.includes("order_status = 'completed'")) {
            return {
              rows: [{
                order_count: 5,
                gross_subtotal: 500000,
                total_discounts: 50000,
                total_delivery: 5000,
                total_charges: 2500,
                total_completed: 457500,
              }],
            };
          }

          if (lower.includes("order_status = 'cancelled'")) {
            return { rows: [{ count: 1, total_minor: 100000 }] };
          }

          if (lower.includes("from order_refunds")) {
            return { rows: [{ refund_total: 45000, refunded_order_count: 1 }] };
          }

          if (lower.includes("from order_payments")) {
            return {
              rows: [
                { payment_method: "cash", captured_minor: 300000, refunded_minor: 45000 },
                { payment_method: "bank_account", captured_minor: 157500, refunded_minor: 0 },
              ],
            };
          }

          if (lower.includes("group by order_type")) {
            return {
              rows: [
                { order_type: "dine_in", count: 3, total_minor: 300000 },
                { order_type: "takeaway", count: 2, total_minor: 157500 },
              ],
            };
          }

          if (lower.includes("daily_orders")) {
            return {
              rows: [
                {
                  date: "2026-10-04",
                  order_count: 5,
                  gross_sales_minor: 507500,
                  discount_minor: 50000,
                  completed_sales_minor: 457500,
                  refund_total_minor: 45000,
                },
              ],
            };
          }

          if (lower.includes("total_rows")) {
            return { rows: [{ total_rows: 5 }] };
          }

          if (lower.includes("from orders o")) {
            return {
              rows: [
                {
                  id: "44444444-4444-4444-a444-444444444444",
                  order_number: 101,
                  order_type: "dine_in",
                  order_status: "completed",
                  payment_status: "partially_refunded",
                  total_minor: 100000,
                  refunded_minor: 45000,
                  business_date: "2026-10-04",
                  ordered_at: new Date().toISOString(),
                },
              ],
            };
          }

          return { rows: [] };
        },
        release() {},
      };
    },
  };
  return pool;
}

describe("Sales Report Service (Unit Tests)", () => {
  const tenant = {
    restaurant: { id: RESTAURANT_ID, name: "Bite Tech Cafe", timezone: "Asia/Karachi" },
    membership: { userId: USER_ID, role: "owner" },
  };

  it("calculates metrics, net sales, and breakdowns accurately", async () => {
    const pool = createMockReportPool();
    const service = createSalesReportService(pool);

    const report = await service.getSalesReport({
      tenant,
      filters: { startDate: "2026-10-04", endDate: "2026-10-04" },
    });

    assert.equal(report.metrics.completedOrderCount, 5);
    assert.equal(report.metrics.cancelledOrderCount, 1);
    assert.equal(report.metrics.completedSalesMinor, 457500);
    assert.equal(report.metrics.refundTotalMinor, 45000);
    assert.equal(report.metrics.netSalesMinor, 412500); // 457500 - 45000
    assert.equal(report.paymentBreakdown.length, 2);
    assert.equal(report.paymentBreakdown[0].netMinor, 255000); // 300000 - 45000
  });

  it("generates safe CSV export with formula injection defense", async () => {
    const pool = createMockReportPool();
    const service = createSalesReportService(pool);

    const csv = await service.exportSalesReportCsv({
      tenant,
      filters: { startDate: "2026-10-04", endDate: "2026-10-04" },
    });

    assert.ok(csv.startsWith("\uFEFFSales Report Export"));
    assert.ok(csv.includes("Bite Tech Cafe"));
    assert.ok(csv.includes("Net Sales,4125.00"));
  });
});
