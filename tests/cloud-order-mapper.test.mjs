import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCloudOrderId,
  mapCloudOrderDetail,
  mapCloudOrderSummary,
  mapCloudSummary,
} from "../src/client/cloud-order-mapper.mjs";

const orderId = "11111111-1111-4111-8111-111111111111";

function cloudSummary(overrides = {}) {
  return {
    id: orderId,
    orderNumber: 42,
    orderType: "dine_in",
    orderStatus: "completed",
    paymentStatus: "paid",
    tableId: "22222222-2222-4222-8222-222222222222",
    tableNumber: 4,
    customerName: "Ayesha Khan",
    customerPhone: "03001234567",
    riderName: null,
    subtotalMinor: 10_000,
    discountMinor: 1_000,
    deliveryMinor: 250,
    additionalChargesMinor: 0,
    totalMinor: 9_250,
    businessDate: "2026-10-02",
    orderedAt: "2026-10-02T14:30:05.000Z",
    cancelledAt: null,
    cancellationReason: null,
    ...overrides,
  };
}

describe("cloud order mapper", () => {
  it("recognizes cloud order identifiers", () => {
    assert.equal(isCloudOrderId(orderId), true);
    assert.equal(isCloudOrderId(42), false);
    assert.equal(isCloudOrderId("not-a-uuid"), false);
    assert.equal(isCloudOrderId(null), false);
  });

  it("maps a list summary onto the legacy row shape", () => {
    const order = mapCloudOrderSummary(cloudSummary());
    assert.equal(order.id, orderId);
    assert.equal(order.orderNumber, 42);
    assert.equal(order.date, "2026-10-02");
    assert.equal(order.orderType, "Dine-In");
    assert.equal(order.tableNumber, 4);
    assert.equal(order.customerName, "Ayesha Khan");
    assert.equal(order.subtotal, 100);
    assert.equal(order.discountAmount, 10);
    assert.equal(order.deliveryCharges, 2.5);
    assert.equal(order.totalBill, 92.5);
    assert.equal(order.paymentStatus, "Paid");
    assert.equal(order.amountReceived, 92.5);
    assert.equal(order.orderStatus, "Completed");
    assert.equal(order.cloudOrder, true);
  });

  it("collapses cloud lifecycle statuses the way the ledger does", () => {
    assert.equal(
      mapCloudOrderSummary(cloudSummary({ orderStatus: "served" })).orderStatus,
      "Completed",
    );
    assert.equal(
      mapCloudOrderSummary(cloudSummary({ orderStatus: "cancelled" })).orderStatus,
      "Cancelled",
    );
    assert.equal(
      mapCloudOrderSummary(cloudSummary({ orderStatus: "cancelled", cancellationReason: "wrong order" })).statusReason,
      "wrong order",
    );
  });

  it("marks unpaid and partially paid orders as Unpaid with no received amount", () => {
    for (const paymentStatus of ["unpaid", "partially_paid"]) {
      const order = mapCloudOrderSummary(cloudSummary({ paymentStatus }));
      assert.equal(order.paymentStatus, "Unpaid");
      assert.equal(order.amountReceived, 0);
    }
    assert.equal(
      mapCloudOrderSummary(cloudSummary({ paymentStatus: "refunded" })).paymentStatus,
      "Paid",
    );
  });

  it("maps every order type label", () => {
    assert.equal(mapCloudOrderSummary(cloudSummary({ orderType: "takeaway" })).orderType, "Takeaway");
    assert.equal(mapCloudOrderSummary(cloudSummary({ orderType: "delivery" })).orderType, "Delivery");
  });

  it("maps the detail payload with items, charges, payments and events", () => {
    const detail = {
      order: cloudSummary({
        discountType: "percent",
        discountValue: 10,
        costOfGoodsMinor: 3_300,
        legacyOrderId: 18,
      }),
      items: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          menuItemId: "44444444-4444-4444-8444-444444444444",
          name: "Burger",
          quantity: 2,
          unitPriceMinor: 5_000,
          lineTotalMinor: 10_000,
          unitCostMinor: 1_650,
          recipe: {
            offer: {
              type: "item",
              regularPriceMinor: 6_000,
              offerPriceMinor: 5_000,
            },
          },
        },
      ],
      charges: [
        { id: "55555555-5555-4555-8555-555555555555", name: "Tax", type: "percent", value: 5, amountMinor: 450 },
        { id: "66666666-6666-4666-8666-666666666666", name: "Service", type: "flat", value: 2_000, amountMinor: 2_000 },
      ],
      payments: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          method: "bank_account",
          status: "captured",
          amountMinor: 9_250,
          financialAccountId: "88888888-8888-4888-8888-888888888888",
          accountName: "Main Account",
          receivedAt: "2026-10-02T14:31:00.000Z",
        },
      ],
      events: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          type: "edit",
          changes: [{ label: "Quantity", from: 1, to: 2 }],
          note: "Customer added one more",
          createdAt: "2026-10-02T14:32:00.000Z",
        },
      ],
      cancellation: null,
    };

    const order = mapCloudOrderDetail(detail);
    assert.equal(order.id, orderId);
    assert.equal(order.legacyOrderId, 18);
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0].name, "Burger");
    assert.equal(order.items[0].qty, 2);
    assert.equal(order.items[0].price, 50);
    assert.equal(order.items[0].offerLabel, "🔥 Item Offer");
    assert.equal(order.items[0].originalPrice, 60);
    assert.equal(order.items[0].lineCostAtSale, 16.5);
    assert.equal(order.discountType, "percent");
    assert.equal(order.discountValue, 10);
    assert.equal(order.discountAmount, 10);
    assert.equal(order.additionalCharges.length, 2);
    assert.equal(order.additionalCharges[0].value, 5);
    assert.equal(order.additionalCharges[0].amount, 4.5);
    assert.equal(order.additionalCharges[1].value, 20);
    assert.equal(order.additionalCharges[1].amount, 20);
    assert.equal(order.paymentMethod, "Bank Account");
    assert.equal(order.amountReceived, 92.5);
    assert.equal(order.paymentAccountId, "88888888-8888-4888-8888-888888888888");
    assert.equal(order.editHistory.length, 1);
    assert.equal(order.editHistory[0].type, "edit");
    assert.equal(order.editHistory[0].changes[0].label, "Quantity");
    assert.equal(order.lastEditedDate, "2026-10-02");
    assert.equal(order.costOfGoods, 33);
    assert.equal(order.costSnapshotSource, "cloud");
  });

  it("maps category offers from the stored snapshot", () => {
    const detail = {
      order: cloudSummary(),
      items: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          menuItemId: "44444444-4444-4444-8444-444444444444",
          name: "Pizza",
          quantity: 1,
          unitPriceMinor: 8_500,
          lineTotalMinor: 8_500,
          unitCostMinor: 3_000,
          recipe: {
            offer: {
              type: "category",
              regularPriceMinor: 10_000,
              discountType: "percent",
              discountPercent: 15,
            },
          },
        },
      ],
      charges: [],
      payments: [],
      events: [],
      cancellation: null,
    };
    const order = mapCloudOrderDetail(detail);
    assert.equal(order.items[0].offerLabel, "🏷️ Category Offer (15% off)");
    assert.equal(order.items[0].originalPrice, 100);
  });

  it("maps a cancellation with restock and refund details", () => {
    const detail = {
      order: cloudSummary({
        orderStatus: "cancelled",
        cancellationReason: "customer changed mind",
      }),
      items: [],
      charges: [],
      payments: [
        { id: "77777777-7777-4777-8777-777777777777", method: "cash", status: "refunded", amountMinor: 9_250 },
      ],
      events: [],
      cancellation: {
        cancelledAt: "2026-10-02T15:00:00.000Z",
        reason: "customer changed mind",
        refundedMinor: 9_250,
        restocked: [{ stockItemId: "aaaa1111", quantityBaseUnits: 200 }],
      },
    };
    const order = mapCloudOrderDetail(detail);
    assert.equal(order.orderStatus, "Cancelled");
    assert.equal(order.statusReason, "customer changed mind");
    assert.equal(order.restockSummary, "aaaa1111 +200");
    assert.equal(order.paymentStatus, "Paid");
  });

  it("converts the server summary block for display", () => {
    const summary = mapCloudSummary({
      orderCount: 12,
      cancelledCount: 2,
      salesMinor: 120_500,
      costOfGoodsMinor: 40_000,
      paidMinor: 100_000,
      dueMinor: 20_500,
    });
    assert.equal(summary.orderCount, 12);
    assert.equal(summary.cancelledCount, 2);
    assert.equal(summary.sales, 1205);
    assert.equal(summary.costOfGoods, 400);
    assert.equal(summary.paid, 1000);
    assert.equal(summary.due, 205);
  });
});
