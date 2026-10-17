import { test, expect } from "@playwright/test";

async function openPos(page) {
  await page.addInitScript(() => sessionStorage.setItem("biteTechUnlocked", "true"));
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/pos/reports/sales") return route.fulfill({ json: {
      restaurant: { timezone: "Asia/Karachi" }, filters: { startDate: "2026-10-17", endDate: "2026-10-17" },
      metrics: { grossSalesMinor: 10000, discountsMinor: 0, refundTotalMinor: 0, refundedOrderCount: 0, completedSalesMinor: 10000,
        netSalesMinor: 10000, completedOrderCount: 1, costOfGoodsMinor: 3000, grossProfitMinor: 7000, grossMarginPercent: 70, operatingExpensesMinor: 500, netProfitMinor: 6500 },
      paymentBreakdown: [], orderTypeBreakdown: [], trends: [], detailedRows: { rows: [], pagination: { page: 1, totalPages: 1, totalRows: 0 } },
    } });
    return route.fulfill({ json: { plans: [], subscription: null, tickets: [] } });
  });
  await page.goto("/");
  await page.waitForFunction(() => window.BiteTechSalesReport && typeof bootFinished !== "undefined" && bootFinished);
  await page.evaluate(async () => { await Storage.setMany({ pos_setup_done: true, pos_pin_code: "8429", pos_business_name: "Layout Cafe", pos_business_name_provided: true }); });
  await page.reload();
  await expect(page.locator(".app-container")).toBeVisible();
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
  test(`compact headers, history toolbar and three kitchen lanes at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPos(page);
    const header = page.locator("#screen-dashboard .workspace-header");
    expect((await header.boundingBox()).height).toBeLessThan(85);
    await page.evaluate(() => switchScreen("view-orders"));
    const search = page.locator("#history-toolbar #history-search");
    await expect(search).toBeVisible();
    const buttons = page.locator("#history-toolbar button");
    await expect(buttons).toHaveCount(3);
    if (viewport.width === 1366) {
      const searchBox = await search.boundingBox();
      expect(searchBox.width).toBeLessThanOrEqual(300);
      for (const button of await buttons.all()) expect(Math.abs((await button.boundingBox()).y - searchBox.y)).toBeLessThan(3);
    }
    await page.evaluate(() => switchScreen("kitchen"));
    const columns = page.locator("#kds-board > div");
    await expect(columns).toHaveCount(3);
    const boxes = await Promise.all((await columns.all()).map(column => column.boundingBox()));
    expect(new Set(boxes.map(box => Math.round(box.y))).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
  });
}

test("current bill divider supports dragging, keyboard adjustment and reset", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openPos(page);
  await page.evaluate(() => switchScreen("new-order"));
  const cart = page.locator("#screen-new-order .cart-box"), divider = page.getByRole("separator", { name: "Resize current bill" });
  const initial = (await cart.boundingBox()).width;
  const handle = await divider.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 50);
  await page.mouse.down(); await page.mouse.move(handle.x - 100, handle.y + 50, { steps: 8 }); await page.mouse.up();
  expect((await cart.boundingBox()).width).toBeGreaterThan(initial + 60);
  expect((await page.locator("#screen-new-order .menu-selection-box").boundingBox()).width).toBeGreaterThanOrEqual(260);
  await divider.focus(); await divider.press("ArrowRight");
  const savedWidth = (await cart.boundingBox()).width;
  await page.reload(); await expect(page.locator(".app-container")).toBeVisible();
  await page.evaluate(() => switchScreen("new-order"));
  await expect.poll(async () => Math.round((await cart.boundingBox()).width)).toBe(Math.round(savedWidth));
  await divider.focus(); await divider.press("Home");
  await expect.poll(async () => Math.round((await cart.boundingBox()).width)).toBe(Math.round(initial));
});

test("report tabs expose gross, net and bill profitability using shared filtered data", async ({ page }) => {
  await openPos(page);
  await page.evaluate(() => { switchScreen("reports"); window.showCloudSalesReport(); });
  await expect(page.locator("#cloud-sales-report-container")).toContainText("Net Sales");
  await page.getByRole("tab", { name: "Gross Profit", exact: true }).click();
  await expect(page.locator(".profit-statement")).toBeVisible();
  await expect(page.locator(".profit-statement")).toContainText("70.00");
  await page.getByRole("tab", { name: "Net Profit", exact: true }).click();
  await expect(page.locator(".profit-statement")).toContainText("65.00");
  await expect(page.locator(".profit-statement")).toContainText("deducted once");
  await expect(page.locator('[data-report-section="bills"]')).toBeHidden();
  await page.getByRole("tab", { name: "Bill Profit & Loss", exact: true }).click();
  await expect(page.locator('[data-report-section="bills"]')).toBeVisible();
  await expect(page.locator(".profit-statement")).toBeHidden();
  await page.getByRole("tab", { name: "Sales Trends", exact: true }).click();
  await expect(page.locator('[data-report-section="trends"]')).toBeVisible();
});
