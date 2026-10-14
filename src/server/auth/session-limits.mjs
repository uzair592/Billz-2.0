export async function lockPlanSessions(client, planId, exclusive = false) {
  if (planId)
    await client.query(
      `SELECT ${exclusive ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared"}(hashtextextended($1,0))`,
      [`plan-sessions:${planId}`],
    );
}

// Keep the most recently used sessions when an administrator lowers an allowance.
export async function revokeExcessSessions(
  client,
  restaurantId,
  maxDevices,
  now,
) {
  const result = await client.query(
    `WITH ranked AS (
    SELECT s.id, row_number() OVER (ORDER BY s.last_seen_at DESC,s.created_at DESC,s.id DESC) AS position
    FROM sessions s JOIN users u ON u.id=s.user_id AND u.status='active'
    JOIN restaurant_memberships m ON m.user_id=s.user_id AND m.restaurant_id=s.restaurant_id AND m.status='active'
    WHERE s.restaurant_id=$1 AND s.revoked_at IS NULL AND s.expires_at>$3)
    UPDATE sessions SET revoked_at=$3 WHERE id IN (SELECT id FROM ranked WHERE position>$2) RETURNING id`,
    [restaurantId, maxDevices, now],
  );
  return result.rows.length;
}

export function controlError(message, code, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}
