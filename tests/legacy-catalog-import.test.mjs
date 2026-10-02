import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLegacyCatalogImportService } from "../src/server/pos/legacy-catalog-import-service.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

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
        recipeOthersCost: 20, dealComponents: [], offerActive: true,
        offerPrice: 450, offerStartDate: null, offerEndDate: null,
      },
      {
        id: 2, itemNumber: 201, category: "Deals", name: "Zinger Deal",
        price: 800, dealComponents: [{ itemId: 1, qty: 2 }],
      },
    ],
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
      restaurantId, userId, snapshot: snapshot(),
    });

    assert.deepEqual(result.counts, { categories: 2, subcategories: 1, menuItems: 2 });
    assert.equal(result.menuItems[1], "menu-1");
    assert.equal(result.menuItems[2], "menu-2");
    assert.ok(pool.calls.some((call) => call.text.startsWith("INSERT INTO menu_item_components")));
    assert.ok(pool.calls.some((call) => call.text.startsWith("INSERT INTO menu_item_offers")));
    assert.ok(pool.calls.some((call) => call.text.startsWith("INSERT INTO menu_category_offers")));
    const itemInsert = pool.calls.find((call) => call.text.startsWith("INSERT INTO menu_items"));
    assert.equal(itemInsert.values[9], 50_000);
    assert.equal(itemInsert.values[10], 2_000);
    assert.equal(pool.calls.at(-1).text, "COMMIT");
  });

  it("rejects missing deal components before opening a transaction", async () => {
    const pool = fakePool();
    const invalid = snapshot();
    invalid.pos_menu[1].dealComponents = [{ itemId: 999, qty: 1 }];
    await assert.rejects(
      createLegacyCatalogImportService(pool).import({ restaurantId, userId, snapshot: invalid }),
      (error) => error.code === "INVALID_LEGACY_CATALOG",
    );
    assert.equal(pool.connections, 0);
  });

  it("rejects indirect circular deals before opening a transaction", async () => {
    const pool = fakePool();
    const invalid = snapshot();
    invalid.pos_menu[0].dealComponents = [{ itemId: 2, qty: 1 }];
    await assert.rejects(
      createLegacyCatalogImportService(pool).import({ restaurantId, userId, snapshot: invalid }),
      (error) => error.code === "INVALID_LEGACY_CATALOG",
    );
    assert.equal(pool.connections, 0);
  });

  it("rolls back every catalog write when PostgreSQL rejects an item", async () => {
    const pool = fakePool({ failOnMenu: true });
    await assert.rejects(
      createLegacyCatalogImportService(pool).import({
        restaurantId, userId, snapshot: snapshot(),
      }),
      /database rejected menu/,
    );
    assert.equal(pool.calls.at(-1).text, "ROLLBACK");
  });
});
