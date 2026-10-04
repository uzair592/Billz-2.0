/**
 * Browser tests for the Milestone 12 refund and sales-report UI.
 *
 * The static test server serves the legacy POS page; the cloud API
 * is intercepted with route mocks so the tests exercise the real
 * client wiring (bootstrap, refund modal, report dashboard) without
 * a live server. IndexedDB is seeded with the cloud session and the
 * imported-catalog context, exactly the state a real device reaches
 * after sign-in + catalog import.
 */

import { test, expect } from "@playwright/test";

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ITEM_ID = "77777777-7777-4777-8777-777777777777";
const MENU_ITEM_ID = "33333333-3333-4333-8333-333333333333";

const cloudContext = {
  version: 1,
  restaurantId: RESTAURANT_ID,
  importedAt: "2026-10-01T00:00:00.000Z",
  mappings: {
    menuItems: { "1": MENU_ITEM_ID },
    tables: { T1: "44444444-4444-4444-8444-444444444444" },
    financialAccounts: {},
  },
};

const cloudSession = {
  user: { id: "user-1", email: "till@bite-tech.example" },
  restaurantId: RESTAURANT_ID,
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function cloudOrder(overrides = {}) {
  return {
    id: ORDER_ID,
    orderNumber: 1001,
    businessDate: "2026-10-03",
    orderedAt: "2026-10-03T12:30:00.000Z",
    customerName: "Ali Khan",
    customerPhone: "03001234567",
    orderType: "dine_in",
    tableNumber: "T1",
    subtotalMinor: 100000,
    discountMinor: 0,
    discountType: "flat",
    discountValue: 0,
    deliveryMinor: 0,
    totalMinor: 100000,
    costOfGoodsMinor: 40000,
    paymentStatus: "paid",
    orderStatus: "completed",
    legacyOrderId: 42,
    ...overrides,
  };
}

/** The detail API shape: order_items rows carry their own UUID `id`,
 *  the frozen `name` snapshot and minor-unit money fields. */
function cloudOrderDetail(order = cloudOrder()) {
  return {
    order,
    items: [
      {
        id: ORDER_ITEM_ID,
        menuItemId: MENU_ITEM_ID,
        name: "Chicken Burger",
        quantity: 2,
        unitPriceMinor: 50000,
        lineTotalMinor: 100000,
        unitCostMinor: 20000,
        recipe: {},
      },
    ],
    charges: [],
    payments: [
      {
        method: "cash",
        status: "captured",
        amountMinor: 100000,
        financialAccountId: null,
        accountName: "Cash",
      },
    ],
    events: [
      {
        type: "created",
        changes: [],
        note: "Order placed",
        createdAt: "2026-10-03T12:30:00.000Z",
      },
    ],
    cancellation: null,
  };
}

function cloudListResponse(orders, { nextCursor = null } = {}) {
  return {
    orders,
    summary: {
      orderCount: orders.length,
      cancelledCount: orders.filter(
        (order) => order.orderStatus === "cancelled",
      ).length,
      salesMinor: orders.reduce((sum, order) => sum + order.totalMinor, 0),
      costOfGoodsMinor: 0,
      paidMinor: orders.reduce((sum, order) => sum + order.totalMinor, 0),
      dueMinor: 0,
    },
    nextCursor,
  };
}

function refundSuccess(overrides = {}) {
  return {
    replayed: false,
    refund: {
      refundNumber: "REF-101-1",
      totalRefundedMinor: 50000,
      status: "completed",
    },
    order: {
      id: ORDER_ID,
      paymentStatus: "partially_refunded",
      remainingRefundableMinor: 50000,
    },
    ...overrides,
  };
}

function salesReportPayload(overrides = {}) {
  return {
    restaurant: { id: RESTAURANT_ID, name: "Test Restaurant", currencyCode: "PKR" },
    filters: { startDate: "2026-10-03", endDate: "2026-10-03" },
    metrics: {
      grossSalesMinor: 300000,
      discountsMinor: 10000,
      refundTotalMinor: 20000,
      refundedOrderCount: 1,
      netSalesMinor: 270000,
      completedOrderCount: 3,
      averageOrderValueMinor: 90000,
    },
    paymentBreakdown: [
      { paymentMethod: "cash", capturedMinor: 200000, refundedMinor: 0, netMinor: 200000 },
    ],
    orderTypeBreakdown: [
      { orderType: "dine_in", count: 2, totalMinor: 180000 },
    ],
    trends: [
      {
        date: "2026-10-03",
        orderCount: 3,
        grossSalesMinor: 300000,
        discountMinor: 10000,
        refundTotalMinor: 20000,
        netSalesMinor: 270000,
      },
    ],
    detailedRows: {
      rows: [
        {
          orderNumber: 1001,
          businessDate: "2026-10-03",
          orderType: "dine_in",
          orderStatus: "completed",
          paymentStatus: "paid",
          totalMinor: 100000,
          refundedMinor: 0,
          netMinor: 100000,
        },
        {
          orderNumber: 1002,
          businessDate: "2026-10-03",
          orderType: "takeaway",
          orderStatus: "completed",
          paymentStatus: "paid",
          totalMinor: 200000,
          refundedMinor: 20000,
          netMinor: 180000,
        },
      ],
      pagination: { page: 1, limit: 50, totalRows: 2, totalPages: 1 },
    },
    ...overrides,
  };
}

async function seedStorage(page, entries) {
  await page.evaluate(async (payload) => {
    const open = indexedDB.open("BiteTechPOS_DB", 1);
    const db = await new Promise((resolve, reject) => {
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains("posData")) {
          open.result.createObjectStore("posData");
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("posData", "readwrite");
      const store = transaction.objectStore("posData");
      for (const [key, value] of Object.entries(payload)) {
        store.put(value, key);
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  }, entries);
}

async function configureCloud(page) {
  await seedStorage(page, {
    pos_cloud_session_v1: cloudSession,
    pos_cloud_context_v1: cloudContext,
  });
}

/** Opens the POS already unlocked (the boot sequence
 *  checks this session flag and skips the PIN screen). */
async function openPos(page) {
  await page.addInitScript(() => {
    sessionStorage.setItem("biteTechUnlocked", "true");
  });
  await page.goto("/");
}

/** Single dispatch route — avoids route-ordering ambiguity. */
function mockApi(page, handler) {
  return page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    return handler(route, url);
  });
}

/** Records every dialog and accepts it so assertions can
 *  inspect the messages without blocking the page. A dialog
 *  that arrives after the test has finished (for example the
 *  success alert once the final assertion has passed) must
 *  not fail the test, so a late accept is swallowed. */
function recordDialogs(page) {
  const dialogs = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    dialog.accept().catch(() => {});
  });
  return dialogs;
}

/** Reads the cloud-sync outbox straight from IndexedDB. */
function readOutbox(page) {
  return page.evaluate(async () => {
    const open = indexedDB.open("BiteTechPOS_DB", 1);
    const db = await new Promise((resolve, reject) => {
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains("posData")) {
          open.result.createObjectStore("posData");
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("posData", "readonly");
      const request = transaction
        .objectStore("posData")
        .get("pos_cloud_order_outbox_v1");
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
  });
}

test.beforeEach(async ({ page }) => {
  // Dialogs are accepted per-test so assertions can
  // inspect their messages without double-handling.
});

test("the invoice shows a refund action for an eligible cloud order", async ({ page }) => {
  mockApi(page, (route, url) => {
    if (url.pathname === `/api/pos/orders/${ORDER_ID}`) {
      return route.fulfill({ json: cloudOrderDetail() });
    }
    return route.fulfill({ json: cloudListResponse([]) });
  });

  await openPos(page);
  await configureCloud(page);
  await page.evaluate((orderId) => {
    window.showOrderInvoiceDetailsView(orderId);
  }, ORDER_ID);

  await expect(page.locator("#invoice-modal-overlay")).not.toHaveClass(/hidden/);
  const refundButton = page.locator("#invoice-modal-content [data-cloud-refund-btn]");
  await expect(refundButton).toBeVisible();
  await expect(refundButton).toContainText("Refund");
});

test("the invoice hides the refund action for an unpaid cloud order", async ({ page }) => {
  mockApi(page, (route, url) => {
    if (url.pathname === `/api/pos/orders/${ORDER_ID}`) {
      return route.fulfill({
        json: cloudOrderDetail(cloudOrder({ paymentStatus: "unpaid" })),
      });
    }
    return route.fulfill({ json: cloudListResponse([]) });
  });

  await openPos(page);
  await configureCloud(page);
  await page.evaluate((orderId) => {
    window.showOrderInvoiceDetailsView(orderId);
  }, ORDER_ID);

  await expect(page.locator("#invoice-modal-overlay")).not.toHaveClass(/hidden/);
  await expect(page.locator("#invoice-modal-content [data-cloud-refund-btn]")).toHaveCount(0);
});

test("a partial item refund posts the quantity, reason and restock flag", async ({ page }) => {
  const refundPosts = [];
  const dialogs = recordDialogs(page);
  mockApi(page, (route, url) => {
    if (url.pathname === `/api/pos/orders/${ORDER_ID}`) {
      return route.fulfill({ json: cloudOrderDetail() });
    }
    if (url.pathname === `/api/pos/orders/${ORDER_ID}/refunds`) {
      if (route.request().method() === "POST") {
        refundPosts.push({
          headers: route.request().headers(),
          body: route.request().postDataJSON(),
        });
        return route.fulfill({ json: refundSuccess() });
      }
      return route.fulfill({ json: [] });
    }
    return route.fulfill({ json: cloudListResponse([]) });
  });

  await openPos(page);
  await configureCloud(page);

  const pending = page.evaluate(
    (orderId) => window.openRefundModal(orderId),
    ORDER_ID,
  );
  await expect(page.locator("#cloud-refund-modal-overlay")).toBeVisible();
  await expect(page.locator("#cloud-refund-modal-overlay")).toContainText(
    "Chicken Burger",
  );
  await pending;

  // Refund one of the two sold burgers.
  await page.fill(".refund-qty-input >> nth=0", "1");
  await expect(page.locator("#refund-preview-amount")).toContainText("PKR 500.00");
  await page.fill("#refund-reason-input", "customer returned one burger");
  await expect(page.locator("#refund-submit-btn")).toBeEnabled();

  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && response.url().includes(`/api/pos/orders/${ORDER_ID}/refunds`),
  );
  await page.click("#refund-submit-btn");
  const response = await responsePromise;
  const request = response.request();
  await pending;

  expect(request.headers()["idempotency-key"]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  expect(refundPosts).toHaveLength(1);
  expect(refundPosts[0].body.items).toEqual([
    { orderItemId: ORDER_ITEM_ID, quantity: 1, restock: true },
  ]);
  expect(refundPosts[0].body.reason).toBe("customer returned one burger");
  expect(refundPosts[0].body.idempotencyKey).toBe(
    request.headers()["idempotency-key"],
  );
  await expect
    .poll(() => dialogs.some((message) => message.includes("REF-101-1")))
    .toBeTruthy();
  await expect
    .poll(() => dialogs.some((message) => message.includes("completed successfully")))
    .toBeTruthy();
});

test("a refund reason is mandatory", async ({ page }) => {
  const refundPosts = [];
  mockApi(page, (route, url) => {
    if (url.pathname === `/api/pos/orders/${ORDER_ID}`) {
      return route.fulfill({ json: cloudOrderDetail() });
    }
    if (url.pathname === `/api/pos/orders/${ORDER_ID}/refunds`) {
      if (route.request().method() === "POST") {
        refundPosts.push(route.request().postDataJSON());
      }
      return route.fulfill({ json: [] });
    }
    return route.fulfill({ json: cloudListResponse([]) });
  });

  await openPos(page);
  await configureCloud(page);

  const pending = page.evaluate(
    (orderId) => window.openRefundModal(orderId),
    ORDER_ID,
  );
  await expect(page.locator("#cloud-refund-modal-overlay")).toBeVisible();
  await pending;

  await page.fill(".refund-qty-input >> nth=0", "1");
  // Reason deliberately left empty: the UI keeps the
  // submit button disabled until a reason is entered.
  await expect(page.locator("#refund-submit-btn")).toBeDisabled();

  // Defense-in-depth: even if the button were enabled,
  // the handler itself refuses a missing reason.
  await page.evaluate(() => {
    const button = document.getElementById("refund-submit-btn");
    button.disabled = false;
    button.click();
  });

  await expect(page.locator("#refund-error-msg")).toBeVisible();
  await expect(page.locator("#refund-error-msg")).toContainText(
    "A refund reason is required.",
  );
  expect(refundPosts).toHaveLength(0);
});

test("restock can be switched off before submitting", async ({ page }) => {
  const refundPosts = [];
  recordDialogs(page);
  mockApi(page, (route, url) => {
    if (url.pathname === `/api/pos/orders/${ORDER_ID}`) {
      return route.fulfill({ json: cloudOrderDetail() });
    }
    if (url.pathname === `/api/pos/orders/${ORDER_ID}/refunds`) {
      if (route.request().method() === "POST") {
        refundPosts.push(route.request().postDataJSON());
        return route.fulfill({ json: refundSuccess() });
      }
      return route.fulfill({ json: [] });
    }
    return route.fulfill({ json: cloudListResponse([]) });
  });

  await openPos(page);
  await configureCloud(page);

  const pending = page.evaluate(
    (orderId) => window.openRefundModal(orderId),
    ORDER_ID,
  );
  await expect(page.locator("#cloud-refund-modal-overlay")).toBeVisible();
  await pending;

  await page.fill(".refund-qty-input >> nth=0", "1");
  await page.fill("#refund-reason-input", "no restock needed");
  await page.uncheck(".refund-restock-checkbox >> nth=0");

  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && response.url().includes(`/api/pos/orders/${ORDER_ID}/refunds`),
  );
  await page.click("#refund-submit-btn");
  await responsePromise;
  await pending;

  expect(refundPosts).toHaveLength(1);
  expect(refundPosts[0].items[0].restock).toBe(false);
});

test("a second submit while one is in flight is ignored", async ({ page }) => {
  const refundPosts = [];
  const dialogs = recordDialogs(page);
  mockApi(page, (route, url) => {
    if (url.pathname === `/api/pos/orders/${ORDER_ID}`) {
      return route.fulfill({ json: cloudOrderDetail() });
    }
    if (url.pathname === `/api/pos/orders/${ORDER_ID}/refunds`) {
      if (route.request().method() === "POST") {
        refundPosts.push(route.request().postDataJSON());
        // A slow server response keeps the in-flight window open
        // long enough to prove the second click is a no-op.
        return new Promise((resolve) => {
          setTimeout(() => resolve(route.fulfill({ json: refundSuccess() })), 400);
        });
      }
      return route.fulfill({ json: [] });
    }
    return route.fulfill({ json: cloudListResponse([]) });
  });

  await openPos(page);
  await configureCloud(page);

  const pending = page.evaluate(
    (orderId) => window.openRefundModal(orderId),
    ORDER_ID,
  );
  await expect(page.locator("#cloud-refund-modal-overlay")).toBeVisible();
  await pending;

  await page.fill(".refund-qty-input >> nth=0", "1");
  await page.fill("#refund-reason-input", "double click guard");
  await expect(page.locator("#refund-submit-btn")).toBeEnabled();

  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && response.url().includes(`/api/pos/orders/${ORDER_ID}/refunds`),
  );
  // Two synchronous clicks: the second must be dropped because the
  // first attempt is still in flight.
  await page.evaluate(() => {
    const button = document.getElementById("refund-submit-btn");
    button.click();
    button.click();
  });
  await responsePromise;
  await pending;

  expect(refundPosts).toHaveLength(1);
  // The single in-flight attempt completes and reports success.
  await expect
    .poll(() => dialogs.some((message) => message.includes("REF-101-1")))
    .toBeTruthy();
});

test("a replayed refund reports the replay instead of a new refund", async ({ page }) => {
  const dialogs = recordDialogs(page);
  mockApi(page, (route, url) => {
    if (url.pathname === `/api/pos/orders/${ORDER_ID}`) {
      return route.fulfill({ json: cloudOrderDetail() });
    }
    if (url.pathname === `/api/pos/orders/${ORDER_ID}/refunds`) {
      if (route.request().method() === "POST") {
        return route.fulfill({
          json: refundSuccess({ replayed: true }),
        });
      }
      return route.fulfill({ json: [] });
    }
    return route.fulfill({ json: cloudListResponse([]) });
  });

  await openPos(page);
  await configureCloud(page);

  const pending = page.evaluate(
    (orderId) => window.openRefundModal(orderId),
    ORDER_ID,
  );
  await expect(page.locator("#cloud-refund-modal-overlay")).toBeVisible();
  await pending;

  await page.fill(".refund-qty-input >> nth=0", "1");
  await page.fill("#refund-reason-input", "replay scenario");
  await page.click("#refund-submit-btn");
  await pending;

  await expect
    .poll(() => dialogs.some((message) => message.includes("replayed")))
    .toBeTruthy();
});

test("a 403 refusal is reported inline without closing the modal", async ({ page }) => {
  const dialogs = recordDialogs(page);
  mockApi(page, (route, url) => {
    if (url.pathname === `/api/pos/orders/${ORDER_ID}`) {
      return route.fulfill({ json: cloudOrderDetail() });
    }
    if (url.pathname === `/api/pos/orders/${ORDER_ID}/refunds`) {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 403,
          json: { error: "You do not have permission.", code: "FORBIDDEN" },
        });
      }
      return route.fulfill({ json: [] });
    }
    return route.fulfill({ json: cloudListResponse([]) });
  });

  await openPos(page);
  await configureCloud(page);

  const pending = page.evaluate(
    (orderId) => window.openRefundModal(orderId),
    ORDER_ID,
  );
  await expect(page.locator("#cloud-refund-modal-overlay")).toBeVisible();
  await pending;

  await page.fill(".refund-qty-input >> nth=0", "1");
  await page.fill("#refund-reason-input", "unauthorized scenario");
  await page.click("#refund-submit-btn");

  await expect(page.locator("#cloud-refund-modal-overlay")).toBeVisible();
  await expect(page.locator("#refund-error-msg")).toBeVisible();
  await expect(page.locator("#refund-error-msg")).toContainText("permission");
  // The button is re-armed so the operator can retry or fix the session.
  await expect(page.locator("#refund-submit-btn")).toBeEnabled();
  expect(dialogs).toHaveLength(0);
});

test("a 409 over-refund is reported inline and the retry reuses the idempotency key", async ({ page }) => {
  const refundPosts = [];
  recordDialogs(page);
  let call = 0;
  mockApi(page, (route, url) => {
    if (url.pathname === `/api/pos/orders/${ORDER_ID}`) {
      return route.fulfill({ json: cloudOrderDetail() });
    }
    if (url.pathname === `/api/pos/orders/${ORDER_ID}/refunds`) {
      if (route.request().method() === "POST") {
        call += 1;
        refundPosts.push({
          headers: route.request().headers(),
          body: route.request().postDataJSON(),
        });
        if (call === 1) {
          return route.fulfill({
            status: 409,
            json: {
              error: "Refund exceeds the remaining refundable balance.",
              code: "AMOUNT_EXCEEDS_REFUNDABLE",
            },
          });
        }
        return route.fulfill({ json: refundSuccess() });
      }
      return route.fulfill({ json: [] });
    }
    return route.fulfill({ json: cloudListResponse([]) });
  });

  await openPos(page);
  await configureCloud(page);

  const pending = page.evaluate(
    (orderId) => window.openRefundModal(orderId),
    ORDER_ID,
  );
  await expect(page.locator("#cloud-refund-modal-overlay")).toBeVisible();
  await pending;

  await page.fill(".refund-qty-input >> nth=0", "1");
  await page.fill("#refund-reason-input", "over-refund scenario");

  // First attempt is refused…
  const firstResponse = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && response.url().includes(`/api/pos/orders/${ORDER_ID}/refunds`),
  );
  await page.click("#refund-submit-btn");
  await firstResponse;
  await expect(page.locator("#refund-error-msg")).toContainText(
    "refundable balance",
  );

  // …and the retry must carry the same idempotency key so the
  // server can correlate the attempt instead of double-refunding.
  const retryResponse = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && response.url().includes(`/api/pos/orders/${ORDER_ID}/refunds`),
  );
  await page.click("#refund-submit-btn");
  await retryResponse;
  await pending;

  expect(refundPosts).toHaveLength(2);
  expect(refundPosts[1].headers["idempotency-key"]).toBe(
    refundPosts[0].headers["idempotency-key"],
  );
});

test("opening the refund modal offline refuses with a clear message", async ({ page }) => {
  const dialogs = recordDialogs(page);
  mockApi(page, (route) => route.abort());

  await openPos(page);
  await configureCloud(page);

  await page.evaluate(
    (orderId) => window.openRefundModal(orderId),
    ORDER_ID,
  );

  await expect
    .poll(() => dialogs.some((message) => message.includes("offline")))
    .toBeTruthy();
  await expect(page.locator("#cloud-refund-modal-overlay")).toHaveCount(0);
});

test("local checkout keeps working while the cloud is offline", async ({ page }) => {
  mockApi(page, (route) => route.abort());

  await openPos(page);
  await configureCloud(page);

  await page.evaluate(() => {
    menuItems.push({
      id: 1,
      itemNumber: 1,
      name: "Fries",
      price: 150,
      category: "Snacks",
    });
    cart.push({ id: 1, name: "Fries", price: 150, qty: 2 });
    currentOrderType = "Takeaway";
    currentPaymentStatus = "Paid";
    currentPaymentMethod = "Cash";
  });

  await page.evaluate(() => submitOrder(false));

  // The durable local commit happened: the order is in the ledger
  // and the save feedback is shown, with no network round-trip.
  const orderCount = await page.evaluate(() => orders.length);
  expect(orderCount).toBe(1);
  await expect(page.locator("#order-save-feedback")).toContainText(
    "Bill #1 saved",
  );

  // The cloud sync is queued for later instead of blocking checkout.
  await expect
    .poll(async () => {
      const outbox = await readOutbox(page);
      return outbox.filter((entry) => entry.localOrderId === 1).length;
    })
    .toBe(1);
});

test("the reports screen switches between local and cloud tabs", async ({ page }) => {
  let reportCalls = 0;
  mockApi(page, (route, url) => {
    if (url.pathname === "/api/pos/reports/sales") {
      reportCalls += 1;
      return route.fulfill({ json: salesReportPayload() });
    }
    return route.fulfill({ json: {} });
  });

  await openPos(page);
  await configureCloud(page);
  await page.evaluate(() => switchScreen("reports"));

  // Local view is the default; the cloud view is hidden.
  await expect(page.locator("#local-reports-view")).not.toHaveClass(/hidden/);
  await expect(page.locator("#cloud-sales-report-view")).toHaveClass(/hidden/);

  await page.click("#reports-tab-cloud");
  await expect(page.locator("#cloud-sales-report-view")).not.toHaveClass(/hidden/);
  await expect(page.locator("#local-reports-view")).toHaveClass(/hidden/);
  await expect(page.locator("#reports-tab-cloud")).toHaveClass(/active-switch/);
  await expect(page.locator("#reports-tab-local")).not.toHaveClass(/active-switch/);

  // Switching to the cloud tab loads the server report exactly once.
  await expect(page.locator("#cloud-sales-report-container")).toContainText(
    "Net Sales",
  );
  expect(reportCalls).toBe(1);

  await page.click("#reports-tab-local");
  await expect(page.locator("#local-reports-view")).not.toHaveClass(/hidden/);
  await expect(page.locator("#cloud-sales-report-view")).toHaveClass(/hidden/);
  // Going back to the cloud tab reloads the server figures.
  await page.click("#reports-tab-cloud");
  await expect(page.locator("#cloud-sales-report-container")).toContainText(
    "Net Sales",
  );
  expect(reportCalls).toBe(2);
});

test("the cloud report renders gross sales, refunds and net sales", async ({ page }) => {
  mockApi(page, (route, url) => {
    if (url.pathname === "/api/pos/reports/sales") {
      return route.fulfill({ json: salesReportPayload() });
    }
    return route.fulfill({ json: {} });
  });

  await openPos(page);
  await configureCloud(page);
  await page.evaluate(() => switchScreen("reports"));
  await page.click("#reports-tab-cloud");

  const container = page.locator("#cloud-sales-report-container");
  await expect(container).toContainText("Gross Sales");
  await expect(container).toContainText("PKR 3,000.00");
  await expect(container).toContainText("Total Refunds");
  await expect(container).toContainText("PKR 200.00");
  await expect(container).toContainText("Net Sales");
  await expect(container).toContainText("PKR 2,700.00");
  await expect(container).toContainText("Completed Orders");
  await expect(container).toContainText("Payment Method Breakdown");
  await expect(container).toContainText("cash");
  await expect(container).toContainText("Order Type Breakdown");
  await expect(container).toContainText("dine in");
  await expect(container).toContainText("Sales & Refund Trend");
  await expect(container).toContainText("2026-10-03");
});

test("custom date filters are sent to the report API", async ({ page }) => {
  const reportRequests = [];
  mockApi(page, (route, url) => {
    if (url.pathname === "/api/pos/reports/sales") {
      reportRequests.push(new URL(route.request().url()).searchParams);
      return route.fulfill({ json: salesReportPayload() });
    }
    return route.fulfill({ json: {} });
  });

  await openPos(page);
  await configureCloud(page);
  await page.evaluate(() => switchScreen("reports"));
  await page.click("#reports-tab-cloud");
  await expect(page.locator("#cloud-sales-report-container")).toContainText(
    "Net Sales",
  );

  await page.fill("#report-start-date", "2026-09-01");
  await page.fill("#report-end-date", "2026-09-30");
  await page.click("#report-apply-btn");

  await expect(page.locator("#cloud-sales-report-container")).toContainText(
    "Net Sales",
  );
  const last = reportRequests[reportRequests.length - 1];
  expect(last.get("startDate")).toBe("2026-09-01");
  expect(last.get("endDate")).toBe("2026-09-30");
});

test("detailed rows render for the requested page", async ({ page }) => {
  const reportRequests = [];
  mockApi(page, (route, url) => {
    if (url.pathname === "/api/pos/reports/sales") {
      reportRequests.push(new URL(route.request().url()).searchParams);
      return route.fulfill({ json: salesReportPayload() });
    }
    return route.fulfill({ json: {} });
  });

  await openPos(page);
  await configureCloud(page);
  await page.evaluate(() => switchScreen("reports"));
  await page.click("#reports-tab-cloud");

  const container = page.locator("#cloud-sales-report-container");
  await expect(container).toContainText("Detailed Sales Rows");
  await expect(container).toContainText("#1001");
  await expect(container).toContainText("#1002");
  await expect(container).toContainText("takeaway");

  const last = reportRequests[reportRequests.length - 1];
  expect(last.get("page")).toBe("1");
  expect(last.get("limit")).toBe("50");
  expect(last.get("groupBy")).toBe("day");
});

test("CSV export downloads the current filter range", async ({ page }) => {
  mockApi(page, (route, url) => {
    if (url.pathname === "/api/pos/reports/sales") {
      return route.fulfill({ json: salesReportPayload() });
    }
    if (url.pathname === "/api/pos/reports/sales/export") {
      return route.fulfill({
        headers: { "content-type": "text/csv; charset=utf-8" },
        body: '﻿Date Range,Net Sales\r\n2026-09-01 to 2026-09-30,PKR 2700.00\r\n',
      });
    }
    return route.fulfill({ json: {} });
  });

  await openPos(page);
  await configureCloud(page);
  await page.evaluate(() => switchScreen("reports"));
  await page.click("#reports-tab-cloud");
  await expect(page.locator("#cloud-sales-report-container")).toContainText(
    "Net Sales",
  );

  await page.fill("#report-start-date", "2026-09-01");
  await page.fill("#report-end-date", "2026-09-30");
  await page.click("#report-apply-btn");
  await expect(page.locator("#cloud-sales-report-container")).toContainText(
    "Net Sales",
  );

  const exportRequestPromise = page.waitForRequest(
    (request) => request.url().includes("/api/pos/reports/sales/export"),
  );
  await page.click("#sales-export-btn");
  const exportRequest = await exportRequestPromise;

  const url = new URL(exportRequest.url());
  expect(url.pathname).toBe("/api/pos/reports/sales/export");
  expect(url.searchParams.get("startDate")).toBe("2026-09-01");
  expect(url.searchParams.get("endDate")).toBe("2026-09-30");
});
