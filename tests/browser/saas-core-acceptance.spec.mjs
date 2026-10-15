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

      await page.click('[data-view="restaurants"]');

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
      await page.click('[data-view="restaurants"]');
      await page.fill("#search-input", restCode);
      await expect(page.locator("#restaurants-tbody")).toContainText(restCode);
      await page.click(`.btn-manage[data-id]`);

      await page.waitForSelector("#detail-view:not(.hidden)");
      await page.fill("#pay-ref", `TRX-${vp.name.toUpperCase()}-1001`);
      await page.click("#record-pay-form button[type='submit']");

      await page.waitForSelector(".btn-approve");
      await page.click(".btn-approve");
      await page.click("#confirm-accept");

      // Verify payment status updated to approved
      await expect(page.locator("#detail-content")).toContainText("approved");

      // 4. Owner Logs into POS
      await page.goto("http://127.0.0.1:3000/");
      if (vp.name === "desktop") {
        await page.screenshot({ path: `tests/browser/screenshots/restaurant-login-${vp.name}.png` });
      }

      // Visible owner sign-in and actual menu onboarding.
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

      // Stored text must stay inert in the real DOM, including inline handler arguments.
      const rendered = await page.evaluate(() => {
        globalThis.launchCanaryExecuted = false;
        const canary = '<img src=x onerror="globalThis.launchCanaryExecuted=true">';
        const key = "stock');globalThis.launchCanaryExecuted=true;//";
        menuItems[0].name = canary;
        menuItems.push({ id: 2, name: "Canary deal", category: "Deals", price: 200, desc: canary,
          dealComponents: [{ itemId: 1, qty: 2 }] });
        managementMenuCategoryFilter = "All";
        managementMenuSearchQuery = "";
        renderManagementMenuTable();
        stockItemDefs[key] = { label: canary, icon: canary, group: "kitchen", buyUnit: "kg", sellUnit: "g" };
        renderStockHistoryIngredientFilterOptions("kitchen");
        const filters = document.getElementById(STOCK_GROUPS.kitchen.filterOptions);
        const checkbox = [...filters.querySelectorAll('input[type="checkbox"]')]
          .find(input => input.parentElement.textContent.includes(canary));
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
        expenseFields = [{ key: '"><img src=x>', label: canary }];
        populateExpenseFieldSelect();
        const expense = document.getElementById("expense-field-select");
        return {
          managementImages: document.getElementById("management-menu-rows").querySelectorAll("img").length,
          filterImages: filters.querySelectorAll("img").length,
          expenseImages: expense.querySelectorAll("img").length,
          expenseLabel: expense.options[0].textContent,
          expenseValue: expense.options[0].value,
          exactFilterSelected: selectedStockHistoryIngredientFilters.kitchen.includes(key),
        };
      });
      expect(rendered).toEqual({ managementImages: 0, filterImages: 0, expenseImages: 0,
        expenseLabel: '<img src=x onerror="globalThis.launchCanaryExecuted=true">',
        expenseValue: '"><img src=x>', exactFilterSelected: true });
      expect(await page.evaluate(() => globalThis.launchCanaryExecuted)).toBe(false);

      // 8. Platform Admin Suspends Restaurant
      await page.goto("http://127.0.0.1:3000/platform-admin/");
      await page.waitForSelector("#portal-view:not(.hidden)");
      await page.click('[data-view="restaurants"]');
      await page.fill("#search-input", restCode);
      await page.waitForSelector(`.btn-manage[data-id]`);
      await page.click(`.btn-manage[data-id]`);

      await page.waitForSelector("#suspend-btn");
      await page.click("#suspend-btn");
      await page.click("#confirm-accept");
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
      await page.click("#confirm-accept");
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

  test("support reset revokes old sessions and passwords; admin text stays inert",async({page,browser})=>{
    const ownerContext=await browser.newContext();const ownerPage=await ownerContext.newPage();
    const code="reset-browser-cafe",username="reset_owner";
    const canary='<img src=x onerror="globalThis.adminCanaryExecuted=true">';
    try {
      await page.goto("/platform-admin/");
      await page.fill("#username","superadmin");await page.fill("#password","SuperAdminPassword123!");
      await page.click("#login-form button[type=submit]");
      await expect(page.locator("#portal-view")).toBeVisible();await page.click('[data-view="restaurants"]');
      await page.evaluate(()=>{globalThis.adminCanaryExecuted=false;});
      await page.click("#open-create-modal");await page.fill("#create-code",code);await page.fill("#create-name",canary);
      await page.fill("#create-owner-user",username);await page.fill("#create-owner-pass","OriginalBrowserPassword!42");
      await page.click("#create-restaurant-form button[type=submit]");await expect(page.locator("#create-modal")).toBeHidden();
      await page.fill("#search-input",code);const row=page.locator("#restaurants-tbody tr").filter({hasText:code});
      await expect(row).toContainText(canary);await expect(row.locator("img")).toHaveCount(0);
      const rest=(await pool.query("SELECT id FROM restaurants WHERE code=$1",[code])).rows[0];
      await pool.query("UPDATE users SET display_name=$2 WHERE restaurant_id=$1",[rest.id,canary]);
      await pool.query("UPDATE plans SET name=$1 WHERE code='GROWTH'",[canary]);
      await row.locator(".btn-manage").click();await expect(page.locator("#users-tbody")).toContainText(username);
      await expect(page.locator("#detail-content")).toContainText(canary);await expect(page.locator("#detail-content img")).toHaveCount(0);
      expect(await page.evaluate(()=>globalThis.adminCanaryExecuted)).toBe(false);
      const ownerSignIn=async(password)=>{
        await ownerPage.goto("http://127.0.0.1:3000/");await ownerPage.fill("#cloud-username",username);
        await ownerPage.fill("#cloud-password",password);await ownerPage.click("#cloud-signin-button");await expect(ownerPage.locator(".app-container")).toBeVisible();
      };
      await ownerSignIn("OriginalBrowserPassword!42");
      const oldSession=(await ownerContext.cookies()).find(cookie=>cookie.name==="pos_session");expect(Boolean(oldSession)).toBe(true);
      await page.locator("#users-tbody .user-reset").click();await page.uncheck("#reset-generate");await page.fill("#reset-new-password","ResetBrowserPassword!42");
      await page.click("#reset-password-form button[type=submit]");await page.click("#confirm-accept");await expect(page.locator("#reset-modal")).toBeHidden();
      expect((await ownerContext.request.get("http://127.0.0.1:3000/api/auth/me")).status()).toBe(401);
      expect((await ownerContext.request.post("http://127.0.0.1:3000/api/auth/login",{data:{restaurantCode:code,username,password:"OriginalBrowserPassword!42"}})).status()).toBe(401);
      // This is the real bounded failed-login delay, not a disabled account guard.
      await ownerPage.waitForTimeout(300);
      await ownerSignIn("ResetBrowserPassword!42");
      expect((await ownerContext.request.get("http://127.0.0.1:3000/api/auth/me")).status()).toBe(200);
      expect((await ownerContext.request.get("http://127.0.0.1:3000/api/auth/me",{headers:{cookie:`pos_session=${oldSession.value}`}})).status()).toBe(401);
      const audit=(await pool.query("SELECT metadata FROM audit_logs WHERE restaurant_id=$1 AND action='user.password_reset'",[rest.id])).rows;
      expect(audit.length).toBe(1);expect(JSON.stringify(audit).includes("ResetBrowserPassword")).toBe(false);

      await page.locator("#users-tbody .user-reset").click();await page.click("#reset-password-form button[type=submit]");await page.click("#confirm-accept");
      let generatedIsStrong=false;
      try {
        await expect(page.locator("#temporary-password-modal")).toBeVisible();
        generatedIsStrong=await page.locator("#temporary-password").evaluate(input=>/^[A-Za-z0-9_-]{32}$/.test(input.value));
        await page.click('[data-close="temporary-password-modal"]');
      }finally{
        // Never retain a generated password in screenshots or failure artifacts.
        await page.evaluate(()=>{document.getElementById("temporary-password").value="";document.getElementById("temporary-password-modal").close();}).catch(()=>{});
      }
      expect(generatedIsStrong).toBe(true);await expect(page.locator("#temporary-password")).toHaveValue("");
      expect((await ownerContext.request.get("http://127.0.0.1:3000/api/auth/me")).status()).toBe(401);
      await page.click("#edit-restaurant-btn");await page.fill("#edit-name","Reset Test Cafe");await page.fill("#edit-phone","03001234567");
      await page.fill("#edit-email","support@example.com");await page.click("#edit-restaurant-form button[type=submit]");
      await expect(page.locator("#edit-modal")).toBeHidden();await expect(page.locator("#detail-content")).toContainText("support@example.com");
      await page.locator("#users-tbody .user-status").click();await page.click("#confirm-accept");await expect(page.locator("#users-tbody")).toContainText("disabled");
      await page.locator("#users-tbody .user-status").click();await page.click("#confirm-accept");await expect(page.locator("#users-tbody .user-status")).toHaveText("Disable");
      await page.click('[data-view="audits"]');await page.fill("#audit-search","user.password_reset");await expect(page.locator("#audits-tbody")).toContainText("user.password_reset");
      await page.screenshot({path:"tests/browser/screenshots/admin-audit-reset.png"});
    }finally{
      await page.evaluate(()=>{const input=document.getElementById("temporary-password");if(input)input.value="";}).catch(()=>{});
      await ownerContext.close();
    }
  });
});
