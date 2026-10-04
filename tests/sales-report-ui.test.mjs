import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSalesReportUI } from "../src/client/sales-report-ui.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const TEST_TIMEZONE = "Asia/Karachi";

/** Formats an instant as YYYY-MM-DD in the test timezone, matching the
 *  UI's timezone-aware business-date calculation. */
function formatInTimezone(instant, timeZone = TEST_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function todayStr() {
  return formatInTimezone(new Date());
}

function yesterdayStr() {
  return formatInTimezone(new Date(Date.now() - 24 * 60 * 60 * 1000));
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
  const orderTypeSelect = makeElement();
  const paymentMethodSelect = makeElement();
  const prevPageBtn = makeElement();
  const nextPageBtn = makeElement();
  const paginationInfo = makeElement();
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
      "#report-ordertype-filter": orderTypeSelect,
      "#report-paymentmethod-filter": paymentMethodSelect,
      "#report-prev-page": prevPageBtn,
      "#report-next-page": nextPageBtn,
      "#report-pagination-info": paginationInfo,
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
    orderTypeSelect,
    paymentMethodSelect,
    prevPageBtn,
    nextPageBtn,
    paginationInfo,
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
    assert.equal(url.searchParams.get("startDate"), yesterdayStr());
    assert.equal(url.searchParams.get("endDate"), yesterdayStr());
  });

  it("sends the orderType and paymentMethod filters to the server", async () => {
    const { requests, containerEl, orderTypeSelect, paymentMethodSelect, applyBtn, restore } = setup();
    try {
      const ui = createSalesReportUI({ containerEl });
      await ui.mount();
      orderTypeSelect.value = "dine_in";
      paymentMethodSelect.value = "cash";
      applyBtn.dispatch("click");
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      restore();
    }

    const last = requests[requests.length - 1];
    const url = new URL(last.url, "http://localhost");
    assert.equal(url.searchParams.get("orderType"), "dine_in");
    assert.equal(url.searchParams.get("paymentMethod"), "cash");
  });

  it("resets to page 1 when a filter changes", async () => {
    const { requests, containerEl, paymentMethodSelect, applyBtn, restore } = setup({
      report: reportPayload({
        detailedRows: {
          rows: [],
          pagination: { page: 3, limit: 50, totalRows: 150, totalPages: 3 },
        },
      }),
    });
    try {
      const ui = createSalesReportUI({ containerEl });
      await ui.mount();
      // Move to a later page, then change a filter.
      await ui.setFilters({ page: 3 });
      paymentMethodSelect.value = "cash";
      applyBtn.dispatch("click");
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      restore();
    }

    const last = requests[requests.length - 1];
    const url = new URL(last.url, "http://localhost");
    assert.equal(url.searchParams.get("page"), "1", "filter change must reset to page 1");
  });

  it("navigates to the next page and requests it from the server", async () => {
    const { requests, containerEl, nextPageBtn, restore } = setup({
      report: reportPayload({
        detailedRows: {
          rows: [],
          pagination: { page: 1, limit: 50, totalRows: 120, totalPages: 3 },
        },
      }),
    });
    try {
      const ui = createSalesReportUI({ containerEl });
      await ui.mount();
      nextPageBtn.dispatch("click");
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      restore();
    }

    const last = requests[requests.length - 1];
    const url = new URL(last.url, "http://localhost");
    assert.equal(url.searchParams.get("page"), "2", "Next must request page 2");
  });

  it("renders pagination info and disables Previous on the first page", async () => {
    const { containerEl, contentArea, prevPageBtn, restore } = setup({
      report: reportPayload({
        detailedRows: {
          rows: [],
          pagination: { page: 1, limit: 50, totalRows: 120, totalPages: 3 },
        },
      }),
    });
    try {
      const ui = createSalesReportUI({ containerEl });
      await ui.mount();
    } finally {
      restore();
    }

    assert.match(contentArea.innerHTML, /Page 1 of 3 · 120 rows/);
    // The Previous button is rendered with the disabled attribute on page 1.
    assert.match(
      contentArea.innerHTML,
      /id="report-prev-page"[^>]*disabled/,
      "Previous must be disabled on page 1",
    );
  });

  it("suppresses a stale response so it cannot overwrite a newer filter result", async () => {
    // The first request is slow; the second (newer) resolves first.
    // Only the newer response may be rendered.
    let resolveFirst;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = () => resolve(jsonResponse(reportPayload({
        metrics: {
          grossSalesMinor: 111_000,
          discountsMinor: 0,
          refundTotalMinor: 0,
          refundedOrderCount: 0,
          netSalesMinor: 111_000,
          completedOrderCount: 1,
          averageOrderValueMinor: 111_000,
        },
        detailedRows: { rows: [], pagination: { page: 1, limit: 50, totalRows: 1, totalPages: 1 } },
      })));
    });

    const requests = [];
    const previous = {
      fetch: globalThis.fetch,
      session: globalThis.BiteTechCloudSession,
      window: globalThis.window,
      location: globalThis.location,
    };
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      if (requests.length === 1) return firstPromise;
      return jsonResponse(reportPayload({
        metrics: {
          grossSalesMinor: 222_000,
          discountsMinor: 0,
          refundTotalMinor: 0,
          refundedOrderCount: 0,
          netSalesMinor: 222_000,
          completedOrderCount: 2,
          averageOrderValueMinor: 222_000,
        },
        detailedRows: { rows: [], pagination: { page: 1, limit: 50, totalRows: 2, totalPages: 1 } },
      }));
    };
    globalThis.BiteTechCloudSession = { activeRestaurant: async () => restaurantId };
    globalThis.window = globalThis;
    globalThis.location = { href: "" };

    const containerEl = makeElement();
    const contentArea = makeElement();
    containerEl.querySelector = (selector) =>
      selector === "#report-content-area" ? contentArea : null;
    containerEl.querySelectorAll = () => [];

    try {
      const ui = createSalesReportUI({ containerEl });
      const firstLoad = ui.mount();
      // Start a second (newer) request before the first resolves.
      const secondLoad = ui.setFilters({ paymentMethod: "cash" });
      // Let the newer response render first.
      await secondLoad;
      // Now resolve the stale first request.
      resolveFirst();
      await firstLoad;
    } finally {
      globalThis.fetch = previous.fetch;
      globalThis.BiteTechCloudSession = previous.session;
      globalThis.window = previous.window;
      globalThis.location = previous.location;
    }

    // The rendered content must reflect the newer (222_000) response,
    // not the stale (111_000) one.
    assert.ok(
      contentArea.innerHTML.includes("PKR 2,220.00"),
      "newer response must be rendered",
    );
    assert.ok(
      !contentArea.innerHTML.includes("PKR 1,110.00"),
      "stale response must not overwrite the newer result",
    );
  });

  it("renders an empty state when no orders match the filters", async () => {
    const { containerEl, contentArea, restore } = setup({
      report: reportPayload({
        detailedRows: { rows: [], pagination: { page: 1, limit: 50, totalRows: 0, totalPages: 0 } },
      }),
    });
    try {
      const ui = createSalesReportUI({ containerEl });
      await ui.mount();
    } finally {
      restore();
    }

    assert.match(contentArea.innerHTML, /No orders match the selected filters/);
  });
});
