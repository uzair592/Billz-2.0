import { test, expect } from "@playwright/test";
import { createControlPool } from "../helpers/postgres.mjs";
import { createPlatformAdminService } from "../../src/server/auth/platform-admin-service.mjs";
import { createPlatformAdminRepository } from "../../src/server/auth/platform-admin-repository.mjs";

test("admin creates a dynamic plan and restaurant, enforces seats, resets credentials and controls access", async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1366, height: 900 });
  const control = await createControlPool();
  try {
    await createPlatformAdminService({
      repository: createPlatformAdminRepository(control),
      passwordPepper: "test-pepper-for-development-only-32bytes",
    }).bootstrapAdmin({
      username: "controlbrowser",
      password: "AdminPassword123!",
    });
  } finally {
    await control.end();
  }
  const contexts = await Promise.all([1, 2, 3].map(() => browser.newContext()));
  const tills = await Promise.all(contexts.map((c) => c.newPage()));
  const code = "ui_cafe (01)";
  const signIn = async (
    target,
    username = "control_owner",
    password = "OwnerPassword123!",
  ) => {
    await target.goto("/");
    await target.fill("#cloud-username", username);
    await target.fill("#cloud-password", password);
    const response = target.waitForResponse(
      (r) =>
        r.url().endsWith("/api/auth/login") && r.request().method() === "POST",
    );
    await target.click("#cloud-signin-button");
    return response;
  };
  const openDetails = async () => {
    await page.click('[data-view="restaurants"]');
    await page.fill("#search-input", code);
    await page.locator("#restaurants-tbody .btn-manage").click();
    await expect(page.locator("#owner-credentials-btn")).toBeVisible();
  };
  try {
    await page.goto("/platform-admin/");
    await page.fill("#username", "controlbrowser");
    await page.fill("#password", "AdminPassword123!");
    await page.click("#login-form button[type=submit]");
    await expect(page.locator("#portal-view")).toBeVisible();
    await page.click('[data-view="plans"]');
    await page.click("#new-plan-btn");
    await page.fill("#plan-name", "Enterprise UI Plan");
    await page.fill("#plan-code", "ENTERPRISE_UI");
    await page.selectOption("#plan-interval", "quarter");
    await page.fill("#plan-price", "7500");
    await page.fill("#plan-currency", "USD");
    await page.fill("#plan-devices", "2");
    await page.fill("#plan-trial-days", "11");
    await page.click("#plan-form button[type=submit]");
    await expect(page.locator("#plan-modal")).toBeHidden();
    await expect(page.locator("#plans-tbody")).toContainText(
      "Enterprise UI Plan",
    );
    await page.click('[data-view="restaurants"]');
    await page.click("#open-create-modal");
    await page.fill("#create-name", "Enterprise UI Cafe");
    await page.fill("#create-code", code);
    await page.fill("#create-owner-user", "control_owner");
    await page.fill("#create-owner-pass", "OwnerPassword123!");
    await page.fill("#create-owner-email", "owner.ui@example.com");
    await page.selectOption("#create-plan", "ENTERPRISE_UI");
    await page.click("#create-restaurant-form button[type=submit]");
    await expect(page.locator("#create-modal")).toBeHidden();
    expect((await signIn(tills[0])).status()).toBe(200);
    expect((await signIn(tills[1])).status()).toBe(200);
    expect((await signIn(tills[2])).status()).toBe(409);
    await openDetails();
    await expect(page.locator("#pay-currency")).toHaveValue("USD");
    await expect(page.locator("#pay-amount")).toHaveValue("7500.00");
    await page.fill("#pay-ref", "enterprise-ui-manual-payment");
    await page.click("#record-pay-form button[type=submit]");
    await expect(page.locator("#detail-content")).toContainText(
      "enterprise-ui-manual-payment",
    );
    await expect(page.locator("#detail-content")).toContainText("USD 7500.00");
    await expect(page.locator("#session-results")).toContainText(
      "2 active sessions",
    );
    await page.click("#owner-credentials-btn");
    await page.fill("#owner-login-email", "new.owner.ui@example.com");
    await page.check("#owner-generate-password");
    await page.fill("#owner-credential-reason", "Owner recovery");
    await page.click("#owner-credentials-form button[type=submit]");
    await page.click("#confirm-accept");
    await expect(page.locator("#temporary-password-modal")).toBeVisible();
    const temporary = await page.inputValue("#temporary-password");
    expect(temporary.length).toBeGreaterThanOrEqual(24);
    await page.locator("#temporary-password-modal [data-close]").click();
    await expect(page.locator("#temporary-password")).toHaveValue("");
    for (const till of tills.slice(0, 2))
      expect((await till.request.get("/api/auth/me")).status()).toBe(401);
    expect((await signIn(tills[0])).status()).toBe(401);
    expect(
      (await signIn(tills[0], "new.owner.ui@example.com", temporary)).status(),
    ).toBe(200);
    await page.click("#subscription-edit-btn");
    await page.selectOption("#subscription-mode", "renew");
    await page.fill("#subscription-reason", "Quarterly renewal verified");
    await page.click("#subscription-form button[type=submit]");
    await page.click("#confirm-accept");
    await expect(page.locator("#subscription-modal")).toBeHidden();
    await page.click("#force-logout-btn");
    await page.click("#confirm-accept");
    await expect(page.locator("#session-results")).toContainText(
      "No active restaurant sessions",
    );
    expect((await tills[0].request.get("/api/auth/me")).status()).toBe(401);
    await page.click("#suspend-btn");
    await page.click("#confirm-accept");
    await expect(page.locator("#restore-btn")).toBeVisible();
    expect(
      (await signIn(tills[1], "new.owner.ui@example.com", temporary)).status(),
    ).toBe(403);
    await page.click("#restore-btn");
    await page.click("#confirm-accept");
    await expect(page.locator("#suspend-btn")).toBeVisible();
    expect(
      (await signIn(tills[1], "new.owner.ui@example.com", temporary)).status(),
    ).toBe(200);
    await expect(page.locator(".toast")).toHaveCount(0, { timeout: 10000 });
    await page.screenshot({
      path: "tests/browser/screenshots/admin-control-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 2,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "tests/browser/screenshots/admin-control-phone.png",
      fullPage: true,
    });
    await page.click('[data-view="audits"]');
    await page.fill("#audit-search", "owner.credentials_updated");
    await expect(page.locator("#audits-tbody")).toContainText(
      "owner.credentials_updated",
    );
    await page.click('[data-view="plans"]');
    const row = page
      .locator("#plans-tbody tr")
      .filter({ hasText: "Enterprise UI Plan" });
    await row.locator(".plan-edit").click();
    await page.fill("#plan-devices", "1");
    await page.click("#plan-form button[type=submit]");
    await page.click("#confirm-accept");
    await expect(page.locator("#plan-modal")).toBeHidden();
    await row.locator(".plan-toggle").click();
    await page.click("#confirm-accept");
    await expect(row).toContainText("archived");
    await row.locator(".plan-toggle").click();
    await page.click("#confirm-accept");
    await expect(row).toContainText("active");
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
