import { randomUUID } from "node:crypto";
import { apiError } from "./business-date.mjs";

/**
 * Shared helpers for the Milestone 14 inventory domain.
 *
 * Every quantity change in the inventory domain writes exactly one
 * row to the immutable `inventory_movements` ledger and updates the
 * `inventory_items.current_quantity` balance in the same tenant
 * transaction, under a row lock, so concurrent operations can never
 * lose a stock update and the ledger always agrees with the balance.
 */

const QUANTITY_PLACES = 4;
const RECIPE_PLACES = 6;

// PostgreSQL renders timestamptz as "YYYY-MM-DD HH:MM:SS[.ffffff]+TZ".
// The text form is lossless (microsecond precision), unlike a parsed
// JavaScript Date, so it is what the pagination cursor carries.
const TIMESTAMPTZ_TEXT_PATTERN =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:?\d{2})?$/;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Quantizes a client-supplied quantity to the column's scale so the
 * value the service computes matches what PostgreSQL will store.
 * Quantities are safe numeric values, never floating-point money.
 */
export function quantizeQuantity(value, places = QUANTITY_PLACES) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw apiError("A valid quantity is required.", "INVALID_QUANTITY", 400);
  }
  const factor = 10 ** places;
  return Math.round(number * factor) / factor;
}

/** Encodes a keyset pagination cursor from a lossless timestamp text and id. */
export function encodeInventoryCursor(createdAtText, id) {
  return Buffer.from(`${createdAtText}.${id}`, "utf8").toString("base64url");
}

/**
 * Decodes and validates a keyset pagination cursor. The timestamp is
 * validated against PostgreSQL's own text format and the id against
 * the UUID format before either is sent back to the database.
 */
export function decodeInventoryCursor(cursor) {
  if (typeof cursor !== "string" || cursor.length > 500) {
    throw apiError("The pagination cursor is not valid.", "INVALID_CURSOR", 400);
  }
  let decoded;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw apiError("The pagination cursor is not valid.", "INVALID_CURSOR", 400);
  }
  const separator = decoded.lastIndexOf(".");
  if (separator < 1 || separator === decoded.length - 1) {
    throw apiError("The pagination cursor is not valid.", "INVALID_CURSOR", 400);
  }
  const createdAtText = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!TIMESTAMPTZ_TEXT_PATTERN.test(createdAtText) || !UUID_PATTERN.test(id)) {
    throw apiError("The pagination cursor is not valid.", "INVALID_CURSOR", 400);
  }
  return { createdAtText, id };
}

/**
 * Locks one inventory item row for the duration of the transaction.
 * Callers must hold an open tenant transaction (`client`); the lock
 * serializes every concurrent stock change for the item so the
 * balance and the ledger can never disagree.
 */
export async function lockInventoryItem(client, restaurantId, inventoryItemId) {
  const result = await client.query(
    `SELECT id, name, sku, base_unit, current_quantity,
            reorder_level, average_cost_minor, is_active
       FROM inventory_items
      WHERE restaurant_id = $1 AND id = $2
      FOR UPDATE`,
    [restaurantId, inventoryItemId],
  );
  return result.rows[0] ?? null;
}

/**
 * Inserts one immutable ledger row. The caller has already computed
 * `quantityAfter` under the item row lock and updated the balance in
 * the same transaction, so the movement and the balance commit
 * together or roll back together.
 */
export async function recordMovement(client, {
  restaurantId,
  inventoryItemId,
  movementType,
  quantityDelta,
  quantityAfter,
  unitCostMinor = null,
  totalCostMinor = null,
  referenceType = null,
  referenceId = null,
  idempotencyKey,
  notes = null,
  actorUserId = null,
  now,
}) {
  const movementId = randomUUID();
  await client.query(
    `INSERT INTO inventory_movements (
       id, restaurant_id, inventory_item_id, movement_type,
       quantity_delta, quantity_after, unit_cost_minor, total_cost_minor,
       reference_type, reference_id, idempotency_key, notes,
       actor_user_id, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      movementId, restaurantId, inventoryItemId, movementType,
      quantityDelta, quantityAfter, unitCostMinor, totalCostMinor,
      referenceType, referenceId, idempotencyKey, notes,
      actorUserId, now,
    ],
  );
  return movementId;
}

/**
 * Applies a signed stock change to one item: locks the row, updates
 * the balance, and records the movement, all inside the caller's
 * transaction. Used by adjustments, waste, and sale consumption.
 * Purchase receipts use their own locked update because they also
 * recompute the weighted average cost.
 */
export async function applyStockChange(client, {
  restaurantId,
  inventoryItemId,
  movementType,
  quantityDelta,
  unitCostMinor = null,
  totalCostMinor = null,
  referenceType = null,
  referenceId = null,
  idempotencyKey,
  notes = null,
  actorUserId = null,
  now,
}) {
  const item = await lockInventoryItem(client, restaurantId, inventoryItemId);
  if (!item) {
    throw apiError("Inventory item not found.", "INVENTORY_ITEM_NOT_FOUND", 404);
  }
  const quantityAfter = Number(item.current_quantity) + quantityDelta;
  await client.query(
    `UPDATE inventory_items
        SET current_quantity = current_quantity + $3,
            updated_at = $4
      WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, inventoryItemId, quantityDelta, now],
  );
  const movementId = await recordMovement(client, {
    restaurantId,
    inventoryItemId,
    movementType,
    quantityDelta,
    quantityAfter,
    unitCostMinor,
    totalCostMinor,
    referenceType,
    referenceId,
    idempotencyKey,
    notes,
    actorUserId,
    now,
  });
  return { movementId, quantityAfter };
}

/**
 * Exact line total in integer minor units for a quantity priced
 * at a unit cost, matching PostgreSQL's
 * `round(quantity * unit_cost_minor)` half-away-from-zero rule.
 *
 * The quantity is carried as ten-thousandths of a base unit
 * (the scale of numeric(18, 4)) and multiplied with BigInt, so
 * the result is exact and always agrees with the database's own
 * rounding — a floating-point product could flip a .5 boundary.
 */
export function lineTotalMinor(quantity, unitCostMinor) {
  const quantityTenThousandths = BigInt(Math.round(Number(quantity) * 10_000));
  const cost = BigInt(Math.round(Number(unitCostMinor)));
  const product = quantityTenThousandths * cost;
  return Number((product + 5_000n) / 10_000n);
}

/**
 * Deterministic weighted-average cost for a purchase receipt, in
 * integer minor units per base unit.
 *
 * When the item already holds positive stock, the new average is
 * the quantity-weighted mean of the existing stock value and the
 * received value, rounded half away from zero (the same rule
 * PostgreSQL's round() uses for numeric). When the item was empty
 * or negative, the receipt cost becomes the new average, because
 * there is no meaningful prior cost to weight against.
 *
 * The arithmetic is done with BigInt over ten-thousandths of a
 * base unit, so it is exact for every value the numeric(18, 4)
 * columns can hold — floating-point multiplication would lose
 * precision for large quantities or costs.
 */
export function weightedAverageCostMinor({
  currentQuantity,
  currentAverageCostMinor,
  receivedQuantity,
  unitCostMinor,
}) {
  const TEN_THOUSAND = 10_000n;
  const toTenThousandths = (value) => {
    const scaled = Math.round(Number(value) * 10_000);
    if (!Number.isSafeInteger(scaled)) {
      throw apiError("A quantity is too large to cost accurately.", "QUANTITY_TOO_LARGE", 422);
    }
    return BigInt(scaled);
  };

  const current = toTenThousandths(currentQuantity);
  const received = toTenThousandths(receivedQuantity);
  const next = current + received;
  const cost = BigInt(Math.round(Number(unitCostMinor)));
  const priorCost = BigInt(Math.round(Number(currentAverageCostMinor)));

  if (current > 0n && next > 0n) {
    const totalValue = current * priorCost + received * cost;
    // round(totalValue / next) with half-away-from-zero, for
    // positive values: floor((2 * totalValue + next) / (2 * next)).
    const rounded = (totalValue * 2n + next) / (next * 2n);
    return Number(rounded);
  }
  return Number(cost);
}
