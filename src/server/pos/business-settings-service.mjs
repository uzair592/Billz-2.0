import { withTenantTransaction } from "../database/tenant-transaction.mjs";

function mapSettings(row) {
  if (!row) return null;
  return Object.freeze({
    restaurantId: row.restaurant_id,
    defaultBranchId: row.default_branch_id,
    businessName: row.business_name,
    phone: row.phone,
    address: row.address,
    slogan: row.slogan,
    logoObjectKey: row.logo_object_key,
    timezone: row.timezone,
    currencyCode: row.currency_code,
  });
}

export function createBusinessSettingsService(pool) {
  async function getWithinTransaction(client) {
    const result = await client.query(
      `SELECT b.restaurant_id, b.default_branch_id, b.business_name,
              b.phone, b.address, b.slogan, b.logo_object_key,
              r.timezone, r.currency_code
         FROM business_settings b
         JOIN restaurants r ON r.id = b.restaurant_id`,
    );
    return mapSettings(result.rows[0]);
  }

  return Object.freeze({
    async get({ restaurantId, userId }) {
      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        getWithinTransaction,
      );
    },

    async update({ restaurantId, userId, changes }) {
      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          const current = await getWithinTransaction(client);
          if (!current) {
            const error = new Error("Business settings were not found.");
            error.code = "SETTINGS_NOT_FOUND";
            error.statusCode = 404;
            throw error;
          }
          const next = {
            businessName: changes.businessName ?? current.businessName,
            phone: changes.phone === undefined ? current.phone : changes.phone,
            address: changes.address === undefined ? current.address : changes.address,
            slogan: changes.slogan === undefined ? current.slogan : changes.slogan,
            timezone: changes.timezone ?? current.timezone,
            currencyCode: changes.currencyCode ?? current.currencyCode,
          };
          await client.query(
            `UPDATE business_settings
                SET business_name = $2, phone = $3, address = $4, slogan = $5
              WHERE restaurant_id = $1`,
            [restaurantId, next.businessName, next.phone, next.address, next.slogan],
          );
          await client.query(
            `UPDATE restaurants
                SET name = $2, phone = $3, address = $4,
                    timezone = $5, currency_code = $6
              WHERE id = $1`,
            [
              restaurantId,
              next.businessName,
              next.phone,
              next.address,
              next.timezone,
              next.currencyCode,
            ],
          );
          return getWithinTransaction(client);
        },
      );
    },
  });
}
