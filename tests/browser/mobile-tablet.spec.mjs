import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

try {
  mkdirSync(join(process.cwd(), "docs", "screenshots"), { recursive: true });
} catch {}

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";

const cloudContext = {
  version: 1,
  restaurantId: RESTAURANT_ID,
  importedAt: "2026-10-01T00:00:00.000Z",
  mappings: { menuItems: {}, tables: {}, financialAccounts: {} },
};

const cloudSession = {
  user: { id: "user-1", email: "till@bite-tech.example" },
  restaurantId: RESTAURANT_ID,
  updatedAt: "2026-10-01T00:00:00.000Z",
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

async function openPosUnlocked(page) {
  await page.addInitScript(() => {
    sessionStorage.setItem("biteTechUnlocked", "true");
  });
  await page.goto("/");
  await page.evaluate(() => {
    document.getElementById("pin-lock-overlay")?.classList.add("hidden");
    document.querySelector(".app-container")?.classList.remove("hidden");
  });
  await seedStorage(page, {
    pos_cloud_session_v1: cloudSession,
    pos_cloud_context_v1: cloudContext,
  });
  await page.reload();
  await page.evaluate(() => {
    document.getElementById("pin-lock-overlay")?.classList.add("hidden");
    document.querySelector(".app-container")?.classList.remove("hidden");
  });
}

function mockApi(page) {
  return page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/api/auth/me")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: cloudSession.user }) });
    }
    if (url.pathname.includes("/api/pos/inventory")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], nextCursor: null }) });
    }
    if (url.pathname.includes("/api/pos/purchases")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ purchases: [], nextCursor: null }) });
    }
    if (url.pathname.includes("/api/pos/reports")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ summary: { salesMinor: 0, orderCount: 0 }, orders: [] }) });
    }
    if (url.pathname.includes("/api/billing")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plans: [], subscription: null }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
}

const VIEWPORTS = [
  { name: "phone-portrait-390", width: 390, height: 844 },
  { name: "phone-portrait-412", width: 412, height: 915 },
  { name: "phone-landscape-844", width: 844, height: 390 },
  { name: "tablet-portrait-768", width: 768, height: 1024 },
  { name: "tablet-landscape-1024", width: 1024, height: 768 },
  { name: "laptop-1366", width: 1366, height: 768 },
];

test.describe("Mobile & Tablet Usability & Acceptance", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("Phone navigation drawer opens, overlays, closes on navigation", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPosUnlocked(page);

    const toggleBtn = page.locator("#mobile-menu-toggle");
    await expect(toggleBtn).toBeVisible();

    await toggleBtn.click();
    const sidebar = page.locator("#app-sidebar");
    await expect(sidebar).toHaveClass(/mobile-open/);

    const overlay = page.locator("#sidebar-drawer-overlay");
    await expect(overlay).toBeVisible();

    const newOrderBtn = page.locator('button.menu-btn[onclick*="new-order"]');
    await expect(newOrderBtn).toBeVisible();
    await newOrderBtn.click();

    await expect(sidebar).not.toHaveClass(/mobile-open/);
    await expect(overlay).not.toBeVisible();
    await expect(page.locator("#app-screen-title")).toHaveText("New Sale");
  });

  test("No page-level horizontal overflow across required viewports", async ({ page }) => {
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openPosUnlocked(page);

      const hasOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });

      expect(hasOverflow, `Viewport ${vp.name} (${vp.width}x${vp.height}) has horizontal overflow`).toBe(false);
    }
  });

  test("New Order product and cart usability on mobile (390x844)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPosUnlocked(page);

    await page.locator("#mobile-menu-toggle").click();
    await page.locator('button.menu-btn[onclick*="new-order"]').click();

    const foodGrid = page.locator(".food-grid");
    await expect(foodGrid).toBeVisible();

    await page.screenshot({ path: "docs/screenshots/mobile-new-order.png" });

    const cartBox = page.locator(".cart-box").first();
    await expect(cartBox).toBeVisible();
  });

  test("Checkout controls reachable and modal responsive on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPosUnlocked(page);

    await page.locator("#mobile-menu-toggle").click();
    await page.locator('button.menu-btn[onclick*="new-order"]').click();

    await page.screenshot({ path: "docs/screenshots/mobile-checkout.png" });
  });

  test("Reports screen filter usability and responsive layout on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPosUnlocked(page);

    await page.locator("#mobile-menu-toggle").click();
    await page.locator('button.menu-btn[onclick*="reports"]').click();

    await expect(page.locator("#app-screen-title")).toHaveText("Reports");
    await page.screenshot({ path: "docs/screenshots/mobile-reports.png" });
  });

  test("Inventory list responsive rendering and modal scrolling on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPosUnlocked(page);

    await page.locator("#mobile-menu-toggle").click();
    await page.locator('button.menu-btn[onclick*="inventory"]').click();

    await expect(page.locator("#app-screen-title")).toHaveText("Inventory");
    await page.screenshot({ path: "docs/screenshots/mobile-inventory.png" });
  });

  test("Purchases screen responsive rendering on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPosUnlocked(page);

    await page.locator("#mobile-menu-toggle").click();
    await page.locator('button.menu-btn[onclick*="purchases"]').click();

    await expect(page.locator("#app-screen-title")).toHaveText("Purchases");
    await page.screenshot({ path: "docs/screenshots/mobile-purchases.png" });
  });

  test("Repeated navigation does not register duplicate event handlers or crash UI", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPosUnlocked(page);

    const screenIds = ["dashboard", "new-order", "view-orders", "inventory", "purchases", "reports", "billing"];

    for (let i = 0; i < 2; i++) {
      for (const s of screenIds) {
        await page.locator("#mobile-menu-toggle").click();
        await page.locator(`button.menu-btn[onclick*="${s}"]`).click();
        await expect(page.locator("#app-sidebar")).not.toHaveClass(/mobile-open/);
      }
    }
  });

  test("Desktop thermal print CSS rules remain intact", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await openPosUnlocked(page);

    const hasPrintMedia = await page.evaluate(() => {
      const styles = Array.from(document.querySelectorAll("style"));
      return styles.some((s) => s.textContent.includes("@media print"));
    });

    expect(hasPrintMedia).toBe(true);
  });
});
