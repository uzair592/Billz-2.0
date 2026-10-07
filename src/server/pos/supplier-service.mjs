import { withTenantTransaction } from "../database/tenant-transaction.mjs";
import { apiError } from "./business-date.mjs";

const MAX_PAGE_SIZE = 200;

function mapSupplier(row) {
  return {
    id: row.id,
    name: row.name,
    contactPerson: row.contact_person ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    address: row.address ?? null,
    notes: row.notes ?? null,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeText(value, maxLength) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw apiError(
      `A value may not exceed ${maxLength} characters.`,
      "VALUE_TOO_LONG",
      400,
    );
  }
  return trimmed;
}

/**
 * Supplier service: the purchasing contact directory.
 *
 * Suppliers are tenant-owned and never destructively deleted;
 * a supplier that is no longer used is deactivated so its
 * historical purchases keep a valid reference.
 */
export function createSupplierService(pool, { clock = () => new Date() } = {}) {
  return Object.freeze({
    /** Lists a restaurant's suppliers, active names first. */
    async list({ restaurantId, isActive = null } = {}) {
      return withTenantTransaction(
        pool,
        { restaurantId },
        async (client) => {
          const result = await client.query(
            `SELECT * FROM suppliers
              WHERE restaurant_id = $1
                AND ($2::boolean IS NULL OR is_active = $2)
              ORDER BY is_active DESC, name ASC, id ASC`,
            [restaurantId, isActive],
          );
          return { suppliers: result.rows.map(mapSupplier) };
        },
      );
    },

    /** Creates a supplier. Duplicate active names are rejected. */
    async create({ restaurantId, userId, input }) {
      const name = normalizeText(input.name, 200);
      if (!name) {
        throw apiError("A supplier name is required.", "MISSING_SUPPLIER_NAME", 400);
      }
      const contactPerson = normalizeText(input.contactPerson, 200);
      const phone = normalizeText(input.phone, 40);
      const email = normalizeText(input.email, 320);
      const address = normalizeText(input.address, 500);
      const notes = normalizeText(input.notes, 2000);
      const isActive = input.isActive === undefined ? true : Boolean(input.isActive);

      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          try {
            const result = await client.query(
              `INSERT INTO suppliers (
                 restaurant_id, name, contact_person, phone, email,
                 address, notes, is_active
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               RETURNING *`,
              [
                restaurantId, name, contactPerson, phone, email,
                address, notes, isActive,
              ],
            );
            return { supplier: mapSupplier(result.rows[0]) };
          } catch (error) {
            // The partial unique index on active names is the
            // authoritative duplicate guard.
            if (String(error.message).includes("suppliers_restaurant_active_name_idx")) {
              throw apiError(
                "An active supplier with this name already exists.",
                "DUPLICATE_SUPPLIER_NAME",
                409,
              );
            }
            throw error;
          }
        },
      );
    },

    /** Updates a supplier's details or active flag. */
    async update({ restaurantId, userId, supplierId, changes }) {
      const fields = {};
      if (changes.name !== undefined) {
        const name = normalizeText(changes.name, 200);
        if (!name) {
          throw apiError("A supplier name is required.", "MISSING_SUPPLIER_NAME", 400);
        }
        fields.name = name;
      }
      if (changes.contactPerson !== undefined) {
        fields.contact_person = normalizeText(changes.contactPerson, 200);
      }
      if (changes.phone !== undefined) {
        fields.phone = normalizeText(changes.phone, 40);
      }
      if (changes.email !== undefined) {
        fields.email = normalizeText(changes.email, 320);
      }
      if (changes.address !== undefined) {
        fields.address = normalizeText(changes.address, 500);
      }
      if (changes.notes !== undefined) {
        fields.notes = normalizeText(changes.notes, 2000);
      }
      if (changes.isActive !== undefined) {
        fields.is_active = Boolean(changes.isActive);
      }

      const keys = Object.keys(fields);
      if (keys.length === 0) {
        throw apiError("No supplier changes were provided.", "NO_CHANGES", 400);
      }

      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          const setClauses = keys
            .map((key, index) => `${key} = $${index + 3}`)
            .join(", ");
          try {
            const result = await client.query(
              `UPDATE suppliers
                  SET ${setClauses}
                WHERE restaurant_id = $1 AND id = $2
                RETURNING *`,
              [restaurantId, supplierId, ...keys.map((key) => fields[key])],
            );
            if (result.rows.length === 0) {
              throw apiError("Supplier not found.", "SUPPLIER_NOT_FOUND", 404);
            }
            return { supplier: mapSupplier(result.rows[0]) };
          } catch (error) {
            if (String(error.message).includes("suppliers_restaurant_active_name_idx")) {
              throw apiError(
                "An active supplier with this name already exists.",
                "DUPLICATE_SUPPLIER_NAME",
                409,
              );
            }
            throw error;
          }
        },
      );
    },

    /** Deactivates a supplier without deleting its history. */
    async deactivate({ restaurantId, userId, supplierId }) {
      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          const result = await client.query(
            `UPDATE suppliers
                SET is_active = false
              WHERE restaurant_id = $1 AND id = $2
              RETURNING *`,
            [restaurantId, supplierId],
          );
          if (result.rows.length === 0) {
            throw apiError("Supplier not found.", "SUPPLIER_NOT_FOUND", 404);
          }
          return { supplier: mapSupplier(result.rows[0]) };
        },
      );
    },
  });
}

export { MAX_PAGE_SIZE };
