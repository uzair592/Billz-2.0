import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildLegacyCatalogSnapshot,
  LEGACY_SNAPSHOT_KEYS,
  readLegacyCollections,
} from "../src/client/legacy-catalog-snapshot.mjs";
import { legacyCatalogSchema } from "../src/server/http/app.mjs";

function memoryStorage(values = {}) {
  const store = new Map(Object.entries(values));
  return {
    async get(key) { return structuredClone(store.get(key)); },
    async set(key, value) { store.set(key, structuredClone(value)); },
  };
}

const collections = {
  pos_categories: ["Burgers", "Drinks", "Ice Cream"],
  pos_subcategories: { Burgers: ["Zinger"], Drinks: [] },
  pos_category_offers: {
    Burgers: {
      active: true,
      discountType: "percent",
      discountValue: 10,
      startDate: "",
      endDate: null,
    },
  },
  pos_menu: [
    {
      id: 7,
      itemNumber: 1,
      category: "Burgers",
      subcategory: "Zinger",
      name: "Zinger",
      desc: "Spicy",
      price: 650,
      recipeDough: 120,
      recipeChicken: 150,
      recipeCheese: 20,
      recipeOthersCost: 10,
      dealComponents: [],
    },
    {
      id: 8,
      category: "Drinks",
      subcategory: "",
      name: "Cola 330ml",
      desc: "",
      price: 120,
      softDrinkKey: "Cola|Original|330",
      recipeDough: 0,
    },
  ],
  pos_stock_item_defs: {
    Dough: { label: "Dough", buyUnit: "kg", sellUnit: "kg" },
    Nuggets: { label: "Nuggets", buyUnit: "kg", sellUnit: "number" },
  },
  pos_ingredient_stock: {
    Dough: { stockGrams: 5_000, avgCostPerGram: 0.45, minThresholdGrams: 500 },
    Nuggets: {
      stockGrams: 2_000, avgCostPerGram: 0.9, minThresholdGrams: 400, avgUnitWeightGrams: 25,
    },
  },
  pos_softdrink_stock: {
    "Cola|Original|330": { stockUnits: 24, avgCostPerUnit: 90, sellPrice: 120 },
  },
  pos_softdrink_threshold: 6,
  pos_icecream_stock: {
    "Vanilla|Chocolate|100": { stockGrams: 4_000, avgCostPerGram: 0.6, sellPrice: 200 },
  },
  pos_icecream_threshold: 500,
  pos_total_tables: 12,
  pos_halls_list: ["Main Hall", "Family Hall"],
  pos_bank_accounts: [{
    id: 9,
    displayName: "Meezan",
    bankName: "Meezan Bank",
    accountNumber: "0102 0107 0001 23",
    openingBalance: 5_000,
    asOfDate: "2026-09-01",
    active: true,
  }],
};

describe("legacy catalog snapshot builder", () => {
  it("reads exactly the collections the import endpoint needs", async () => {
    const requested = [];
    const storage = {
      async get(key) { requested.push(key); return collections[key]; },
      async set() {},
    };

    const read = await readLegacyCollections(storage);

    assert.deepEqual(requested, [...LEGACY_SNAPSHOT_KEYS]);
    assert.equal(read.pos_menu.length, 2);
  });

  it("produces a payload the server contract accepts", () => {
    const snapshot = buildLegacyCatalogSnapshot(collections);

    assert.doesNotThrow(() => legacyCatalogSchema.parse(snapshot));
  });

  it("keeps only defined optional legacy fields", () => {
    const snapshot = buildLegacyCatalogSnapshot(collections);

    assert.equal("itemNumber" in snapshot.pos_menu[1], false);
    assert.equal(snapshot.pos_menu[0].itemNumber, 1);
    assert.equal("recipeCheese" in snapshot.pos_menu[1], false);
    assert.equal(snapshot.pos_menu[1].subcategory, null);
    assert.equal("offerActive" in snapshot.pos_menu[0], false);
    assert.equal(snapshot.pos_menu[1].softDrinkKey, "Cola|Original|330");
    assert.deepEqual(snapshot.pos_category_offers.Burgers, {
      active: true,
      discountType: "percent",
      discountValue: 10,
      startDate: null,
      endDate: null,
    });
  });

  it("keeps an inactive category offer instead of silently dropping it", () => {
    const snapshot = buildLegacyCatalogSnapshot({
      ...collections,
      pos_category_offers: {
        Burgers: { active: false, discountType: "flat", discountValue: 50 },
      },
    });

    assert.equal(snapshot.pos_category_offers.Burgers.active, false);
    assert.equal(snapshot.pos_category_offers.Burgers.discountType, "flat");
  });

  it("maps ice-cream serving sizes and drink units without reinterpretation", () => {
    const snapshot = buildLegacyCatalogSnapshot(collections);

    assert.equal(snapshot.pos_softdrink_threshold, 6);
    assert.equal(snapshot.pos_icecream_threshold, 500);
    assert.deepEqual(snapshot.pos_softdrink_stock["Cola|Original|330"], {
      stockUnits: 24,
      avgCostPerUnit: 90,
      sellPrice: 120,
    });
    assert.deepEqual(snapshot.pos_icecream_stock["Vanilla|Chocolate|100"], {
      stockGrams: 4_000,
      avgCostPerGram: 0.6,
      sellPrice: 200,
    });
    assert.equal(snapshot.pos_stock_item_defs.Nuggets.sellUnit, "number");
    assert.equal(snapshot.pos_stock_item_defs.Nuggets.gramsPerPiece, undefined);
    assert.equal(snapshot.pos_ingredient_stock.Nuggets.avgUnitWeightGrams, 25);
  });

  it("preserves deal components, tables, halls, and masked bank accounts", () => {
    const snapshot = buildLegacyCatalogSnapshot({
      ...collections,
      pos_menu: [{
        id: 21,
        category: "Burgers",
        name: "Deal",
        price: 1_200,
        dealComponents: [{ itemId: 7, qty: 2 }],
        offerActive: true,
        offerPrice: 999,
        offerStartDate: "2026-10-01",
        offerEndDate: "2026-10-31",
      }],
    });

    assert.deepEqual(snapshot.pos_menu[0].dealComponents, [{ itemId: 7, qty: 2 }]);
    assert.equal(snapshot.pos_menu[0].offerPrice, 999);
    assert.equal(snapshot.pos_menu[0].offerStartDate, "2026-10-01");
    assert.equal(snapshot.pos_total_tables, 12);
    assert.deepEqual(snapshot.pos_halls_list, ["Main Hall", "Family Hall"]);
    assert.deepEqual(snapshot.pos_bank_accounts, [{
      id: 9,
      displayName: "Meezan",
      bankName: "Meezan Bank",
      accountNumber: "0102 0107 0001 23",
      openingBalance: 5_000,
      asOfDate: "2026-09-01",
      active: true,
    }]);
    assert.doesNotThrow(() => legacyCatalogSchema.parse(snapshot));
  });

  it("refuses to build a snapshot that would lose data", () => {
    const cases = [
      [{ ...collections, pos_menu: [{ id: 1, category: "Ghost", name: "X", price: 1 }] }, /Menu item 1 references an unknown category: Ghost/],
      [{ ...collections, pos_menu: [{ id: 1, category: "Burgers", subcategory: "Ghost", name: "X", price: 1 }] }, /Menu item 1 references an unknown subcategory: Ghost/],
      [{ ...collections, pos_menu: [{ id: 1, category: "Burgers", name: "X", price: "abc" }] }, /Menu item 1 price is not a number/],
      [{ ...collections, pos_menu: [{ id: 1, category: "Burgers", name: "", price: 1 }] }, /Menu item 1 name is required/],
      [{ ...collections, pos_subcategories: { Ghost: [] } }, /unknown category: Ghost/],
      [{ ...collections, pos_category_offers: { Ghost: { active: true, discountType: "flat", discountValue: 1 } } }, /unknown category: Ghost/],
      [{ ...collections, pos_ingredient_stock: { Ghost: { stockGrams: 1 } } }, /unknown stock definition: Ghost/],
      [{ ...collections, pos_stock_item_defs: [] }, /pos_stock_item_defs is not a collection/],
      [{ ...collections, pos_bank_accounts: "nope" }, /pos_bank_accounts is not a list/],
      [{ ...collections, pos_total_tables: -1 }, /Table count must be between/],
    ];

    for (const [input, message] of cases) {
      assert.throws(() => buildLegacyCatalogSnapshot(input), message);
    }
  });

  it("marks a rejected snapshot as permanently invalid rather than retryable", () => {
    assert.throws(
      () => buildLegacyCatalogSnapshot({ ...collections, pos_menu: [{ id: 1 }] }),
      (error) => error.code === "LEGACY_SNAPSHOT_INVALID" && error.retriable === false,
    );
  });
});