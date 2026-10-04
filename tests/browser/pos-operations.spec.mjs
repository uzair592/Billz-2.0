/**
 * Browser tests for the Milestone 11 POS operations UI.
 *
 * The static test server serves the legacy POS page; the
 * cloud API is intercepted with route mocks so the tests
 * exercise the real client wiring (bootstrap, wrappers,
 * mappers and renderers) without a live server.
 *
 * IndexedDB is seeded after load with the cloud session
 * and the imported-catalog context, exactly the state a
 * real device reaches after sign-in + catalog import.
 */

import { test, expect } from "@playwright/test";

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORDER_ID = "55555555-5555-4555-8555-555555555555";

const cloudContext = {
  version: 1,
  restaurantId: RESTAURANT_ID,
  importedAt: "2026-10-01T00:00:00.000Z",
  mappings: {
    menuItems: { "1": "33333333-3333-4333-8333-333333333333" },
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

function cloudOrderDetail(order = cloudOrder()) {
  return {
    order,
    items: [
      {
        menuItemId: "33333333-3333-4333-8333-333333333333",
        name: "Chicken Burger",
        quantity: 2,
        unitPriceMinor: 50000,
        unitCostMinor: 20000,
        recipe: { offer: null },
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

const billingOverview = {
  plans: [
    {
      id: "plan-1",
      code: "starter",
      name: "Starter",
      description: "For small counters",
      features: { orders: true, reports: true },
      prices: [
        {
          id: "price-1",
          currencyCode: "PKR",
          amountMinor: 299900,
          interval: "month",
        },
      ],
    },
  ],
  subscription: {
    status: "active",
    plan: { name: "Starter" },
    currentPeriodEnd: "2026-11-03T00:00:00.000Z",
    cancelAtPeriodEnd: false,
  },
  trialDays: 14,
  graceDays: 7,
};

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

test.beforeEach(async ({ page }) => {
  // Dialogs are accepted per-test so assertions can
  // inspect their messages without double-handling.
});

test("order history renders cloud orders with the server summary", async ({ page }) => {
  const listRequests = [];
  mockApi(page, (route, url) => {
    if (url.pathname === "/api/pos/orders") {
      listRequests.push(new URL(route.request().url()).searchParams);
      return route.fulfill({ json: cloudListResponse([cloudOrder()]) });
    }
    return route.fulfill({ json: {} });
  });

  await openPos(page);
  await configureCloud(page);
  await page.evaluate(() => {
    isSalesVisible = true;
  });
  await page.evaluate(() => window.renderOrdersHistory());

  await expect(page.locator("#history-orders-rows tr")).toHaveCount(1);
  await expect(page.locator("#history-orders-rows")).toContainText("#1001");
  await expect(page.locator("#history-orders-rows")).toContainText("Ali Khan");
  await expect(page.locator("#history-orders-rows")).toContainText("Dine-In");
  await expect(page.locator("#history-results-count-text")).toContainText(
    "1 order found",
  );
  await expect(page.locator("#filtered-sales-amount")).toContainText("Rs. 1,000");
  expect(listRequests[0].get("limit")).toBe("50");
  expect(listRequests[0].get("search")).toBeNull();
});

test("history sends search and filter values to the cloud API", async ({ page }) => {
  let lastParams = null;
  mockApi(page, (route, url) => {
    if (url.pathname === "/api/pos/orders") {
      lastParams = new URL(route.request().url()).searchParams;
      return route.fulfill({ json: cloudListResponse([]) });
    }
    return route.fulfill({ json: {} });
  });

  await openPos(page);
  await configureCloud(page);
  await page.evaluate(() => {
    switchScreen("view-orders");
  });
  await page.fill("#history-search", "Ali");
  await page.fill("#history-date-from", "2026-10-01");
  await page.fill("#history-date-to", "2026-10-03");
  await page.selectOption("#history-payment-filter", "Paid");
  await page.selectOption("#history-status-filter", "Completed");
  await page.evaluate(() => window.renderOrdersHistory());

  expect(lastParams.get("search")).toBe("Ali");
  expect(lastParams.get("from")).toBe("2026-10-01");
  expect(lastParams.get("to")).toBe("2026-10-03");
  expect(lastParams.get("paymentStatus")).toBe("paid");
  expect(lastParams.get("orderStatus")).toBe("completed");
});

test("history paginates with the server cursor", async ({ page }) => {
  let call = 0;
  mockApi(page, (route, url) => {
    if (url.pathname === "/api/pos/orders") {
      call += 1;
      const params = new URL(route.request().url()).searchParams;
      if (call === 2 && params.get("cursor") !== "cursor-1") {
        return route.fulfill({
          status: 500,
          json: { error: "second page must carry the cursor" },
        });
      }
      return route.fulfill({
        json:
          call === 1
            ? cloudListResponse(
                [cloudOrder({ orderNumber: 1001 })],
                { nextCursor: "cursor-1" },
              )
            : cloudListResponse(
                [
                  cloudOrder({
                    id: OTHER_ORDER_ID,
                    orderNumber: 1002,
                    customerName: "Sara Ahmed",
                  }),
                ],
                { nextCursor: null },
              ),
      });
    }
    return route.fulfill({ json: {} });
  });

  await openPos(page);
  await configureCloud(page);
  await page.evaluate(() => {
    switchScreen("view-orders");
  });
  await expect(page.locator("#history-orders-rows tr")).toHaveCount(1);
  await expect(page.locator("#history-load-more")).not.toHaveClass(/hidden/);

  await page.click("#history-load-more-btn");

  await expect(page.locator("#history-orders-rows tr")).toHaveCount(2);
  await expect(page.locator("#history-orders-rows")).toContainText("Sara Ahmed");
  await expect(page.locator("#history-load-more")).toHaveClass(/hidden/);
});

test("history falls back to the local ledger when the cloud is unreachable", async ({ page }) => {
  mockApi(page, (route) => route.abort());

  await openPos(page);
  await configureCloud(page);
  await page.evaluate(() => {
    orders.push({
      id: 7,
      date: "2026-10-03",
      time: "10:00:00",
      customerName: "Local Customer",
      orderType: "Takeaway",
      items: [],
      subtotal: 500,
      totalBill: 500,
      paymentStatus: "Paid",
      paymentMethod: "Cash",
      amountReceived: 500,
      orderStatus: "Completed",
      editHistory: [],
      additionalCharges: [],
    });
    window.renderOrdersHistory();
  });

  await expect(page.locator("#history-cloud-notice")).toContainText(
    "Cloud unavailable",
  );
  await expect(page.locator("#history-orders-rows")).toContainText(
    "Local Customer",
  );
  await expect(page.locator("#history-results-count-text")).toContainText(
    "1 order found",
  );
});

test("the Edited filter uses the local ledger with a notice", async ({ page }) => {
  let cloudCalls = 0;
  mockApi(page, (route, url) => {
    if (url.pathname === "/api/pos/orders") {
      cloudCalls += 1;
      return route.fulfill({ json: cloudListResponse([]) });
    }
    return route.fulfill({ json: {} });
  });

  await openPos(page);
  await configureCloud(page);
  await page.evaluate(() => {
    orders.push({
      id: 9,
      date: "2026-10-03",
      time: "11:00:00",
      customerName: "Edited Customer",
      orderType: "Takeaway",
      items: [],
      subtotal: 250,
      totalBill: 250,
      paymentStatus: "Paid",
      paymentMethod: "Cash",
      amountReceived: 250,
      orderStatus: "Completed",
      editHistory: [{ type: "item", date: "2026-10-03", time: "11:05:00", changes: [], note: "" }],
      additionalCharges: [],
    });
    document.getElementById("history-status-filter").value = "Edited";
    window.renderOrdersHistory();
  });

  expect(cloudCalls).toBe(0);
  await expect(page.locator("#history-cloud-notice")).toContainText(
    "edit-history filter",
  );
  await expect(page.locator("#history-orders-rows")).toContainText(
    "Edited Customer",
  );
});

test("invoice modal renders a cloud order from the detail API", async ({ page }) => {
  mockApi(page, (route, url) => {
    if (url.pathname === `/api/pos/orders/${ORDER_ID}`) {
      return route.fulfill({ json: cloudOrderDetail() });
    }
    return route.fulfill({ json: cloudListResponse([]) });
  });

  await openPos(page);
  await configureCloud(page);

  const ledgerSize = await page.evaluate(() => orders.length);
  await page.evaluate((orderId) => {
    window.showOrderInvoiceDetailsView(orderId);
  }, ORDER_ID);

  await expect(page.locator("#invoice-modal-overlay")).not.toHaveClass(/hidden/);
  await expect(page.locator("#invoice-modal-content")).toContainText("Ali Khan");
  await expect(page.locator("#invoice-modal-content")).toContainText(
    "Chicken Burger",
  );
  await expect(page.locator("#invoice-modal-content")).toContainText(
    "Rs. 1000",
  );

  const restoredSize = await page.evaluate(() => orders.length);
  expect(restoredSize).toBe(ledgerSize);
});

test("reprint fetches the cloud order and populates the receipt slip", async ({ page }) => {
  mockApi(page, (route, url) => {
    if (url.pathname === `/api/pos/orders/${ORDER_ID}`) {
      return route.fulfill({ json: cloudOrderDetail() });
    }
    return route.fulfill({ json: cloudListResponse([]) });
  });

  await openPos(page);
  await configureCloud(page);
  await page.evaluate((orderId) => {
    window.reprintOrderReceipt(orderId);
  }, ORDER_ID);

  await expect(page.locator("#print-receipt-slip")).toContainText("Ali Khan");
  await expect(page.locator("#print-receipt-slip")).toContainText(
    "Chicken Burger",
  );
});

test("local mutations are blocked for cloud orders", async ({ page }) => {
  const dialogs = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    dialog.accept();
  });
  let mutatingRequests = 0;
  mockApi(page, (route, url) => {
    if (route.request().method() !== "GET") {
      mutatingRequests += 1;
    }
    return route.fulfill({ json: {} });
  });

  await openPos(page);
  await configureCloud(page);

  await page.evaluate((orderId) => {
    window.deleteBill(orderId);
    window.enterEditOrderMode(orderId);
    window.setInvoiceOrderPaymentStatus(orderId, "Paid");
    window.updateOrderRemainingDue(orderId);
  }, ORDER_ID);

  expect(dialogs.length).toBe(4);
  expect(
    dialogs.every((message) => message.includes("cloud")),
  ).toBe(true);
  expect(mutatingRequests).toBe(0);
});

test("cancelling a cloud order posts the reason with an idempotency key", async ({ page }) => {
  const cancellations = [];
  const dialogs = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    dialog.accept();
  });
  mockApi(page, (route, url) => {
    if (url.pathname === `/api/pos/orders/${ORDER_ID}/cancel`) {
      cancellations.push({
        method: route.request().method(),
        body: route.request().postDataJSON(),
      });
      return route.fulfill({
        json: {
          replayed: false,
          orderId: ORDER_ID,
          orderStatus: "cancelled",
          paymentStatus: "refunded",
          restocked: [],
          refundedMinor: 100000,
        },
      });
    }
    if (url.pathname === `/api/pos/orders/${ORDER_ID}`) {
      return route.fulfill({ json: cloudOrderDetail() });
    }
    return route.fulfill({ json: cloudListResponse([]) });
  });

  await openPos(page);
  await configureCloud(page);
  await page.evaluate(() => window.renderOrdersHistory());
  await expect(page.locator("#history-orders-rows tr")).toHaveCount(1);

  // The evaluate callback returns the promise so the test
  // waits for the whole flow (dialog, POST, confirmation
  // alert) instead of racing it.
  const pending = page.evaluate(
    (orderId) => window.openCancelOrderModal(orderId),
    ORDER_ID,
  );

  await expect(page.locator("#cloud-cancel-dialog-overlay")).toBeVisible();
  await expect(page.locator("#cloud-cancel-dialog-overlay")).toContainText(
    "#1001",
  );
  await page.fill("#cloud-cancel-reason", "customer changed mind");

  const cancelRequestPromise = page.waitForRequest(
    (request) => request.method() === "POST"
      && request.url().includes(`/api/pos/orders/${ORDER_ID}/cancel`),
  );
  await page.click("#cloud-cancel-confirm");
  const cancelRequest = await cancelRequestPromise;
  await pending;

  const body = JSON.parse(cancelRequest.postData());
  expect(body.reason).toBe("customer changed mind");
  expect(body.idempotencyKey).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  expect(cancellations).toHaveLength(1);
  expect(cancellations[0].method).toBe("POST");
  expect(cancellations[0].body.reason).toBe("customer changed mind");
  await expect
    .poll(() => dialogs.some((message) => message.includes("cancelled")))
    .toBeTruthy();
});

test("cancellation reports an already-cancelled order without compensating twice", async ({ page }) => {
  const cancellations = [];
  const dialogs = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    dialog.accept();
  });
  mockApi(page, (route, url) => {
    if (url.pathname === `/api/pos/orders/${ORDER_ID}/cancel`) {
      cancellations.push(route.request().postDataJSON());
      return route.fulfill({
        status: 409,
        json: { error: "Order already cancelled", code: "ORDER_ALREADY_CANCELLED" },
      });
    }
    if (url.pathname === `/api/pos/orders/${ORDER_ID}`) {
      return route.fulfill({
        json: cloudOrderDetail(
          cloudOrder({ orderStatus: "completed" }),
        ),
      });
    }
    return route.fulfill({ json: cloudListResponse([]) });
  });

  await openPos(page);
  await configureCloud(page);

  const pending = page.evaluate(
    (orderId) => window.openCancelOrderModal(orderId),
    ORDER_ID,
  );
  await expect(page.locator("#cloud-cancel-dialog-overlay")).toBeVisible();
  await page.fill("#cloud-cancel-reason", "wrong order");

  const cancelRequestPromise = page.waitForRequest(
    (request) => request.method() === "POST"
      && request.url().includes(`/api/pos/orders/${ORDER_ID}/cancel`),
  );
  await page.click("#cloud-cancel-confirm");
  await cancelRequestPromise;
  await pending;

  expect(cancellations).toHaveLength(1);
  await expect
    .poll(() =>
      dialogs.some((message) => message.includes("already cancelled")),
    )
    .toBeTruthy();
});

test("billing screen renders plans, subscription and payment history", async ({ page }) => {
  mockApi(page, (route, url) => {
    if (url.pathname === "/api/billing") {
      return route.fulfill({ json: billingOverview });
    }
    if (url.pathname === "/api/billing/payments") {
      return route.fulfill({
        json: [
          {
            paidAt: "2026-10-01T00:00:00.000Z",
            provider: "stripe",
            amountMinor: 299900,
            currencyCode: "PKR",
            status: "succeeded",
          },
        ],
      });
    }
    return route.fulfill({ json: {} });
  });

  await openPos(page);
  await page.evaluate(() => switchScreen("billing"));

  await expect(page.locator("#screen-billing")).not.toHaveClass(/hidden/);
  await expect(page.locator("#billing-current-subscription")).toContainText(
    "Starter",
  );
  await expect(page.locator("#billing-current-subscription")).toContainText(
    "Active",
  );
  await expect(page.locator("#billing-plans")).toContainText("Starter");
  await expect(page.locator("#billing-plans")).toContainText("Rs. 2,999");
  await expect(page.locator("#billing-plans")).toContainText("Subscribe / Pay");
  await expect(page.locator("#billing-payments")).toContainText("stripe");
});

test("billing screen renders without a subscription", async ({ page }) => {
  mockApi(page, (route, url) => {
    if (url.pathname === "/api/billing") {
      return route.fulfill({
        json: { ...billingOverview, subscription: null },
      });
    }
    if (url.pathname === "/api/billing/payments") {
      return route.fulfill({ json: [] });
    }
    return route.fulfill({ json: {} });
  });

  await openPos(page);
  await page.evaluate(() => switchScreen("billing"));

  await expect(page.locator("#billing-current-subscription")).toContainText(
    "No active subscription",
  );
  await expect(page.locator("#billing-payments")).toContainText(
    "No payments recorded yet",
  );
});

test("cloud status indicator reflects the outbox state", async ({ page }) => {
  mockApi(page, (route, url) => {
    if (url.pathname === "/api/pos/orders"
      && route.request().method() === "POST") {
      // The outbox transport: a retryable failure keeps
      // queued records queued (retrying still counts as
      // pending) instead of consuming them.
      return route.fulfill({
        status: 500,
        json: { error: "Internal server error." },
      });
    }
    return route.fulfill({ json: {} });
  });

  await openPos(page);
  await expect(page.locator(".status-badge")).toContainText(
    "Offline & ready",
  );

  await configureCloud(page);
  await seedStorage(page, {
    pos_cloud_order_outbox_v1: [
      {
        localOrderId: 1,
        restaurantId: RESTAURANT_ID,
        status: "pending",
        payload: {},
      },
      {
        localOrderId: 2,
        restaurantId: RESTAURANT_ID,
        status: "retrying",
        payload: {},
      },
    ],
  });
  await page.evaluate(() => {
    globalThis.dispatchEvent(new Event("online"));
  });

  await expect(page.locator(".status-badge")).toContainText(
    "Cloud syncing (2 pending)",
  );
});

test("cloud status indicator reports failed syncs", async ({ page }) => {
  mockApi(page, (route) => route.fulfill({ json: {} }));

  await openPos(page);
  await configureCloud(page);
  await seedStorage(page, {
    pos_cloud_order_outbox_v1: [
      {
        localOrderId: 1,
        restaurantId: RESTAURANT_ID,
        status: "failed",
        payload: {},
      },
    ],
  });
  await page.evaluate(() => {
    globalThis.dispatchEvent(new Event("online"));
  });

  await expect(page.locator(".status-badge")).toContainText(
    "Cloud sync failed (1)",
  );
});

test("cloud status indicator reports subscription problems", async ({ page }) => {
  mockApi(page, (route, url) => {
    if (url.pathname === "/api/billing") {
      return route.fulfill({
        json: {
          ...billingOverview,
          subscription: { ...billingOverview.subscription, status: "past_due" },
        },
      });
    }
    return route.fulfill({ json: {} });
  });

  await openPos(page);
  await configureCloud(page);
  await page.evaluate(() => {
    globalThis.dispatchEvent(new Event("online"));
  });

  await expect(page.locator(".status-badge")).toContainText(
    "Subscription problem",
  );
});
