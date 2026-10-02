/**
 * Translates the existing browser collections into the exact snapshot the
 * catalog import endpoint accepts.
 *
 * This builder only reshapes and validates types. It never invents values,
 * silently drops records, or "fixes" business data: anything unusable stops the
 * import with a message naming the offending record, so no restaurant data can
 * disappear silently during a migration.
 */

export const LEGACY_SNAPSHOT_KEYS = Object.freeze([
  "pos_categories",
  "pos_subcategories",
  "pos_category_offers",
  "pos_menu",
  "pos_stock_item_defs",
  "pos_ingredient_stock",
  "pos_softdrink_stock",
  "pos_softdrink_threshold",
  "pos_icecream_stock",
  "pos_icecream_threshold",
  "pos_total_tables",
  "pos_halls_list",
  "pos_bank_accounts",
]);

export class SnapshotBuildError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "SnapshotBuildError";
    this.code = "LEGACY_SNAPSHOT_INVALID";
    this.retriable = false;
    this.detail = detail;
  }
}

function fail(message, detail) {
  throw new SnapshotBuildError(message, detail);
}

function number(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) fail(`${label} is not a number.`, { label, value });
  if (parsed < min || parsed > max) {
    fail(`${label} must be between ${min} and ${max}.`, { label, value });
  }
  return parsed;
}

function optionalNumber(value, label, options) {
  if (value === undefined || value === null || value === "") return undefined;
  return number(value, label, options);
}

/** Adds `field` only when the legacy record actually carries a usable value. */
function withOptional(target, field, value, label, options) {
  const parsed = optionalNumber(value, label, options);
  if (parsed !== undefined) target[field] = parsed;
  return target;
}

function text(value, label, { max = 500, allowEmpty = true } = {}) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean) {
    if (allowEmpty) return "";
    fail(`${label} is required.`, { label });
  }
  if (clean.length > max) fail(`${label} is too long.`, { label, max });
  return clean;
}

function dateOrNull(value, label) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    fail(`${label} must use YYYY-MM-DD.`, { label, value: clean });
  }
  return clean;
}

/**
 * A collection that was never written to this device is simply empty. A
 * collection of the wrong shape is an error, because that would hide data.
 */
function record(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  return fail(`${label} is not a collection on this device.`, { label });
}

function recordList(value, label) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return fail(`${label} is not a list on this device.`, { label });
}

function entries(source, label) {
  return Object.entries(source).filter(([, value]) => value && typeof value === "object");
}

export async function readLegacyCollections(storage) {
  const collections = {};
  for (const key of LEGACY_SNAPSHOT_KEYS) {
    collections[key] = await storage.get(key);
  }
  return collections;
}

export function buildLegacyCatalogSnapshot(collections = {}) {
  const categories = recordList(collections.pos_categories, "pos_categories")
    .map((name, index) => text(name, `Category ${index + 1}`, {
      max: 160,
      allowEmpty: false,
    }));
  const categoryNames = new Set(categories);
  if (categories.length > 1_000) fail("There are too many categories to import.", {});

  const subcategorySource = record(collections.pos_subcategories, "pos_subcategories");
  const subcategories = {};
  for (const [categoryName, names] of Object.entries(subcategorySource)) {
    if (!categoryNames.has(categoryName)) {
      fail(`Subcategories reference an unknown category: ${categoryName}`, {
        categoryName,
      });
    }
    subcategories[categoryName] = (Array.isArray(names) ? names : []).map(
      (name, index) => text(name, `Subcategory ${index + 1} in ${categoryName}`, {
        max: 160,
        allowEmpty: false,
      }),
    );
  }

  const categoryOffers = {};
  const categoryOfferSource = record(
    collections.pos_category_offers,
    "pos_category_offers",
  );
  for (const [categoryName, offer] of Object.entries(categoryOfferSource)) {
    if (!offer || typeof offer !== "object") continue;
    if (!categoryNames.has(categoryName)) {
      fail(`An offer references an unknown category: ${categoryName}`, { categoryName });
    }
    const discountType = offer.discountType === "flat" ? "flat" : "percent";
    categoryOffers[categoryName] = {
      active: offer.active === true,
      discountType,
      discountValue: number(offer.discountValue, `Category offer value for ${categoryName}`, {
        min: 0,
        max: 1_000_000,
      }),
      startDate: dateOrNull(offer.startDate, `Category offer start for ${categoryName}`),
      endDate: dateOrNull(offer.endDate, `Category offer end for ${categoryName}`),
    };
  }

  const stockDefinitions = {};
  for (const [key, definition] of entries(
    record(collections.pos_stock_item_defs, "pos_stock_item_defs"),
    "stock definitions",
  )) {
    const buyUnit = definition.buyUnit === "number" ? "number" : "kg";
    const sellUnit = definition.sellUnit === "number" ? "number" : "kg";
    const normalized = {
      label: text(definition.label, `Stock name for ${key}`, {
        max: 200,
        allowEmpty: false,
      }),
      buyUnit,
      sellUnit,
    };
    withOptional(normalized, "gramsPerPiece", definition.gramsPerPiece,
      `Grams per piece for ${key}`, { min: 0 });
    stockDefinitions[key] = normalized;
  }

  const stockKeys = new Set(Object.keys(stockDefinitions));
  const ingredientStock = {};
  for (const [key, balance] of entries(
    record(collections.pos_ingredient_stock, "pos_ingredient_stock"),
    "ingredient stock",
  )) {
    if (!stockKeys.has(key)) {
      fail(`Stock balance references an unknown stock definition: ${key}`, { stockKey: key });
    }
    ingredientStock[key] = withOptional({
      stockGrams: number(balance.stockGrams ?? 0, `Stock in grams for ${key}`),
      avgCostPerGram: number(balance.avgCostPerGram ?? 0, `Average cost for ${key}`, {
        max: 10_000_000,
      }),
      minThresholdGrams: number(balance.minThresholdGrams ?? 0, `Low-stock threshold for ${key}`),
    }, "avgUnitWeightGrams", balance.avgUnitWeightGrams, `Unit weight for ${key}`, { min: 0 });
  }

  const softDrinkStock = {};
  for (const [key, balance] of entries(
    record(collections.pos_softdrink_stock, "pos_softdrink_stock"),
    "soft-drink stock",
  )) {
    softDrinkStock[key] = {
      stockUnits: number(balance.stockUnits ?? 0, `Soft-drink units for ${key}`),
      avgCostPerUnit: number(balance.avgCostPerUnit ?? 0, `Soft-drink average cost for ${key}`, {
        max: 10_000_000,
      }),
      sellPrice: number(balance.sellPrice ?? 0, `Soft-drink selling price for ${key}`, {
        max: 10_000_000,
      }),
    };
  }

  const iceCreamStock = {};
  for (const [key, balance] of entries(
    record(collections.pos_icecream_stock, "pos_icecream_stock"),
    "ice-cream stock",
  )) {
    iceCreamStock[key] = withOptional({
      stockGrams: number(balance.stockGrams ?? 0, `Ice-cream grams for ${key}`),
      avgCostPerGram: number(balance.avgCostPerGram ?? 0, `Ice-cream average cost for ${key}`, {
        max: 10_000_000,
      }),
      sellPrice: number(balance.sellPrice ?? 0, `Ice-cream selling price for ${key}`, {
        max: 10_000_000,
      }),
    }, "minThresholdGrams", balance.minThresholdGrams, `Ice-cream threshold for ${key}`, {
      min: 0,
    });
  }

  const menuSource = recordList(collections.pos_menu, "pos_menu");
  if (menuSource.length > 10_000) fail("There are too many menu items to import.", {});
  const menu = menuSource.map((item, index) => {
    const label = `Menu item ${item?.id ?? index + 1}`;
    const category = text(item?.category, `${label} category`, { max: 160, allowEmpty: false });
    if (!categoryNames.has(category)) {
      fail(`${label} references an unknown category: ${category}`, { category });
    }
    const subcategory = text(item?.subcategory ?? "", `${label} subcategory`, { max: 160 });
    if (subcategory && !(subcategories[category] ?? []).includes(subcategory)) {
      fail(`${label} references an unknown subcategory: ${subcategory}`, { subcategory });
    }
    const normalized = {
      id: number(item?.id, `${label} identifier`, { min: 0 }),
      category,
      subcategory: subcategory || null,
      name: text(item?.name, `${label} name`, { max: 200, allowEmpty: false }),
      desc: text(item?.desc ?? "", `${label} description`, { max: 2_000 }),
      price: number(item?.price, `${label} price`, { max: 10_000_000 }),
    };
    withOptional(normalized, "itemNumber", item?.itemNumber, `${label} number`, { min: 1 });
    withOptional(normalized, "recipeOthersCost", item?.recipeOthersCost, `${label} other cost`, {
      min: 0,
    });
    for (const key of Object.keys(stockDefinitions)) {
      withOptional(normalized, `recipe${key}`, item?.[`recipe${key}`],
        `${label} recipe for ${key}`, { min: 0 });
    }
    if (Array.isArray(item?.dealComponents) && item.dealComponents.length > 0) {
      normalized.dealComponents = item.dealComponents.map((component, componentIndex) => ({
        itemId: number(component?.itemId, `${label} component ${componentIndex + 1}`, { min: 0 }),
        qty: number(component?.qty, `${label} component ${componentIndex + 1} quantity`, {
          min: 0,
          max: 10_000,
        }),
      }));
    }
    if (item?.offerActive === true) {
      normalized.offerActive = true;
      normalized.offerPrice = number(item.offerPrice, `${label} offer price`, { max: 10_000_000 });
      normalized.offerStartDate = dateOrNull(item.offerStartDate, `${label} offer start`);
      normalized.offerEndDate = dateOrNull(item.offerEndDate, `${label} offer end`);
    }
    if (typeof item?.softDrinkKey === "string" && item.softDrinkKey) {
      normalized.softDrinkKey = text(item.softDrinkKey, `${label} soft-drink key`, {
        max: 300,
        allowEmpty: false,
      });
    }
    if (typeof item?.iceCreamKey === "string" && item.iceCreamKey) {
      normalized.iceCreamKey = text(item.iceCreamKey, `${label} ice-cream key`, {
        max: 300,
        allowEmpty: false,
      });
    }
    return normalized;
  });

  const halls = recordList(collections.pos_halls_list, "pos_halls_list")
    .map((name, index) => text(name, `Dining area ${index + 1}`, {
      max: 160,
      allowEmpty: false,
    }));

  const bankAccounts = recordList(collections.pos_bank_accounts, "pos_bank_accounts")
    .map((account, index) => {
    const label = `Bank account ${index + 1}`;
    const id = account?.id;
    if (typeof id !== "string" && !Number.isInteger(id)) {
      fail(`${label} has no identifier.`, { label });
    }
    return {
      id: typeof id === "string" ? text(id, `${label} identifier`, { max: 100, allowEmpty: false }) : id,
      displayName: text(account?.displayName, `${label} name`, { max: 160, allowEmpty: false }),
      bankName: text(account?.bankName, `${label} bank`, { max: 160, allowEmpty: false }),
      accountNumber: text(account?.accountNumber ?? "", `${label} account number`, { max: 100 }),
      openingBalance: number(account?.openingBalance ?? 0, `${label} opening balance`, {
        min: -10_000_000,
        max: 10_000_000,
      }),
      asOfDate: dateOrNull(account?.asOfDate, `${label} balance date`),
      active: account?.active !== false,
    };
  });

  return {
    pos_categories: categories,
    pos_subcategories: subcategories,
    pos_category_offers: categoryOffers,
    pos_menu: menu,
    pos_stock_item_defs: stockDefinitions,
    pos_ingredient_stock: ingredientStock,
    pos_softdrink_stock: softDrinkStock,
    pos_softdrink_threshold: number(collections.pos_softdrink_threshold ?? 6, "Soft-drink low-stock threshold"),
    pos_icecream_stock: iceCreamStock,
    pos_icecream_threshold: number(collections.pos_icecream_threshold ?? 500, "Ice-cream low-stock threshold"),
    pos_total_tables: Math.trunc(number(collections.pos_total_tables ?? 0, "Table count", {
      min: 0,
      max: 10_000,
    })),
    pos_halls_list: halls,
    pos_bank_accounts: bankAccounts,
  };
}