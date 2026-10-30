/**
 * fifo-allocation-service.mjs
 *
 * FIFO inventory allocation engine for Billz-2.0.
 *
 * Responsibilities:
 *  1. createFifoBatch        — called by purchase-service when a purchase is received.
 *  2. allocateFifo           — called by inventory-consumption-service when an order
 *                              consumes stock. Selects the oldest available batches
 *                              first, deducts remaining_quantity, and writes immutable
 *                              allocation rows.
 *  3. reverseFifoAllocation  — called by order-cancellation-service to restore batch
 *                              quantities and record reversal rows.
 *  4. getFifoCogsForOrder    — returns the total FIFO COGS (in integer minor units)
 *                              for an order, used by sales reports.
 *  5. getItemFifoValue       — returns the current FIFO valuation of an item
 *                              (sum of remaining_quantity * unit_cost_minor).
 *
 * All functions take an open `client` (from `withTenantTransaction`) so that FIFO
 * changes are atomic with the surrounding inventory movement and order update.
 *
 * FIFO ordering is deterministic:
 *   ORDER BY effective_receipt_at ASC, created_at ASC, id ASC
 *
 * Negative stock is allowed. When batches are exhausted, a deficit record is
 * created in `inventory_fifo_deficits`. The reported COGS for deficit-covered
 * quantities is 0 with costing_status = 'provisional'. A later purchase can
 * reconcile the deficit.
 */

import { randomUUID } from "node:crypto";

// ────────────────────────────────────────────────────────────────────────────
// Public: create a FIFO batch when a purchase line is received
// ────────────────────────────────────────────────────────────────────────────

/**
 * Creates one FIFO cost batch for a received purchase line.
 *
 * @param {object} client - Open pg transaction client.
 * @param {object} opts
 * @param {string} opts.restaurantId
 * @param {string} opts.inventoryItemId
 * @param {string} opts.purchaseId
 * @param {string} opts.purchaseItemId
 * @param {number} opts.quantity          - Received quantity in base units.
 * @param {number} opts.unitCostMinor     - Unit cost in integer minor units.
 * @param {Date}   opts.effectiveReceiptAt - Timestamp used for FIFO ordering.
 * @param {string} [opts.batchRef]        - Optional external reference.
 * @returns {Promise<string>} The new batch id.
 */
export async function createFifoBatch(client, {
  restaurantId,
  inventoryItemId,
  purchaseId,
  purchaseItemId,
  quantity,
  unitCostMinor,
  effectiveReceiptAt,
  batchRef = null,
}) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO inventory_fifo_batches (
       id, restaurant_id, inventory_item_id,
       purchase_id, purchase_item_id,
       original_quantity, remaining_quantity,
       unit_cost_minor, effective_receipt_at,
       batch_ref, batch_origin
     ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, 'purchase')
     ON CONFLICT (restaurant_id, purchase_item_id) DO NOTHING`,
    [
      id, restaurantId, inventoryItemId,
      purchaseId, purchaseItemId,
      quantity,
      unitCostMinor, effectiveReceiptAt,
      batchRef,
    ],
  );
  return id;
}

/**
 * Creates a FIFO batch for opening stock or a manual adjustment.
 * Unlike purchase batches, these have no purchase/purchase_item reference.
 */
export async function createOpeningBatch(client, {
  restaurantId,
  inventoryItemId,
  quantity,
  unitCostMinor,
  effectiveReceiptAt,
  batchRef = null,
  batchOrigin = "opening_stock",
}) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO inventory_fifo_batches (
       id, restaurant_id, inventory_item_id,
       original_quantity, remaining_quantity,
       unit_cost_minor, effective_receipt_at,
       batch_ref, batch_origin
     ) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8)`,
    [
      id, restaurantId, inventoryItemId,
      quantity,
      unitCostMinor, effectiveReceiptAt,
      batchRef, batchOrigin,
    ],
  );
  return id;
}

// ────────────────────────────────────────────────────────────────────────────
// Public: allocate stock from FIFO batches for a sale
// ────────────────────────────────────────────────────────────────────────────

/**
 * Allocates `requiredQuantity` units of `inventoryItemId` from the oldest
 * available FIFO batches, inside the caller's transaction.
 *
 * Algorithm:
 *  1. Lock the inventory_item row (already done by caller — passed as `lockedItem`).
 *  2. Select batches with remaining_quantity > 0, oldest first, locking each.
 *  3. Consume from each batch until `requiredQuantity` is satisfied.
 *  4. If batches run out, record a deficit for the shortfall.
 *  5. Write an immutable allocation row per batch slice.
 *
 * @returns {{ totalCostMinor: number, costingStatus: string, allocations: object[], deficit: number }}
 *   - totalCostMinor: FIFO COGS for this consumption.
 *   - costingStatus:  'resolved' | 'provisional' (some deficit) | 'unresolved' (no cost)
 *   - allocations:    list of { batchId, allocatedQuantity, unitCostMinor, totalCostMinor }
 *   - deficit:        quantity not covered by any batch (0 when fully covered)
 */
export async function allocateFifo(client, {
  restaurantId,
  inventoryItemId,
  orderId,
  requiredQuantity,
  now,
}) {
  // Select and lock the oldest batches with remaining stock.
  const batchResult = await client.query(
    `SELECT id, remaining_quantity, unit_cost_minor
       FROM inventory_fifo_batches
      WHERE restaurant_id = $1
        AND inventory_item_id = $2
        AND remaining_quantity > 0
      ORDER BY effective_receipt_at ASC, created_at ASC, id ASC
      FOR UPDATE`,
    [restaurantId, inventoryItemId],
  );

  let remaining = requiredQuantity;
  let totalCostMinor = 0;
  const allocations = [];

  for (const batch of batchResult.rows) {
    if (remaining <= 0) break;

    const take = Math.min(Number(batch.remaining_quantity), remaining);
    const unitCost = Number(batch.unit_cost_minor);
    // Match PostgreSQL's round(quantity * unit_cost_minor) rule.
    const sliceCost = roundHalfAwayFromZero(take * unitCost);

    // Deduct from batch.
    await client.query(
      `UPDATE inventory_fifo_batches
          SET remaining_quantity = remaining_quantity - $3
        WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, batch.id, take],
    );

    // Write immutable allocation row.
    const allocationId = randomUUID();
    await client.query(
      `INSERT INTO inventory_fifo_allocations (
         id, restaurant_id, batch_id, order_id, inventory_item_id,
         allocated_quantity, unit_cost_minor, total_cost_minor,
         allocation_type, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sale', $9)
       ON CONFLICT (restaurant_id, order_id, batch_id) DO NOTHING`,
      [
        allocationId, restaurantId, batch.id, orderId, inventoryItemId,
        take, unitCost, sliceCost, now,
      ],
    );

    allocations.push({
      allocationId,
      batchId: batch.id,
      allocatedQuantity: take,
      unitCostMinor: unitCost,
      totalCostMinor: sliceCost,
    });

    totalCostMinor += sliceCost;
    remaining -= take;
  }

  // Handle shortfall (negative stock permitted).
  let deficit = 0;
  if (remaining > 0) {
    deficit = remaining;
    // Record provisional deficit for later reconciliation.
    await client.query(
      `INSERT INTO inventory_fifo_deficits (
         id, restaurant_id, inventory_item_id, order_id, deficit_quantity, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (restaurant_id, order_id, inventory_item_id) DO NOTHING`,
      [randomUUID(), restaurantId, inventoryItemId, orderId, deficit, now],
    );
  }

  const costingStatus =
    deficit > 0 && allocations.length === 0
      ? "unresolved"
      : deficit > 0
        ? "provisional"
        : "resolved";

  return { totalCostMinor, costingStatus, allocations, deficit };
}

// ────────────────────────────────────────────────────────────────────────────
// Public: reverse FIFO allocations on cancellation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Reverses all FIFO allocations for an order (on cancellation).
 * Restores `remaining_quantity` on the original batches.
 * Writes reversal rows in `inventory_fifo_allocations`.
 * Idempotent: reversal rows collide on the unique index.
 *
 * @returns {{ restoredItems: object[] }} - Summary of restored quantities per batch.
 */
export async function reverseFifoAllocations(client, {
  restaurantId,
  orderId,
  now,
}) {
  // Fetch all sale allocations for this order.
  const allocResult = await client.query(
    `SELECT a.id, a.batch_id, a.inventory_item_id,
            a.allocated_quantity, a.unit_cost_minor, a.total_cost_minor
       FROM inventory_fifo_allocations a
      WHERE a.restaurant_id = $1
        AND a.order_id = $2
        AND a.allocation_type = 'sale'
      ORDER BY a.created_at ASC`,
    [restaurantId, orderId],
  );

  const restoredItems = [];

  for (const alloc of allocResult.rows) {
    // Restore batch quantity.
    await client.query(
      `UPDATE inventory_fifo_batches
          SET remaining_quantity = remaining_quantity + $3
        WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, alloc.batch_id, Number(alloc.allocated_quantity)],
    );

    // Write reversal row (idempotent via unique index on original_allocation_id).
    await client.query(
      `INSERT INTO inventory_fifo_allocations (
         id, restaurant_id, batch_id, order_id, inventory_item_id,
         allocated_quantity, unit_cost_minor, total_cost_minor,
         allocation_type, original_allocation_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sale_reversal', $9, $10)
       ON CONFLICT (restaurant_id, original_allocation_id) DO NOTHING`,
      [
        randomUUID(), restaurantId, alloc.batch_id, orderId,
        alloc.inventory_item_id,
        Number(alloc.allocated_quantity),
        Number(alloc.unit_cost_minor),
        Number(alloc.total_cost_minor),
        alloc.id,
        now,
      ],
    );

    restoredItems.push({
      batchId: alloc.batch_id,
      inventoryItemId: alloc.inventory_item_id,
      restoredQuantity: Number(alloc.allocated_quantity),
      unitCostMinor: Number(alloc.unit_cost_minor),
    });
  }

  // Also cancel any unresolved deficits for this order.
  await client.query(
    `DELETE FROM inventory_fifo_deficits
      WHERE restaurant_id = $1 AND order_id = $2 AND resolved_at IS NULL`,
    [restaurantId, orderId],
  );

  return { restoredItems };
}

// ────────────────────────────────────────────────────────────────────────────
// Public: query helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returns the total FIFO COGS for a completed order.
 * Sums only 'sale' allocations (excludes reversals).
 */
export async function getFifoCogsForOrder(client, { restaurantId, orderId }) {
  const result = await client.query(
    `SELECT COALESCE(SUM(total_cost_minor), 0) AS total
       FROM inventory_fifo_allocations
      WHERE restaurant_id = $1 AND order_id = $2 AND allocation_type = 'sale'`,
    [restaurantId, orderId],
  );
  return Number(result.rows[0].total);
}

/**
 * Returns the FIFO valuation of one inventory item:
 *   SUM(remaining_quantity * unit_cost_minor)
 * This is the inventory value according to the FIFO method.
 */
export async function getItemFifoValue(client, { restaurantId, inventoryItemId }) {
  const result = await client.query(
    `SELECT COALESCE(SUM(remaining_quantity * unit_cost_minor), 0) AS fifo_value,
            COALESCE(SUM(remaining_quantity), 0)                   AS remaining_qty
       FROM inventory_fifo_batches
      WHERE restaurant_id = $1 AND inventory_item_id = $2`,
    [restaurantId, inventoryItemId],
  );
  return {
    fifoValueMinor: Number(result.rows[0].fifo_value),
    remainingQuantity: Number(result.rows[0].remaining_qty),
  };
}

/**
 * Returns batch details for an inventory item — used for the drill-down
 * view that lets owners inspect which purchase batches produced the cost
 * of a sold ingredient.
 */
export async function getItemBatches(client, { restaurantId, inventoryItemId }) {
  const result = await client.query(
    `SELECT id, purchase_id, purchase_item_id,
            original_quantity, remaining_quantity,
            unit_cost_minor,
            round(remaining_quantity * unit_cost_minor) AS remaining_value_minor,
            effective_receipt_at, batch_ref, batch_origin, created_at
       FROM inventory_fifo_batches
      WHERE restaurant_id = $1 AND inventory_item_id = $2
      ORDER BY effective_receipt_at ASC, created_at ASC, id ASC`,
    [restaurantId, inventoryItemId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    purchaseId: row.purchase_id,
    purchaseItemId: row.purchase_item_id,
    originalQuantity: Number(row.original_quantity),
    remainingQuantity: Number(row.remaining_quantity),
    unitCostMinor: Number(row.unit_cost_minor),
    remainingValueMinor: Number(row.remaining_value_minor),
    effectiveReceiptAt: row.effective_receipt_at,
    batchRef: row.batch_ref,
    batchOrigin: row.batch_origin,
    createdAt: row.created_at,
  }));
}

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Matches PostgreSQL's round() for numeric: half-away-from-zero.
 * BigInt arithmetic avoids floating-point rounding errors on large quantities.
 */
function roundHalfAwayFromZero(value) {
  const scaled = Math.round(value * 10_000);
  if (!Number.isSafeInteger(scaled)) {
    throw new Error("Quantity or cost is too large to round accurately.");
  }
  // (BigInt(scaled) + 5000n) / 10000n rounds half away from zero for positive.
  return Number((BigInt(scaled) + 5_000n) / 10_000n);
}
