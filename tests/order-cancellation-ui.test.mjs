import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOrderCancellationUI } from "../src/client/order-cancellation-ui.mjs";

const orderId = "11111111-1111-4111-8111-111111111111";
const restaurantId = "22222222-2222-4222-8222-222222222222";

function createFakeDom() {
  const alerts = [];
  const appended = [];

  function makeElement(tag = "div") {
    const listeners = new Map();
    const element = {
      tagName: String(tag).toUpperCase(),
      className: "",
      id: "",
      style: {},
      dataset: {},
      children: [],
      removed: false,
      _innerHTML: "",
      set innerHTML(value) {
        this._innerHTML = value;
      },
      get innerHTML() {
        return this._innerHTML;
      },
      textContent: "",
      value: "",
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      removeEventListener(type, handler) {
        const list = listeners.get(type) ?? [];
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      },
      dispatch(type, event = {}) {
        (listeners.get(type) ?? []).forEach((handler) =>
          handler({ preventDefault() {}, target: element, ...event }),
        );
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      prepend() {},
      remove() {
        this.removed = true;
      },
      querySelector(selector) {
        if (!this._querySelectors) this._querySelectors = new Map();
        if (!this._querySelectors.has(selector)) {
          this._querySelectors.set(selector, makeElement());
        }
        return this._querySelectors.get(selector);
      },
      querySelectorAll() {
        return [];
      },
      focus() {},
      click() {
        this.dispatch("click");
      },
    };
    return element;
  }

  const body = makeElement("body");
  const document = {
    createElement: (tag) => makeElement(tag),
    querySelector: () => null,
    body,
  };

  return { document, body, makeElement, alerts, appended };
}

function cloudOrderDetail(overrides = {}) {
  return {
    order: {
      id: orderId,
      orderNumber: 42,
      orderType: "dine_in",
      orderStatus: "completed",
      paymentStatus: "paid",
      subtotalMinor: 10_000,
      discountMinor: 0,
      deliveryMinor: 0,
      totalMinor: 10_000,
      costOfGoodsMinor: 3_000,
      businessDate: "2026-10-02",
      orderedAt: "2026-10-02T14:30:00.000Z",
      customerName: "Ayesha Khan",
      customerPhone: null,
      riderName: null,
      tableNumber: 4,
      ...overrides,
    },
    items: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        menuItemId: "44444444-4444-4444-8444-444444444444",
        name: "Burger",
        quantity: 2,
        unitPriceMinor: 5_000,
        lineTotalMinor: 10_000,
        unitCostMinor: 1_500,
        recipe: {},
      },
    ],
    charges: [],
    payments: [],
    events: [],
    cancellation: null,
  };
}

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

function setup({ fetchImpl, context = { restaurantId }, onCancelled } = {}) {
  const dom = createFakeDom();
  const storage = {
    async get(key) {
      if (key === "pos_cloud_context_v1") return context;
      return null;
    },
    async set() {},
  };

  const previous = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    alert: globalThis.alert,
    window: globalThis.window,
    closeInvoiceModal: globalThis.closeInvoiceModal,
    openCancelOrderModal: globalThis.openCancelOrderModal,
    session: globalThis.BiteTechCloudSession,
  };

  globalThis.fetch = fetchImpl ?? (async () => jsonResponse({}));
  globalThis.document = dom.document;
  globalThis.alert = (message) => dom.alerts.push(message);
  globalThis.window = globalThis;
  globalThis.BiteTechCloudSession = {
    activeRestaurant: async () => restaurantId,
  };
  globalThis.closeInvoiceModal = () => {
    dom.closedInvoice = true;
  };
  globalThis.openCancelOrderModal = () => {
    dom.legacyCancelOpened = true;
  };

  const ui = createOrderCancellationUI({ storage, onCancelled });

  return {
    dom,
    ui,
    restore() {
      globalThis.fetch = previous.fetch;
      globalThis.document = previous.document;
      globalThis.alert = previous.alert;
      globalThis.window = previous.window;
      globalThis.closeInvoiceModal = previous.closeInvoiceModal;
      globalThis.openCancelOrderModal = previous.openCancelOrderModal;
      globalThis.BiteTechCloudSession = previous.session;
    },
  };
}

function confirmDialog(dom, reason) {
  return waitForDialog(dom).then((overlay) => {
    const reasonInput = overlay.querySelector("#cloud-cancel-reason");
    reasonInput.value = reason;
    overlay.querySelector("#cloud-cancel-confirm").dispatch("click");
  });
}

async function waitForDialog(dom) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (dom.body.children.length > 0) {
      const overlay = dom.body.children.at(-1);
      assert.ok(overlay, "the cancellation dialog was shown");
      return overlay;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("the cancellation dialog was never shown");
}

describe("order cancellation UI", () => {
  it("cancels a cloud order with a reason and a fresh idempotency key", async () => {
    const requests = [];
    const cancelled = [];
    const { dom, ui, restore } = setup({
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        if (url.includes("/cancel")) {
          return jsonResponse({
            order: { id: orderId, orderStatus: "cancelled" },
            cancellation: {},
            replayed: false,
          });
        }
        return jsonResponse(cloudOrderDetail());
      },
      onCancelled: (id) => cancelled.push(id),
    });
    try {
      const pending = ui.cancelCloudOrder(orderId);
      await confirmDialog(dom, "customer changed mind");
      await pending;
    } finally {
      restore();
    }

    const cancelRequest = requests.find((request) => request.url.includes("/cancel"));
    assert.ok(cancelRequest, "the cancel endpoint was called");
    assert.equal(cancelRequest.init.method, "POST");
    const body = JSON.parse(cancelRequest.init.body);
    assert.equal(body.reason, "customer changed mind");
    assert.match(
      body.idempotencyKey,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.equal(dom.alerts[0], "Order cancelled. Stock was reversed and any captured payment was refunded.");
    assert.equal(dom.closedInvoice, true);
    assert.deepEqual(cancelled, [orderId]);
  });

  it("acknowledges a replayed cancellation without compensating twice", async () => {
    const { dom, ui, restore } = setup({
      fetchImpl: async (url) =>
        url.includes("/cancel")
          ? jsonResponse({
              order: { id: orderId, orderStatus: "cancelled" },
              cancellation: {},
              replayed: true,
            })
          : jsonResponse(cloudOrderDetail()),
    });
    try {
      const pending = ui.cancelCloudOrder(orderId);
      await confirmDialog(dom, "customer changed mind");
      await pending;
    } finally {
      restore();
    }

    assert.equal(
      dom.alerts[0],
      "Cancellation confirmed — it was already recorded for this order.",
    );
  });

  it("refuses to cancel an order the cloud already cancelled", async () => {
    const posts = [];
    const { dom, ui, restore } = setup({
      fetchImpl: async (url, init) => {
        if (init?.method === "POST") posts.push(url);
        return jsonResponse(
          cloudOrderDetail({ orderStatus: "cancelled", cancellationReason: "done" }),
        );
      },
    });
    try {
      await ui.cancelCloudOrder(orderId);
    } finally {
      restore();
    }

    assert.equal(dom.alerts[0], "This order is already cancelled.");
    assert.equal(posts.length, 0);
  });

  it("dismisses without calling the cloud when the dialog is closed", async () => {
    const posts = [];
    const { dom, ui, restore } = setup({
      fetchImpl: async (url, init) => {
        if (init?.method === "POST") posts.push(url);
        return jsonResponse(cloudOrderDetail());
      },
    });
    try {
      const pending = ui.cancelCloudOrder(orderId);
      const overlay = await waitForDialog(dom);
      overlay.querySelector("#cloud-cancel-back").dispatch("click");
      await pending;
    } finally {
      restore();
    }

    assert.equal(posts.length, 0);
    assert.equal(dom.alerts.length, 0);
  });

  it("requires the cloud catalog before cancelling", async () => {
    const { dom, ui, restore } = setup({ context: null });
    try {
      await ui.cancelCloudOrder(orderId);
    } finally {
      restore();
    }

    assert.match(dom.alerts[0], /Sign in and copy this till's catalog/);
  });

  it("ignores local (numeric) order ids", async () => {
    const { dom, ui, restore } = setup();
    try {
      await ui.cancelCloudOrder(42);
    } finally {
      restore();
    }

    assert.equal(dom.alerts.length, 0);
  });

  it("surfaces cloud errors with actionable messages", async () => {
    const cases = [
      { status: 403, code: "FORBIDDEN", expected: "permission" },
      { status: 404, code: "ORDER_NOT_FOUND", expected: "no longer exists" },
      { status: 409, code: "ORDER_ALREADY_CANCELLED", expected: "already cancelled" },
      { status: 500, code: null, expected: "try again" },
    ];
    for (const testCase of cases) {
      const { dom, ui, restore } = setup({
        fetchImpl: async (url) =>
          url.includes("/cancel")
            ? jsonResponse({ error: "nope", code: testCase.code }, { status: testCase.status })
            : jsonResponse(cloudOrderDetail()),
      });
      try {
        const pending = ui.cancelCloudOrder(orderId);
        await confirmDialog(dom, "reason");
        await pending;
        assert.match(dom.alerts.at(-1), new RegExp(testCase.expected));
      } finally {
        restore();
      }
    }
  });

  it("explains that offline devices cannot cancel cloud orders", async () => {
    const { dom, ui, restore } = setup({
      fetchImpl: async (url, init) => {
        if (init?.method === "POST") throw new TypeError("fetch failed");
        return jsonResponse(cloudOrderDetail());
      },
    });
    try {
      const pending = ui.cancelCloudOrder(orderId);
      await confirmDialog(dom, "reason");
      await pending;
    } finally {
      restore();
    }

    assert.match(dom.alerts.at(-1), /offline/i);
  });

  it("routes cloud orders through openCancelOrderModal and local orders to the legacy flow", async () => {
    const { dom, ui, restore } = setup({
      fetchImpl: async (url) =>
        url.includes("/cancel")
          ? jsonResponse({ order: {}, cancellation: {}, replayed: false })
          : jsonResponse(cloudOrderDetail()),
    });
    try {
      assert.equal(typeof window.openCancelOrderModal, "function");
      const legacy = globalThis.openCancelOrderModal;
      // The wrapper replaced the legacy function; the original is
      // reachable through the closure only via local ids.
      const pending = window.openCancelOrderModal(orderId);
      await confirmDialog(dom, "reason");
      await pending;
      assert.equal(dom.alerts.length, 1);

      // A local numeric id must reach the legacy restock flow.
      window.openCancelOrderModal(42);
      assert.equal(dom.legacyCancelOpened, true);
      assert.equal(typeof legacy, "function");
    } finally {
      restore();
    }
  });

  it("exposes cancelCloudOrder globally for the history rows", () => {
    const { dom, ui, restore } = setup();
    try {
      assert.equal(typeof globalThis.cancelCloudOrder, "function");
      assert.equal(globalThis.cancelCloudOrder, ui.cancelCloudOrder);
    } finally {
      restore();
    }
    assert.equal(dom.alerts.length, 0);
  });
});
