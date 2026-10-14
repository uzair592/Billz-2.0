import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildHttpApp } from "../src/server/http/app.mjs";
import { hasPermission, PERMISSION } from "../src/server/authorization/permissions.mjs";
import { createKitchenService } from "../src/server/pos/kitchen-service.mjs";
import { createOrderService } from "../src/server/pos/order-service.mjs";

const apps = [];
const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const branchId = "33333333-3333-4333-8333-333333333333";
const ticketId = "44444444-4444-4444-8444-444444444444";
const orderId = "55555555-5555-4555-8555-555555555555";
const idempotencyKey = "66666666-6666-4666-8666-666666666666";

function tenant(role = "owner") {
  return {
    restaurant: { id: restaurantId, name: "Test Cafe", status: "active" },
    membership: { userId, role, status: "active", defaultBranchId: branchId },
    subscription: {
      status: "active",
      currentPeriodEnd: "2999-01-01T00:00:00Z",
    },
  };
}

async function makeApp({ role = "owner" } = {}) {
  const calls = [];
  const app = await buildHttpApp({
    trustedOrigin: "https://pos.example.com",
    secureCookies: true,
    authService: {
      async authenticate(token) {
        return token ? { user: { id: userId, email: `${role}@example.com` } } : null;
      },
      async register() {}, async verifyEmail() {}, async login() {}, async logout() {},
    },
    tenantContextService: {
      async load() { return tenant(role); },
    },
    menuService: {
      async list() {
        calls.push("menu:list");
        return { categories: [], items: [] };
      },
    },
    businessSettingsService: {
      async get() {
        calls.push("settings:get");
        return { businessName: "Test Cafe", phone: "123", address: "City" };
      },
    },
    kitchenService: {
      async listTickets({ status, station }) {
        calls.push({ action: "kitchen:list", status, station });
        return {
          tickets: [
            {
              id: ticketId,
              ticketNumber: 1,
              orderId,
              orderNumber: 101,
              orderType: "dine_in",
              status: "new",
              items: [{ name: "Burger", quantity: 2 }],
            },
          ],
        };
      },
      async updateStatus({ ticketId: tid, status }) {
        calls.push({ action: "kitchen:update", ticketId: tid, status });
        return {
          ticket: { id: tid, status, ticketNumber: 1, orderId },
        };
      },
    },
    orderService: {
      async settlePayment({ orderId: oid, input }) {
        calls.push({ action: "order:settle", orderId: oid, input });
        return {
          payment: { id: "pay-1", orderId: oid, amountMinor: input.amountMinor, status: "captured" },
          order: { id: oid, orderNumber: 101, paymentStatus: "paid" },
          remainingMinor: 0,
          replayed: false,
        };
      },
    },
  });
  apps.push(app);
  return { app, calls };
}

afterEach(async () => {
  while (apps.length) {
    const app = apps.pop();
    await app.close();
  }
});

describe("audit findings verification", () => {
  it("kitchen role can access /api/pos/menu and /api/pos/receipt-business without ORDER_CREATE permission", async () => {
    const { app, calls } = await makeApp({ role: "kitchen" });

    const menuRes = await app.inject({
      method: "GET",
      url: "/api/pos/menu",
      headers: {
        cookie: "pos_session=valid-token",
        "x-restaurant-id": restaurantId,
      },
    });
    assert.equal(menuRes.statusCode, 200);
    assert.ok(calls.includes("menu:list"));

    const receiptRes = await app.inject({
      method: "GET",
      url: "/api/pos/receipt-business",
      headers: {
        cookie: "pos_session=valid-token",
        "x-restaurant-id": restaurantId,
      },
    });
    assert.equal(receiptRes.statusCode, 200);
    assert.ok(calls.includes("settings:get"));
  });

  it("accountant role can access /api/pos/menu and has finance & report permissions", async () => {
    const { app } = await makeApp({ role: "accountant" });

    const menuRes = await app.inject({
      method: "GET",
      url: "/api/pos/menu",
      headers: {
        cookie: "pos_session=valid-token",
        "x-restaurant-id": restaurantId,
      },
    });
    assert.equal(menuRes.statusCode, 200);

    assert.equal(hasPermission("accountant", PERMISSION.REPORT_VIEW), true);
    assert.equal(hasPermission("accountant", PERMISSION.EXPENSE_MANAGE), true);
    assert.equal(hasPermission("accountant", PERMISSION.FINANCE_MANAGE), true);
    assert.equal(hasPermission("accountant", PERMISSION.ORDER_CREATE), false);
  });

  it("kitchen staff can view tickets and advance ticket lifecycle", async () => {
    const { app, calls } = await makeApp({ role: "kitchen" });

    const listRes = await app.inject({
      method: "GET",
      url: "/api/pos/kitchen/tickets?status=new",
      headers: {
        cookie: "pos_session=valid-token",
        "x-restaurant-id": restaurantId,
      },
    });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.json().tickets[0].id, ticketId);

    const updateRes = await app.inject({
      method: "PATCH",
      url: `/api/pos/kitchen/tickets/${ticketId}/status`,
      headers: {
        cookie: "pos_session=valid-token",
        "x-restaurant-id": restaurantId,
        "content-type": "application/json",
      },
      payload: { status: "preparing" },
    });
    assert.equal(updateRes.statusCode, 200);
    assert.equal(updateRes.json().ticket.status, "preparing");
  });

  it("cashier or manager can settle unpaid order balance via settlement route", async () => {
    const { app, calls } = await makeApp({ role: "cashier" });

    const settleRes = await app.inject({
      method: "POST",
      url: `/api/pos/orders/${orderId}/payments`,
      headers: {
        cookie: "pos_session=valid-token",
        "x-restaurant-id": restaurantId,
        "content-type": "application/json",
      },
      payload: {
        amountMinor: 500,
        paymentMethod: "cash",
        idempotencyKey,
      },
    });
    assert.equal(settleRes.statusCode, 201);
    assert.equal(settleRes.json().order.paymentStatus, "paid");
    assert.equal(settleRes.json().remainingMinor, 0);
  });

  it("order service rejects altered payload replay on identical idempotency key with 409 IDEMPOTENCY_CONFLICT", async () => {
    const fakeClient = {
      async query(text) {
        if (text.includes("FROM orders") && text.includes("idempotency_key")) {
          return {
            rows: [
              {
                id: orderId,
                order_number: "1",
                order_type: "takeaway",
                order_status: "completed",
                payment_status: "paid",
                subtotal_minor: "500",
                discount_minor: "0",
                delivery_minor: "0",
                additional_charges_minor: "0",
                total_minor: "500",
                cost_of_goods_minor: "100",
                business_date: "2026-10-14",
                ordered_at: new Date(),
                request_hash: "hash_for_original_order",
              },
            ],
          };
        }
        return { rows: [] };
      },
      release() {},
    };
    const pool = {
      async connect() { return fakeClient; },
    };

    const orderService = createOrderService(pool);
    await assert.rejects(
      async () => {
        await orderService.create({
          tenant: { restaurant: { id: restaurantId, timezone: "UTC" }, membership: { defaultBranchId: branchId, role: "owner" } },
          userId,
          input: {
            idempotencyKey,
            orderType: "takeaway",
            items: [{ menuItemId: "item-1", quantity: 99 }],
          },
        });
      },
      (err) => {
        assert.equal(err.code, "IDEMPOTENCY_CONFLICT");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  });
});
