import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLegacyCatalogImportService } from "../src/server/pos/legacy-catalog-import-service.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const branchId = "33333333-3333-4333-8333-333333333333";

function snapshot() {
  return {
    pos_categories: ["Burgers", "Deals"],
    pos_subcategories: { Burgers: ["Chicken"], Deals: [] },
    pos_category_offers: {
      Burgers: {
        active: true, discountType: "percent", discountValue: 10,
        startDate: "2026-10-01", endDate: "2026-10-31",
      },
    },
    pos_menu: [
      {
        id: 1, itemNumber: 101, category: "Burgers", subcategory: "Chicken",
        name: "Zinger", desc: "Crispy burger", price: 500,
        recipeOthersCost: 20, recipeDough: 100, dealComponents: [], offerActive: true,
        offerPrice: 450, offerStartDate: null, offerEndDate: null,
      },
      {
        id: 2, itemNumber: 201, category: "Deals", name: "Zinger Deal",
        price: 800, dealComponents: [{ itemId: 1, qty: 2 }],
      },
    ],
    pos_stock_item_defs: {
      Dough: { label: "Dough", buyUnit: "kg", sellUnit: "kg" },
    },
    pos_ingredient_stock: {
      Dough: { stockGrams: 5_000, avgCostPerGram: 0.2, minThresholdGrams: 500 },
    },
    pos_total_tables: 2,
    pos_halls_list: ["Main Hall"],
    pos_bank_accounts: [{
      id: 7, displayName: "Main Bank", bankName: "Example Bank",
      accountNumber: "1234567890", openingBalance: 1_500,
      asOfDate: "2026-10-01", active: true,
    }],
  };
}

function fakePool({ failOnMenu = false } = {}) {
  const calls = [];
  let connections = 0;
  const client = {
    async query(text, values = []) {
      const normalized = text.replace(/\s+/g, " ").trim();
      calls.push({ text: normalized, values });
      if (normalized.startsWith("INSERT INTO menu_categories")) {
        return { rows: [{ id: `category-${values[2]}` }] };
      }
      if (normalized.startsWith("INSERT INTO menu_subcategories")) {
        return { rows: [{ id: `subcategory-${values[3]}` }] };
      }
      if (normalized.startsWith("INSERT INTO menu_items")) {
        if (failOnMenu) throw new Error("database rejected menu");
        return { rows: [{ id: `menu-${values[2]}` }] };
      }
      if (normalized.startsWith("INSERT INTO stock_items")) {
        return { rows: [{ id: `stock-${values[2]}` }] };
      }
      if (normalized.startsWith("INSERT INTO dining_areas")) {
        return { rows: [{ id: `area-${values[3]}` }] };
      }
      if (normalized.startsWith("INSERT INTO restaurant_tables")) {
        return { rows: [{ id: `table-${values[3]}` }] };
      }
      if (normalized.startsWith("INSERT INTO financial_accounts")) {
        return { rows: [{ id: `account-${values[3]}` }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    calls,
    get connections() { return connections; },
    async connect() { connections += 1; return client; },
  };
}

describe("legacy catalog import service", () => {
  it("upserts a complete catalog and returns stable cloud ID mappings atomically", async () => {
    const pool = fakePool();
    const result = await createLegacyCatalogImportService(pool).import({
      restaurantId, branchId, userId, snapshot: snapshot(),
    });

    assert.deepEqual(result.counts, {
      categories: 2, subcategories: 1, menuItems: 2,
      stockItems: 1, tables: 2, financialAccounts: 1,
    });
    assert.equal(result.menuItems[1], "menu-1");
    assert.equal(result.menuItems[2], "menu-2");
    assert.ok(pool.calls.some((call) => call.text.startsWith("INSERT INTO menu_item_components")));
    assert.ok(pool.calls.some((call) => call.text.startsWith("INSERT INTO menu_item_offers")));
    assert.ok(pool.calls.some((call) => call.text.startsWith("INSERT INTO menu_category_offers")));
    assert.ok(pool.calls.some((call) => call.text.startsWith("INSERT INTO menu_item_recipe_items")));
    assert.equal(result.stockItems.Dough, "stock-Dough");
    assert.equal(result.tables[1], "table-1");
    assert.equal(result.financialAccounts[7], "account-7");
    const itemInsert = pool.calls.find((call) => call.text.startsWith("INSERT INTO menu_items"));
    assert.equal(itemInsert.values[9], 50_000);
    assert.equal(itemInsert.values[10], 2_000);
    const accountInsert = pool.calls.find((call) => call.text.startsWith("INSERT INTO financial_accounts"));
    assert.equal(accountInsert.values[6], "••••7890");
    assert.equal(pool.calls.at(-1).text, "COMMIT");
  });

  it("rejects missing deal components before opening a transaction", async () => {
    const pool = fakePool();
    const invalid = snapshot();
    invalid.pos_menu[1].dealComponents = [{ itemId: 999, qty: 1 }];
    await assert.rejects(
      createLegacyCatalogImportService(pool).import({ restaurantId, branchId, userId, snapshot: invalid }),
      (error) => error.code === "INVALID_LEGACY_CATALOG",
    );
    assert.equal(pool.connections, 0);
  });

  it("rejects indirect circular deals before opening a transaction", async () => {
    const pool = fakePool();
    const invalid = snapshot();
    invalid.pos_menu[0].dealComponents = [{ itemId: 2, qty: 1 }];
    await assert.rejects(
      createLegacyCatalogImportService(pool).import({ restaurantId, branchId, userId, snapshot: invalid }),
      (error) => error.code === "INVALID_LEGACY_CATALOG",
    );
    assert.equal(pool.connections, 0);
  });

  it("rolls back every catalog write when PostgreSQL rejects an item", async () => {
    const pool = fakePool({ failOnMenu: true });
    await assert.rejects(
      createLegacyCatalogImportService(pool).import({
        restaurantId, branchId, userId, snapshot: snapshot(),
      }),
      /database rejected menu/,
    );
    assert.equal(pool.calls.at(-1).text, "ROLLBACK");
  });
});
