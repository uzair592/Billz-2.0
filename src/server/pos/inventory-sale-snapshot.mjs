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
  for (const id of [...new Set(recipes.map(r => r.inventory_item_id))].sort()) {
    const item = await lockInventoryItem(client, restaurantId, id);
    if (!item) throw new Error("Recipe inventory item is missing.");
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
    if (!usage.size) continue;
    const legacyUsage = new Map();
    function legacy(component, multiplier = 1) {
      if (!byProduct.has(component.menuItemId)) for (const ingredient of legacyCatalog.get(component.menuItemId)?.recipe || []) {
        legacyUsage.set(ingredient.stockItemId, (legacyUsage.get(ingredient.stockItemId) || 0) + Number(ingredient.quantityBaseUnits) * multiplier);
      }
      for (const child of component.componentSnapshots || component.components || []) legacy(child, multiplier * Number(child.quantity));
    }
    legacy(line);
    line.inventoryRecipe = [...usage].map(([inventoryItemId, quantityPerUnit]) => ({
      inventoryItemId, quantityPerUnit, unitCostMinor: Number(items.get(inventoryItemId).average_cost_minor),
    }));
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
export async function reverseRemainingInventory(client, { restaurantId, orderId, userId, now }) {
  const rows = (await client.query(`SELECT inventory_item_id, -SUM(quantity_delta) AS remaining
    FROM inventory_movements WHERE restaurant_id = $1 AND reference_type = 'order' AND reference_id = $2
      AND movement_type IN ('sale_consumption', 'sale_reversal') GROUP BY inventory_item_id
      HAVING SUM(quantity_delta) < 0 ORDER BY inventory_item_id`, [restaurantId, orderId])).rows;
  for (const row of rows) await applyStockChange(client, { restaurantId, inventoryItemId: row.inventory_item_id,
    movementType: "sale_reversal", quantityDelta: Number(row.remaining), referenceType: "order", referenceId: orderId,
    idempotencyKey: operationId(`cancel:${orderId}:${row.inventory_item_id}`), notes: "Cancellation of remaining consumed stock", actorUserId: userId, now });
}
