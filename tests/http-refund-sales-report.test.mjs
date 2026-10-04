import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildHttpApp } from "../src/server/http/app.mjs";
import { ACCESS_LEVEL } from "../src/server/subscriptions/access-policy.mjs";
import { apiError } from "../src/server/pos/business-date.mjs";

const RESTAURANT_ID = "11111111-1111-4111-a111-111111111111";
const OTHER_RESTAURANT_ID = "99999999-9999-4999-a999-999999999999";
const ORDER_ID = "44444444-4444-4444-a444-444444444444";
const REFUND_ID = "55555555-5555-4555-a555-555555555555";
const IDEMPOTENCY_KEY = "66666666-6666-4666-a666-666666666666";
const USER_ID = "33333333-3333-4333-a333-333333333333";

function mockAuthService(sessionUser = null) {
  return {
    async authenticate(cookieToken) {
      if (!cookieToken || cookieToken !== "valid-session") {
        throw new Error("Invalid session");
      }
      return {
        user: sessionUser || { id: USER_ID, email: "owner@example.com" },
        expiresAt: new Date(Date.now() + 3600000),
      };
    },
  };
}

function mockTenantContextService({
  role = "owner",
  subscriptionLevel = ACCESS_LEVEL.FULL,
  restaurantId = RESTAURANT_ID,
} = {}) {
  return {
    async load({ userId, restaurantId: requestedId }) {
      if (requestedId !== restaurantId) return null;
      return {
        restaurant: {
          id: restaurantId,
          name: "Test Restaurant",
          slug: "test-restaurant",
          status: "active",
          currencyCode: "PKR",
          timezone: "Asia/Karachi",
        },
        membership: {
          userId,
          role,
          defaultBranchId: "22222222-2222-4222-a222-222222222222",
        },
        subscription: {
          status: subscriptionLevel === ACCESS_LEVEL.FULL ? "active" : "expired",
          currentPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
        },
      };
    },
  };
}

async function buildApp({
  role = "owner",
  subscriptionLevel = ACCESS_LEVEL.FULL,
  restaurantId = RESTAURANT_ID,
  orderRefundService,
  salesReportService,
} = {}) {
  const app = await buildHttpApp({
    authService: mockAuthService(),
    tenantContextService: mockTenantContextService({
      role,
      subscriptionLevel,
      restaurantId,
    }),
    trustedOrigin: "http://localhost:3000",
    orderRefundService,
    salesReportService,
  });
  apps.push(app);
  return app;
}

const authedHeaders = {
  cookie: "pos_session=valid-session",
  "x-restaurant-id": RESTAURANT_ID,
};

const apps = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const refundPayload = {
  reason: "Customer returned an item",
  items: [{ orderItemId: "aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa", quantity: 1, restock: true }],
};

describe("HTTP Refund & Sales Report Routes", () => {
  describe("refund creation (POST /api/pos/orders/:orderId/refunds)", () => {
    it("returns 401 without authentication", async () => {
      const app = await buildApp({
        orderRefundService: { async createRefund() {} },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: { "x-restaurant-id": RESTAURANT_ID },
        payload: refundPayload,
      });
      assert.equal(res.statusCode, 401);
    });

    it("returns 403 when the role lacks REFUND_CREATE", async () => {
      const app = await buildApp({
        role: "cashier",
        orderRefundService: { async createRefund() {} },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: { ...authedHeaders, "idempotency-key": IDEMPOTENCY_KEY },
        payload: refundPayload,
      });
      assert.equal(res.statusCode, 403);
      assert.equal(JSON.parse(res.body).code, "FORBIDDEN");
    });

    it("returns 402 when the subscription is not active", async () => {
      const app = await buildApp({
        subscriptionLevel: ACCESS_LEVEL.BILLING_ONLY,
        orderRefundService: { async createRefund() {} },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: { ...authedHeaders, "idempotency-key": IDEMPOTENCY_KEY },
        payload: refundPayload,
      });
      assert.equal(res.statusCode, 402);
      assert.equal(JSON.parse(res.body).code, "SUBSCRIPTION_REQUIRED");
    });

    it("returns 400 when the Idempotency-Key is missing", async () => {
      const app = await buildApp({
        orderRefundService: { async createRefund() {} },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: authedHeaders,
        payload: refundPayload,
      });
      assert.equal(res.statusCode, 400);
      assert.equal(JSON.parse(res.body).code, "MISSING_IDEMPOTENCY_KEY");
    });

    it("returns 400 when the refund reason is missing", async () => {
      const app = await buildApp({
        orderRefundService: { async createRefund() {} },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: { ...authedHeaders, "idempotency-key": IDEMPOTENCY_KEY },
        payload: { items: refundPayload.items },
      });
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error, "Invalid request.");
      assert.equal(body.issues[0].path, "reason");
    });

    it("returns 400 when a refund quantity is not positive", async () => {
      const app = await buildApp({
        orderRefundService: { async createRefund() {} },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: { ...authedHeaders, "idempotency-key": IDEMPOTENCY_KEY },
        payload: {
          reason: "Test",
          items: [{ orderItemId: ORDER_ID, quantity: 0, restock: false }],
        },
      });
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error, "Invalid request.");
      assert.equal(body.issues[0].path, "items.0.quantity");
    });

    it("returns 404 when the order does not exist", async () => {
      const app = await buildApp({
        orderRefundService: {
          async createRefund() {
            throw apiError("Order not found.", "ORDER_NOT_FOUND", 404);
          },
        },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: { ...authedHeaders, "idempotency-key": IDEMPOTENCY_KEY },
        payload: refundPayload,
      });
      assert.equal(res.statusCode, 404);
      assert.equal(JSON.parse(res.body).code, "ORDER_NOT_FOUND");
    });

    it("returns 409 when the refund exceeds the refundable balance", async () => {
      const app = await buildApp({
        orderRefundService: {
          async createRefund() {
            throw apiError(
              "Refund exceeds the remaining refundable balance.",
              "AMOUNT_EXCEEDS_REFUNDABLE",
              409,
            );
          },
        },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: { ...authedHeaders, "idempotency-key": IDEMPOTENCY_KEY },
        payload: refundPayload,
      });
      assert.equal(res.statusCode, 409);
      assert.equal(JSON.parse(res.body).code, "AMOUNT_EXCEEDS_REFUNDABLE");
    });

    it("returns 409 when the idempotency key was reused with a different payload", async () => {
      const app = await buildApp({
        orderRefundService: {
          async createRefund() {
            throw apiError(
              "Idempotency key reused with a different payload.",
              "IDEMPOTENCY_PAYLOAD_MISMATCH",
              409,
            );
          },
        },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: { ...authedHeaders, "idempotency-key": IDEMPOTENCY_KEY },
        payload: refundPayload,
      });
      assert.equal(res.statusCode, 409);
      assert.equal(JSON.parse(res.body).code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
    });

    it("returns 200 with a replay indicator for a replayed refund", async () => {
      const app = await buildApp({
        orderRefundService: {
          async createRefund() {
            return {
              replayed: true,
              refund: {
                id: REFUND_ID,
                refundNumber: "REF-101-1",
                totalRefundedMinor: 45000,
                status: "completed",
              },
              order: { id: ORDER_ID, paymentStatus: "partially_refunded", remainingRefundableMinor: 45000 },
            };
          },
        },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: { ...authedHeaders, "idempotency-key": IDEMPOTENCY_KEY },
        payload: refundPayload,
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.replayed, true);
      assert.equal(body.refund.refundNumber, "REF-101-1");
    });

    it("returns 201 for a newly created refund", async () => {
      const app = await buildApp({
        orderRefundService: {
          async createRefund() {
            return {
              replayed: false,
              refund: {
                id: REFUND_ID,
                refundNumber: "REF-101-2",
                totalRefundedMinor: 45000,
                status: "completed",
              },
              order: { id: ORDER_ID, paymentStatus: "partially_refunded", remainingRefundableMinor: 45000 },
            };
          },
        },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: { ...authedHeaders, "idempotency-key": IDEMPOTENCY_KEY },
        payload: refundPayload,
      });
      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.replayed, false);
      assert.equal(body.refund.refundNumber, "REF-101-2");
    });

    it("passes the tenant context, user, order, and parsed input to the service", async () => {
      const calls = [];
      const app = await buildApp({
        orderRefundService: {
          async createRefund(input) {
            calls.push(input);
            return {
              replayed: false,
              refund: { id: REFUND_ID, refundNumber: "REF-101-3", totalRefundedMinor: 1, status: "completed" },
              order: { id: ORDER_ID, paymentStatus: "paid", remainingRefundableMinor: 1 },
            };
          },
        },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: { ...authedHeaders, "idempotency-key": IDEMPOTENCY_KEY },
        payload: refundPayload,
      });
      assert.equal(res.statusCode, 201);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].tenant.restaurant.id, RESTAURANT_ID);
      assert.equal(calls[0].userId, USER_ID);
      assert.equal(calls[0].orderId, ORDER_ID);
      assert.equal(calls[0].input.idempotencyKey, IDEMPOTENCY_KEY);
      assert.equal(calls[0].input.reason, refundPayload.reason);
      assert.deepEqual(calls[0].input.items, refundPayload.items);
    });

    it("returns 403 for a restaurant the user has no membership for", async () => {
      const app = await buildApp({
        restaurantId: RESTAURANT_ID,
        orderRefundService: { async createRefund() {} },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: {
          cookie: "pos_session=valid-session",
          "x-restaurant-id": OTHER_RESTAURANT_ID,
          "idempotency-key": IDEMPOTENCY_KEY,
        },
        payload: refundPayload,
      });
      assert.equal(res.statusCode, 403);
      assert.equal(JSON.parse(res.body).code, "MEMBERSHIP_REQUIRED");
    });

    it("never leaks internal error details in the response body", async () => {
      const app = await buildApp({
        orderRefundService: {
          async createRefund() {
            throw new Error("ECONNREFUSED 10.0.0.1:5432 password=secret");
          },
        },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: { ...authedHeaders, "idempotency-key": IDEMPOTENCY_KEY },
        payload: refundPayload,
      });
      assert.equal(res.statusCode, 500);
      const body = JSON.parse(res.body);
      assert.equal(body.error, "Internal server error.");
      assert.ok(!res.body.includes("ECONNREFUSED"));
      assert.ok(!res.body.includes("password=secret"));
    });
  });

  describe("refund listing (GET /api/pos/orders/:orderId/refunds)", () => {
    it("returns 401 without authentication", async () => {
      const app = await buildApp({
        orderRefundService: { async listRefunds() {} },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: { "x-restaurant-id": RESTAURANT_ID },
      });
      assert.equal(res.statusCode, 401);
    });

    it("returns 403 when the role lacks REFUND_VIEW", async () => {
      const app = await buildApp({
        role: "cashier",
        orderRefundService: { async listRefunds() {} },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 403);
    });

    it("returns 200 with the refund list for an authorized role", async () => {
      const app = await buildApp({
        role: "manager",
        orderRefundService: {
          async listRefunds() {
            return [
              {
                id: REFUND_ID,
                refundNumber: "REF-101-1",
                totalRefundedMinor: 45000,
                status: "completed",
              },
            ];
          },
        },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.length, 1);
      assert.equal(body[0].refundNumber, "REF-101-1");
    });

    it("returns 200 for an owner viewing refunds", async () => {
      const app = await buildApp({
        role: "owner",
        orderRefundService: { async listRefunds() { return []; } },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/pos/orders/${ORDER_ID}/refunds`,
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 200);
    });
  });

  describe("refund retrieval (GET /api/pos/refunds/:refundId)", () => {
    it("returns 401 without authentication", async () => {
      const app = await buildApp({
        orderRefundService: { async getRefund() {} },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/pos/refunds/${REFUND_ID}`,
        headers: { "x-restaurant-id": RESTAURANT_ID },
      });
      assert.equal(res.statusCode, 401);
    });

    it("returns 403 when the role lacks REFUND_VIEW", async () => {
      const app = await buildApp({
        role: "cashier",
        orderRefundService: { async getRefund() {} },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/pos/refunds/${REFUND_ID}`,
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 403);
    });

    it("returns 404 when the refund does not exist", async () => {
      const app = await buildApp({
        orderRefundService: {
          async getRefund() {
            throw apiError("Refund not found.", "REFUND_NOT_FOUND", 404);
          },
        },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/pos/refunds/${REFUND_ID}`,
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 404);
      assert.equal(JSON.parse(res.body).code, "REFUND_NOT_FOUND");
    });

    it("returns 200 with the refund for an authorized role", async () => {
      const app = await buildApp({
        role: "owner",
        orderRefundService: {
          async getRefund() {
            return {
              id: REFUND_ID,
              refundNumber: "REF-101-1",
              totalRefundedMinor: 45000,
              status: "completed",
            };
          },
        },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/pos/refunds/${REFUND_ID}`,
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).refundNumber, "REF-101-1");
    });
  });

  describe("sales report (GET /api/pos/reports/sales)", () => {
    const reportResult = {
      restaurant: { id: RESTAURANT_ID, name: "Test Restaurant", currencyCode: "PKR" },
      filters: { startDate: "2026-10-04", endDate: "2026-10-04" },
      metrics: {
        completedOrderCount: 3,
        completedSalesMinor: 290000,
        refundTotalMinor: 192000,
        netSalesMinor: 98000,
      },
      paymentBreakdown: [],
      orderTypeBreakdown: [],
      trends: [],
      detailedRows: { rows: [], pagination: { page: 1, limit: 50, totalRows: 0, totalPages: 0 } },
    };

    it("returns 401 without authentication", async () => {
      const app = await buildApp({ salesReportService: { async getSalesReport() {} } });
      const res = await app.inject({
        method: "GET",
        url: "/api/pos/reports/sales?startDate=2026-10-04&endDate=2026-10-04",
        headers: { "x-restaurant-id": RESTAURANT_ID },
      });
      assert.equal(res.statusCode, 401);
    });

    it("returns 403 when the role lacks SALES_REPORT_VIEW", async () => {
      const app = await buildApp({
        role: "cashier",
        salesReportService: { async getSalesReport() {} },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/pos/reports/sales?startDate=2026-10-04&endDate=2026-10-04",
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 403);
      assert.equal(JSON.parse(res.body).code, "FORBIDDEN");
    });

    it("returns 402 when the subscription is not active", async () => {
      const app = await buildApp({
        subscriptionLevel: ACCESS_LEVEL.BILLING_ONLY,
        salesReportService: { async getSalesReport() {} },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/pos/reports/sales?startDate=2026-10-04&endDate=2026-10-04",
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 402);
    });

    it("returns 400 when a date does not use YYYY-MM-DD", async () => {
      const app = await buildApp({ salesReportService: { async getSalesReport() {} } });
      const res = await app.inject({
        method: "GET",
        url: "/api/pos/reports/sales?startDate=not-a-date&endDate=2026-10-04",
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 400);
      assert.equal(JSON.parse(res.body).error, "Invalid request.");
    });

    it("returns 200 and forwards the filters when dates are omitted", async () => {
      const calls = [];
      const app = await buildApp({
        salesReportService: {
          async getSalesReport(input) {
            calls.push(input);
            return reportResult;
          },
        },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/pos/reports/sales",
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].tenant.restaurant.id, RESTAURANT_ID);
      assert.deepEqual(calls[0].filters, {});
    });

    it("maps a service rejection of the date range to 422", async () => {
      const app = await buildApp({
        salesReportService: {
          async getSalesReport() {
            throw apiError(
              "The date range cannot exceed 92 days.",
              "DATE_RANGE_TOO_LARGE",
              422,
            );
          },
        },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/pos/reports/sales?startDate=2026-01-01&endDate=2026-12-31",
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 422);
      assert.equal(JSON.parse(res.body).code, "DATE_RANGE_TOO_LARGE");
    });

    it("returns 200 with the report for an authorized role", async () => {
      const app = await buildApp({
        role: "owner",
        salesReportService: { async getSalesReport() { return reportResult; } },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/pos/reports/sales?startDate=2026-10-04&endDate=2026-10-04",
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.metrics.netSalesMinor, 98000);
    });

    it("returns 200 for a manager with report access", async () => {
      const app = await buildApp({
        role: "manager",
        salesReportService: { async getSalesReport() { return reportResult; } },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/pos/reports/sales?startDate=2026-10-04&endDate=2026-10-04",
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 200);
    });
  });

  describe("sales report CSV export (GET /api/pos/reports/sales/export)", () => {
    it("returns 401 without authentication", async () => {
      const app = await buildApp({
        salesReportService: { async exportSalesReportCsv() {} },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/pos/reports/sales/export?startDate=2026-10-04&endDate=2026-10-04",
        headers: { "x-restaurant-id": RESTAURANT_ID },
      });
      assert.equal(res.statusCode, 401);
    });

    it("returns 403 when the role lacks SALES_REPORT_EXPORT", async () => {
      const app = await buildApp({
        role: "cashier",
        salesReportService: { async exportSalesReportCsv() {} },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/pos/reports/sales/export?startDate=2026-10-04&endDate=2026-10-04",
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 403);
    });

    it("returns 402 when the subscription is not active", async () => {
      const app = await buildApp({
        subscriptionLevel: ACCESS_LEVEL.BILLING_ONLY,
        salesReportService: { async exportSalesReportCsv() {} },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/pos/reports/sales/export?startDate=2026-10-04&endDate=2026-10-04",
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 402);
    });

    it("returns 400 when a date does not use YYYY-MM-DD", async () => {
      const app = await buildApp({
        salesReportService: { async exportSalesReportCsv() {} },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/pos/reports/sales/export?startDate=not-a-date",
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 400);
      assert.equal(JSON.parse(res.body).error, "Invalid request.");
    });

    it("returns 200 with a UTF-8 BOM CSV and a safe filename", async () => {
      const app = await buildApp({
        role: "owner",
        salesReportService: {
          async exportSalesReportCsv() {
            return "﻿Order,Net Sales\r\n1001,PKR 900.00\r\n";
          },
        },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/pos/reports/sales/export?startDate=2026-10-04&endDate=2026-10-04",
        headers: authedHeaders,
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers["content-type"].includes("text/csv"));
      assert.ok(res.headers["content-type"].includes("charset=utf-8"));
      const disposition = res.headers["content-disposition"] || "";
      assert.ok(disposition.includes("attachment"));
      assert.ok(disposition.includes("sales-report"));
      assert.ok(disposition.includes(`filename="sales-report-test-restaurant-2026-10-04-to-2026-10-04.csv"`));
      assert.ok(res.body.startsWith("﻿"));
    });
  });
});
