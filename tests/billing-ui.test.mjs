import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBillingUI } from "../src/client/billing-ui.mjs";

function createFakeDom() {
  const elements = new Map();
  const confirmResults = [];

  function makeElement(id = "") {
    const listeners = new Map();
    const element = {
      id,
      className: "",
      style: {},
      dataset: {},
      children: [],
      _innerHTML: "",
      set innerHTML(value) {
        this._innerHTML = value;
      },
      get innerHTML() {
        return this._innerHTML;
      },
      textContent: "",
      value: "",
      hidden: false,
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      removeEventListener() {},
      dispatch(type, event = {}) {
        (listeners.get(type) ?? []).forEach((handler) =>
          handler({ preventDefault() {}, target: element, ...event }),
        );
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      classList: {
        add(...classes) {
          element.className = [
            ...new Set([...element.className.split(" ").filter(Boolean), ...classes]),
          ].join(" ");
        },
        remove(...classes) {
          const set = new Set(element.className.split(" ").filter(Boolean));
          classes.forEach((cls) => set.delete(cls));
          element.className = [...set].join(" ");
        },
        toggle(cls, force) {
          const set = new Set(element.className.split(" ").filter(Boolean));
          const shouldAdd = force === undefined ? !set.has(cls) : force;
          if (shouldAdd) set.add(cls);
          else set.delete(cls);
          element.className = [...set].join(" ");
        },
        contains(cls) {
          return element.className.split(" ").includes(cls);
        },
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

  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    createElement: (tag) => makeElement(),
    querySelector: () => null,
    body: makeElement("body"),
  };

  return { document, makeElement, confirmResults };
}

function billingOverview(overrides = {}) {
  return {
    plans: [
      {
        id: "plan-1",
        code: "STARTER",
        name: "Starter",
        description: "One till",
        features: { "Up to 2 users": true },
        prices: [
          { id: "price-1", currencyCode: "PKR", amountMinor: 4_999_00, interval: "month" },
        ],
      },
      {
        id: "plan-2",
        code: "STANDARD",
        name: "Standard",
        description: "Multi till",
        features: { "Up to 10 users": true, "Multi-branch": true },
        prices: [
          { id: "price-2", currencyCode: "PKR", amountMinor: 9_999_00, interval: "month" },
        ],
      },
    ],
    subscription: {
      id: "sub-1",
      status: "active",
      plan: { id: "plan-2", code: "STANDARD", name: "Standard" },
      currentPeriodStart: "2026-10-01T00:00:00.000Z",
      currentPeriodEnd: "2026-11-01T00:00:00.000Z",
      trialEndsAt: null,
      graceEndsAt: null,
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      provider: "stripe",
    },
    ...overrides,
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

function setup({ fetchImpl, confirm = true } = {}) {
  const dom = createFakeDom();
  const redirects = [];
  const confirms = [];

  const previous = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    window: globalThis.window,
    confirm: globalThis.confirm,
    session: globalThis.BiteTechCloudSession,
  };

  globalThis.fetch = fetchImpl ?? (async () => jsonResponse(billingOverview()));
  globalThis.document = dom.document;
  globalThis.window = {
    location: {
      origin: "https://app.example",
      assign: (url) => redirects.push(url),
    },
  };
  globalThis.confirm = (message) => {
    confirms.push(message);
    return confirm;
  };
  globalThis.BiteTechCloudSession = {
    activeRestaurant: async () => "22222222-2222-4222-8222-222222222222",
  };

  const ui = createBillingUI();

  return {
    dom,
    ui,
    redirects,
    confirms,
    restore() {
      globalThis.fetch = previous.fetch;
      globalThis.document = previous.document;
      globalThis.window = previous.window;
      globalThis.confirm = previous.confirm;
      globalThis.BiteTechCloudSession = previous.session;
    },
  };
}

describe("billing UI", () => {
  it("renders the subscription, plans and payment history", async () => {
    const payments = [
      {
        id: "pay-1",
        provider: "stripe",
        providerPaymentId: "pi_1",
        status: "succeeded",
        amountMinor: 9_999_00,
        currencyCode: "PKR",
        failureCode: null,
        failureMessage: null,
        paidAt: "2026-10-01T00:00:00.000Z",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ];
    let calls = 0;
    const { dom, ui, restore } = setup({
      fetchImpl: async (url) => {
        calls += 1;
        if (url.includes("/payments")) return jsonResponse(payments);
        return jsonResponse(billingOverview());
      },
    });
    try {
      await ui.renderBilling();
    } finally {
      restore();
    }

    assert.equal(calls, 2);
    const subscription = dom.document.getElementById("billing-current-subscription").innerHTML;
    assert.match(subscription, /Standard/);
    assert.match(subscription, /Active/);
    assert.match(subscription, /Renews/);

    const plans = dom.document.getElementById("billing-plans").innerHTML;
    assert.match(plans, /Starter/);
    assert.match(plans, /Standard/);
    assert.match(plans, /Subscribe \/ Pay/);

    const paymentsHtml = dom.document.getElementById("billing-payments").innerHTML;
    assert.match(paymentsHtml, /succeeded/);
    assert.match(paymentsHtml, /9,999/);
  });

  it("renders without a subscription so lapsed restaurants can pay", async () => {
    const { dom, ui, restore } = setup({
      fetchImpl: async () =>
        jsonResponse(billingOverview({ subscription: null })),
    });
    try {
      await ui.renderBilling();
    } finally {
      restore();
    }

    const subscription = dom.document.getElementById("billing-current-subscription").innerHTML;
    assert.match(subscription, /No active subscription/);
    const actions = dom.document.getElementById("billing-actions").innerHTML;
    assert.equal(actions, "");
  });

  it("shows a problem state for past-due subscriptions", async () => {
    const { dom, ui, restore } = setup({
      fetchImpl: async () =>
        jsonResponse(
          billingOverview({
            subscription: {
              ...billingOverview().subscription,
              status: "past_due",
            },
          }),
        ),
    });
    try {
      await ui.renderBilling();
    } finally {
      restore();
    }

    const subscription = dom.document.getElementById("billing-current-subscription").innerHTML;
    assert.match(subscription, /Past due/);
  });

  it("offers cancel and resume actions for the right states", async () => {
    const active = setup({
      fetchImpl: async () => jsonResponse(billingOverview()),
    });
    try {
      await active.ui.renderBilling();
      const actions = active.dom.document.getElementById("billing-actions").innerHTML;
      assert.match(actions, /Cancel subscription/);
      assert.doesNotMatch(actions, /Resume subscription/);
    } finally {
      active.restore();
    }

    const canceled = setup({
      fetchImpl: async () =>
        jsonResponse(
          billingOverview({
            subscription: {
              ...billingOverview().subscription,
              status: "canceled",
            },
          }),
        ),
    });
    try {
      await canceled.ui.renderBilling();
      const actions = canceled.dom.document.getElementById("billing-actions").innerHTML;
      assert.match(actions, /Resume subscription/);
      assert.doesNotMatch(actions, /Cancel subscription/);
    } finally {
      canceled.restore();
    }
  });

  it("starts a checkout against the application origin and redirects", async () => {
    const requests = [];
    const { ui, redirects, restore } = setup({
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse({
          replayed: false,
          checkoutUrl: "https://pay.example/session/abc",
          plan: { code: "STANDARD", name: "Standard" },
          amountMinor: 9_999_00,
          currencyCode: "PKR",
          status: "awaiting_payment",
        });
      },
    });
    try {
      await ui.startCheckout("STANDARD");
    } finally {
      restore();
    }

    assert.equal(requests[0].url, "/api/billing/checkout");
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.planCode, "STANDARD");
    assert.equal(body.successUrl, "https://app.example/billing?checkout=success");
    assert.equal(body.cancelUrl, "https://app.example/billing?checkout=cancelled");
    assert.match(
      body.idempotencyKey,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.deepEqual(redirects, ["https://pay.example/session/abc"]);
  });

  it("surfaces checkout errors instead of redirecting", async () => {
    const { dom, ui, redirects, restore } = setup({
      fetchImpl: async () =>
        jsonResponse(
          { error: "The success URL must use HTTPS.", code: "BILLING_URL_NOT_TRUSTED" },
          { status: 400 },
        ),
    });
    try {
      await ui.startCheckout("STANDARD");
    } finally {
      restore();
    }

    assert.deepEqual(redirects, []);
    const status = dom.document.getElementById("billing-status");
    assert.match(status.textContent, /HTTPS/);
    assert.match(status.className, /error/);
  });

  it("cancels the subscription at period end after confirmation", async () => {
    const requests = [];
    const { ui, confirms, restore } = setup({
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        if (url.includes("/cancel")) return jsonResponse({});
        if (url.includes("/payments")) return jsonResponse([]);
        return jsonResponse(billingOverview());
      },
    });
    try {
      await ui.cancelSubscription();
    } finally {
      restore();
    }

    assert.equal(confirms.length, 1);
    const cancelRequest = requests.find((request) => request.url.includes("/billing/cancel"));
    assert.ok(cancelRequest);
    assert.deepEqual(JSON.parse(cancelRequest.init.body), { cancelAtPeriodEnd: true });
  });

  it("does nothing when cancellation is not confirmed", async () => {
    const requests = [];
    const { ui, restore } = setup({
      confirm: false,
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse(billingOverview());
      },
    });
    try {
      await ui.cancelSubscription();
    } finally {
      restore();
    }

    assert.equal(
      requests.some((request) => request.url.includes("/billing/cancel")),
      false,
    );
  });

  it("resumes a cancelled subscription", async () => {
    const requests = [];
    const { ui, restore } = setup({
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        if (url.includes("/resume")) return jsonResponse({});
        if (url.includes("/payments")) return jsonResponse([]);
        return jsonResponse(billingOverview());
      },
    });
    try {
      await ui.resumeSubscription();
    } finally {
      restore();
    }

    assert.ok(
      requests.some((request) => request.url === "/api/billing/resume"),
    );
  });

  it("reports when the cloud is unreachable", async () => {
    const { dom, ui, restore } = setup({
      fetchImpl: async () => {
        throw new TypeError("network down");
      },
    });
    try {
      await ui.renderBilling();
    } finally {
      restore();
    }

    const status = dom.document.getElementById("billing-status");
    assert.match(status.textContent, /unreachable/);
    assert.match(status.className, /error/);
  });
});
