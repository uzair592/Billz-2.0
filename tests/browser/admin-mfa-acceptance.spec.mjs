import { test, expect } from "@playwright/test";
import { createControlPool } from "../helpers/postgres.mjs";
import { createPlatformAdminService } from "../../src/server/auth/platform-admin-service.mjs";
import { createPlatformAdminRepository } from "../../src/server/auth/platform-admin-repository.mjs";
import { totp } from "../../src/server/auth/totp.mjs";

test("administrator enrolls 2FA through Security and uses a recovery code once", async ({
  page,
}) => {
  const pool = await createControlPool();
  try {
    await createPlatformAdminService({
      repository: createPlatformAdminRepository(pool),
      passwordPepper: "test-pepper-for-development-only-32bytes",
    }).bootstrapAdmin({
      username: "mfabrowser",
      password: "AdminPassword123!",
    });
  } finally {
    await pool.end();
  }
  await page.goto("/platform-admin/");
  await page.fill("#username", "mfabrowser");
  await page.fill("#password", "AdminPassword123!");
  await page.click("#login-form button[type=submit]");
  await expect(page.locator("#portal-view")).toBeVisible();
  await page.click("[data-view=security]");
  await page.fill("#mfa-start-password", "AdminPassword123!");
  await page.click("#mfa-start-form button[type=submit]");
  await expect(page.locator("#mfa-once")).toBeVisible();
  const uri = await page.inputValue("#mfa-uri"),
    secret = new URL(uri).searchParams.get("secret");
  const codes = (await page.locator("#mfa-recovery-codes").innerText()).split(
    "\n",
  );
  await page.fill(
    "#mfa-verify-code",
    totp(secret, Math.floor(Date.now() / 30000)),
  );
  await page.click("#mfa-verify-form button[type=submit]");
  await expect(page.locator("#mfa-status")).toContainText("2FA enabled");
  await expect(page.locator("#mfa-uri")).toHaveValue("");
  await expect(page.locator("#mfa-recovery-codes")).toBeEmpty();
  await page.click("#logout-btn");
  await page.fill("#username", "mfabrowser");
  await page.fill("#password", "AdminPassword123!");
  await page.fill("#admin-login-code", codes[0]);
  await page.click("#login-form button[type=submit]");
  await expect(page.locator("#portal-view")).toBeVisible();
  await page.click("#logout-btn");
  await page.fill("#username", "mfabrowser");
  await page.fill("#password", "AdminPassword123!");
  await page.fill("#admin-login-code", codes[0]);
  await page.click("#login-form button[type=submit]");
  await expect(page.locator("#login-error")).toContainText(
    "Invalid administrator",
  );
});
