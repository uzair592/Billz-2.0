import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractInlineScript,
  readLegacyApp,
} from "./helpers/legacy-source.mjs";

const expectedScreens = [
  "dashboard",
  "new-order",
  "view-orders",
  "edit-menu",
  "settings",
  "kitchen-stock",
  "cash-bank",
  "expenses",
  "reports",
  "ledger",
];

const criticalStorageKeys = [
  "pos_orders",
  "pos_menu",
  "pos_categories",
  "pos_ingredient_stock",
  "pos_stock_log",
  "pos_expense_entries",
  "pos_cash_transactions",
  "pos_bank_accounts",
  "pos_bank_transactions",
  "pos_business_name",
  "pos_receipt_layout",
];

describe("legacy POS application integrity", () => {
  it("retains every established primary screen", async () => {
    const html = await readLegacyApp();

    for (const screen of expectedScreens) {
      assert.match(html, new RegExp(`id=["']screen-${screen}["']`));
    }
  });

  it("retains the critical browser-storage collections needed for migration", async () => {
    const html = await readLegacyApp();

    for (const key of criticalStorageKeys) {
      assert.ok(html.includes(`"${key}"`), `Missing storage key: ${key}`);
    }
  });

  it("keeps the current inline JavaScript syntactically valid", async () => {
    const script = extractInlineScript(await readLegacyApp());

    assert.doesNotThrow(() => new Function(script));
  });

  it("retains the transactional local order-save boundary", async () => {
    const html = await readLegacyApp();

    assert.ok(html.includes("orders.push(finalOrder)"));
    assert.ok(html.includes("syncSalePaymentLedger(finalOrder)"));
    assert.ok(html.includes("applyOrderStockUsage(finalOrder.stockUsage, -1)"));
    assert.ok(html.includes("await saveToStorage()"));
  });

  it("loads the cloud bootstrap module alongside the inline application", async () => {
    const html = await readLegacyApp();

    assert.match(
      html,
      /<script type="module" src="\.\/src\/client\/legacy-cloud-bootstrap\.mjs"><\/script>/,
    );
  });

  it("queues cloud synchronization only after the durable local commit", async () => {
    const html = await readLegacyApp();
    const orderCommit = html.indexOf("orders.push(finalOrder)");
    const localSave = html.indexOf("await saveToStorage()", orderCommit);
    const cloudHook = html.indexOf(
      "BiteTechCloudSync.enqueueLegacyOrder",
      orderCommit,
    );

    assert.ok(orderCommit !== -1);
    assert.ok(localSave > orderCommit, "The local order save must be awaited.");
    assert.ok(
      cloudHook > localSave,
      "Cloud queueing must happen after the local save succeeds.",
    );
  });

  it("never blocks checkout on the cloud", async () => {
    const html = await readLegacyApp();

    assert.ok(
      !html.includes("await window.BiteTechCloudSync"),
      "Checkout must not await a network call.",
    );
  });

  it("offers a cloud account panel without replacing any existing screen", async () => {
    const html = await readLegacyApp();

    assert.match(html, /id="cloud-account-modal-overlay"/);
    assert.match(html, /onclick="openCloudAccountModal\(\)"/);
    assert.match(html, /function submitCloudSignIn\(\)/);
    assert.match(html, /function submitCloudRestaurant\(\)/);
    assert.match(html, /function submitCloudImport\(\)/);
    assert.match(html, /function submitCloudSignOut\(\)/);
  });

  it("keeps the cloud panel hidden until it is opened", async () => {
    const html = await readLegacyApp();
    const overlay = html.indexOf('id="cloud-account-modal-overlay"');
    const tag = html.slice(overlay, html.indexOf(">", overlay));

    assert.match(tag, /class="hidden"/);
  });
});
