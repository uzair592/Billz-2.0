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
    legacyItemId: row.legacy_item_id === null || row.legacy_item_id === undefined
      ? null
      : Number(row.legacy_item_id),
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
            `SELECT id, legacy_item_id, item_number, category_id, subcategory_id, name,
                    description, item_type, price_minor, image_object_key, metadata
               FROM menu_items
              WHERE is_active = true
              ORDER BY item_number NULLS LAST, name`,
          );
          const itemOfferResult = await client.query(
            `SELECT menu_item_id, offer_price_minor, starts_on, ends_on
               FROM menu_item_offers
              WHERE is_active = true`,
          );
          const categoryOfferResult = await client.query(
            `SELECT category_id, discount_type, discount_minor,
                    discount_percent, starts_on, ends_on
               FROM menu_category_offers
              WHERE is_active = true`,
          );

          return Object.freeze({
            categories: categoryResult.rows.map(mapCategory),
            subcategories: subcategoryResult.rows.map(mapSubcategory),
            items: itemResult.rows.map(mapMenuItem),
            itemOffers: itemOfferResult.rows.map((row) => ({
              menuItemId: row.menu_item_id,
              offerPriceMinor: Number(row.offer_price_minor),
              startsOn: row.starts_on,
              endsOn: row.ends_on,
            })),
            categoryOffers: categoryOfferResult.rows.map((row) => ({
              categoryId: row.category_id,
              discountType: row.discount_type,
              discountMinor: row.discount_minor === null ? null : Number(row.discount_minor),
              discountPercent: row.discount_percent === null
                ? null
                : Number(row.discount_percent),
              startsOn: row.starts_on,
              endsOn: row.ends_on,
            })),
          });
        },
      );
    },
  });
}
