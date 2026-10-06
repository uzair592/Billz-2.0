import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../database/tenant-transaction.mjs";
import { apiError } from "./business-date.mjs";
import {
  decodeInventoryCursor,
  encodeInventoryCursor,
  lineTotalMinor,
  lockInventoryItem,
  quantizeQuantity,
  recordMovement,
  weightedAverageCostMinor,
} from "./inventory-ledger.mjs";

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PURCHASE_ITEMS = 100;

function mapPurchase(row) {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name ?? null,
    purchaseNumber: row.purchase_number,
    supplierInvoiceNumber: row.supplier_invoice_number ?? null,
    status: row.status,
    purchaseDate: row.purchase_date,
    subtotalMinor: Number(row.subtotal_minor),
    discountMinor: Number(row.discount_minor),
    taxMinor: Number(row.tax_minor),
    totalMinor: Number(row.total_minor),
    notes: row.notes ?? null,
    receivedAt: row.received_at ?? null,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPurchaseItem(row) {
  return {
    id: row.id,
    inventoryItemId: row.inventory_item_id,
    itemName: row.item_name ?? null,
    itemSku: row.item_sku ?? null,
    baseUnit: row.base_unit ?? null,
    quantity: Number(row.quantity),
    unitCostMinor: Number(row.unit_cost_minor),
    lineTotalMinor: Number(row.line_total_minor),
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

function normalizeLimit(limit) {
  const parsed = limit === undefined ? DEFAULT_PAGE_SIZE : Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw apiError(`The page size must be between 1 and ${MAX_PAGE_SIZE}.`, "INVALID_PAGE_SIZE", 400);
  }
  return parsed;
}

function isDuplicateKeyError(error, indexName) {
  return String(error.message).includes(indexName);
}

/**
 * Generates the next per-restaurant purchase number under the
 * sequence row lock, mirroring the order-number pattern so two
 * concurrent drafts can never share a number.
 */
async function nextPurchaseNumber(client, restaurantId) {
  const result = await client.query(
    `INSERT INTO purchase_sequences (restaurant_id, next_number)
     VALUES ($1, 2)
     ON CONFLICT (restaurant_id) DO UPDATE
       SET next_number = purchase_sequences.next_number + 1
     RETURNING next_number - 1 AS number`,
    [restaurantId],
  );
  const number = Number(result.rows[0].number);
  return `PO-${String(number).padStart(6, "0")}`;
}

/**
 * Validates and normalizes purchase lines, computing the
 * authoritative line totals on the server. A client-sent line
 * total is never read.
 */
function normalizeLines(items) {
  const lines = (items ?? []).map((item) => {
    const quantity = quantizeQuantity(item.quantity);
    const unitCostMinor = Number(item.unitCostMinor);
    if (!(quantity > 0)) {
      throw apiError("Every purchase line quantity must be greater than zero.", "INVALID_PURCHASE_QUANTITY", 400);
    }
    if (!Number.isInteger(unitCostMinor) || unitCostMinor < 0) {
      throw apiError("Every purchase line unit cost must be a non-negative integer of minor units.", "INVALID_UNIT_COST", 400);
    }
    return {
      inventoryItemId: item.inventoryItemId,
      quantity,
      unitCostMinor,
      lineTotalMinor: lineTotalMinor(quantity, unitCostMinor),
    };
  });

  if (lines.length === 0) {
    throw apiError("A purchase must contain at least one line.", "EMPTY_PURCHASE", 400);
  }
  if (lines.length > MAX_PURCHASE_ITEMS) {
    throw apiError(
      `A purchase may not contain more than ${MAX_PURCHASE_ITEMS} lines.`,
      "PURCHASE_TOO_LARGE",
      400,
    );
  }
  return lines;
}

function computeTotals(lines, discountMinor, taxMinor) {
  const subtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  const totalMinor = subtotalMinor - discountMinor + taxMinor;
  if (totalMinor < 0) {
    throw apiError("The purchase total cannot be negative.", "NEGATIVE_PURCHASE_TOTAL", 400);
  }
  return { subtotalMinor, totalMinor };
}

/** Reads a purchase with its lines and supplier within a transaction. */
async function readPurchase(client, restaurantId, purchaseId) {
  const result = await client.query(
    `SELECT p.*, s.name AS supplier_name
       FROM purchases p
       JOIN suppliers s
         ON s.restaurant_id = p.restaurant_id
        AND s.id = p.supplier_id
      WHERE p.restaurant_id = $1 AND p.id = $2`,
    [restaurantId, purchaseId],
  );
  const row = result.rows[0];
  if (!row) {
    throw apiError("Purchase not found.", "PURCHASE_NOT_FOUND", 404);
  }

  const items = await client.query(
    `SELECT pi.*, i.name AS item_name, i.sku AS item_sku,
            i.base_unit
       FROM purchase_items pi
       JOIN inventory_items i
         ON i.restaurant_id = pi.restaurant_id
        AND i.id = pi.inventory_item_id
      WHERE pi.restaurant_id = $1 AND pi.purchase_id = $2
      ORDER BY pi.created_at ASC, pi.id ASC`,
    [restaurantId, purchaseId],
  );

  return { purchase: mapPurchase(row), items: items.rows.map(mapPurchaseItem) };
}

/**
 * Purchase service: draft purchasing documents that are
 * received into inventory.
 *
 * All money figures are computed on the server in integer
 * minor units. Only a draft can be edited; receiving is
 * idempotent and writes one receipt movement per purchased
 * item while recomputing the weighted average cost, all in
 * the same tenant transaction.
 */
export function createPurchaseService(pool, { clock = () => new Date() } = {}) {
  return Object.freeze({
    /** Lists a restaurant's purchases, newest first. */
    async list({ restaurantId, status = null, limit, cursor } = {}) {
      const pageSize = normalizeLimit(limit);
      return withTenantTransaction(
        pool,
        { restaurantId },
        async (client) => {
          const params = [restaurantId, status];
          let cursorClause = "";
          if (cursor) {
            const decoded = decodeInventoryCursor(cursor);
            params.push(decoded.createdAtText, decoded.id);
            cursorClause =
              ` AND (p.created_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
          }
          params.push(pageSize + 1);
          const result = await client.query(
            `SELECT p.*, s.name AS supplier_name,
                    p.created_at::text AS created_at_text
               FROM purchases p
               JOIN suppliers s
                 ON s.restaurant_id = p.restaurant_id
                AND s.id = p.supplier_id
              WHERE p.restaurant_id = $1
                AND ($2::text IS NULL OR p.status = $2)${cursorClause}
              ORDER BY p.created_at DESC, p.id DESC
              LIMIT $${params.length}`,
            params,
          );

          const rows = result.rows.slice(0, pageSize);
          const last = rows.at(-1);
          const hasMore = result.rows.length > pageSize;
          return {
            purchases: rows.map(mapPurchase),
            nextCursor: hasMore && last
              ? encodeInventoryCursor(last.created_at_text, last.id)
              : null,
          };
        },
      );
    },

    /** Retrieves one purchase with its lines and supplier. */
    async get({ restaurantId, purchaseId }) {
      return withTenantTransaction(
        pool,
        { restaurantId },
        async (client) => readPurchase(client, restaurantId, purchaseId),
      );
    },

    /**
     * Creates a draft purchase. The supplier and every
     * inventory item must belong to the restaurant, and the
     * server computes every total. Idempotent per idempotency
     * key.
     */
    async create({ restaurantId, userId, input }) {
      const idempotencyKey = input.idempotencyKey;
      const supplierId = input.supplierId;
      const purchaseDate = input.purchaseDate;
      const supplierInvoiceNumber = normalizeText(input.supplierInvoiceNumber, 100);
      const notes = normalizeText(input.notes, 2000);
      const discountMinor = Number(input.discountMinor ?? 0);
      const taxMinor = Number(input.taxMinor ?? 0);
      if (!Number.isInteger(discountMinor) || discountMinor < 0) {
        throw apiError("The discount must be a non-negative integer of minor units.", "INVALID_DISCOUNT", 400);
      }
      if (!Number.isInteger(taxMinor) || taxMinor < 0) {
        throw apiError("The tax must be a non-negative integer of minor units.", "INVALID_TAX", 400);
      }
      const lines = normalizeLines(input.items);
      const { subtotalMinor, totalMinor } = computeTotals(lines, discountMinor, taxMinor);
      if (discountMinor > subtotalMinor) {
        throw apiError("The discount cannot exceed the subtotal.", "DISCOUNT_EXCEEDS_SUBTOTAL", 400);
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
            `SELECT id FROM purchases
              WHERE restaurant_id = $1 AND idempotency_key = $2`,
            [restaurantId, idempotencyKey],
          );
          if (existing.rows[0]) {
            const purchase = await client.query(
              `SELECT p.*, s.name AS supplier_name
                 FROM purchases p
                 JOIN suppliers s ON s.restaurant_id = p.restaurant_id AND s.id = p.supplier_id
                WHERE p.restaurant_id = $1 AND p.id = $2`,
              [restaurantId, existing.rows[0].id],
            );
            return { purchase: mapPurchase(purchase.rows[0]), replayed: true };
          }

          const supplier = await client.query(
            `SELECT id FROM suppliers
              WHERE restaurant_id = $1 AND id = $2`,
            [restaurantId, supplierId],
          );
          if (supplier.rows.length === 0) {
            throw apiError("Supplier not found.", "SUPPLIER_NOT_FOUND", 404);
          }

          const itemIds = lines.map((line) => line.inventoryItemId);
          const itemResult = await client.query(
            `SELECT id FROM inventory_items
              WHERE restaurant_id = $1 AND id = ANY($2::uuid[])`,
            [restaurantId, itemIds],
          );
          const found = new Set(itemResult.rows.map((row) => row.id));
          const missing = itemIds.filter((id) => !found.has(id));
          if (missing.length > 0) {
            throw apiError(
              "One or more inventory items were not found.",
              "PURCHASE_ITEM_NOT_FOUND",
              404,
              { inventoryItemIds: missing },
            );
          }

          const purchaseNumber = await nextPurchaseNumber(client, restaurantId);
          const purchaseId = randomUUID();
          try {
            await client.query(
              `INSERT INTO purchases (
                 id, restaurant_id, supplier_id, purchase_number,
                 supplier_invoice_number, status, purchase_date,
                 subtotal_minor, discount_minor, tax_minor, total_minor,
                 notes, idempotency_key, created_by_user_id, created_at
               ) VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
              [
                purchaseId, restaurantId, supplierId, purchaseNumber,
                supplierInvoiceNumber, purchaseDate,
                subtotalMinor, discountMinor, taxMinor, totalMinor,
                notes, idempotencyKey, userId, now,
              ],
            );
          } catch (error) {
            if (isDuplicateKeyError(error, "purchases_restaurant_idempotency_unique")
                || isDuplicateKeyError(error, "purchases_restaurant_id_unique")
                || isDuplicateKeyError(error, "purchases_restaurant_purchase_number_unique")) {
              throw apiError("A conflicting purchase already exists.", "DUPLICATE_PURCHASE", 409);
            }
            throw error;
          }

          for (const line of lines) {
            await client.query(
              `INSERT INTO purchase_items (
                 restaurant_id, purchase_id, inventory_item_id,
                 quantity, unit_cost_minor, line_total_minor
               ) VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                restaurantId, purchaseId, line.inventoryItemId,
                line.quantity, line.unitCostMinor, line.lineTotalMinor,
              ],
            );
          }

          const purchase = await client.query(
            `SELECT p.*, s.name AS supplier_name
               FROM purchases p
               JOIN suppliers s ON s.restaurant_id = p.restaurant_id AND s.id = p.supplier_id
              WHERE p.restaurant_id = $1 AND p.id = $2`,
            [restaurantId, purchaseId],
          );
          return { purchase: mapPurchase(purchase.rows[0]), replayed: false };
        },
      );
    },

    /**
     * Edits a draft purchase. Only a draft can be edited; a
     * received or cancelled purchase is immutable. When lines
     * are supplied they replace the draft's lines and every
     * total is recomputed on the server.
     */
    async update({ restaurantId, userId, purchaseId, changes }) {
      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          const current = await client.query(
            `SELECT * FROM purchases
              WHERE restaurant_id = $1 AND id = $2
              FOR UPDATE`,
            [restaurantId, purchaseId],
          );
          const purchase = current.rows[0];
          if (!purchase) {
            throw apiError("Purchase not found.", "PURCHASE_NOT_FOUND", 404);
          }
          if (purchase.status !== "draft") {
            throw apiError(
              "Only a draft purchase can be edited.",
              "PURCHASE_NOT_DRAFT",
              409,
            );
          }

          const nextSupplierId = changes.supplierId !== undefined
            ? changes.supplierId
            : purchase.supplier_id;
          const nextPurchaseDate = changes.purchaseDate !== undefined
            ? changes.purchaseDate
            : purchase.purchase_date;
          const nextInvoiceNumber = changes.supplierInvoiceNumber !== undefined
            ? normalizeText(changes.supplierInvoiceNumber, 100)
            : purchase.supplier_invoice_number;
          const nextNotes = changes.notes !== undefined
            ? normalizeText(changes.notes, 2000)
            : purchase.notes;
          const nextDiscountMinor = changes.discountMinor !== undefined
            ? Number(changes.discountMinor)
            : Number(purchase.discount_minor);
          const nextTaxMinor = changes.taxMinor !== undefined
            ? Number(changes.taxMinor)
            : Number(purchase.tax_minor);

          if (!Number.isInteger(nextDiscountMinor) || nextDiscountMinor < 0) {
            throw apiError("The discount must be a non-negative integer of minor units.", "INVALID_DISCOUNT", 400);
          }
          if (!Number.isInteger(nextTaxMinor) || nextTaxMinor < 0) {
            throw apiError("The tax must be a non-negative integer of minor units.", "INVALID_TAX", 400);
          }

          let lines = null;
          let subtotalMinor = Number(purchase.subtotal_minor);
          if (changes.items !== undefined) {
            lines = normalizeLines(changes.items);
            const totals = computeTotals(lines, nextDiscountMinor, nextTaxMinor);
            subtotalMinor = totals.subtotalMinor;
            if (nextDiscountMinor > subtotalMinor) {
              throw apiError("The discount cannot exceed the subtotal.", "DISCOUNT_EXCEEDS_SUBTOTAL", 400);
            }
          } else if (nextDiscountMinor > subtotalMinor) {
            throw apiError("The discount cannot exceed the subtotal.", "DISCOUNT_EXCEEDS_SUBTOTAL", 400);
          }

          if (changes.supplierId !== undefined) {
            const supplier = await client.query(
              `SELECT id FROM suppliers
                WHERE restaurant_id = $1 AND id = $2`,
              [restaurantId, nextSupplierId],
            );
            if (supplier.rows.length === 0) {
              throw apiError("Supplier not found.", "SUPPLIER_NOT_FOUND", 404);
            }
          }

          if (lines) {
            const itemIds = lines.map((line) => line.inventoryItemId);
            const itemResult = await client.query(
              `SELECT id FROM inventory_items
                WHERE restaurant_id = $1 AND id = ANY($2::uuid[])`,
              [restaurantId, itemIds],
            );
            const found = new Set(itemResult.rows.map((row) => row.id));
            const missing = itemIds.filter((id) => !found.has(id));
            if (missing.length > 0) {
              throw apiError(
                "One or more inventory items were not found.",
                "PURCHASE_ITEM_NOT_FOUND",
                404,
                { inventoryItemIds: missing },
              );
            }

            await client.query(
              `DELETE FROM purchase_items
                WHERE restaurant_id = $1 AND purchase_id = $2`,
              [restaurantId, purchaseId],
            );
            for (const line of lines) {
              await client.query(
                `INSERT INTO purchase_items (
                   restaurant_id, purchase_id, inventory_item_id,
                   quantity, unit_cost_minor, line_total_minor
                 ) VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                  restaurantId, purchaseId, line.inventoryItemId,
                  line.quantity, line.unitCostMinor, line.lineTotalMinor,
                ],
              );
            }
          }

          const totalMinor = subtotalMinor - nextDiscountMinor + nextTaxMinor;
          if (totalMinor < 0) {
            throw apiError("The purchase total cannot be negative.", "NEGATIVE_PURCHASE_TOTAL", 400);
          }

          await client.query(
            `UPDATE purchases
                SET supplier_id = $3,
                    supplier_invoice_number = $4,
                    purchase_date = $5,
                    subtotal_minor = $6,
                    discount_minor = $7,
                    tax_minor = $8,
                    total_minor = $9,
                    notes = $10
              WHERE restaurant_id = $1 AND id = $2`,
            [
              restaurantId, purchaseId, nextSupplierId, nextInvoiceNumber,
              nextPurchaseDate, subtotalMinor, nextDiscountMinor,
              nextTaxMinor, totalMinor, nextNotes,
            ],
          );

          return readPurchase(client, restaurantId, purchaseId);
        },
      );
    },

    /**
     * Receives a draft purchase into inventory.
     *
     * Receiving is idempotent: the same receive idempotency key
     * returns the already-received purchase, and a different key
     * against an already-received purchase is a 409 conflict.
     * The status change, the receipt movements, and the weighted
     * average cost updates all commit in one tenant transaction.
     */
    async receive({ restaurantId, userId, purchaseId, idempotencyKey }) {
      const now = clock();

      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            [idempotencyKey],
          );

          const current = await client.query(
            `SELECT * FROM purchases
              WHERE restaurant_id = $1 AND id = $2
              FOR UPDATE`,
            [restaurantId, purchaseId],
          );
          const purchase = current.rows[0];
          if (!purchase) {
            throw apiError("Purchase not found.", "PURCHASE_NOT_FOUND", 404);
          }

          if (purchase.status === "received") {
            if (purchase.receive_idempotency_key === idempotencyKey) {
              return { purchase: mapPurchase(purchase), replayed: true };
            }
            throw apiError(
              "This purchase has already been received.",
              "PURCHASE_ALREADY_RECEIVED",
              409,
            );
          }
          if (purchase.status !== "draft") {
            throw apiError(
              "Only a draft purchase can be received.",
              "PURCHASE_NOT_DRAFT",
              409,
            );
          }

          const items = await client.query(
            `SELECT * FROM purchase_items
              WHERE restaurant_id = $1 AND purchase_id = $2
              ORDER BY created_at ASC, id ASC`,
            [restaurantId, purchaseId],
          );
          if (items.rows.length === 0) {
            throw apiError(
              "A purchase must contain at least one line before it can be received.",
              "EMPTY_PURCHASE",
              422,
            );
          }

          await client.query(
            `UPDATE purchases
                SET status = 'received',
                    received_at = $3,
                    receive_idempotency_key = $4
              WHERE restaurant_id = $1 AND id = $2`,
            [restaurantId, purchaseId, now, idempotencyKey],
          );

          const receipts = [];
          for (const item of items.rows) {
            // The row lock serializes concurrent receipts and
            // concurrent consumption for this item, so the
            // balance, the average cost, and the ledger always
            // agree.
            const locked = await lockInventoryItem(
              client,
              restaurantId,
              item.inventory_item_id,
            );
            if (!locked) {
              throw apiError(
                "Inventory item not found.",
                "INVENTORY_ITEM_NOT_FOUND",
                404,
              );
            }

            const receivedQuantity = Number(item.quantity);
            const unitCostMinor = Number(item.unit_cost_minor);
            const nextQuantity = Number(locked.current_quantity) + receivedQuantity;
            const nextAverageCostMinor = weightedAverageCostMinor({
              currentQuantity: locked.current_quantity,
              currentAverageCostMinor: locked.average_cost_minor,
              receivedQuantity,
              unitCostMinor,
            });

            await client.query(
              `UPDATE inventory_items
                  SET current_quantity = $3,
                      average_cost_minor = $4,
                      updated_at = $5
                WHERE restaurant_id = $1 AND id = $2`,
              [
                restaurantId, item.inventory_item_id,
                nextQuantity, nextAverageCostMinor, now,
              ],
            );

            const movementId = await recordMovement(client, {
              restaurantId,
              inventoryItemId: item.inventory_item_id,
              movementType: "purchase_receipt",
              quantityDelta: receivedQuantity,
              quantityAfter: nextQuantity,
              unitCostMinor,
              totalCostMinor: Number(item.line_total_minor),
              referenceType: "purchase",
              referenceId: purchaseId,
              idempotencyKey: randomUUID(),
              notes: `Purchase ${purchase.purchase_number}`,
              actorUserId: userId,
              now,
            });

            receipts.push({
              movementId,
              inventoryItemId: item.inventory_item_id,
              quantity: receivedQuantity,
              unitCostMinor,
              quantityAfter: nextQuantity,
              averageCostMinor: nextAverageCostMinor,
            });
          }

          const updated = await client.query(
            `SELECT p.*, s.name AS supplier_name
               FROM purchases p
               JOIN suppliers s ON s.restaurant_id = p.restaurant_id AND s.id = p.supplier_id
              WHERE p.restaurant_id = $1 AND p.id = $2`,
            [restaurantId, purchaseId],
          );
          return { purchase: mapPurchase(updated.rows[0]), receipts, replayed: false };
        },
      );
    },
  });
}

export { MAX_PAGE_SIZE, MAX_PURCHASE_ITEMS };
