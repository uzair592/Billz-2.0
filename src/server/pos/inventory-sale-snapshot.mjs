import { createHash } from "node:crypto";
import { lockInventoryItem, applyStockChange } from "./inventory-ledger.mjs";

// Freeze the recipe and weighted cost actually consumed. A product with a new
// recipe uses that ledger exclusively; products not migrated retain legacy stock.
export async function freezeInventoryRecipes(client, restaurantId, lines, legacyCatalog = new Map()) {
  const productIds = new Set();
  function collect(line) { productIds.add(line.menuItemId); for (const child of line.componentSnapshots || line.components || []) collect(child); }
  lines.forEach(collect);
  const recipes = (await client.query(`SELECT product_id, inventory_item_id, quantity_required
    FROM product_recipes WHERE restaurant_id = $1 AND product_id = ANY($2::uuid[])
    ORDER BY product_id, inventory_item_id`, [restaurantId, [...productIds]])).rows;
  const byProduct = new Map();
  for (const recipe of recipes) {
    if (!byProduct.has(recipe.product_id)) byProduct.set(recipe.product_id, []);
    byProduct.get(recipe.product_id).push(recipe);
  }
  const items = new Map();
  const missingInventoryItemIds = new Set();
  for (const id of [...new Set(recipes.map(r => r.inventory_item_id))].sort()) {
    const item = await lockInventoryItem(client, restaurantId, id);
    if (!item) {
      missingInventoryItemIds.add(id);
      continue;
    }
    items.set(id, item);
  }
  function expand(line, multiplier = 1, usage = new Map()) {
    for (const recipe of byProduct.get(line.menuItemId) || []) {
      const id = recipe.inventory_item_id;
      usage.set(id, (usage.get(id) || 0) + Number(recipe.quantity_required) * multiplier);
    }
    for (const child of line.componentSnapshots || line.components || []) expand(child, multiplier * Number(child.quantity), usage);
    return usage;
  }
  for (const line of lines) {
    const usage = expand(line);
    line.inventoryRecipe = [];
    line.skippedInventoryUsage = [];
    if (!usage.size) {
      if (!line.recipe || line.recipe.length === 0) {
        line.incompleteCosting = true;
      }
      continue;
    }
    const legacyUsage = new Map();
    function legacy(component, multiplier = 1) {
      if (!byProduct.has(component.menuItemId)) for (const ingredient of legacyCatalog.get(component.menuItemId)?.recipe || []) {
        legacyUsage.set(ingredient.stockItemId, (legacyUsage.get(ingredient.stockItemId) || 0) + Number(ingredient.quantityBaseUnits) * multiplier);
      }
      for (const child of component.componentSnapshots || component.components || []) legacy(child, multiplier * Number(child.quantity));
    }
    legacy(line);
    const availableUsage = [...usage].filter(([id]) => items.has(id));
    const skippedUsage = [...usage].filter(([id]) => !items.has(id));
    line.inventoryRecipe = availableUsage.map(([inventoryItemId, quantityPerUnit]) => ({
      inventoryItemId, quantityPerUnit, unitCostMinor: Number(items.get(inventoryItemId).average_cost_minor || 0),
    }));
    line.skippedInventoryUsage = skippedUsage.map(([inventoryItemId, quantityPerUnit]) => ({
      inventoryItemId, quantityPerUnit, reason: "missing_inventory_item",
    }));
    if (skippedUsage.length > 0) {
      line.incompleteCosting = true;
    }
    line.inventoryUnitCostMinor = Math.round(line.inventoryRecipe.reduce((sum, r) => sum + r.quantityPerUnit * r.unitCostMinor, 0));
    line.recipe = [...legacyUsage].map(([stockItemId, quantityBaseUnits]) => ({ stockItemId, quantityBaseUnits }));
  }
}
function operationId(value) {
  const hex = createHash("md5").update(value).digest("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export async function restockInventoryRecipe(client, { restaurantId, orderId, refundId, orderItemId, recipe, quantity, userId, now }) {
  for (const item of [...recipe].sort((a,b) => a.inventoryItemId.localeCompare(b.inventoryItemId))) {
    await applyStockChange(client, { restaurantId, inventoryItemId: item.inventoryItemId,
      movementType: "sale_reversal", quantityDelta: Number(item.quantityPerUnit) * quantity,
      unitCostMinor: item.unitCostMinor, referenceType: "order", referenceId: orderId,
      idempotencyKey: operationId(`${refundId}:${orderItemId}:${item.inventoryItemId}`),
      notes: "Refund using frozen sale recipe", actorUserId: userId, now });
  }
}
export async function nonRestockedRefundUsage(client, { restaurantId, orderId }) {
  const rows = (await client.query(`SELECT oi.recipe_snapshot, SUM(ri.quantity) AS refunded_quantity
    FROM order_refund_items ri JOIN order_refunds r ON r.id = ri.refund_id AND r.restaurant_id = ri.restaurant_id
    JOIN order_items oi ON oi.id = ri.order_item_id AND oi.restaurant_id = ri.restaurant_id
    WHERE r.restaurant_id = $1 AND r.order_id = $2 AND r.status = 'completed' AND ri.restock = false
    GROUP BY oi.id, oi.recipe_snapshot`, [restaurantId, orderId])).rows;
  const inventory = new Map(), legacy = new Map();
  for (const row of rows) {
    const recipe = row.recipe_snapshot ?? {};
    if (recipe.version !== 2) continue; // Historical snapshots require reconciliation.
    const quantity = Number(row.refunded_quantity);
    for (const item of recipe.inventoryItems || []) inventory.set(item.inventoryItemId, (inventory.get(item.inventoryItemId) || 0) + quantity * Number(item.quantityPerUnit));
    for (const item of recipe.items || []) legacy.set(item.stockItemId, (legacy.get(item.stockItemId) || 0) + quantity * Number(item.quantityBaseUnits));
  }
  return { inventory, legacy };
}
export async function reverseRemainingInventory(client, { restaurantId, orderId, userId, now, unreturned = new Map() }) {
  const restocked = [];
  const rows = (await client.query(`SELECT inventory_item_id, -SUM(quantity_delta) AS remaining
    FROM inventory_movements WHERE restaurant_id = $1 AND reference_type = 'order' AND reference_id = $2
      AND movement_type IN ('sale_consumption', 'sale_reversal') GROUP BY inventory_item_id
      HAVING SUM(quantity_delta) < 0 ORDER BY inventory_item_id`, [restaurantId, orderId])).rows;
  for (const row of rows) {
    const quantity = Math.max(0, Number(row.remaining) - (unreturned.get(row.inventory_item_id) || 0));
    if (!quantity) continue;
    await applyStockChange(client, { restaurantId, inventoryItemId: row.inventory_item_id,
    movementType: "sale_reversal", quantityDelta: quantity, referenceType: "order", referenceId: orderId,
    idempotencyKey: operationId(`cancel:${orderId}:${row.inventory_item_id}`), notes: "Cancellation of remaining consumed stock", actorUserId: userId, now });
    restocked.push({ inventoryItemId: row.inventory_item_id, quantityBaseUnits: quantity });
  }
  return restocked;
}
