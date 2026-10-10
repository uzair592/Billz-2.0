import { test, expect } from "@playwright/test";
import { createAppPool, createControlPool, seedPlan } from "../helpers/postgres.mjs";
import { createPlatformAdminRepository } from "../../src/server/auth/platform-admin-repository.mjs";
import { createPlatformAdminService } from "../../src/server/auth/platform-admin-service.mjs";
import { createPlatformAdminPortalService } from "../../src/server/subscriptions/platform-admin-portal-service.mjs";
import { createPostgresAuthRepository } from "../../src/server/auth/postgres-auth-repository.mjs";

const pepper = "test-pepper-for-development-only-32bytes";
const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1366, height: 768 },
];

test.describe("PHASE 8 — Real Browser Acceptance Suite", () => {
  let pool;
  let adminService;
  let portalService;
  let authRepo;

  test.beforeAll(async () => {
    pool = await createControlPool();
    await seedPlan(pool, { code: "GROWTH", provider: "manual" });

    const adminRepo = createPlatformAdminRepository(pool);
    adminService = createPlatformAdminService({ repository: adminRepo, passwordPepper: pepper });
    portalService = createPlatformAdminPortalService({ pool, passwordPepper: pepper });
    authRepo = createPostgresAuthRepository(pool);

    // Seed super admin
    await adminService.bootstrapAdmin({
      username: "superadmin",
      password: "SuperAdminPassword123!",
      displayName: "Lead Super Admin",
    });
  });

  test.afterAll(async () => {
    if (pool) await pool.end();
  });

  for (const vp of viewports) {
    test(`Full SaaS Commercial Journey at ${vp.width}x${vp.height} (${vp.name})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      page.on("console", (msg) => console.log(`[PAGE CONSOLE ${vp.name}] ${msg.type()}: ${msg.text()}`));
      page.on("pageerror", (err) => console.log(`[PAGE ERROR ${vp.name}] ${err.message}`));

      // 1. Platform Admin Login Screen & Submission
      await page.goto("http://127.0.0.1:3000/platform-admin/");
      await page.waitForSelector("#username");
      if (vp.name === "desktop") {
        await page.screenshot({ path: `tests/browser/screenshots/platform-admin-login-${vp.name}.png` });
      }

      await page.fill("#username", "superadmin");
      await page.fill("#password", "SuperAdminPassword123!");
      await page.click("button[type='submit']");

      await page.waitForSelector("#portal-view:not(.hidden)");
      if (vp.name === "desktop") {
        await page.screenshot({ path: `tests/browser/screenshots/platform-admin-dashboard-${vp.name}.png` });
      }

      // 2. Create Restaurant via Platform Admin Portal UI
      await page.click("#open-create-modal");
      await page.waitForSelector("#create-modal:not(.hidden)");

      const restCode = `rest-${vp.name}`;
      await page.fill("#create-code", restCode);
      await page.fill("#create-name", `Test Restaurant ${vp.name}`);
      await page.fill("#create-owner-user", `owner_${vp.name}`);
      await page.fill("#create-owner-pass", "OwnerPass123!");

      if (vp.name === "desktop") {
        await page.screenshot({ path: `tests/browser/screenshots/restaurant-creation-${vp.name}.png` });
      }

      await page.click("#create-restaurant-form button[type='submit']");
      await page.waitForSelector("#create-modal", { state: "hidden" });

      // 3. View created restaurant details, record & approve manual payment
      await page.fill("#search-input", restCode);
      await expect(page.locator("#restaurants-tbody")).toContainText(restCode);
      await page.click(`.btn-manage[data-id]`);

      await page.waitForSelector("#detail-view:not(.hidden)");
      await page.fill("#pay-ref", `TRX-${vp.name.toUpperCase()}-1001`);
      await page.click("#record-pay-form button[type='submit']");

      await page.waitForSelector(".btn-approve");
      await page.click(".btn-approve");

      // Verify payment status updated to approved
      await expect(page.locator("#detail-content")).toContainText("approved");

      // 4. Owner Logs into POS
      await page.goto("http://127.0.0.1:3000/");
      if (vp.name === "desktop") {
        await page.screenshot({ path: `tests/browser/screenshots/restaurant-login-${vp.name}.png` });
      }

      // Visible owner sign-in and actual menu onboarding.
      await page.fill("#cloud-restaurant-code", restCode);
      await page.fill("#cloud-username", `owner_${vp.name}`);
      await page.fill("#cloud-password", "OwnerPass123!");
      await page.click("#cloud-signin-button");
      await expect(page.locator(".app-container")).toBeVisible();
      const restRow = await pool.query(`SELECT id FROM restaurants WHERE code = $1`, [restCode]);
      const restId = restRow.rows[0].id;
      // Populate one valid product in this tenant's local catalog before import.
      await page.evaluate(async () => {
        menuItems = [{ id: 1, itemNumber: 1, name: "Acceptance Burger", category: "Burgers", price: 100, otherCost: 0 }];
        categories = ["Burgers"];
        await saveToStorage();
        renderDynamicCategoryTabsRow();
        renderFoodGridOrderingUI();
      });
      await page.evaluate(() => openCloudAccountModal());
      await page.click("#cloud-import-button");
      await expect(page.locator("#cloud-account-status")).toContainText("Copied 1 menu items");
      await page.evaluate(() => closeCloudAccountModal());
      // Real checkout uses the visible POS action; no accepted error statuses.
      await page.evaluate(() => {
        switchScreen("new-order");
        setOrderType("Takeaway");
        cart = [{ ...menuItems[0], qty: 2 }];
        renderCart();
      });
      const completed = page.waitForResponse(r => r.url().endsWith("/api/pos/orders") && r.request().method() === "POST");
      await page.locator('#screen-new-order button[onclick="submitOrder(false)"]').click();
      const response = await completed;
      expect(response.status()).toBe(201);
      const sale = (await response.json()).order;
      expect(sale.totalMinor).toBe(20000);
      expect(sale.paymentStatus).toBe("paid");
      const persisted = await pool.query(`SELECT total_minor, payment_status FROM orders WHERE restaurant_id = $1 AND id = $2`, [restId, sale.id]);
      expect(Number(persisted.rows[0].total_minor)).toBe(20000);
      expect(persisted.rows[0].payment_status).toBe("paid");

      // 8. Platform Admin Suspends Restaurant
      await page.goto("http://127.0.0.1:3000/platform-admin/");
      await page.waitForSelector("#portal-view:not(.hidden)");
      await page.fill("#search-input", restCode);
      await page.waitForSelector(`.btn-manage[data-id]`);
      await page.click(`.btn-manage[data-id]`);

      await page.waitForSelector("#suspend-btn");
      await page.click("#suspend-btn");
      await page.waitForSelector("#restore-btn");

      // 9. Cashier receives suspension response on POS API
      const posSuspendedRes = await page.request.post("http://127.0.0.1:3000/api/auth/login", {
        data: {
          restaurantCode: restCode,
          username: `owner_${vp.name}`,
          password: "OwnerPass123!",
        },
      });
      expect(posSuspendedRes.status()).toBe(403);
      const errData = await posSuspendedRes.json();
      expect(errData.code).toBe("RESTAURANT_SUSPENDED");

      if (vp.name === "desktop") {
        await page.screenshot({ path: `tests/browser/screenshots/suspended-restaurant-screen-${vp.name}.png` });
      }

      // 10. Platform Admin Restores Restaurant
      await page.click("#restore-btn");
      await page.waitForSelector("#suspend-btn");

      // 11. Cashier regains access
      const posRestoredRes = await page.request.post("http://127.0.0.1:3000/api/auth/login", {
        data: {
          restaurantCode: restCode,
          username: `owner_${vp.name}`,
          password: "OwnerPass123!",
        },
      });
      expect(posRestoredRes.status()).toBe(200);

      if (vp.name === "desktop") {
        await page.screenshot({ path: `tests/browser/screenshots/restored-pos-access-${vp.name}.png` });
      }
    });
  }
});
