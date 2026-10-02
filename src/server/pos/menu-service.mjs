import { withTenantTransaction } from "../database/tenant-transaction.mjs";

function mapCategory(row) {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
  };
}

function mapSubcategory(row) {
  return {
    id: row.id,
    categoryId: row.category_id,
    name: row.name,
    sortOrder: row.sort_order,
  };
}

function mapMenuItem(row) {
  return {
    id: row.id,
    itemNumber: row.item_number,
    categoryId: row.category_id,
    subcategoryId: row.subcategory_id,
    name: row.name,
    description: row.description,
    itemType: row.item_type,
    priceMinor: Number(row.price_minor),
    imageObjectKey: row.image_object_key,
    metadata: row.metadata ?? {},
  };
}

export function createMenuService(pool) {
  return Object.freeze({
    async list({ restaurantId, userId }) {
      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          const categoryResult = await client.query(
            `SELECT id, name, sort_order
               FROM menu_categories
              WHERE is_active = true
              ORDER BY sort_order, name`,
          );
          const subcategoryResult = await client.query(
            `SELECT id, category_id, name, sort_order
               FROM menu_subcategories
              WHERE is_active = true
              ORDER BY sort_order, name`,
          );
          const itemResult = await client.query(
            `SELECT id, item_number, category_id, subcategory_id, name,
                    description, item_type, price_minor, image_object_key, metadata
               FROM menu_items
              WHERE is_active = true
              ORDER BY item_number NULLS LAST, name`,
          );

          return Object.freeze({
            categories: categoryResult.rows.map(mapCategory),
            subcategories: subcategoryResult.rows.map(mapSubcategory),
            items: itemResult.rows.map(mapMenuItem),
          });
        },
      );
    },
  });
}
