import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../database/tenant-transaction.mjs";
import { apiError } from "./business-date.mjs";
import {
  applyStockChange,
  decodeInventoryCursor,
  encodeInventoryCursor,
  quantizeQuantity,
} from "./inventory-ledger.mjs";

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
const LOW_STOCK_LIMIT = 100;

const BASE_UNITS = Object.freeze([
  "piece", "gram", "kilogram", "millilitre", "litre",
]);

function mapItem(row) {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku ?? null,
    baseUnit: row.base_unit,
    currentQuantity: Number(row.current_quantity),
    reorderLevel: Number(row.reorder_level),
    averageCostMinor: Number(row.average_cost_minor),
    stockValueMinor: Math.round(
      Number(row.current_quantity) * Number(row.average_cost_minor),
    ),
    isActive: Boolean(row.is_active),
    isLowStock: Number(row.current_quantity) <= Number(row.reorder_level),
    isNegativeStock: Number(row.current_quantity) < 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMovement(row) {
  return {
    id: row.id,
    inventoryItemId: row.inventory_item_id,
    itemName: row.item_name ?? null,
    itemSku: row.item_sku ?? null,
    baseUnit: row.base_unit ?? null,
    movementType: row.movement_type,
    quantityDelta: Number(row.quantity_delta),
    quantityAfter: Number(row.quantity_after),
    unitCostMinor: row.unit_cost_minor === null
      ? null
      : Number(row.unit_cost_minor),
    totalCostMinor: row.total_cost_minor === null
      ? null
      : Number(row.total_cost_minor),
    referenceType: row.reference_type ?? null,
    referenceId: row.reference_id ?? null,
    notes: row.notes ?? null,
    actorUserId: row.actor_user_id ?? null,
    createdAt: row.created_at,
  };
}

function normalizeText(value, maxLength) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw apiError(`A value may not exceed ${maxLength} characters.`, "VALUE_TOO_LONG", 400);
  }
  return trimmed;
}

function normalizeLimit(limit, max = MAX_PAGE_SIZE, fallback = DEFAULT_PAGE_SIZE) {
  const parsed = limit === undefined ? fallback : Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw apiError(`The page size must be between 1 and ${max}.`, "INVALID_PAGE_SIZE", 400);
  }
  return parsed;
}

function isDuplicateKeyError(error, indexName) {
  return String(error.message).includes(indexName);
}

/**
 * Inventory service: stock items, balances, the immutable
 * movement ledger, adjustments, and waste.
 *
 * Every quantity change is written as an immutable movement in
 * the same tenant transaction as the balance update, under a
 * row lock, so the ledger and the balance can never disagree
 * and concurrent operations never lose an update. Negative
 * balances are allowed and surfaced as warnings; they never
 * block a sale.
 */
export function createInventoryService(pool, { clock = () => new Date() } = {}) {
  return Object.freeze({
    /** Searches and paginates a restaurant's inventory. */
    async list({ restaurantId, search = null, isActive = null, limit, cursor } = {}) {
      const pageSize = normalizeLimit(limit);
      const searchTerm = typeof search === "string" && search.trim()
        ? `%${search.trim().slice(0, 160)}%`
        : null;

      return withTenantTransaction(
        pool,
        { restaurantId },
        async (client) => {
          const params = [restaurantId, searchTerm, isActive];
          let cursorClause = "";
          if (cursor) {
            const decoded = decodeInventoryCursor(cursor);
            params.push(decoded.createdAtText, decoded.id);
            cursorClause =
              ` AND (i.created_at, i.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
          }
          params.push(pageSize + 1);
          const result = await client.query(
            `SELECT i.*, i.created_at::text AS created_at_text
               FROM inventory_items i
              WHERE i.restaurant_id = $1
                AND ($2::text IS NULL OR i.name ILIKE $2 OR i.sku ILIKE $2)
                AND ($3::boolean IS NULL OR i.is_active = $3)${cursorClause}
              ORDER BY i.created_at DESC, i.id DESC
              LIMIT $${params.length}`,
            params,
          );

          const rows = result.rows.slice(0, pageSize);
          const last = rows.at(-1);
          const hasMore = result.rows.length > pageSize;
          return {
            items: rows.map(mapItem),
            nextCursor: hasMore && last
              ? encodeInventoryCursor(last.created_at_text, last.id)
              : null,
          };
        },
      );
    },

    /** Retrieves one item with its current balance. */
    async get({ restaurantId, itemId }) {
      return withTenantTransaction(
        pool,
        { restaurantId },
        async (client) => {
          const result = await client.query(
            `SELECT * FROM inventory_items
              WHERE restaurant_id = $1 AND id = $2`,
            [restaurantId, itemId],
          );
          const row = result.rows[0];
          if (!row) {
            throw apiError("Inventory item not found.", "INVENTORY_ITEM_NOT_FOUND", 404);
          }
          return { item: mapItem(row) };
        },
      );
    },

    /**
     * Creates an item. An optional opening balance is recorded
     * as an adjustment_increase movement so the ledger always
     * explains the starting quantity. Creation is idempotent
     * per idempotency key.
     */
    async create({ restaurantId, userId, input }) {
      const idempotencyKey = input.idempotencyKey;
      const name = normalizeText(input.name, 200);
      if (!name) {
        throw apiError("An inventory item name is required.", "MISSING_ITEM_NAME", 400);
      }
      if (!BASE_UNITS.includes(input.baseUnit)) {
        throw apiError("An unsupported base unit was provided.", "INVALID_BASE_UNIT", 400);
      }
      const sku = normalizeText(input.sku, 64);
      const baseUnit = input.baseUnit;
      const openingQuantity = quantizeQuantity(input.openingQuantity ?? 0);
      const reorderLevel = quantizeQuantity(input.reorderLevel ?? 0);
      const averageCostMinor = Number(input.averageCostMinor ?? 0);
      if (!Number.isInteger(averageCostMinor) || averageCostMinor < 0) {
        throw apiError("Average cost must be a non-negative integer of minor units.", "INVALID_AVERAGE_COST", 400);
      }
      if (openingQuantity < 0 || reorderLevel < 0) {
        throw apiError("Opening quantity and reorder level cannot be negative.", "NEGATIVE_QUANTITY", 400);
      }
      const now = clock();

      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            [idempotencyKey],
          );
          const existing = await client.query(
            `SELECT id FROM inventory_items
              WHERE restaurant_id = $1 AND idempotency_key = $2`,
            [restaurantId, idempotencyKey],
          );
          if (existing.rows[0]) {
            const item = await client.query(
              `SELECT * FROM inventory_items WHERE restaurant_id = $1 AND id = $2`,
              [restaurantId, existing.rows[0].id],
            );
            return { item: mapItem(item.rows[0]), replayed: true };
          }

          let result;
          try {
            result = await client.query(
              `INSERT INTO inventory_items (
                 restaurant_id, name, sku, base_unit,
                 current_quantity, reorder_level, average_cost_minor,
                 idempotency_key
               ) VALUES ($1, $2, $3, $4, 0, $5, $6, $7)
               RETURNING *`,
              [restaurantId, name, sku, baseUnit, reorderLevel, averageCostMinor, idempotencyKey],
            );
          } catch (error) {
            if (isDuplicateKeyError(error, "inventory_items_restaurant_sku_idx")) {
              throw apiError("Another item already uses this SKU.", "DUPLICATE_SKU", 409);
            }
            if (isDuplicateKeyError(error, "inventory_items_restaurant_name_unique")) {
              throw apiError("An item with this name already exists.", "DUPLICATE_ITEM_NAME", 409);
            }
            throw error;
          }
          const item = result.rows[0];

          if (openingQuantity > 0) {
            await applyStockChange(client, {
              restaurantId,
              inventoryItemId: item.id,
              movementType: "adjustment_increase",
              quantityDelta: openingQuantity,
              referenceType: "manual",
              idempotencyKey: randomUUID(),
              notes: "Opening balance",
              actorUserId: userId,
              now,
            });
          }

          const final = await client.query(
            `SELECT * FROM inventory_items WHERE restaurant_id = $1 AND id = $2`,
            [restaurantId, item.id],
          );
          return { item: mapItem(final.rows[0]), replayed: false };
        },
      );
    },

    /**
     * Updates an item's mutable fields. The base unit is fixed
     * at creation: changing it would invalidate every ledger
     * quantity already recorded.
     */
    async update({ restaurantId, userId, itemId, changes }) {
      const fields = {};
      if (changes.name !== undefined) {
        const name = normalizeText(changes.name, 200);
        if (!name) {
          throw apiError("An inventory item name is required.", "MISSING_ITEM_NAME", 400);
        }
        fields.name = name;
      }
      if (changes.sku !== undefined) {
        fields.sku = normalizeText(changes.sku, 64);
      }
      if (changes.reorderLevel !== undefined) {
        const reorderLevel = quantizeQuantity(changes.reorderLevel);
        if (reorderLevel < 0) {
          throw apiError("The reorder level cannot be negative.", "NEGATIVE_QUANTITY", 400);
        }
        fields.reorder_level = reorderLevel;
      }
      if (changes.averageCostMinor !== undefined) {
        const averageCostMinor = Number(changes.averageCostMinor);
        if (!Number.isInteger(averageCostMinor) || averageCostMinor < 0) {
          throw apiError("Average cost must be a non-negative integer of minor units.", "INVALID_AVERAGE_COST", 400);
        }
        fields.average_cost_minor = averageCostMinor;
      }
      if (changes.isActive !== undefined) {
        fields.is_active = Boolean(changes.isActive);
      }

      const keys = Object.keys(fields);
      if (keys.length === 0) {
        throw apiError("No inventory item changes were provided.", "NO_CHANGES", 400);
      }

      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          const setClauses = keys.map((key, index) => `${key} = $${index + 3}`).join(", ");
          try {
            const result = await client.query(
              `UPDATE inventory_items
                  SET ${setClauses}
                WHERE restaurant_id = $1 AND id = $2
                RETURNING *`,
              [restaurantId, itemId, ...keys.map((key) => fields[key])],
            );
            if (result.rows.length === 0) {
              throw apiError("Inventory item not found.", "INVENTORY_ITEM_NOT_FOUND", 404);
            }
            return { item: mapItem(result.rows[0]) };
          } catch (error) {
            if (isDuplicateKeyError(error, "inventory_items_restaurant_sku_idx")) {
              throw apiError("Another item already uses this SKU.", "DUPLICATE_SKU", 409);
            }
            if (isDuplicateKeyError(error, "inventory_items_restaurant_name_unique")) {
              throw apiError("An item with this name already exists.", "DUPLICATE_ITEM_NAME", 409);
            }
            throw error;
          }
        },
      );
    },

    /** Deactivates an item without deleting its ledger history. */
    async deactivate({ restaurantId, userId, itemId }) {
      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          const result = await client.query(
            `UPDATE inventory_items
                SET is_active = false
              WHERE restaurant_id = $1 AND id = $2
              RETURNING *`,
            [restaurantId, itemId],
          );
          if (result.rows.length === 0) {
            throw apiError("Inventory item not found.", "INVENTORY_ITEM_NOT_FOUND", 404);
          }
          return { item: mapItem(result.rows[0]) };
        },
      );
    },

    /**
     * Active items at or below their reorder level, most
     * critical first. Capped so the warning view stays bounded.
     */
    async lowStock({ restaurantId, limit } = {}) {
      const maxRows = limit === undefined
        ? LOW_STOCK_LIMIT
        : Math.min(LOW_STOCK_LIMIT, Math.max(1, Number(limit) || LOW_STOCK_LIMIT));
      return withTenantTransaction(
        pool,
        { restaurantId },
        async (client) => {
          const result = await client.query(
            `SELECT i.*, i.created_at::text AS created_at_text
               FROM inventory_items i
              WHERE i.restaurant_id = $1
                AND i.is_active = true
                AND i.current_quantity <= i.reorder_level
              ORDER BY i.current_quantity ASC, i.name ASC, i.id ASC
              LIMIT $2`,
            [restaurantId, maxRows + 1],
          );
          const rows = result.rows.slice(0, maxRows);
          return {
            items: rows.map(mapItem),
            hasMore: result.rows.length > maxRows,
          };
        },
      );
    },

    /** Paginates the immutable movement ledger, newest first. */
    async movements({ restaurantId, itemId = null, limit, cursor } = {}) {
      const pageSize = normalizeLimit(limit);
      return withTenantTransaction(
        pool,
        { restaurantId },
        async (client) => {
          const params = [restaurantId];
          let itemClause = "";
          if (itemId) {
            params.push(itemId);
            itemClause = ` AND m.inventory_item_id = $${params.length}`;
          }
          let cursorClause = "";
          if (cursor) {
            const decoded = decodeInventoryCursor(cursor);
            params.push(decoded.createdAtText, decoded.id);
            cursorClause =
              ` AND (m.created_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
          }
          params.push(pageSize + 1);
          const result = await client.query(
            `SELECT m.*, m.created_at::text AS created_at_text,
                    i.name AS item_name, i.sku AS item_sku, i.base_unit
               FROM inventory_movements m
               JOIN inventory_items i
                 ON i.restaurant_id = m.restaurant_id
                AND i.id = m.inventory_item_id
              WHERE m.restaurant_id = $1${itemClause}${cursorClause}
              ORDER BY m.created_at DESC, m.id DESC
              LIMIT $${params.length}`,
            params,
          );

          const rows = result.rows.slice(0, pageSize);
          const last = rows.at(-1);
          const hasMore = result.rows.length > pageSize;
          return {
            movements: rows.map(mapMovement),
            nextCursor: hasMore && last
              ? encodeInventoryCursor(last.created_at_text, last.id)
              : null,
          };
        },
      );
    },

    /**
     * Applies a controlled stock adjustment. Idempotent per
     * idempotency key: replaying the key returns the original
     * movement instead of adjusting twice.
     */
    async adjust({ restaurantId, userId, input }) {
      const idempotencyKey = input.idempotencyKey;
      const itemId = input.itemId;
      const direction = input.direction;
      const quantity = quantizeQuantity(input.quantity);
      const reason = normalizeText(input.reason, 2000);
      if (!["increase", "decrease"].includes(direction)) {
        throw apiError("An adjustment direction of increase or decrease is required.", "INVALID_ADJUSTMENT_DIRECTION", 400);
      }
      if (!(quantity > 0)) {
        throw apiError("An adjustment quantity must be greater than zero.", "INVALID_QUANTITY", 400);
      }
      if (!reason) {
        throw apiError("An adjustment reason is required.", "MISSING_ADJUSTMENT_REASON", 400);
      }
      const now = clock();

      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            [idempotencyKey],
          );
          const existing = await client.query(
            `SELECT id, inventory_item_id, movement_type,
                    quantity_delta, quantity_after, notes, created_at
               FROM inventory_movements
              WHERE restaurant_id = $1 AND idempotency_key = $2`,
            [restaurantId, idempotencyKey],
          );
          if (existing.rows[0]) {
            const prior = existing.rows[0];
            if (prior.inventory_item_id !== itemId) {
              throw apiError(
                "This idempotency key was already used for a different item.",
                "IDEMPOTENCY_KEY_CONFLICT",
                409,
              );
            }
            return {
              movement: mapMovement({ ...prior, item_name: null, item_sku: null, base_unit: null }),
              quantityAfter: Number(prior.quantity_after),
              replayed: true,
            };
          }

          const movementType = direction === "increase"
            ? "adjustment_increase"
            : "adjustment_decrease";
          const quantityDelta = direction === "increase" ? quantity : -quantity;
          const result = await applyStockChange(client, {
            restaurantId,
            inventoryItemId: itemId,
            movementType,
            quantityDelta,
            referenceType: "manual",
            idempotencyKey,
            notes: reason,
            actorUserId: userId,
            now,
          });
          const movement = await client.query(
            `SELECT m.*, m.created_at::text AS created_at_text,
                    i.name AS item_name, i.sku AS item_sku, i.base_unit
               FROM inventory_movements m
               JOIN inventory_items i
                 ON i.restaurant_id = m.restaurant_id AND i.id = m.inventory_item_id
              WHERE m.id = $1`,
            [result.movementId],
          );
          return {
            movement: mapMovement(movement.rows[0]),
            quantityAfter: result.quantityAfter,
            replayed: false,
          };
        },
      );
    },

    /**
     * Records waste. Idempotent per idempotency key. Waste is a
     * decrease with its own movement type so it is distinguishable
     * from a manual adjustment in the ledger.
     */
    async waste({ restaurantId, userId, input }) {
      const idempotencyKey = input.idempotencyKey;
      const itemId = input.itemId;
      const quantity = quantizeQuantity(input.quantity);
      const reason = normalizeText(input.reason, 2000);
      if (!(quantity > 0)) {
        throw apiError("A waste quantity must be greater than zero.", "INVALID_QUANTITY", 400);
      }
      if (!reason) {
        throw apiError("A waste reason is required.", "MISSING_WASTE_REASON", 400);
      }
      const now = clock();

      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            [idempotencyKey],
          );
          const existing = await client.query(
            `SELECT id, inventory_item_id, movement_type,
                    quantity_delta, quantity_after, notes, created_at
               FROM inventory_movements
              WHERE restaurant_id = $1 AND idempotency_key = $2`,
            [restaurantId, idempotencyKey],
          );
          if (existing.rows[0]) {
            const prior = existing.rows[0];
            if (prior.inventory_item_id !== itemId) {
              throw apiError(
                "This idempotency key was already used for a different item.",
                "IDEMPOTENCY_KEY_CONFLICT",
                409,
              );
            }
            return {
              movement: mapMovement({ ...prior, item_name: null, item_sku: null, base_unit: null }),
              quantityAfter: Number(prior.quantity_after),
              replayed: true,
            };
          }

          const result = await applyStockChange(client, {
            restaurantId,
            inventoryItemId: itemId,
            movementType: "waste",
            quantityDelta: -quantity,
            referenceType: "manual",
            idempotencyKey,
            notes: reason,
            actorUserId: userId,
            now,
          });
          const movement = await client.query(
            `SELECT m.*, m.created_at::text AS created_at_text,
                    i.name AS item_name, i.sku AS item_sku, i.base_unit
               FROM inventory_movements m
               JOIN inventory_items i
                 ON i.restaurant_id = m.restaurant_id AND i.id = m.inventory_item_id
              WHERE m.id = $1`,
            [result.movementId],
          );
          return {
            movement: mapMovement(movement.rows[0]),
            quantityAfter: result.quantityAfter,
            replayed: false,
          };
        },
      );
    },
  });
}

export { MAX_PAGE_SIZE, BASE_UNITS };
