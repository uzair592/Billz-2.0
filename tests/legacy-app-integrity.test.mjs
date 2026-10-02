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
});
