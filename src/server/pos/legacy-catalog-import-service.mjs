import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../database/tenant-transaction.mjs";

function importError(message, code = "INVALID_LEGACY_CATALOG", details) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  if (details !== undefined) error.details = details;
  return error;
}

function unique(values, label) {
  const seen = new Set();
  for (const value of values) {
    const key = String(value);
    if (seen.has(key)) throw importError(`Duplicate ${label}: ${key}`);
    seen.add(key);
  }
}

function itemType(item) {
  if (Array.isArray(item.dealComponents) && item.dealComponents.length > 0) return "deal";
  const category = item.category.toLowerCase();
  if (category === "drinks" || category.includes("soft drink")) return "soft_drink";
  if (category.includes("ice cream")) return "ice_cream";
  return "standard";
}

function minor(value) {
  return Math.round(Number(value) * 100);
}

function gramsPerPiece(definition, balance) {
  return Number(balance?.avgUnitWeightGrams) || Number(definition.gramsPerPiece) || 0;
}

function recipeBaseQuantity(definition, balance, quantity) {
  const value = Number(quantity) || 0;
  if (definition.buyUnit === definition.sellUnit) return value;
  const conversion = gramsPerPiece(definition, balance);
  if (definition.buyUnit === "kg" && definition.sellUnit === "number") {
    return value * conversion;
  }
  if (definition.buyUnit === "number" && definition.sellUnit === "kg") {
    return conversion > 0 ? value / conversion : 0;
  }
  return value;
}

function maskedAccountNumber(value) {
  const clean = String(value ?? "").replace(/\s+/g, "");
  if (!clean) return null;
  return clean.length <= 4 ? clean : `••••${clean.slice(-4)}`;
}

export function createLegacyCatalogImportService(pool) {
  return Object.freeze({
    async import({ restaurantId, branchId, userId, snapshot }) {
      unique(snapshot.pos_categories, "category");
      unique(snapshot.pos_menu.map((item) => item.id), "legacy menu item ID");
      const itemNumbers = snapshot.pos_menu.map((item) => item.itemNumber ?? item.id);
      unique(itemNumbers, "menu item number");

      const categoryNames = new Set(snapshot.pos_categories);
      for (const categoryName of Object.keys(snapshot.pos_subcategories)) {
        if (!categoryNames.has(categoryName)) {
          throw importError(`Subcategories reference an unknown category: ${categoryName}`);
        }
      }
      for (const [categoryName, offer] of Object.entries(snapshot.pos_category_offers)) {
        if (!categoryNames.has(categoryName)) {
          throw importError(`An offer references an unknown category: ${categoryName}`);
        }
        if (offer.startDate && offer.endDate && offer.startDate > offer.endDate) {
          throw importError(`Category offer dates are invalid: ${categoryName}`);
        }
      }
      for (const item of snapshot.pos_menu) {
        if (!categoryNames.has(item.category)) {
          throw importError(`Menu item ${item.id} references an unknown category.`, undefined, {
            legacyItemId: item.id,
            category: item.category,
          });
        }
        const allowedSubcategories = snapshot.pos_subcategories[item.category] ?? [];
        if (item.subcategory && !allowedSubcategories.includes(item.subcategory)) {
          throw importError(`Menu item ${item.id} references an unknown subcategory.`, undefined, {
            legacyItemId: item.id,
            subcategory: item.subcategory,
          });
        }
        if (item.offerActive) {
          if (!(item.offerPrice > 0) || item.offerPrice >= item.price) {
            throw importError(`Menu item ${item.id} has an invalid offer price.`);
          }
          if (item.offerStartDate && item.offerEndDate
              && item.offerStartDate > item.offerEndDate) {
            throw importError(`Menu item ${item.id} has invalid offer dates.`);
          }
        }
        unique(
          (item.dealComponents ?? []).map((component) => component.itemId),
          `deal component in menu item ${item.id}`,
        );
      }
      unique(snapshot.pos_halls_list, "dining area");
      unique(snapshot.pos_bank_accounts.map((account) => account.id), "bank account ID");
      unique(snapshot.pos_bank_accounts.map((account) => account.displayName), "bank display name");
      for (const key of Object.keys(snapshot.pos_ingredient_stock)) {
        if (!snapshot.pos_stock_item_defs[key]) {
          throw importError(`Stock balance references an unknown stock definition: ${key}`);
        }
      }

      const importedLegacyIds = new Set(snapshot.pos_menu.map((item) => String(item.id)));
      for (const item of snapshot.pos_menu) {
        for (const component of item.dealComponents ?? []) {
          if (!importedLegacyIds.has(String(component.itemId))) {
            throw importError(`Deal ${item.id} references a menu item outside this snapshot.`, undefined, {
              legacyItemId: item.id,
              componentLegacyItemId: component.itemId,
            });
          }
          if (String(component.itemId) === String(item.id)) {
            throw importError(`Deal ${item.id} cannot contain itself.`);
          }
        }
      }
      const componentsByItem = new Map(snapshot.pos_menu.map((item) => [
        String(item.id),
        (item.dealComponents ?? []).map((component) => String(component.itemId)),
      ]));
      const visiting = new Set();
      const visited = new Set();
      function visit(legacyItemId) {
        if (visiting.has(legacyItemId)) {
          throw importError("The legacy catalog contains a circular deal component graph.", undefined, {
            legacyItemId: Number(legacyItemId),
          });
        }
        if (visited.has(legacyItemId)) return;
        visiting.add(legacyItemId);
        for (const componentId of componentsByItem.get(legacyItemId) ?? []) visit(componentId);
        visiting.delete(legacyItemId);
        visited.add(legacyItemId);
      }
      for (const legacyItemId of componentsByItem.keys()) visit(legacyItemId);

      return withTenantTransaction(pool, { restaurantId, userId }, async (client) => {
        const categoryIds = new Map();
        for (let index = 0; index < snapshot.pos_categories.length; index += 1) {
          const name = snapshot.pos_categories[index];
          const result = await client.query(
            `INSERT INTO menu_categories (id, restaurant_id, name, sort_order, is_active)
             VALUES ($1, $2, $3, $4, true)
             ON CONFLICT (restaurant_id, name)
             DO UPDATE SET sort_order = EXCLUDED.sort_order, is_active = true
             RETURNING id`,
            [randomUUID(), restaurantId, name, index],
          );
          categoryIds.set(name, result.rows[0].id);
        }

        const subcategoryIds = new Map();
        for (const categoryName of snapshot.pos_categories) {
          const names = snapshot.pos_subcategories[categoryName] ?? [];
          unique(names, `subcategory in ${categoryName}`);
          for (let index = 0; index < names.length; index += 1) {
            const name = names[index];
            const categoryId = categoryIds.get(categoryName);
            const result = await client.query(
              `INSERT INTO menu_subcategories (
                 id, restaurant_id, category_id, name, sort_order, is_active
               ) VALUES ($1, $2, $3, $4, $5, true)
               ON CONFLICT (restaurant_id, category_id, name)
               DO UPDATE SET sort_order = EXCLUDED.sort_order, is_active = true
               RETURNING id`,
              [randomUUID(), restaurantId, categoryId, name, index],
            );
            subcategoryIds.set(`${categoryName}\u0000${name}`, result.rows[0].id);
          }
        }

        const menuItemIds = new Map();
        for (const item of snapshot.pos_menu) {
          const categoryId = categoryIds.get(item.category);
          const subcategoryId = item.subcategory
            ? subcategoryIds.get(`${item.category}\u0000${item.subcategory}`)
            : null;
          const result = await client.query(
            `INSERT INTO menu_items (
               id, restaurant_id, legacy_item_id, item_number, category_id,
               subcategory_id, name, description, item_type, price_minor,
               other_cost_minor, metadata, is_active
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
             ON CONFLICT (restaurant_id, legacy_item_id)
             DO UPDATE SET item_number = EXCLUDED.item_number,
               category_id = EXCLUDED.category_id,
               subcategory_id = EXCLUDED.subcategory_id,
               name = EXCLUDED.name,
               description = EXCLUDED.description,
               item_type = EXCLUDED.item_type,
               price_minor = EXCLUDED.price_minor,
               other_cost_minor = EXCLUDED.other_cost_minor,
               metadata = EXCLUDED.metadata,
               is_active = true
             RETURNING id`,
            [
              randomUUID(), restaurantId, item.id, item.itemNumber ?? item.id,
              categoryId, subcategoryId, item.name, item.desc ?? null,
              itemType(item), minor(item.price), minor(item.recipeOthersCost ?? 0),
              JSON.stringify({ importedFrom: "legacy-pos", legacyCategory: item.category }),
            ],
          );
          menuItemIds.set(String(item.id), result.rows[0].id);
        }

        for (const item of snapshot.pos_menu) {
          const menuItemId = menuItemIds.get(String(item.id));
          await client.query(
            `DELETE FROM menu_item_components WHERE menu_item_id = $1`,
            [menuItemId],
          );
          for (const component of item.dealComponents ?? []) {
            await client.query(
              `INSERT INTO menu_item_components (
                 restaurant_id, menu_item_id, component_menu_item_id, quantity
               ) VALUES ($1, $2, $3, $4)`,
              [
                restaurantId, menuItemId,
                menuItemIds.get(String(component.itemId)), component.qty,
              ],
            );
          }

          await client.query(`DELETE FROM menu_item_offers WHERE menu_item_id = $1`, [menuItemId]);
          if (item.offerActive && item.offerPrice > 0 && item.offerPrice < item.price) {
            await client.query(
              `INSERT INTO menu_item_offers (
                 restaurant_id, menu_item_id, offer_price_minor,
                 starts_on, ends_on, is_active
               ) VALUES ($1, $2, $3, $4, $5, true)`,
              [
                restaurantId, menuItemId, minor(item.offerPrice),
                item.offerStartDate ?? null, item.offerEndDate ?? null,
              ],
            );
          }
        }

        for (const categoryName of snapshot.pos_categories) {
          const categoryId = categoryIds.get(categoryName);
          await client.query(`DELETE FROM menu_category_offers WHERE category_id = $1`, [categoryId]);
          const offer = snapshot.pos_category_offers[categoryName];
          if (!offer?.active) continue;
          await client.query(
            `INSERT INTO menu_category_offers (
               restaurant_id, category_id, discount_type, discount_minor,
               discount_percent, starts_on, ends_on, is_active
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
            [
              restaurantId, categoryId, offer.discountType,
              offer.discountType === "flat" ? minor(offer.discountValue) : null,
              offer.discountType === "percent" ? offer.discountValue : null,
              offer.startDate ?? null, offer.endDate ?? null,
            ],
          );
        }

        const stockItemIds = new Map();
        for (const [legacyKey, definition] of Object.entries(snapshot.pos_stock_item_defs)) {
          const balance = snapshot.pos_ingredient_stock[legacyKey] ?? {};
          const baseUnit = definition.buyUnit === "number" ? "piece" : "gram";
          const conversion = definition.buyUnit === "kg"
            ? (definition.sellUnit === "number" ? gramsPerPiece(definition, balance) || null : 1000)
            : 1;
          const result = await client.query(
            `INSERT INTO stock_items (
               id, restaurant_id, legacy_key, name, stock_type, base_unit,
               sell_unit, base_units_per_sell_unit, low_stock_threshold,
               metadata, is_active
             ) VALUES ($1, $2, $3, $4, 'ingredient', $5, $6, $7, $8, $9, true)
             ON CONFLICT (restaurant_id, legacy_key)
             DO UPDATE SET name = EXCLUDED.name, base_unit = EXCLUDED.base_unit,
               sell_unit = EXCLUDED.sell_unit,
               base_units_per_sell_unit = EXCLUDED.base_units_per_sell_unit,
               low_stock_threshold = EXCLUDED.low_stock_threshold,
               metadata = EXCLUDED.metadata, is_active = true
             RETURNING id`,
            [
              randomUUID(), restaurantId, legacyKey, definition.label, baseUnit,
              definition.sellUnit, conversion, Number(balance.minThresholdGrams) || 0,
              JSON.stringify({
                importedFrom: "legacy-pos",
                buyUnit: definition.buyUnit,
                icon: definition.icon ?? null,
                color: definition.color ?? null,
              }),
            ],
          );
          const stockItemId = result.rows[0].id;
          stockItemIds.set(legacyKey, stockItemId);
          await client.query(
            `INSERT INTO inventory_balances (
               restaurant_id, branch_id, stock_item_id, quantity_base_units,
               average_cost_minor_per_base_unit
             ) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (restaurant_id, branch_id, stock_item_id)
             DO UPDATE SET quantity_base_units = EXCLUDED.quantity_base_units,
               average_cost_minor_per_base_unit = EXCLUDED.average_cost_minor_per_base_unit,
               version = inventory_balances.version + 1`,
            [
              restaurantId, branchId, stockItemId,
              Number(balance.stockGrams) || 0,
              Number(balance.avgCostPerGram) * 100 || 0,
            ],
          );
        }

        for (const item of snapshot.pos_menu) {
          const menuItemId = menuItemIds.get(String(item.id));
          await client.query(`DELETE FROM menu_item_recipe_items WHERE menu_item_id = $1`, [menuItemId]);
          for (const [legacyKey, stockItemId] of stockItemIds) {
            const definition = snapshot.pos_stock_item_defs[legacyKey];
            const quantity = recipeBaseQuantity(
              definition,
              snapshot.pos_ingredient_stock[legacyKey],
              item[`recipe${legacyKey}`],
            );
            if (quantity <= 0) continue;
            await client.query(
              `INSERT INTO menu_item_recipe_items (
                 restaurant_id, menu_item_id, stock_item_id, quantity_base_units
               ) VALUES ($1, $2, $3, $4)`,
              [restaurantId, menuItemId, stockItemId, quantity],
            );
          }
        }

        const diningAreaIds = new Map();
        for (let index = 0; index < snapshot.pos_halls_list.length; index += 1) {
          const name = snapshot.pos_halls_list[index];
          const result = await client.query(
            `INSERT INTO dining_areas (
               id, restaurant_id, branch_id, name, sort_order, is_active
             ) VALUES ($1, $2, $3, $4, $5, true)
             ON CONFLICT (restaurant_id, branch_id, name)
             DO UPDATE SET sort_order = EXCLUDED.sort_order, is_active = true
             RETURNING id`,
            [randomUUID(), restaurantId, branchId, name, index],
          );
          diningAreaIds.set(name, result.rows[0].id);
        }

        const tableIds = new Map();
        for (let tableNumber = 1; tableNumber <= snapshot.pos_total_tables; tableNumber += 1) {
          const result = await client.query(
            `INSERT INTO restaurant_tables (
               id, restaurant_id, branch_id, table_number, is_active
             ) VALUES ($1, $2, $3, $4, true)
             ON CONFLICT (restaurant_id, branch_id, table_number)
             DO UPDATE SET is_active = true
             RETURNING id`,
            [randomUUID(), restaurantId, branchId, String(tableNumber)],
          );
          tableIds.set(String(tableNumber), result.rows[0].id);
        }

        const financialAccountIds = new Map();
        for (const account of snapshot.pos_bank_accounts) {
          const legacyAccountId = String(account.id);
          const result = await client.query(
            `INSERT INTO financial_accounts (
               id, restaurant_id, branch_id, legacy_account_id, account_type,
               display_name, bank_name, masked_account_number,
               opening_balance_minor, opening_balance_date, is_active
             ) VALUES ($1, $2, $3, $4, 'bank', $5, $6, $7, $8, $9, $10)
             ON CONFLICT (restaurant_id, legacy_account_id)
             DO UPDATE SET display_name = EXCLUDED.display_name,
               bank_name = EXCLUDED.bank_name,
               masked_account_number = EXCLUDED.masked_account_number,
               opening_balance_minor = EXCLUDED.opening_balance_minor,
               opening_balance_date = EXCLUDED.opening_balance_date,
               is_active = EXCLUDED.is_active
             RETURNING id`,
            [
              randomUUID(), restaurantId, branchId, legacyAccountId,
              account.displayName, account.bankName,
              maskedAccountNumber(account.accountNumber), minor(account.openingBalance),
              account.asOfDate ?? null, account.active !== false,
            ],
          );
          financialAccountIds.set(legacyAccountId, result.rows[0].id);
        }

        return {
          categories: Object.fromEntries(categoryIds),
          subcategories: Object.fromEntries(subcategoryIds),
          menuItems: Object.fromEntries(menuItemIds),
          stockItems: Object.fromEntries(stockItemIds),
          diningAreas: Object.fromEntries(diningAreaIds),
          tables: Object.fromEntries(tableIds),
          financialAccounts: Object.fromEntries(financialAccountIds),
          counts: {
            categories: categoryIds.size,
            subcategories: subcategoryIds.size,
            menuItems: menuItemIds.size,
            stockItems: stockItemIds.size,
            tables: tableIds.size,
            financialAccounts: financialAccountIds.size,
          },
        };
      });
    },
  });
}
