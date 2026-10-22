import { test, expect } from "@playwright/test";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const menuItemId = "33333333-3333-4333-8333-333333333333";
const lineId = "44444444-4444-4444-8444-444444444444";
const chickenStockId = "66666666-6666-4666-8666-666666666666";
const nuggetStockId = "77777777-7777-4777-8777-777777777777";

async function setupExtrasPage(page) {
  const state = {
    order: {
      id: orderId,
      orderNumber: 42,
      version: 1,
      orderType: "takeaway",
      orderStatus: "new",
      paymentStatus: "unpaid",
      customerName: "Zubair",
      businessDate: "2026-10-22",
      orderedAt: "2026-10-22T12:00:00Z",
      subtotalMinor: 50000,
      discountMinor: 0,
      discountType: "flat",
      discountValue: 0,
      deliveryMinor: 0,
      totalMinor: 50000,
      costOfGoodsMinor: 15000,
    },
    items: [
      {
        id: lineId,
        menuItemId,
        name: "Zinger Burger",
        quantity: 1,
        unitPriceMinor: 50000,
        unitCostMinor: 15000,
        recipe: {},
        extras: [
          {
            id: "extra-1",
            stockItemId: chickenStockId,
            name: "Chicken Breast",
            quantity: 50,
            unit: "g",
            quantityBaseUnits: 50,
            priceMinor: 0,
            costMinor: 5000,
          },
        ],
      },
    ],
    payments: [],
    charges: [],
    events: [],
    tickets: [
      {
        id: "ticket-1",
        ticketNumber: 42,
        orderId,
        orderNumber: 42,
        orderType: "takeaway",
        status: "new",
        items: [
          {
            menuItemId,
            name: "Zinger Burger",
            quantity: 1,
            extras: [
              {
                stockItemId: chickenStockId,
                name: "Chicken Breast",
                quantity: 50,
                unit: "g",
              },
            ],
          },
        ],
      },
    ],
  };

  const writes = [];

  function detail() {
    return {
      ...state,
      actions: {
        canPay: true,
        canEdit: true,
        canCancel: true,
      },
    };
  }

  await page.addInitScript(() => {
    sessionStorage.setItem("biteTechUnlocked", "true");
    window.BILLZ_MANAGED = true;
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === `/api/pos/orders/${orderId}` && method === "GET") {
      return route.fulfill({ json: detail() });
    }
    if (path === "/api/pos/orders" && method === "GET") {
      return route.fulfill({
        json: {
          orders: [state.order],
          summary: { orderCount: 1, salesMinor: state.order.totalMinor, paidMinor: 0, dueMinor: state.order.totalMinor },
          nextCursor: null,
        },
      });
    }
    if (path === "/api/pos/menu") {
      return route.fulfill({ json: { items: [{ id: menuItemId, name: "Zinger Burger", priceMinor: 50000 }] } });
    }
    if (path === "/api/pos/inventory/items") {
      return route.fulfill({
        json: {
          items: [
            { id: chickenStockId, name: "Chicken Breast", baseUnit: "gram", sellUnit: "kg" },
            { id: nuggetStockId, name: "Chicken Nuggets", baseUnit: "gram", sellUnit: "number" },
          ],
        },
      });
    }
    if (path === "/api/pos/kitchen/tickets" && method === "GET") {
      return route.fulfill({ json: { tickets: state.tickets } });
    }
    if (path === `/api/pos/orders/${orderId}` && method === "PATCH") {
      const payload = route.request().postDataJSON();
      writes.push({ path, payload });
      state.order.version++;
      if (payload.items) {
        state.items = payload.items.map((row, idx) => ({
          id: row.orderItemId || `item-${idx}`,
          menuItemId: row.menuItemId || menuItemId,
          name: "Zinger Burger",
          quantity: row.quantity,
          unitPriceMinor: 50000,
          extras: (row.extras || []).map((e) => ({
            stockItemId: e.stockItemId,
            name: e.stockItemId === chickenStockId ? "Chicken Breast" : "Chicken Nuggets",
            quantity: e.quantity,
            unit: e.unit || "g",
          })),
        }));
      }
      return route.fulfill({ json: { replayed: false, order: state.order } });
    }
    return route.fulfill({
      json: {
        plans: [],
        subscription: null,
        accounts: [],
        tickets: state.tickets,
        user: { id: "cashier" },
        restaurants: [{ id: restaurantId, restaurantId }],
      },
    });
  });

  await page.goto("/");
  await page.waitForFunction(() => window.BillzOrderActions && typeof bootFinished !== "undefined" && bootFinished);
  await page.evaluate(async ({ restaurantId, chickenStockId, nuggetStockId, menuItemId }) => {
    Storage.setMany({
      pos_setup_done: true,
      pos_pin_code: "8429",
      pos_business_name: "Burger Spot",
      pos_business_name_provided: true,
      pos_cloud_context_v1: {
        restaurantId,
        mappings: {
          menuItems: { 1: menuItemId },
          stockItems: { Chicken: chickenStockId, Nuggets: nuggetStockId },
          tables: {},
          financialAccounts: {},
        },
      },
      pos_cloud_session_v1: { user: { id: "cashier" }, restaurantId },
    });
  }, { restaurantId, chickenStockId, nuggetStockId, menuItemId });

  await page.reload();
  await expect(page.locator(".app-container")).toBeVisible();
  return { state, writes };
}

test("KDS displays extras with readable names and units, avoiding raw UUIDs", async ({ page }) => {
  await setupExtrasPage(page);
  await page.evaluate(() => switchScreen("kitchen"));

  // Verify KDS ticket card has the extra with name and unit
  const kdsBoard = page.locator("#kds-board");
  await expect(kdsBoard).toContainText("Ticket #42");
  await expect(kdsBoard).toContainText("Zinger Burger");
  await expect(kdsBoard).toContainText("Chicken Breast (50 g)");
  // Ensure no raw UUID is displayed
  await expect(kdsBoard).not.toContainText(chickenStockId);
});

test("Edit order dialog allows viewing, adding, and removing extras and submits correct payload", async ({ page }) => {
  const { writes } = await setupExtrasPage(page);
  await page.evaluate(() => switchScreen("view-orders"));

  await expect(page.locator("#history-orders-rows")).toContainText("Zubair");
  await page.locator("#history-orders-rows tr").first().click();

  await page.locator('[data-order-action="edit"]').click();
  const overlay = page.locator(".order-action-overlay");
  await expect(overlay).toBeVisible();

  // Verify existing extra is displayed with name and unit
  await expect(overlay).toContainText("Chicken Breast (50 g)");
  await expect(overlay).not.toContainText(chickenStockId);

  // Add a new extra: Chicken Nuggets (pcs)
  await overlay.locator("[data-extra-select='0']").selectOption(nuggetStockId);
  await overlay.locator("[data-extra-qty='0']").fill("3");
  await overlay.locator("[data-extra-add='0']").click();

  // Verify second extra badge appears
  await expect(overlay).toContainText("Chicken Nuggets (3 pcs)");

  // Submit edit
  await overlay.getByRole("button", { name: "Save Changes", exact: true }).click();
  await expect(overlay).toHaveCount(0);

  // Verify amendment payload
  expect(writes.length).toBe(1);
  const patchPayload = writes[0].payload;
  expect(patchPayload.items.length).toBe(1);
  expect(patchPayload.items[0].extras).toHaveLength(2);
  expect(patchPayload.items[0].extras).toContainEqual({
    stockItemId: chickenStockId,
    quantity: 50,
    unit: "g",
  });
  expect(patchPayload.items[0].extras).toContainEqual({
    stockItemId: nuggetStockId,
    quantity: 3,
    unit: "pcs",
  });
});
