import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOrderRefundUI } from "../src/client/order-refund-ui.mjs";
import { CloudApiError } from "../src/client/api-client.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const itemId = "44444444-4444-4444-8444-444444444444";

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

function orderDetail(overrides = {}) {
  return {
    order: {
      id: orderId,
      orderNumber: 1001,
      orderStatus: "completed",
      paymentStatus: "paid",
      customerName: "Ayesha Khan",
      subtotalMinor: 10_000,
      discountMinor: 0,
      additionalChargesMinor: 0,
      totalMinor: 10_000,
      ...overrides,
    },
    items: [
      {
        id: itemId,
        itemNameSnapshot: "Burger",
        quantity: 2,
        unitPriceMinor: 5_000,
        lineTotalMinor: 10_000,
      },
    ],
  };
}

function makeElement() {
  const listeners = new Map();
  const element = {
    className: "",
    id: "",
    style: {},
    textContent: "",
    value: "",
    checked: true,
    disabled: false,
    hidden: false,
    _innerHTML: "",
    set innerHTML(value) {
      this._innerHTML = value;
    },
    get innerHTML() {
      return this._innerHTML;
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatch(type, event = {}) {
      (listeners.get(type) ?? []).forEach((handler) =>
        handler({ target: element, preventDefault() {}, ...event }),
      );
    },
    getAttribute() {
      return null;
    },
    appendChild(child) {
      return child;
    },
    remove() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  return element;
}

function setup({
  detail = orderDetail(),
  refunds = [],
  createRefundResponse = null,
  createRefundError = null,
  context = { restaurantId },
} = {}) {
  const requests = [];
  const alerts = [];
  const previous = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    alert: globalThis.alert,
    session: globalThis.BiteTechCloudSession,
  };

  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (String(url).includes("/refunds") && init?.method === "POST") {
      // HTTP-level failures are delivered as error responses, not
      // as fetch rejections: a rejected fetch is a network outage.
      if (createRefundError) {
        return jsonResponse(
          { error: createRefundError.message, code: createRefundError.code },
          { status: createRefundError.status },
        );
      }
      return jsonResponse(
        createRefundResponse ?? {
          replayed: false,
          refund: {
            refundNumber: "REF-101-1",
            totalRefundedMinor: 10_000,
            status: "completed",
          },
          order: { id: orderId, paymentStatus: "partially_refunded" },
        },
      );
    }
    if (String(url).includes("/refunds")) {
      return jsonResponse(refunds);
    }
    return jsonResponse(detail);
  };

  globalThis.alert = (message) => {
    alerts.push(message);
  };
  globalThis.BiteTechCloudSession = {
    activeRestaurant: async () => restaurantId,
  };

  const overlay = makeElement();
  overlay.querySelectorAll = (selector) => {
    if (selector === ".refund-qty-input") return [qtyInput];
    if (selector === ".refund-restock-checkbox") return [restockCheckbox];
    return [];
  };
  overlay.querySelector = (selector) => {
    const byId = {
      "#refund-reason-input": reasonInput,
      "#refund-notes-input": notesInput,
      "#refund-preview-amount": previewAmount,
      "#refund-submit-btn": submitBtn,
      "#refund-cancel-btn": cancelBtn,
      "#refund-close-btn": closeBtn,
      "#refund-error-msg": errorMsg,
    };
    return byId[selector] ?? null;
  };

  const qtyInput = makeElement();
  qtyInput.getAttribute = (name) => (name === "data-index" ? "0" : null);
  qtyInput.value = "2";
  const restockCheckbox = makeElement();
  restockCheckbox.getAttribute = (name) => (name === "data-index" ? "0" : null);
  restockCheckbox.checked = true;
  const reasonInput = makeElement();
  reasonInput.value = "Customer return";
  const notesInput = makeElement();
  notesInput.value = "";
  const previewAmount = makeElement();
  const submitBtn = makeElement();
  const cancelBtn = makeElement();
  const closeBtn = makeElement();
  const errorMsg = makeElement();

  const body = makeElement();
  body.appendChild = (child) => {
    body.children = body.children ?? [];
    body.children.push(child);
    return child;
  };

  globalThis.document = {
    createElement: () => overlay,
    querySelector: () => null,
    body,
  };

  const storage = {
    async get(key) {
      if (key === "pos_cloud_context_v1") return context;
      return null;
    },
    async set() {},
  };

  return {
    requests,
    alerts,
    overlay,
    qtyInput,
    restockCheckbox,
    reasonInput,
    notesInput,
    previewAmount,
    submitBtn,
    errorMsg,
    storage,
    restore() {
      globalThis.fetch = previous.fetch;
      globalThis.document = previous.document;
      globalThis.alert = previous.alert;
      globalThis.BiteTechCloudSession = previous.session;
    },
  };
}

describe("order refund UI", () => {
  it("rejects local order identifiers", async () => {
    const { alerts, storage, restore } = setup();
    try {
      const ui = createOrderRefundUI({ storage });
      await ui.openRefundModal("7");
    } finally {
      restore();
    }
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /cloud orders/);
  });

  it("rejects when the cloud is not configured", async () => {
    const { alerts, storage, restore } = setup({ context: null });
    try {
      const ui = createOrderRefundUI({ storage });
      await ui.openRefundModal(orderId);
    } finally {
      restore();
    }
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /sign in/i);
  });

  it("rejects cancelled orders", async () => {
    const { alerts, storage, restore } = setup({
      detail: orderDetail({ orderStatus: "cancelled" }),
    });
    try {
      const ui = createOrderRefundUI({ storage });
      await ui.openRefundModal(orderId);
    } finally {
      restore();
    }
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /cancelled/);
  });

  it("rejects orders that are already fully refunded", async () => {
    const { alerts, storage, restore } = setup({
      refunds: [
        {
          id: "55555555-5555-4555-a555-555555555555",
          totalRefundedMinor: 10_000,
          items: [{ orderItemId: itemId, quantity: 2 }],
        },
      ],
    });
    try {
      const ui = createOrderRefundUI({ storage });
      await ui.openRefundModal(orderId);
    } finally {
      restore();
    }
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /fully refunded/);
  });

  it("opens the refund modal for an eligible order", async () => {
    const { storage, restore, overlay } = setup();
    try {
      const ui = createOrderRefundUI({ storage });
      await ui.openRefundModal(orderId);
      assert.equal(overlay.className, "modal-overlay");
      assert.match(overlay.innerHTML, /Refund Order #1001/);
      assert.match(overlay.innerHTML, /PKR 100\.00/);
    } finally {
      restore();
    }
  });

  it("submits the selected items, reason and idempotency key", async () => {
    const { requests, alerts, storage, restore, qtyInput, reasonInput, submitBtn } =
      setup();
    const refunded = [];
    try {
      const ui = createOrderRefundUI({
        storage,
        onRefunded: (id, result) => refunded.push({ id, result }),
      });
      await ui.openRefundModal(orderId);
      // The preview recomputes the selection from the inputs.
      qtyInput.dispatch("input");
      reasonInput.dispatch("input");
      assert.equal(submitBtn.disabled, false);
      submitBtn.dispatch("click");
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      restore();
    }

    const post = requests.find((r) => r.init?.method === "POST");
    assert.ok(post, "expected a POST refund request");
    assert.equal(
      post.url,
      `/api/pos/orders/${orderId}/refunds`,
    );
    assert.match(post.init.headers["Idempotency-Key"], /^[0-9a-f-]{36}$/i);
    const body = JSON.parse(post.init.body);
    assert.deepEqual(body.items, [
      { orderItemId: itemId, quantity: 2, restock: true },
    ]);
    assert.equal(body.reason, "Customer return");
    assert.equal(body.idempotencyKey, post.init.headers["Idempotency-Key"]);

    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /REF-101-1/);
    assert.equal(refunded.length, 1);
    assert.equal(refunded[0].id, orderId);
    assert.equal(refunded[0].result.refund.refundNumber, "REF-101-1");
  });

  it("keeps the same idempotency key when a failed attempt is retried", async () => {
    const { requests, storage, restore, qtyInput, reasonInput, submitBtn, errorMsg } =
      setup({
        createRefundError: new CloudApiError(
          "Refund exceeds the remaining refundable balance.",
          { status: 409, code: "AMOUNT_EXCEEDS_REFUNDABLE" },
        ),
      });
    try {
      const ui = createOrderRefundUI({ storage });
      await ui.openRefundModal(orderId);
      qtyInput.dispatch("input");
      reasonInput.dispatch("input");
      submitBtn.dispatch("click");
      await new Promise((resolve) => setTimeout(resolve, 0));
      submitBtn.dispatch("click");
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      restore();
    }

    const posts = requests.filter((r) => r.init?.method === "POST");
    assert.equal(posts.length, 2);
    assert.equal(
      posts[0].init.headers["Idempotency-Key"],
      posts[1].init.headers["Idempotency-Key"],
    );
    // The failure is shown inline and the button is re-armed.
    assert.equal(errorMsg.style.display, "block");
    assert.match(errorMsg.textContent, /refundable/);
    assert.equal(submitBtn.disabled, false);
    assert.equal(submitBtn.textContent, "Confirm Refund");
  });

  it("blocks a second attempt while one is in flight", async () => {
    const { requests, storage, restore, qtyInput, reasonInput, submitBtn } =
      setup({
        createRefundResponse: {
          replayed: false,
          refund: { refundNumber: "REF-101-1", totalRefundedMinor: 10_000 },
          order: { id: orderId, paymentStatus: "partially_refunded" },
        },
      });
    let releaseSubmit;
    const gate = new Promise((resolve) => {
      releaseSubmit = resolve;
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (init?.method === "POST") {
        await gate;
      }
      return previousFetch(url, init);
    };
    try {
      const ui = createOrderRefundUI({ storage });
      await ui.openRefundModal(orderId);
      qtyInput.dispatch("input");
      reasonInput.dispatch("input");
      submitBtn.dispatch("click");
      await new Promise((resolve) => setTimeout(resolve, 0));
      // While the first attempt is pending the button stays locked.
      assert.equal(submitBtn.disabled, true);
      assert.equal(submitBtn.textContent, "Processing...");
      submitBtn.dispatch("click");
      releaseSubmit();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      globalThis.fetch = previousFetch;
      restore();
    }

    const posts = requests.filter((r) => r.init?.method === "POST");
    assert.equal(posts.length, 1);
  });

  it("classifies refund failures for the user", async () => {
    const { storage, restore } = setup();
    const ui = createOrderRefundUI({ storage });
    try {
      assert.match(
        ui.describeRefundError(new TypeError("network down")),
        /offline/i,
      );
      assert.match(
        ui.describeRefundError(
          new CloudApiError("Authentication is required.", {
            status: 401,
            code: "UNAUTHENTICATED",
          }),
        ),
        /session has expired/i,
      );
      assert.match(
        ui.describeRefundError(
          new CloudApiError("You do not have permission.", {
            status: 403,
            code: "FORBIDDEN",
          }),
        ),
        /permission/i,
      );
      assert.match(
        ui.describeRefundError(
          new CloudApiError("An active restaurant subscription is required.", {
            status: 402,
            code: "SUBSCRIPTION_REQUIRED",
          }),
        ),
        /subscription/i,
      );
      assert.match(
        ui.describeRefundError(
          new CloudApiError("Invalid refund parameters.", {
            status: 422,
            code: "VALIDATION_ERROR",
          }),
        ),
        /Invalid refund parameters/,
      );
      assert.match(
        ui.describeRefundError(
          new CloudApiError("Order not found.", {
            status: 404,
            code: "ORDER_NOT_FOUND",
          }),
        ),
        /not found in the cloud/i,
      );
      assert.match(
        ui.describeRefundError(
          new CloudApiError("Idempotency key reused with a different payload.", {
            status: 409,
            code: "IDEMPOTENCY_PAYLOAD_MISMATCH",
          }),
        ),
        /different refund request/,
      );
      assert.match(
        ui.describeRefundError(
          new CloudApiError("Refund exceeds the remaining refundable balance.", {
            status: 409,
            code: "AMOUNT_EXCEEDS_REFUNDABLE",
          }),
        ),
        /refundable balance/i,
      );
      assert.match(
        ui.describeRefundError(
          new CloudApiError("Too many requests.", {
            status: 429,
            code: "RATE_LIMITED",
          }),
        ),
        /Too many requests/i,
      );
      assert.match(
        ui.describeRefundError(
          new CloudApiError("Internal server error.", {
            status: 500,
            code: "INTERNAL_ERROR",
          }),
        ),
        /Server error/i,
      );
    } finally {
      restore();
    }
  });
});
