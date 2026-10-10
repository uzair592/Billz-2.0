import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../database/tenant-transaction.mjs";
import {
  lockInventoryItem,
  recordMovement,
} from "./inventory-ledger.mjs";

/**
 * Inventory consumption: deducts ingredient stock when an
 * order reaches the project's authoritative completed state.
 *
 * The consumption is exactly once per order. The
 * `inventory_consumptions` row is the durable, queryable
 * proof: it is inserted with `ON CONFLICT DO NOTHING` under
 * the order's unique (restaurant_id, order_id) constraint, so
 * a replayed or racing checkout can never deduct twice even
 * if the application layer regresses.
 *
 * Business rules, deliberately non-blocking:
 *   - a menu product without a recipe is a warning, not an
 *     error, and consumes nothing;
 *   - a missing inventory item is a warning, not an error;
 *   - a negative resulting balance is a warning, not an
 *     error — negative stock never blocks checkout;
 *   - any genuine failure rolls the whole transaction back,
 *     so an order can never be completed with half-applied
 *     stock changes.
 */

/**
 * Resolves the recipe components for a set of order lines and
 * aggregates the per-ingredient usage, multiplying each
 * recipe quantity by the sold quantity.
 *
 * Returns the aggregated usage map and the list of menu items
 * that have no recipe (missing-recipe warnings).
 */
async function resolveUsage(client, restaurantId, lines) {
  if (lines.some(line => line.inventoryRecipe !== undefined)) {
    const usage = new Map();
    const missingRecipes = [];
    for (const line of lines) {
      for (const recipe of line.inventoryRecipe || []) {
        usage.set(recipe.inventoryItemId, (usage.get(recipe.inventoryItemId) || 0) + Number(recipe.quantityPerUnit) * Number(line.quantity));
      }
    }
    return { usage, missingRecipes };
  }
  const menuItemIds = lines.map((line) => line.menuItemId);
  const uniqueMenuItemIds = [...new Set(menuItemIds)];

  const recipeResult = uniqueMenuItemIds.length
    ? await client.query(
        `SELECT product_id, inventory_item_id, quantity_required
           FROM product_recipes
          WHERE restaurant_id = $1 AND product_id = ANY($2::uuid[])`,
        [restaurantId, uniqueMenuItemIds],
      )
    : { rows: [] };

  const recipesByProduct = new Map();
  for (const row of recipeResult.rows) {
    if (!recipesByProduct.has(row.product_id)) {
      recipesByProduct.set(row.product_id, []);
    }
    recipesByProduct.get(row.product_id).push(row);
  }

  const usage = new Map();
  const missingRecipes = [];
  for (const line of lines) {
    const recipes = recipesByProduct.get(line.menuItemId);
    if (!recipes || recipes.length === 0) {
      missingRecipes.push({
        type: "missing_recipe",
        menuItemId: line.menuItemId,
        quantity: Number(line.quantity),
      });
      continue;
    }
    for (const recipe of recipes) {
      const required = Number(recipe.quantity_required) * Number(line.quantity);
      const itemId = recipe.inventory_item_id;
      usage.set(itemId, (usage.get(itemId) ?? 0) + required);
    }
  }

  return { usage, missingRecipes };
}

/**
 * Applies the consumption within an open tenant transaction.
 * Called by the order service inside the authoritative order
 * transaction, so the order, its items, and the inventory
 * deduction commit or roll back together.
 */
async function consumeWithinTransaction(
  client,
  { restaurantId, orderId, lines, userId, now },
) {
  const { usage, missingRecipes } = await resolveUsage(
    client,
    restaurantId,
    lines,
  );

  // Claim the order exactly once. A conflicting row means a
  // previous, committed consumption already deducted this
  // order's stock.
  const claim = await client.query(
    `INSERT INTO inventory_consumptions (
       restaurant_id, order_id, item_count
     ) VALUES ($1, $2, $3)
     ON CONFLICT (restaurant_id, order_id) DO NOTHING
     RETURNING id`,
    [restaurantId, orderId, usage.size],
  );
  if (claim.rows.length === 0) {
    return { replayed: true, consumedItemCount: 0, warnings: [], movements: [] };
  }

  const warnings = [...missingRecipes];
  const movements = [];

  for (const [inventoryItemId, required] of [...usage].sort(([a],[b]) => a.localeCompare(b))) {
    const locked = await lockInventoryItem(client, restaurantId, inventoryItemId);
    if (!locked) {
      // The recipe references an item that no longer exists.
      // This is a warning, never a checkout failure.
      warnings.push({ type: "missing_item", inventoryItemId, required });
      continue;
    }

    const quantityAfter = Number(locked.current_quantity) - required;
    await client.query(
      `UPDATE inventory_items
          SET current_quantity = current_quantity - $3,
              updated_at = $4
        WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, inventoryItemId, required, now],
    );

    const movementId = await recordMovement(client, {
      restaurantId,
      inventoryItemId,
      movementType: "sale_consumption",
      quantityDelta: -required,
      quantityAfter,
      referenceType: "order",
      referenceId: orderId,
      idempotencyKey: randomUUID(),
      notes: `Order consumption`,
      actorUserId: userId,
      now,
    });

    movements.push({
      movementId,
      inventoryItemId,
      quantityDelta: -required,
      quantityAfter,
    });

    if (quantityAfter < 0) {
      warnings.push({
        type: "negative_stock",
        inventoryItemId,
        quantityAfter,
      });
    }
  }

  return {
    replayed: false,
    consumedItemCount: movements.length,
    warnings,
    movements,
  };
}

export function createInventoryConsumptionService(pool, { clock = () => new Date() } = {}) {
  return Object.freeze({
    /**
     * Consumes inventory for a completed order. Exposed for
     * direct use and testing; the order service calls the
     * same logic inside its own transaction through
     * `consumeWithinTransaction`.
     */
    async consumeOrder({ tenant, orderId, lines, userId }) {
      const restaurantId = tenant.restaurant.id;
      const now = clock();
      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => consumeWithinTransaction(
          client,
          { restaurantId, orderId, lines, userId, now },
        ),
      );
    },

    /**
     * Consumes inventory inside a caller-provided transaction.
     * The order service passes its own transaction client so
     * the deduction is atomic with the order creation.
     */
    async consumeWithinTransaction(client, context) {
      return consumeWithinTransaction(client, {
        ...context,
        now: context.now ?? clock(),
      });
    },
  });
}

export { resolveUsage };
