import { test, expect } from "@playwright/test";
import { createControlPool, seedPlan } from "../helpers/postgres.mjs";
import { createPlatformAdminService } from "../../src/server/auth/platform-admin-service.mjs";
import { createPlatformAdminRepository } from "../../src/server/auth/platform-admin-repository.mjs";

const sizes = [{ name: "phone", width: 390, height: 844 }, { name: "tablet", width: 768, height: 1024 }, { name: "laptop", width: 1366, height: 768 }];
test.describe("Production server readiness journeys", () => {
  let control;
  test.beforeAll(async () => {
    control = await createControlPool(); await seedPlan(control, { code: "GROWTH", provider: "manual" });
    const service = createPlatformAdminService({ repository: createPlatformAdminRepository(control), passwordPepper: "test-pepper-for-development-only-32bytes" });
    await service.bootstrapAdmin({ username: "readinessadmin", password: "AdminPassword123!" });
  });
  test.afterAll(async () => control?.end());
  for (const size of sizes) test(`real menu setup, two tills, expense and P&L on ${size.name}`, async ({ page, browser }) => {
    test.setTimeout(120000);
    await page.setViewportSize(size);
    const code = `readiness-${size.name}`;
    const ownerUsername = `readiness_owner_${size.name}`, cashierUsername = `readiness_cashier_${size.name}`;
    const device = await browser.newContext({ viewport: { width: size.width, height: size.height } }); const second = await device.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message)); second.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.accept()); second.on("dialog", dialog => dialog.accept());
    async function goTo(target, screen) {
      if (await target.locator("#mobile-menu-toggle").isVisible()) await target.locator("#mobile-menu-toggle").click();
      if (["inventory", "purchases"].includes(screen)) {
        await target.locator(`button.menu-btn[onclick="switchScreen('kitchen-stock')"]`).click();
        if (screen === "purchases") await target.locator(`#screen-inventory button[onclick="switchScreen('purchases')"]`).click();
      } else await target.locator(`button.menu-btn[onclick="switchScreen('${screen}')"]`).click();
      await expect(target.locator(`#screen-${screen}`)).toBeVisible();
      if (await target.locator("#mobile-menu-toggle").isVisible()) await expect.poll(() => target.locator("#app-sidebar").evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    }
    async function login(target, username) {
      await target.goto("/"); await target.fill("#cloud-username", username); await target.fill("#cloud-password", "OwnerPassword123!");
      await target.click("#cloud-signin-button"); await expect(target.locator(".app-container")).toBeVisible();
    }
    try {
      await page.goto("/platform-admin/"); await page.fill("#username", "readinessadmin"); await page.fill("#password", "AdminPassword123!"); await page.click("#login-form button[type=submit]");
      await expect(page.locator("#portal-view")).toBeVisible(); await page.click('[data-view="restaurants"]');
      await page.click("#open-create-modal"); await page.fill("#create-code", code); await page.fill("#create-name", `Readiness ${size.name}`); await page.fill("#create-owner-user", ownerUsername); await page.fill("#create-owner-pass", "OwnerPassword123!");
      await page.click("#create-restaurant-form button[type=submit]"); await expect(page.locator("#create-modal")).toBeHidden();
      await page.fill("#search-input", code); await page.locator("#restaurants-tbody .btn-manage").click(); await expect(page.locator("#create-user-btn")).toBeVisible();
      await page.fill("#pay-ref", `READINESS-${size.name}`); await page.click("#record-pay-form button[type=submit]"); await expect(page.locator(".btn-approve")).toBeVisible();
      await page.click('[data-view="payments"]');
      const pending = page.locator("#payments-tbody tr").filter({ hasText: code }); await expect(pending).toContainText("pending");
      await pending.locator(".btn-approve").click(); await page.click("#confirm-accept"); await expect(pending).toHaveCount(0);
      await page.selectOption("#payment-filter", "approved"); const paid = page.locator("#payments-tbody tr").filter({ hasText: code }); await expect(paid).toContainText("approved"); await paid.locator(".payment-restaurant").click();
      await page.click("#create-user-btn"); await page.fill("#user-username", cashierUsername); await page.fill("#user-display-name", "Counter staff"); await page.selectOption("#user-role", "cashier"); await page.fill("#user-password", "OwnerPassword123!"); await page.click("#user-form button[type=submit]");
      await expect(page.locator("#users-tbody")).toContainText("Counter staff");
      await expect(page.locator("#users-tbody td:nth-child(3)").first()).toHaveCSS("white-space", "nowrap");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
      await page.screenshot({ path: `tests/browser/screenshots/readiness-admin-${size.name}.png`, fullPage: true });
      // Create category and menu item through the actual UI, without seeding browser collections.
      await login(page, ownerUsername); await goTo(page, "edit-menu");
      await page.locator('button[onclick="openManageCategoriesModal()"]').click(); await page.fill("#new-category-name", "Burgers"); await page.click("#category-form-submit-btn");
      await page.locator('button[onclick="closeManageCategoriesModal()"]').click();
      await page.fill("#menu-item-name", "Readiness Burger"); await page.fill("#menu-item-number", "101"); await page.selectOption("#menu-item-category", "Burgers"); await page.fill("#menu-item-price", "100"); await page.fill("#menu-item-others", "20"); await page.click("#menu-submit-btn");
      await expect(page.locator("#management-menu-rows")).toContainText("Readiness Burger");
      // A completely separate browser context has no seeded IndexedDB catalog. It must download it.
      await login(second, cashierUsername);
      expect(await second.evaluate(() => businessName)).toBe(`Readiness ${size.name}`);
      for (const target of [page, second]) {
        await goTo(target, "new-order"); await target.evaluate(() => setOrderType("Takeaway"));
        const card = target.locator('#food-grid button.food-card[aria-label="Add Readiness Burger to bill"]');
        if (!(await card.isVisible())) await target.locator("#food-grid button.food-card").filter({ hasText: "Burgers" }).click();
        await target.locator('#food-grid button.food-card[aria-label="Add Readiness Burger to bill"]').click();
        await expect(target.locator("#screen-new-order")).toContainText("Readiness Burger");
      }
      const responses = [page, second].map(target => target.waitForResponse(response => response.url().endsWith("/api/pos/orders") && response.request().method() === "POST"));
      await Promise.all([page, second].map(target => target.locator('#screen-new-order button[onclick="submitOrder(false)"]').click()));
      const results = await Promise.all(responses); for (const response of results) expect(response.status()).toBe(201);
      const orders = await Promise.all(results.map(async response => (await response.json()).order));
      expect(new Set(orders.map(order => order.id)).size).toBe(2); expect(orders.map(order => order.orderNumber).sort()).toEqual([1, 2]);
      for (const order of orders) expect(order.totalMinor).toBe(10000);
      expect(orders[0].costOfGoodsMinor).toBe(2000);
      expect(orders[1]).not.toHaveProperty("costOfGoodsMinor");
      const storedCosts = await control.query("SELECT cost_of_goods_minor FROM orders WHERE id=ANY($1::uuid[])", [orders.map(order => order.id)]);
      expect(storedCosts.rows.map(row => Number(row.cost_of_goods_minor))).toEqual([2000,2000]);
      // An offline till cannot issue a locally paid receipt in managed mode.
      await device.setOffline(true); const count = await second.evaluate(() => orders.length);
      await second.locator('#food-grid button.food-card[aria-label="Add Readiness Burger to bill"]').click(); await second.locator('#screen-new-order button[onclick="submitOrder(false)"]').click();
      expect(await second.evaluate(() => orders.length)).toBe(count); await device.setOffline(false);
      await goTo(page, "expenses"); const expense = page.locator("#cloud-expenses-container"); await expect(expense.locator("[name=financialAccountId] option")).toHaveCount(1);
      await expense.locator("[name=categoryName]").fill("Electricity"); await expense.locator("[name=amount]").fill("10"); await expense.locator("[name=description]").fill('<img src=x onerror="globalThis.xssExecuted=true">'); await expense.locator("button[type=submit]").click();
      await expect(expense.locator("[data-message]")).toHaveText("Expense saved in the cloud."); await expect(expense.locator("[data-results]")).toContainText("Electricity"); await expect(expense.locator("img")).toHaveCount(0);
      await goTo(page, "reports"); await page.locator("#restaurant-statement > summary").click(); await expect(page.locator("#cloud-profit-loss-container [data-results]")).toContainText("150.00");
      await expect(page.locator("#cloud-sales-report-container")).toContainText("200.00");
      await page.screenshot({ path: `tests/browser/screenshots/readiness-profit-${size.name}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
      // The reported journey: KOT -> edit -> serve -> cashier payment -> owner cancellation.
      await goTo(page, "new-order"); await page.evaluate(() => {
        setOrderType("Takeaway"); window.__kotPrints = [];
        window.populateReceiptSlipAndPrint = async (order,targets) => { window.__kotPrints.push({order,targets}); };
      });
      if (!(await page.locator('#food-grid button.food-card[aria-label="Add Readiness Burger to bill"]').isVisible())) {
        await page.locator("#food-grid button.food-card").filter({hasText:"Burgers"}).click();
      }
      await page.locator('#food-grid button.food-card[aria-label="Add Readiness Burger to bill"]').click();
      const kotResponse = page.waitForResponse(response => response.url().endsWith("/api/pos/orders") && response.request().method() === "POST");
      await page.locator("#btn-kot-bill").click();
      if (await page.locator("#missing-stock-confirm-modal").isVisible()) await page.locator("#btn-continue-billing").click();
      const kotSaved = await kotResponse; expect(kotSaved.status()).toBe(201);
      const kot = (await kotSaved.json()).order;
      expect(kot.totalMinor).toBe(10000); expect(kot.paymentStatus).toBe("unpaid"); expect(kot.orderStatus).toBe("preparing");
      await expect.poll(() => page.evaluate(() => cart.length)).toBe(0);
      const printed = await page.evaluate(() => window.__kotPrints);
      expect(printed).toHaveLength(1);expect(printed[0].targets).toEqual(["kitchen"]);expect(printed[0].order.orderNumber).toBe(kot.orderNumber);
      expect(printed[0].order.items[0]).not.toHaveProperty("price");
      await goTo(page, "view-orders");
      const ownerKotRow = page.locator("#history-orders-rows tr").filter({has:page.locator("td:first-child strong",{hasText:`#${kot.orderNumber}`})});
      await ownerKotRow.click(); await page.locator('[data-order-action="edit"]').click();
      await page.getByLabel("Quantity for Readiness Burger",{exact:true}).fill("2");
      await page.getByRole("button",{name:"Save Changes",exact:true}).click();
      await expect(page.locator(".order-action-overlay")).toHaveCount(0);
      await page.getByRole("button",{name:"Close",exact:true}).click();
      expect((await control.query("SELECT id FROM kitchen_tickets WHERE order_id=$1", [kot.id])).rowCount).toBe(2);
      await goTo(page, "kitchen");
      const kotCards = page.locator("#kds-board .kds-card").filter({hasText:new RegExp(`Order #${kot.orderNumber}(?![0-9])`)});
      await expect(kotCards).toHaveCount(2);
      for (const label of ["Start Cooking","Mark Ready","Mark Served"]) {
        for (let index=0;index<2;index++) {
          await kotCards.getByRole("button",{name:new RegExp(label)}).first().click();
          await expect(kotCards.getByRole("button",{name:new RegExp(label)})).toHaveCount(1-index);
        }
      }
      await expect(kotCards).toHaveCount(0);
      await goTo(second,"view-orders");
      const cashierKotRow = second.locator("#history-orders-rows tr").filter({has:second.locator("td:first-child strong",{hasText:`#${kot.orderNumber}`})});
      await cashierKotRow.click();
      await expect(second.locator('[data-order-action="edit"]')).toHaveCount(0);
      await second.locator('[data-order-action="payment"]').click();
      await expect(second.getByLabel("Amount received (Rs.)",{exact:true})).toHaveValue("200.00");
      const paymentSaved = second.waitForResponse(response=>response.url().endsWith(`/api/pos/orders/${kot.id}/payments`) && response.request().method()==="POST");
      await second.getByRole("button",{name:"Record Payment",exact:true}).click();expect((await paymentSaved).status()).toBe(201);
      await expect(second.locator('[data-order-action="payment"]')).toHaveCount(0);
      await goTo(page,"view-orders");await ownerKotRow.click();await page.locator('[data-order-action="cancel"]').click();
      await page.locator("#cloud-cancel-confirm").click();await expect(page.locator("#invoice-modal-overlay")).toBeHidden();
      await expect(ownerKotRow).toContainText("Cancelled");
      // Explicitly visit the production history, stock and purchasing screens; mocked suites exercise their detailed controls.
      for (const screen of ["view-orders", "inventory", "purchases"]) { await goTo(page, screen); }
      if (size.name === "laptop") {
        const restoreResponse = page.waitForResponse(response => response.url().endsWith("/api/pos/import/legacy-orders") && response.request().method() === "POST");
        await page.locator("#restore-backup-uploader").setInputFiles("tests/fixtures/santex-cafe-reproduction-backup.json");
        const restored = await restoreResponse;
        expect(restored.status()).toBe(200);
        expect((await restored.json()).imported).toBe(3);
        await expect(page.locator("#retry-backup-sync")).toBeHidden();
        await goTo(second, "view-orders");
        await expect(second.locator("#history-orders-rows .restored-bill-note")).toHaveCount(3);
        const retryResponse = page.waitForResponse(response => response.url().endsWith("/api/pos/import/legacy-orders") && response.request().method() === "POST");
        await page.locator("#restore-backup-uploader").setInputFiles("tests/fixtures/santex-cafe-reproduction-backup.json");
        const retried = await retryResponse;
        expect(retried.status()).toBe(200);
        expect((await retried.json()).skipped).toBe(3);
        await expect(page.locator("#retry-backup-sync")).toBeHidden();
        expect(Number((await control.query("SELECT count(*) FROM orders WHERE restaurant_id = (SELECT restaurant_id FROM orders WHERE id=$1)", [orders[0].id])).rows[0].count)).toBe(6);
      }
      expect(errors).toEqual([]);
    } finally { await device.close(); }
  });
});
