import { withTenantTransaction } from "../database/tenant-transaction.mjs";
import { apiError } from "./business-date.mjs";
import { quantizeQuantity } from "./inventory-ledger.mjs";

const MAX_RECIPE_ITEMS = 100;

function mapRecipeItem(row) {
  return {
    inventoryItemId: row.inventory_item_id,
    name: row.name,
    sku: row.sku ?? null,
    baseUnit: row.base_unit,
    quantityRequired: Number(row.quantity_required),
  };
}

/** Reads the persisted recipe rows for a product within a transaction. */
async function readRecipe(client, restaurantId, productId, productName) {
  const result = await client.query(
    `SELECT r.inventory_item_id, r.quantity_required,
            i.name, i.sku, i.base_unit
       FROM product_recipes r
       JOIN inventory_items i
         ON i.restaurant_id = r.restaurant_id
        AND i.id = r.inventory_item_id
      WHERE r.restaurant_id = $1 AND r.product_id = $2
      ORDER BY i.name ASC, r.inventory_item_id ASC`,
    [restaurantId, productId],
  );
  return {
    productId,
    productName,
    items: result.rows.map(mapRecipeItem),
  };
}

/**
 * Recipe service: the ingredient list for a menu product.
 *
 * A recipe is replaced as a whole inside one transaction, so a
 * product never exposes a half-updated ingredient list. Every
 * referenced product and ingredient must belong to the same
 * restaurant, and the same ingredient cannot appear twice.
 */
export function createRecipeService(pool, { clock = () => new Date() } = {}) {
  return Object.freeze({
    /** Retrieves the complete recipe for one product. */
    async get({ restaurantId, productId }) {
      return withTenantTransaction(
        pool,
        { restaurantId },
        async (client) => {
          const product = await client.query(
            `SELECT id, name FROM menu_items
              WHERE restaurant_id = $1 AND id = $2`,
            [restaurantId, productId],
          );
          if (product.rows.length === 0) {
            throw apiError("Product not found.", "PRODUCT_NOT_FOUND", 404);
          }
          return readRecipe(client, restaurantId, productId, product.rows[0].name);
        },
      );
    },

    /**
     * Replaces the complete recipe for a product transactionally.
     * An empty list removes every ingredient, which is valid: a
     * product without a recipe simply consumes no inventory.
     */
    async replace({ restaurantId, userId, productId, items }) {
      const recipeItems = (items ?? []).map((item) => ({
        inventoryItemId: item.inventoryItemId,
        quantityRequired: quantizeQuantity(item.quantityRequired, 6),
      }));

      if (recipeItems.length > MAX_RECIPE_ITEMS) {
        throw apiError(
          `A recipe may not contain more than ${MAX_RECIPE_ITEMS} ingredients.`,
          "RECIPE_TOO_LARGE",
          400,
        );
      }

      const seen = new Set();
      for (const item of recipeItems) {
        if (seen.has(item.inventoryItemId)) {
          throw apiError(
            "An ingredient may only appear once in a recipe.",
            "DUPLICATE_RECIPE_ITEM",
            400,
          );
        }
        seen.add(item.inventoryItemId);
        if (!(item.quantityRequired > 0)) {
          throw apiError(
            "Every ingredient quantity must be greater than zero.",
            "INVALID_RECIPE_QUANTITY",
            400,
          );
        }
      }

      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          const product = await client.query(
            `SELECT id FROM menu_items
              WHERE restaurant_id = $1 AND id = $2`,
            [restaurantId, productId],
          );
          if (product.rows.length === 0) {
            throw apiError("Product not found.", "PRODUCT_NOT_FOUND", 404);
          }

          if (recipeItems.length > 0) {
            const ingredientIds = recipeItems.map((item) => item.inventoryItemId);
            const ingredientResult = await client.query(
              `SELECT id FROM inventory_items
                WHERE restaurant_id = $1 AND id = ANY($2::uuid[])`,
              [restaurantId, ingredientIds],
            );
            const found = new Set(ingredientResult.rows.map((row) => row.id));
            const missing = ingredientIds.filter((id) => !found.has(id));
            if (missing.length > 0) {
              throw apiError(
                "One or more ingredients were not found.",
                "RECIPE_ITEM_NOT_FOUND",
                404,
                { inventoryItemIds: missing },
              );
            }
          }

          // The replacement is atomic: the old rows are removed
          // and the new rows are inserted in the same transaction,
          // so a reader never sees a partial recipe.
          await client.query(
            `DELETE FROM product_recipes
              WHERE restaurant_id = $1 AND product_id = $2`,
            [restaurantId, productId],
          );

          for (const item of recipeItems) {
            await client.query(
              `INSERT INTO product_recipes (
                 restaurant_id, product_id, inventory_item_id, quantity_required
               ) VALUES ($1, $2, $3, $4)`,
              [restaurantId, productId, item.inventoryItemId, item.quantityRequired],
            );
          }

          return readRecipe(client, restaurantId, productId, product.rows[0].name);
        },
      );
    },
  });
}

export { MAX_RECIPE_ITEMS };
