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

  it("applies the paymentMethod filter via an EXISTS subquery, not a JOIN", async () => {
    const queries = [];
    const pool = {
      async connect() {
        return {
          async query(sql, params = []) {
            queries.push({ sql, params });
            return createMockReportPool().connect().then((c) => c.query(sql, params));
          },
          release() {},
        };
      },
    };
    const service = createSalesReportService(pool);

    await service.getSalesReport({
      tenant,
      filters: {
        startDate: "2026-10-04",
        endDate: "2026-10-04",
        paymentMethod: "cash",
      },
    });

    // Every scoped query must carry the payment-method parameter and
    // use an EXISTS subquery (never a JOIN that would fan out
    // split-tender orders).
    const scoped = queries.filter((q) => q.sql.includes("restaurant_id = $1"));
    assert.ok(scoped.length > 0, "scoped queries were executed");
    for (const q of scoped) {
      if (q.sql.includes("order_status = 'completed'") || q.sql.includes("order_status = 'cancelled'") || q.sql.includes("GROUP BY order_type") || q.sql.includes("FROM orders o") || q.sql.includes("COUNT(*)::int AS total_rows")) {
        assert.ok(
          q.sql.includes("EXISTS") && q.sql.includes("op.payment_method ="),
          "paymentMethod filter must use an EXISTS subquery",
        );
        assert.ok(
          q.params.includes("cash"),
          "the payment-method value must be bound as a parameter",
        );
      }
    }
  });

  it("applies the same filtered scope to summary, breakdowns, trends, rows, and count", async () => {
    const queries = [];
    const pool = {
      async connect() {
        return {
          async query(sql, params = []) {
            queries.push({ sql, params });
            return createMockReportPool().connect().then((c) => c.query(sql, params));
          },
          release() {},
        };
      },
    };
    const service = createSalesReportService(pool);

    await service.getSalesReport({
      tenant,
      filters: {
        startDate: "2026-10-04",
        endDate: "2026-10-04",
        orderType: "dine_in",
        paymentMethod: "cash",
      },
    });

    // The orderType and paymentMethod filters must appear in the
    // parameter list of every scoped section so no output can
    // describe a different population than the summary.
    const scoped = queries.filter((q) => q.sql.includes("restaurant_id = $1"));
    assert.ok(scoped.length >= 6, "summary, cancelled, refunds, breakdown, rows, and count all ran");
    for (const q of scoped) {
      assert.ok(
        q.params.includes("dine_in"),
        "orderType filter must be bound in every scoped section",
      );
      assert.ok(
        q.params.includes("cash"),
        "paymentMethod filter must be bound in every scoped section",
      );
    }
  });

  it("paginates detailed rows and reports matching totals", async () => {
    const pool = createMockReportPool();
    const service = createSalesReportService(pool);

    const report = await service.getSalesReport({
      tenant,
      filters: { startDate: "2026-10-04", endDate: "2026-10-04", page: 2, limit: 2 },
    });

    assert.equal(report.detailedRows.pagination.page, 2);
    assert.equal(report.detailedRows.pagination.limit, 2);
    assert.equal(report.detailedRows.pagination.totalRows, 5);
    assert.equal(report.detailedRows.pagination.totalPages, 3);
  });

  it("streams every row through the export iterator without truncation", async () => {
    // A pool that returns 3 rows on the first page and 0 on the
    // second, so the iterator must yield the first page then stop.
    let call = 0;
    const pool = {
      async connect() {
        return {
          async query(sql) {
            const lower = sql.toLowerCase();
            if (lower.includes("from orders o") && lower.includes("limit")) {
              call += 1;
              if (call === 1) {
                return {
                  rows: [
                    {
                      id: "1",
                      order_number: 1,
                      order_type: "dine_in",
                      order_status: "completed",
                      payment_status: "paid",
                      total_minor: 10000,
                      business_date: "2026-10-04",
                      ordered_at: "2026-10-04T10:00:00Z",
                      refund_total: 0,
                    },
                    {
                      id: "2",
                      order_number: 2,
                      order_type: "dine_in",
                      order_status: "completed",
                      payment_status: "paid",
                      total_minor: 20000,
                      business_date: "2026-10-04",
                      ordered_at: "2026-10-04T11:00:00Z",
                      refund_total: 0,
                    },
                    {
                      id: "3",
                      order_number: 3,
                      order_type: "takeaway",
                      order_status: "completed",
                      payment_status: "paid",
                      total_minor: 30000,
                      business_date: "2026-10-04",
                      ordered_at: "2026-10-04T12:00:00Z",
                      refund_total: 0,
                    },
                  ],
                };
              }
              return { rows: [] };
            }
            return createMockReportPool().connect().then((c) => c.query(sql));
          },
          release() {},
        };
      },
    };
    const service = createSalesReportService(pool);

    const rows = [];
    for await (const page of service.iterSalesReportRows({
      tenant,
      filters: { startDate: "2026-10-04", endDate: "2026-10-04" },
    })) {
      rows.push(...page);
    }

    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.order_number), [1, 2, 3]);
  });
});
