import { test, expect } from "@playwright/test";
import { createControlPool, seedPlan } from "../helpers/postgres.mjs";
import { createPlatformAdminService } from "../../src/server/auth/platform-admin-service.mjs";
import { createPlatformAdminRepository } from "../../src/server/auth/platform-admin-repository.mjs";
import { createPlatformAdminPortalService } from "../../src/server/subscriptions/platform-admin-portal-service.mjs";

test("persisted customer, menu, supplier and expense text remains inert on POS screens", async ({ page }) => {
  test.setTimeout(120000);
  const canary = '<img src=x onerror="window.__xss=1">';
  const pool = await createControlPool();
  try {
    await seedPlan(pool, { code: "GROWTH", provider: "manual" });
    const passwordPepper = "test-pepper-for-development-only-32bytes";
    const admin = await createPlatformAdminService({ repository: createPlatformAdminRepository(pool), passwordPepper })
      .bootstrapAdmin({ username: "xssadmin", password: "AdminPassword123!" });
    await createPlatformAdminPortalService({ pool, passwordPepper }).createRestaurant({
      adminId: admin.admin.id, name: canary, code: "xss-restaurant", ownerUsername: "owner",
      ownerDisplayName: canary, ownerPassword: "OwnerPassword123!", planCode: "GROWTH",
    });
  } finally { await pool.end(); }
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  async function inert() {
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
  }
  await page.goto("/");
  await page.fill("#cloud-restaurant-code", "xss-restaurant"); await page.fill("#cloud-username", "owner");
  await page.fill("#cloud-password", "OwnerPassword123!"); await page.click("#cloud-signin-button");
  await expect(page.locator(".app-container")).toBeVisible(); await inert();
  await page.evaluate(() => switchScreen("edit-menu"));
  await page.locator('button[onclick="openManageCategoriesModal()"]').click();
  await page.fill("#new-category-name", canary); await page.click("#category-form-submit-btn");
  await page.locator('button[onclick="closeManageCategoriesModal()"]').click();
  await page.fill("#menu-item-name", canary); await page.fill("#menu-item-number", "101");
  await page.selectOption("#menu-item-category", canary); await page.fill("#menu-item-price", "100");
  await page.click("#menu-submit-btn");
  await expect(page.locator("#management-menu-rows")).toContainText(canary); await inert();
  await page.evaluate(() => openCloudAccountModal()); await page.click("#cloud-import-button");
  await expect(page.locator("#cloud-account-status")).toContainText("Copied 1 menu items");
  await page.evaluate(() => closeCloudAccountModal());
  await page.evaluate(() => { switchScreen("new-order"); setOrderType("Takeaway"); });
  const category = page.locator("#food-grid button.food-card").filter({ hasText: canary });
  await category.first().click();
  await page.getByRole("button", { name: `Add ${canary} to bill`, exact: true }).click();
  await page.fill("#cust-name", canary); await inert();
  const completed = page.waitForResponse(r => r.url().endsWith("/api/pos/orders") && r.request().method() === "POST");
  await page.locator('#screen-new-order button[onclick="submitOrder(false)"]').click();
  const response = await completed; expect(response.status()).toBe(201);
  expect((await response.json()).order.customerName).toBe(canary); await inert();
  await page.evaluate(() => switchScreen("purchases"));
  await page.getByRole("button", { name: "Add supplier", exact: true }).click();
  await page.locator(".inventory-modal .inventory-input").first().fill(canary);
  await page.getByRole("button", { name: "Create supplier", exact: true }).click();
  await expect(page.locator(".inventory-supplier-name")).toContainText(canary); await inert();
  await page.evaluate(() => switchScreen("expenses"));
  const expense = page.locator("#cloud-expenses-container");
  await expect(expense.locator("[name=financialAccountId] option")).toHaveCount(1);
  await expense.locator("[name=categoryName]").fill(canary); await expense.locator("[name=amount]").fill("10");
  await expense.locator("[name=description]").fill(canary); await expense.locator("button[type=submit]").click();
  await expect(expense.locator("[data-message]")).toHaveText("Expense saved in the cloud.");
  await expect(expense.locator("[data-results]")).toContainText(canary); await inert();
  for (const screen of ["dashboard", "new-order", "view-orders", "edit-menu", "inventory", "purchases", "expenses", "reports", "settings", "cash-bank"]) {
    await page.evaluate(screen => switchScreen(screen), screen); await inert();
  }
  // Reload forces the names through persistence/catalog download rather than only the edit form.
  await page.reload(); await expect(page.locator(".app-container")).toBeVisible();
  await page.evaluate(() => switchScreen("view-orders"));
  await expect(page.locator("#screen-view-orders")).toContainText(canary); await inert();
  // Imported historical records reach legacy renderers as well as the cloud UI.
  await page.evaluate(canary => {
    expenseFields = [{ key: "imported", label: canary, color: "#123abc" }];
    expenseEntries = [{ id: 991, date: getLocalDateString(new Date()), fieldKey: "imported", amount: 10, note: canary }];
    renderExpenseHistory(); renderExpensesReportTab(); renderBillWiseProfitReport();
    stockItemDefs.canary = { label: canary, icon: canary, group: "kitchen", buyUnit: "kg", sellUnit: "g" };
    renderStockItemTable(); renderStockHistoryIngredientFilterOptions("kitchen");
  }, canary);
  await inert(); expect(errors).toEqual([]);
});
