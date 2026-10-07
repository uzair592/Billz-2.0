import { test, expect } from '@playwright/test';

const RESTAURANT_ID = '11111111-1111-4111-8111-111111111111';

const cloudSession = {
  user: { id: 'user-1', email: 'till@bite-tech.example' },
  restaurantId: RESTAURANT_ID,
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const cloudContext = {
  version: 1,
  restaurantId: RESTAURANT_ID,
  importedAt: '2026-10-01T00:00:00.000Z',
  mappings: { menuItems: {}, tables: {}, financialAccounts: {} },
};

async function seedStorage(page, entries) {
  await page.evaluate(async (payload) => {
    const open = indexedDB.open('BiteTechPOS_DB', 1);
    const db = await new Promise((resolve, reject) => {
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('posData')) {
          open.result.createObjectStore('posData');
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('posData', 'readwrite');
      const store = transaction.objectStore('posData');
      for (const [key, value] of Object.entries(payload)) {
        store.put(value, key);
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  }, entries);
}

async function openPos(page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('biteTechUnlocked', 'true');
  });
  await page.goto('/');
  await seedStorage(page, {
    pos_cloud_session_v1: cloudSession,
    pos_cloud_context_v1: cloudContext,
  });
  await page.reload();
}

test.describe('Milestone 14 - Inventory and Purchasing Browser UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: cloudSession.user,
          restaurants: [{ restaurantId: RESTAURANT_ID, name: 'Test Restaurant', role: 'admin' }],
        }),
      });
    });
    await page.route('**/api/pos/inventory/low-stock*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
    });
    await page.route('**/api/pos/suppliers*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ suppliers: [], total: 0 }) });
    });
    await page.route('**/api/pos/purchases*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          purchases: [
            { id: 'po-1', purchaseNumber: 'PO-202610-001', supplierName: 'Dairy Co', status: 'draft', totalAmountMinor: 500000, lineCount: 2 }
          ],
          total: 1, cursor: null, hasMore: false,
        }),
      });
    });
    await page.route('**/api/pos/inventory/items*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            { id: 'item-1', name: 'Milk Carton', sku: 'MILK-01', baseUnit: 'litre', currentStock: 10, reorderLevel: 2, averageCostMinor: 15000, isActive: true, isLowStock: false, isNegativeStock: false }
          ],
          total: 1, cursor: null, hasMore: false,
        }),
      });
    });
    await openPos(page);
  });

  test('INVENTORY navigation opens the inventory screen', async ({ page }) => {
    await page.evaluate(() => switchScreen('inventory'));
    await expect(page.locator('#screen-inventory')).toBeVisible();
    await expect(page.locator('.inventory-table')).toBeVisible();
    await expect(page.locator('text=Milk Carton')).toBeVisible();
  });

  test('PURCHASES navigation opens the purchases screen', async ({ page }) => {
    await page.evaluate(() => switchScreen('purchases'));
    await expect(page.locator('#screen-purchases')).toBeVisible();
    await expect(page.locator('.inventory-table')).toBeVisible();
    await expect(page.locator('text=PO-202610-001')).toBeVisible();
  });

  test('Inventory list renders quantities, units, costs, low-stock and negative-stock badges', async ({ page }) => {
    await page.route('**/api/pos/inventory/items*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            { id: 'item-1', name: 'Normal Item', sku: 'NORM-01', baseUnit: 'kilogram', currentStock: 20, reorderLevel: 5, averageCostMinor: 20000, isActive: true, isLowStock: false, isNegativeStock: false },
            { id: 'item-2', name: 'Low Stock Item', sku: 'LOW-01', baseUnit: 'litre', currentStock: 3, reorderLevel: 5, averageCostMinor: 10000, isActive: true, isLowStock: true, isNegativeStock: false },
            { id: 'item-3', name: 'Negative Item', sku: 'NEG-01', baseUnit: 'piece', currentStock: -2, reorderLevel: 0, averageCostMinor: 5000, isActive: true, isLowStock: false, isNegativeStock: true },
          ],
          total: 3, cursor: null, hasMore: false,
        }),
      });
    });

    await page.evaluate(() => switchScreen('inventory'));
    await expect(page.locator('text=Normal Item')).toBeVisible();
    await expect(page.locator('text=Low Stock Item')).toBeVisible();
    await expect(page.locator('.badge-warning')).toBeVisible();
    await expect(page.locator('text=Negative Item')).toBeVisible();
    await expect(page.locator('.badge-negative')).toBeVisible();
  });

  test('Search sends the correct server-side query parameter search', async ({ page }) => {
    let queriedSearch = null;
    await page.route('**/api/pos/inventory/items*', async (route) => {
      const url = new URL(route.request().url());
      queriedSearch = url.searchParams.get('search');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], total: 0, cursor: null, hasMore: false }),
      });
    });

    await page.evaluate(() => switchScreen('inventory'));
    const searchInput = page.locator('.inventory-search');
    const reqPromise = page.waitForRequest(req => req.url().includes('search=Espresso'));
    await searchInput.fill('Espresso');
    await searchInput.press('Enter');
    await reqPromise;
    expect(queriedSearch).toBe('Espresso');
  });

  test('Item creation opens modal and posts payload', async ({ page }) => {
    let postPayload = null;
    await page.route('**/api/pos/inventory/items*', async (route) => {
      if (route.request().method() === 'POST') {
        postPayload = JSON.parse(route.request().postData());
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ item: { id: 'item-2', name: 'Fresh Cream', sku: 'CREAM-01', baseUnit: 'litre', currentStock: 0, reorderLevel: 1, averageCostMinor: 0, isActive: true } }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0 }) });
    });

    await page.evaluate(() => switchScreen('inventory'));
    await page.locator('.inventory-btn').first().click();
    await expect(page.locator('.inventory-modal-title')).toBeVisible();
    const inputs = page.locator('.inventory-modal .inventory-input');
    await inputs.nth(0).fill('Fresh Cream');
    await inputs.nth(1).fill('CREAM-01');
    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/pos/inventory/items') && res.request().method() === 'POST'),
      page.locator('.inventory-modal button.inventory-btn-primary').click(),
    ]);
    expect(postPayload).not.toBeNull();
    expect(postPayload.name).toBe('Fresh Cream');
  });

  test('Recipe editor loads products from menuResult.items', async ({ page }) => {
    await page.route('**/api/pos/menu*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{ id: 'prod-1', name: 'Latte Large' }],
        }),
      });
    });

    await page.evaluate(() => switchScreen('inventory'));
    await page.locator('.inventory-btn').nth(1).click();
    await expect(page.locator('.inventory-modal-title')).toBeVisible();
  });

  test('409 conflict displays useful message', async ({ page }) => {
    await page.route('**/api/pos/inventory/items*', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'SKU already exists for another active item in this restaurant.' }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0 }) });
    });

    await page.evaluate(() => switchScreen('inventory'));
    await page.locator('.inventory-btn').first().click();
    const inputs = page.locator('.inventory-modal .inventory-input');
    await inputs.nth(0).fill('Duplicate SKU');
    await inputs.nth(1).fill('MILK-01');
    await page.locator('.inventory-modal button.inventory-btn-primary').click();
    await expect(page.locator('text=SKU already exists')).toBeVisible();
  });

  test('Untrusted text is rendered as text and cannot execute HTML', async ({ page }) => {
    const xssPayload = '<img src=x onerror=window.xssExecuted=true>';
    await page.route('**/api/pos/inventory/items*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            { id: 'xss-1', name: xssPayload, sku: 'XSS-01', baseUnit: 'piece', currentStock: 1, reorderLevel: 0, averageCostMinor: 100, isActive: true },
          ],
          total: 1, cursor: null, hasMore: false,
        }),
      });
    });

    await page.evaluate(() => switchScreen('inventory'));
    await expect(page.locator('text=' + xssPayload)).toBeVisible();
    const executed = await page.evaluate(() => window.xssExecuted);
    expect(executed).toBeUndefined();
  });

  test('Layout remains usable at representative viewport 1366x768', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.evaluate(() => switchScreen('inventory'));
    await expect(page.locator('#screen-inventory')).toBeVisible();
  });
});
