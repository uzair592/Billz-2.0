import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../database/tenant-transaction.mjs";
import {
  lockInventoryItem,
  recordMovement,
} from "./inventory-ledger.mjs";
import { allocateFifo } from "./fifo-allocation-service.mjs";

/**
 * Inventory consumption service — FIFO edition.
 *
 * Deducts ingredient stock when an order reaches the project's authoritative
 * completed state. Uses the FIFO batch allocation engine instead of WAC.
 *
 * Business rules (deliberately non-blocking):
 *   - A menu product without a recipe is a warning, never an error.
 *   - A missing inventory item is a warning, never an error.
 *   - Exhausted batches (negative stock) create a provisional deficit and are
 *     a warning, never an error. Negative stock never blocks checkout.
 *   - Any genuine failure rolls the whole transaction back so an order can
 *     never be completed with half-applied stock changes.
 */

/**
 * Resolves recipe components for a set of order lines and aggregates the
 * per-ingredient usage, multiplying each recipe quantity by the sold quantity.
 *
 * Returns the aggregated usage map and the list of menu items that have no
 * recipe (missing-recipe warnings).
 */
async function resolveUsage(client, restaurantId, lines) {
  // Fast path: caller pre-resolved recipes and passed them in.
  if (lines.some((line) => line.inventoryRecipe !== undefined)) {
    const usage = new Map();
    const missingRecipes = [];
    for (const line of lines) {
      if (!line.inventoryRecipe?.length && !line.recipe?.length) {
        missingRecipes.push({
          type: "missing_recipe",
          menuItemId: line.menuItemId,
          quantity: Number(line.quantity),
        });
      }
      for (const recipe of line.inventoryRecipe || []) {
        usage.set(
          recipe.inventoryItemId,
          (usage.get(recipe.inventoryItemId) || 0)
            + Number(recipe.quantityPerUnit) * Number(line.quantity),
        );
      }
    }
    return { usage, missingRecipes };
  }

  // Standard path: look up recipes from the database.
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
 * Applies FIFO consumption within an open tenant transaction.
 * Called by the order service inside the authoritative order transaction,
 * so the order, its items, and the inventory deduction commit or roll back
 * together.
 *
 * Returns:
 *   { replayed, consumedItemCount, totalFifoCostMinor, costingStatus, warnings, movements }
 *
 * costingStatus is 'resolved' when all items were fully covered by FIFO batches,
 * 'provisional' when some quantities ran into deficit, or 'unresolved' when
 * every item was missing from inventory.
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

  // Claim the order exactly once. A conflicting row means a previous,
  // committed consumption already deducted this order's stock.
  const claim = await client.query(
    `INSERT INTO inventory_consumptions (
       restaurant_id, order_id, item_count
     ) VALUES ($1, $2, $3)
     ON CONFLICT (restaurant_id, order_id) DO NOTHING
     RETURNING id`,
    [restaurantId, orderId, usage.size],
  );
  if (claim.rows.length === 0) {
    return {
      replayed: true,
      consumedItemCount: 0,
      totalFifoCostMinor: 0,
      costingStatus: "replayed",
      warnings: [],
      movements: [],
    };
  }

  const warnings = [...missingRecipes];
  const movements = [];
  let totalFifoCostMinor = 0;
  // Collect per-item costing statuses to determine the order-level status.
  const itemStatuses = [];

  // Deterministic ordering prevents deadlocks between concurrent orders
  // consuming the same set of items.
  for (const [inventoryItemId, required] of [...usage].sort(([a], [b]) => a.localeCompare(b))) {
    // Lock the inventory item row for this transaction.
    const locked = await lockInventoryItem(client, restaurantId, inventoryItemId);
    if (!locked) {
      // Recipe references an item that no longer exists — warning, not failure.
      warnings.push({ type: "missing_item", inventoryItemId, required });
      itemStatuses.push("unresolved");
      continue;
    }

    // FIFO allocation: consume from oldest batches first.
    const fifoResult = await allocateFifo(client, {
      restaurantId,
      inventoryItemId,
      orderId,
      requiredQuantity: required,
      now,
    });
    totalFifoCostMinor += fifoResult.totalCostMinor;
    itemStatuses.push(fifoResult.costingStatus);

    if (fifoResult.deficit > 0) {
      warnings.push({
        type: "fifo_deficit",
        inventoryItemId,
        deficit: fifoResult.deficit,
        covered: required - fifoResult.deficit,
      });
    }

    // Update the inventory item's balance (negative stock is allowed).
    const quantityAfter = Number(locked.current_quantity) - required;
    await client.query(
      `UPDATE inventory_items
          SET current_quantity = current_quantity - $3,
              updated_at = $4
        WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, inventoryItemId, required, now],
    );

    // Record an immutable movement in the ledger. The unit_cost_minor here
    // represents the FIFO cost of the consumed quantity (for reporting).
    const fifoCostPerUnit = required > 0
      ? Math.round(fifoResult.totalCostMinor / required)
      : 0;

    const movementId = await recordMovement(client, {
      restaurantId,
      inventoryItemId,
      movementType: "sale_consumption",
      quantityDelta: -required,
      quantityAfter,
      unitCostMinor: fifoCostPerUnit,
      totalCostMinor: fifoResult.totalCostMinor,
      referenceType: "order",
      referenceId: orderId,
      idempotencyKey: randomUUID(),
      notes: `FIFO order consumption (${fifoResult.costingStatus})`,
      actorUserId: userId,
      now,
    });

    movements.push({
      movementId,
      inventoryItemId,
      quantityDelta: -required,
      quantityAfter,
      fifoCostMinor: fifoResult.totalCostMinor,
      costingStatus: fifoResult.costingStatus,
    });

    if (quantityAfter < 0) {
      warnings.push({
        type: "negative_stock",
        inventoryItemId,
        quantityAfter,
      });
    }
  }

  // Derive the order-level costing status.
  const costingStatus =
    itemStatuses.length === 0 || itemStatuses.every((s) => s === "unresolved")
      ? "unresolved"
      : itemStatuses.some((s) => s === "provisional" || s === "unresolved")
        ? "provisional"
        : "resolved";

  return {
    replayed: false,
    consumedItemCount: movements.length,
    totalFifoCostMinor,
    costingStatus,
    warnings,
    movements,
  };
}

export function createInventoryConsumptionService(pool, { clock = () => new Date() } = {}) {
  return Object.freeze({
    /**
     * Consumes inventory for a completed order. Exposed for direct use and
     * testing; the order service calls the same logic inside its own
     * transaction through `consumeWithinTransaction`.
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
     * The order service passes its own transaction client so the deduction
     * is atomic with the order creation.
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
