import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOrderHistoryUI } from "../src/client/order-history-ui.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";

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

function cloudList(overrides = {}) {
  return {
    orders: [
      {
        id: orderId,
        orderNumber: 42,
        orderType: "dine_in",
        orderStatus: "completed",
        paymentStatus: "paid",
        tableId: null,
        tableNumber: 4,
        customerName: "Ayesha Khan",
        customerPhone: null,
        riderName: null,
        subtotalMinor: 10_000,
        discountMinor: 0,
        deliveryMinor: 0,
        additionalChargesMinor: 0,
        totalMinor: 10_000,
        businessDate: "2026-10-02",
        orderedAt: "2026-10-02T14:30:00.000Z",
        cancelledAt: null,
        cancellationReason: null,
      },
    ],
    summary: {
      orderCount: 1,
      cancelledCount: 0,
      salesMinor: 10_000,
      costOfGoodsMinor: 3_000,
      paidMinor: 10_000,
      dueMinor: 0,
    },
    nextCursor: null,
    ...overrides,
  };
}

function createFakeDom() {
  const elements = new Map();
  const rows = [];

  function makeElement(id = "") {
    const listeners = new Map();
    const element = {
      id,
      className: "",
      style: {},
      dataset: {},
      children: [],
      _innerHTML: "",
      _value: "",
      set innerHTML(value) {
        this._innerHTML = value;
      },
      get innerHTML() {
        return this._innerHTML;
      },
      set value(value) {
        this._value = value;
      },
      get value() {
        return this._value;
      },
      textContent: "",
      hidden: false,
      set innerText(value) {
        this.textContent = value;
      },
      get innerText() {
        return this.textContent;
      },
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
      setAttribute(name, value) {
        element[`data-${name}`] = value;
      },
      querySelector() {
        return null;
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
    createElement: (tag) => {
      const element = makeElement();
      if (tag === "tr") rows.push(element);
      return element;
    },
    querySelector: () => null,
    createTextNode: (text) => ({ text }),
  };

  return { document, elements, rows, makeElement };
}

function setup({ context = { restaurantId }, fetchImpl } = {}) {
  const dom = createFakeDom();
  const legacyRenders = [];

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
    session: globalThis.BiteTechCloudSession,
    isSalesVisible: globalThis.isSalesVisible,
  };

  globalThis.fetch = fetchImpl ?? (async () => jsonResponse(cloudList()));
  globalThis.document = dom.document;
  globalThis.BiteTechCloudSession = {
    activeRestaurant: async () => restaurantId,
  };
  globalThis.isSalesVisible = true;

  function legacyRender() {
    legacyRenders.push(true);
  }

  const ui = createOrderHistoryUI({ storage, legacyRender });

  return {
    dom,
    ui,
    legacyRenders,
    restore() {
      globalThis.fetch = previous.fetch;
      globalThis.document = previous.document;
      globalThis.BiteTechCloudSession = previous.session;
      globalThis.isSalesVisible = previous.isSalesVisible;
    },
  };
}

describe("order history UI", () => {
  it("renders cloud orders with the server-side summary", async () => {
    const requests = [];
    const { dom, ui, legacyRenders, restore } = setup({
      fetchImpl: async (url) => {
        requests.push(url);
        return jsonResponse(cloudList());
      },
    });
    try {
      await ui.renderOrdersHistory();
    } finally {
      restore();
    }

    assert.equal(requests[0], "/api/pos/orders?limit=50");
    assert.equal(legacyRenders.length, 0);
    assert.equal(dom.rows.length, 1);
    assert.match(dom.rows[0].innerHTML, /#42/);
    assert.match(dom.rows[0].innerHTML, /Ayesha Khan/);
    assert.match(dom.rows[0].innerHTML, /Dine-In/);
    assert.match(dom.rows[0].innerHTML, /Rs. 100/);
    assert.match(dom.rows[0].innerHTML, /showOrderInvoiceDetailsView|#42/);
    assert.equal(
      dom.rows[0]["data-onclick"],
      "showOrderInvoiceDetailsView('22222222-2222-4222-8222-222222222222')",
    );
    assert.match(dom.rows[0].innerHTML, /reprintOrderReceipt\('22222222-2222-4222-8222-222222222222'\)/);
    assert.match(dom.rows[0].innerHTML, /cancelCloudOrder\('22222222-2222-4222-8222-222222222222'\)/);

    const count = dom.document.getElementById("history-results-count-text").textContent;
    assert.match(count, /1 order found/);
    const sales = dom.document.getElementById("filtered-sales-amount").textContent;
    assert.match(sales, /Rs. 100/);
  });

  it("sends search, date and status filters to the server", async () => {
    const requests = [];
    const { dom, ui, restore } = setup({
      fetchImpl: async (url) => {
        requests.push(url);
        return jsonResponse(cloudList());
      },
    });
    try {
      dom.document.getElementById("history-search").value = "ayesha";
      dom.document.getElementById("history-date-from").value = "2026-10-01";
      dom.document.getElementById("history-date-to").value = "2026-10-02";
      dom.document.getElementById("history-payment-filter").value = "Paid";
      dom.document.getElementById("history-status-filter").value = "Completed";
      await ui.renderOrdersHistory();
    } finally {
      restore();
    }

    const query = new URLSearchParams(requests[0].split("?")[1]);
    assert.equal(query.get("search"), "ayesha");
    assert.equal(query.get("from"), "2026-10-01");
    assert.equal(query.get("to"), "2026-10-02");
    assert.equal(query.get("paymentStatus"), "paid");
    assert.equal(query.get("orderStatus"), "completed");
  });

  it("marks cancelled orders and hides their cancel button", async () => {
    const { dom, ui, restore } = setup({
      fetchImpl: async () =>
        jsonResponse(
          cloudList({
            orders: [
              {
                ...cloudList().orders[0],
                orderStatus: "cancelled",
                cancellationReason: "wrong order",
              },
            ],
          }),
        ),
    });
    try {
      await ui.renderOrdersHistory();
    } finally {
      restore();
    }

    assert.match(dom.rows[0].innerHTML, /Cancelled/);
    assert.match(dom.rows[0].innerHTML, /wrong order/);
    assert.doesNotMatch(dom.rows[0].innerHTML, /cancelCloudOrder/);
  });

  it("appends the next page when a cursor is returned", async () => {
    const pages = [];
    const { dom, ui, restore } = setup({
      fetchImpl: async (url) => {
        pages.push(url);
        if (url.includes("cursor=page2")) {
          return jsonResponse(cloudList({ nextCursor: null }));
        }
        return jsonResponse(cloudList({ nextCursor: "page2" }));
      },
    });
    try {
      await ui.renderOrdersHistory();
      const loadMore = dom.document.getElementById("history-load-more");
      assert.equal(loadMore.className.includes("hidden"), false);
      await ui.loadMore();
    } finally {
      restore();
    }

    assert.equal(pages.length, 2);
    assert.match(pages[1], /cursor=page2/);
    assert.equal(dom.rows.length, 2);
  });

  it("falls back to the local ledger when the cloud is unreachable", async () => {
    const { dom, ui, legacyRenders, restore } = setup({
      fetchImpl: async () => {
        throw new TypeError("network down");
      },
    });
    try {
      await ui.renderOrdersHistory();
    } finally {
      restore();
    }

    assert.equal(legacyRenders.length, 1);
    const notice = dom.document.getElementById("history-cloud-notice");
    assert.match(notice.textContent, /Cloud unavailable/);
    assert.equal(dom.rows.length, 0);
  });

  it("uses the local ledger for the edit-history filter", async () => {
    const requests = [];
    const { dom, ui, legacyRenders, restore } = setup({
      fetchImpl: async (url) => {
        requests.push(url);
        return jsonResponse(cloudList());
      },
    });
    try {
      dom.document.getElementById("history-status-filter").value = "Edited";
      await ui.renderOrdersHistory();
    } finally {
      restore();
    }

    assert.equal(requests.length, 0);
    assert.equal(legacyRenders.length, 1);
    const notice = dom.document.getElementById("history-cloud-notice");
    assert.match(notice.textContent, /edit-history filter/);
  });

  it("uses the local ledger when no catalog was imported", async () => {
    const { ui, legacyRenders, restore } = setup({ context: null });
    try {
      await ui.renderOrdersHistory();
    } finally {
      restore();
    }

    assert.equal(legacyRenders.length, 1);
  });

  it("debounces search input into a cloud query", async () => {
    const requests = [];
    const { dom, ui, restore } = setup({
      fetchImpl: async (url) => {
        requests.push(url);
        return jsonResponse(cloudList());
      },
    });
    try {
      const search = dom.document.getElementById("history-search");
      search.dispatch("input");
      search.value = "ayesha";
      search.dispatch("input");
      await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      restore();
    }

    assert.equal(requests.length, 1);
    assert.match(requests[0], /search=ayesha/);
  });
});
