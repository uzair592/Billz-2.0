import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSalesReportUI } from "../src/client/sales-report-ui.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";

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

function todayStr() {
  return new Date().toISOString().substring(0, 10);
}

function reportPayload(overrides = {}) {
  return {
    restaurant: { id: restaurantId, name: "Test Restaurant", currencyCode: "PKR" },
    filters: { startDate: todayStr(), endDate: todayStr() },
    metrics: {
      grossSalesMinor: 300_000,
      discountsMinor: 10_000,
      refundTotalMinor: 20_000,
      refundedOrderCount: 1,
      netSalesMinor: 270_000,
      completedOrderCount: 3,
      averageOrderValueMinor: 90_000,
    },
    paymentBreakdown: [
      { paymentMethod: "cash", capturedMinor: 200_000, refundedMinor: 0, netMinor: 200_000 },
    ],
    orderTypeBreakdown: [
      { orderType: "dine_in", count: 2, totalMinor: 180_000 },
    ],
    trends: [
      {
        date: todayStr(),
        orderCount: 3,
        grossSalesMinor: 300_000,
        discountMinor: 10_000,
        refundTotalMinor: 20_000,
        netSalesMinor: 270_000,
      },
    ],
    detailedRows: {
      rows: [
        {
          orderNumber: 1001,
          businessDate: todayStr(),
          orderType: "dine_in",
          orderStatus: "completed",
          paymentStatus: "paid",
          totalMinor: 100_000,
          refundedMinor: 0,
          netMinor: 100_000,
        },
      ],
      pagination: { page: 1, limit: 50, totalRows: 1, totalPages: 1 },
    },
    ...overrides,
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
    disabled: false,
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

function setup({ report = reportPayload(), status = 200 } = {}) {
  const requests = [];
  const previous = {
    fetch: globalThis.fetch,
    session: globalThis.BiteTechCloudSession,
    window: globalThis.window,
    location: globalThis.location,
  };

  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse(report, { status });
  };
  globalThis.BiteTechCloudSession = {
    activeRestaurant: async () => restaurantId,
  };
  globalThis.window = globalThis;
  globalThis.location = { href: "" };

  const containerEl = makeElement();
  const contentArea = makeElement();
  const startDateInput = makeElement();
  const endDateInput = makeElement();
  const exportBtn = makeElement();
  const applyBtn = makeElement();
  const presetButtons = ["today", "yesterday", "last7days", "month"].map(
    (preset) => {
      const button = makeElement();
      button.getAttribute = (name) =>
        name === "data-preset" ? preset : null;
      return button;
    },
  );

  containerEl.querySelector = (selector) => {
    const byId = {
      "#report-content-area": contentArea,
      "#report-start-date": startDateInput,
      "#report-end-date": endDateInput,
      "#sales-export-btn": exportBtn,
      "#report-apply-btn": applyBtn,
    };
    return byId[selector] ?? null;
  };
  containerEl.querySelectorAll = (selector) => {
    if (selector === ".preset-btn") return presetButtons;
    return [];
  };

  return {
    requests,
    containerEl,
    contentArea,
    startDateInput,
    endDateInput,
    exportBtn,
    applyBtn,
    presetButtons,
    restore() {
      globalThis.fetch = previous.fetch;
      globalThis.BiteTechCloudSession = previous.session;
      globalThis.window = previous.window;
      globalThis.location = previous.location;
    },
  };
}

describe("sales report UI", () => {
  it("loads today's report and renders server metrics", async () => {
    const { requests, containerEl, contentArea, startDateInput, endDateInput, restore } =
      setup();
    try {
      const ui = createSalesReportUI({ containerEl });
      await ui.mount();
    } finally {
      restore();
    }

    assert.equal(requests.length, 1);
    const url = new URL(requests[0].url, "http://localhost");
    assert.equal(url.pathname, "/api/pos/reports/sales");
    assert.equal(url.searchParams.get("startDate"), todayStr());
    assert.equal(url.searchParams.get("endDate"), todayStr());
    assert.equal(url.searchParams.get("groupBy"), "day");
    assert.equal(url.searchParams.get("limit"), "50");

    assert.equal(startDateInput.value, todayStr());
    assert.equal(endDateInput.value, todayStr());

    assert.match(contentArea.innerHTML, /Gross Sales/);
    assert.match(contentArea.innerHTML, /Total Refunds/);
    assert.match(contentArea.innerHTML, /Net Sales/);
    assert.match(contentArea.innerHTML, /Completed Orders/);
    assert.match(contentArea.innerHTML, /Payment Method Breakdown/);
    assert.match(contentArea.innerHTML, /Order Type Breakdown/);
    assert.match(contentArea.innerHTML, /Sales & Refund Trend/);
    assert.match(contentArea.innerHTML, /Detailed Sales Rows/);
    assert.match(contentArea.innerHTML, /#1001/);
    assert.match(contentArea.innerHTML, /cash/i);
    assert.match(contentArea.innerHTML, /dine in/i);
  });

  it("escapes cloud values instead of injecting markup", async () => {
    const { containerEl, contentArea, restore } = setup({
      report: reportPayload({
        paymentBreakdown: [
          {
            paymentMethod: 'cash"><script>alert("xss")</script>',
            capturedMinor: 1,
            refundedMinor: 0,
            netMinor: 1,
          },
        ],
      }),
    });
    try {
      const ui = createSalesReportUI({ containerEl });
      await ui.mount();
      assert.ok(
        !contentArea.innerHTML.includes("<script>"),
        "script tag must be escaped",
      );
      assert.match(contentArea.innerHTML, /&lt;script&gt;/);
    } finally {
      restore();
    }
  });

  it("renders a failure message when the report cannot be loaded", async () => {
    const { containerEl, contentArea, restore } = setup({
      status: 402,
      report: {
        error: "An active restaurant subscription is required.",
        code: "SUBSCRIPTION_REQUIRED",
      },
    });
    try {
      const ui = createSalesReportUI({ containerEl });
      await ui.mount();
      assert.match(contentArea.innerHTML, /Unable to load sales report/);
      assert.match(contentArea.innerHTML, /subscription is required/i);
    } finally {
      restore();
    }
  });

  it("exports the current date range as CSV", async () => {
    const { containerEl, exportBtn, restore } = setup();
    let exportedHref = "";
    try {
      const ui = createSalesReportUI({ containerEl });
      await ui.mount();
      exportBtn.dispatch("click");
      exportedHref = globalThis.location.href;
    } finally {
      restore();
    }

    assert.match(exportedHref, /\/api\/pos\/reports\/sales\/export/);
    assert.match(exportedHref, /startDate=/);
    assert.match(exportedHref, /endDate=/);
  });

  it("reloads with a custom date range", async () => {
    const { requests, containerEl, restore } = setup();
    try {
      const ui = createSalesReportUI({ containerEl });
      await ui.mount();
      await ui.setFilters({
        preset: "custom",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });
    } finally {
      restore();
    }

    assert.equal(requests.length, 2);
    const url = new URL(requests[1].url, "http://localhost");
    assert.equal(url.searchParams.get("startDate"), "2026-01-01");
    assert.equal(url.searchParams.get("endDate"), "2026-01-31");
  });

  it("reloads when a date preset is chosen", async () => {
    const { requests, containerEl, presetButtons, restore } = setup();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().substring(0, 10);
    try {
      const ui = createSalesReportUI({ containerEl });
      await ui.mount();
      presetButtons[1].dispatch("click");
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      restore();
    }

    const last = requests[requests.length - 1];
    const url = new URL(last.url, "http://localhost");
    assert.equal(url.searchParams.get("startDate"), yesterdayStr);
    assert.equal(url.searchParams.get("endDate"), yesterdayStr);
  });
});
