import { withTenantTransaction } from "../database/tenant-transaction.mjs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function mapContext(row) {
  if (!row) return null;
  return Object.freeze({
    restaurant: Object.freeze({
      id: row.restaurant_id,
      name: row.restaurant_name,
      status: row.restaurant_status,
      timezone: row.restaurant_timezone,
      currencyCode: row.currency_code,
    }),
    membership: Object.freeze({
      userId: row.user_id,
      role: row.role,
      status: row.membership_status,
      defaultBranchId: row.default_branch_id,
    }),
    subscription: row.subscription_status
      ? Object.freeze({
          id: row.subscription_id,
          status: row.subscription_status,
          currentPeriodEnd: row.current_period_end,
          trialEndsAt: row.trial_ends_at,
          graceEndsAt: row.grace_ends_at,
        })
      : null,
  });
}

export function createTenantContextService(pool) {
  return Object.freeze({
    async load({ userId, restaurantId }) {
      if (!isUuid(userId) || !isUuid(restaurantId)) return null;

      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          const result = await client.query(
            `SELECT
               r.id AS restaurant_id,
               r.name AS restaurant_name,
               r.status AS restaurant_status,
               r.timezone AS restaurant_timezone,
               r.currency_code,
               m.user_id,
               m.role,
               m.status AS membership_status,
               m.default_branch_id,
               s.id AS subscription_id,
               s.status AS subscription_status,
               s.current_period_end,
               s.trial_ends_at,
               s.grace_ends_at
             FROM restaurant_memberships m
             JOIN restaurants r ON r.id = m.restaurant_id
             LEFT JOIN LATERAL (
               SELECT id, status, current_period_end, trial_ends_at, grace_ends_at
                 FROM subscriptions
                WHERE restaurant_id = m.restaurant_id
                ORDER BY created_at DESC
                LIMIT 1
             ) s ON true
            WHERE m.restaurant_id = $1
              AND m.user_id = $2
              AND m.status = 'active'`,
            [restaurantId, userId],
          );
          return mapContext(result.rows[0]);
        },
      );
    },
  });
}
