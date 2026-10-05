import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOrderDetailUI } from "../src/client/order-detail-ui.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const localOrderId = 7;

function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "application/json"]]),
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function cloudDetail(overrides = {}) {
  return {
    order: {
      id: orderId,
      orderNumber: 1001,
      orderType: "dine_in",
      orderStatus: "completed",
      paymentStatus: "paid",
      tableNumber: 4,
      customerName: "Ayesha Khan",
      subtotalMinor: 10_000,
      discountMinor: 0,
      deliveryMinor: 0,
      totalMinor: 10_000,
      costOfGoodsMinor: 3_000,
      businessDate: "2026-10-02",
      orderedAt: "2026-10-02T14:30:00.000Z",
      legacyOrderId: localOrderId,
      ...overrides,
    },
    items: [
      {
        menuItemId: "44444444-4444-4444-8444-444444444444",
        name: "Burger",
        quantity: 2,
        unitPriceMinor: 5_000,
        unitCostMinor: 1_500,
        recipe: null,
      },
    ],
    charges: [],
    payments: [
      {
        method: "cash",
        status: "captured",
        amountMinor: 10_000,
        financialAccountId: null,
      },
    ],
    events: [],
    cancellation: null,
  };
}

function setup({ context = { restaurantId }, fetchImpl, legacyThrows = false } = {}) {
  const previous = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    session: globalThis.BiteTechCloudSession,
    orders: globalThis.orders,
    window: globalThis.window,
    alert: globalThis.alert,
    legacy: {
      showOrderInvoiceDetailsView: globalThis.showOrderInvoiceDetailsView,
      reprintOrderReceipt: globalThis.reprintOrderReceipt,
      populateReceiptSlipAndPrint: globalThis.populateReceiptSlipAndPrint,
      updateOrderRemainingDue: globalThis.updateOrderRemainingDue,
      setInvoiceOrderPaymentStatus:
        globalThis.setInvoiceOrderPaymentStatus,
      enterEditOrderMode: globalThis.enterEditOrderMode,
      deleteBill: globalThis.deleteBill,
    },
  };

  const orders = [
    {
      id: localOrderId,
      date: "2026-10-01",
      customerName: "Local Order",
      items: [],
      totalBill: 100,
      orderStatus: "Completed",
      paymentStatus: "Paid",
      editHistory: [],
    },
  ];
  globalThis.orders = orders;

  const legacyCalls = [];
  const alerts = [];
  globalThis.window = globalThis;
  globalThis.alert = (message) => {
    alerts.push(message);
  };
  globalThis.showOrderInvoiceDetailsView = (id) => {
    if (legacyThrows) throw new Error("renderer exploded");
    legacyCalls.push(["showOrderInvoiceDetailsView", id]);
  };
  globalThis.reprintOrderReceipt = (id) => {
    legacyCalls.push(["reprintOrderReceipt", id]);
  };
  globalThis.populateReceiptSlipAndPrint = (order) => {
    legacyCalls.push(["populateReceiptSlipAndPrint", order.id]);
  };
  globalThis.updateOrderRemainingDue = (id) => {
    legacyCalls.push(["updateOrderRemainingDue", id]);
  };
  globalThis.setInvoiceOrderPaymentStatus = (id, status) => {
    legacyCalls.push(["setInvoiceOrderPaymentStatus", id, status]);
  };
  globalThis.enterEditOrderMode = (id) => {
    legacyCalls.push(["enterEditOrderMode", id]);
  };
  globalThis.deleteBill = (id) => {
    legacyCalls.push(["deleteBill", id]);
  };

  globalThis.fetch = fetchImpl
    ?? (async () => jsonResponse(cloudDetail()));
  globalThis.document = { querySelector: () => null };
  globalThis.BiteTechCloudSession = {
    activeRestaurant: async () => restaurantId,
  };

  const storage = {
    async get(key) {
      if (key === "pos_cloud_context_v1") return context;
      return null;
    },
    async set() {},
  };

  const ui = createOrderDetailUI({ storage });

  return {
    orders,
    legacyCalls,
    alerts,
    ui,
    restore() {
      globalThis.fetch = previous.fetch;
      globalThis.document = previous.document;
      globalThis.BiteTechCloudSession = previous.session;
      globalThis.orders = previous.orders;
      globalThis.window = previous.window;
      globalThis.alert = previous.alert;
      Object.assign(globalThis, previous.legacy);
    },
  };
}

describe("order detail UI", () => {
  it("renders a cloud order through the legacy modal and restores the ledger", async () => {
    const { orders, legacyCalls, ui, restore } = setup();
    try {
      await ui.showCloudOrderDetails(orderId);
    } finally {
      restore();
    }

    assert.deepEqual(legacyCalls, [
      ["showOrderInvoiceDetailsView", orderId],
    ]);
    // The local ledger is byte-for-byte restored: the
    // cloud order never lingers in it.
    assert.equal(orders.length, 1);
    assert.equal(orders[0].id, localOrderId);
    assert.equal(orders[0].customerName, "Local Order");
  });

  it("restores the ledger when the legacy renderer throws", async () => {
    const { orders, alerts, restore } = setup({ legacyThrows: true });
    try {
      // Through the wrapper: the renderer failure is
      // surfaced as a user-facing message, not a crash.
      await window.showOrderInvoiceDetailsView(orderId);
    } finally {
      restore();
    }

    // The failure surfaces to the user…
    assert.equal(alerts.length, 1);
    // …and the ledger is still restored.
    assert.equal(orders.length, 1);
    assert.equal(orders[0].id, localOrderId);
  });

  it("appends and removes a cloud-only order that has no local twin", async () => {
    const { orders, legacyCalls, ui, restore } = setup({
      fetchImpl: async () =>
        jsonResponse(cloudDetail({ legacyOrderId: null })),
    });
    try {
      await ui.showCloudOrderDetails(orderId);
    } finally {
      restore();
    }

    assert.deepEqual(legacyCalls, [
      ["showOrderInvoiceDetailsView", orderId],
    ]);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].id, localOrderId);
  });

  it("forwards every argument to the legacy mutation functions", async () => {
    const { legacyCalls, ui, restore } = setup();
    try {
      window.setInvoiceOrderPaymentStatus(localOrderId, "Paid");
      window.updateOrderRemainingDue(localOrderId);
      window.enterEditOrderMode(localOrderId);
      window.deleteBill(localOrderId);
    } finally {
      restore();
    }

    assert.deepEqual(legacyCalls, [
      ["setInvoiceOrderPaymentStatus", localOrderId, "Paid"],
      ["updateOrderRemainingDue", localOrderId],
      ["enterEditOrderMode", localOrderId],
      ["deleteBill", localOrderId],
    ]);
  });

  it("blocks local mutations for cloud orders", async () => {
    const { legacyCalls, alerts, ui, restore } = setup();
    try {
      window.updateOrderRemainingDue(orderId);
      window.setInvoiceOrderPaymentStatus(orderId, "Paid");
      window.enterEditOrderMode(orderId);
      window.deleteBill(orderId);
    } finally {
      restore();
    }

    assert.deepEqual(legacyCalls, []);
    assert.equal(alerts.length, 4);
    assert.ok(alerts.every((message) => message.includes("cloud")));
  });

  it("reprints a cloud order without touching the ledger or creating a sale", async () => {
    const requests = [];
    const { orders, legacyCalls, ui, restore } = setup({
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse(cloudDetail());
      },
    });
    try {
      await ui.reprintCloudOrder(orderId);
    } finally {
      restore();
    }

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `/api/pos/orders/${orderId}`);
    assert.equal(requests[0].init.method, "GET");
    assert.deepEqual(legacyCalls, [
      ["populateReceiptSlipAndPrint", orderId],
    ]);
    // No sale, payment or order was created locally.
    assert.equal(orders.length, 1);
    assert.equal(orders[0].id, localOrderId);
  });

  it("keeps local orders on the local path", async () => {
    const { legacyCalls, restore } = setup();
    try {
      await window.showOrderInvoiceDetailsView(localOrderId);
    } finally {
      restore();
    }

    assert.deepEqual(legacyCalls, [
      ["showOrderInvoiceDetailsView", localOrderId],
    ]);
  });

  it("falls back to the local renderer when the cloud is unreachable", async () => {
    const { legacyCalls, alerts, restore } = setup({
      fetchImpl: async () => {
        throw new TypeError("network down");
      },
    });
    try {
      await window.showOrderInvoiceDetailsView(orderId);
    } finally {
      restore();
    }

    // The original renderer runs with the cloud id; the
    // local lookup simply finds nothing.
    assert.deepEqual(legacyCalls, [
      ["showOrderInvoiceDetailsView", orderId],
    ]);
    assert.deepEqual(alerts, []);
  });

  it("surfaces API errors for cloud orders instead of silently rendering nothing", async () => {
    const { legacyCalls, alerts, restore } = setup({
      fetchImpl: async () =>
        jsonResponse({ error: "Order not found.", code: "ORDER_NOT_FOUND" }, { status: 404 }),
    });
    try {
      await window.showOrderInvoiceDetailsView(orderId);
    } finally {
      restore();
    }

    assert.deepEqual(legacyCalls, []);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /no longer exists/);
  });

  it("surfaces a session error for cloud orders", async () => {
    const { legacyCalls, alerts, restore } = setup({
      fetchImpl: async () =>
        jsonResponse(
          { error: "Authentication is required.", code: "UNAUTHENTICATED" },
          { status: 401 },
        ),
    });
    try {
      await window.reprintOrderReceipt(orderId);
    } finally {
      restore();
    }

    assert.deepEqual(legacyCalls, []);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /session expired/i);
  });

  it("injects a refund action for completed, paid cloud orders", async () => {
    const refundCalls = [];
    const previousOpenRefundModal = globalThis.openRefundModal;
    globalThis.openRefundModal = (id) => {
      refundCalls.push(id);
    };

    const inserted = [];
    const clickListeners = [];
    const printButton = {
      getAttribute(name) {
        return name === "onclick" ? "reprintOrderReceipt(7)" : null;
      },
      parentElement: {
        insertBefore(node, ref) {
          inserted.push({ node, ref });
        },
      },
    };
    const modalContent = {
      querySelectorAll(selector) {
        return selector === "button" ? [printButton] : [];
      },
    };
    const { ui, restore } = setup();
    globalThis.document = {
      querySelector: () => null,
      getElementById(id) {
        return id === "invoice-modal-content" ? modalContent : null;
      },
      createElement() {
        return {
          type: "",
          className: "",
          attributes: {},
          style: {},
          textContent: "",
          setAttribute(name, value) {
            this.attributes[name] = value;
          },
          getAttribute(name) {
            return this.attributes[name];
          },
          addEventListener(name, handler) {
            if (name === "click") clickListeners.push(handler);
          },
        };
      },
    };
    let propagationStopped = false;
    try {
      await ui.showCloudOrderDetails(orderId);
      clickListeners[0]({
        stopPropagation() {
          propagationStopped = true;
        },
      });
    } finally {
      restore();
      globalThis.openRefundModal = previousOpenRefundModal;
    }

    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].ref, printButton);
    const refundButton = inserted[0].node;
    assert.equal(refundButton.getAttribute("data-cloud-refund-btn"), "true");
    assert.equal(refundButton.textContent, "↩️ Refund");
    assert.equal(clickListeners.length, 1);
    assert.equal(propagationStopped, true);
    assert.deepEqual(refundCalls, [orderId]);
  });

  it("does not inject a refund action for unpaid cloud orders", async () => {
    const inserted = [];
    const printButton = {
      getAttribute(name) {
        return name === "onclick" ? "reprintOrderReceipt(7)" : null;
      },
      parentElement: {
        insertBefore(node, ref) {
          inserted.push({ node, ref });
        },
      },
    };
    const modalContent = {
      querySelectorAll(selector) {
        return selector === "button" ? [printButton] : [];
      },
    };
    const { ui, restore } = setup({
      fetchImpl: async () =>
        jsonResponse(cloudDetail({ paymentStatus: "unpaid" })),
    });
    globalThis.document = {
      querySelector: () => null,
      getElementById(id) {
        return id === "invoice-modal-content" ? modalContent : null;
      },
      createElement() {
        return {
          setAttribute() {},
          addEventListener() {},
          style: {},
        };
      },
    };
    try {
      await ui.showCloudOrderDetails(orderId);
    } finally {
      restore();
    }

    assert.deepEqual(inserted, []);
  });

  it("does not accumulate wrappers when created once", async () => {
    const { legacyCalls, ui, restore } = setup();
    try {
      // Each call goes through exactly one wrapper: the
      // legacy function is invoked once per call.
      await ui.showCloudOrderDetails(orderId);
      await ui.showCloudOrderDetails(orderId);
    } finally {
      restore();
    }

    assert.equal(legacyCalls.length, 2);
  });
});
