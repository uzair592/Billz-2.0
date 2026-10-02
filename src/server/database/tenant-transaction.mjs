const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a valid UUID.`);
  }
}

/**
 * Executes tenant work in one PostgreSQL transaction with the RLS context set.
 * The restaurant ID must come from the authenticated membership selected by the
 * server, never from a request body or resource payload.
 */
export async function withTenantTransaction(
  pool,
  { restaurantId, userId = null },
  operation,
) {
  requireUuid(restaurantId, "restaurantId");
  if (userId !== null) requireUuid(userId, "userId");
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("A PostgreSQL-compatible connection pool is required.");
  }
  if (typeof operation !== "function") {
    throw new TypeError("operation must be a function.");
  }

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query(
      "SELECT set_config('app.restaurant_id', $1, true)",
      [restaurantId],
    );
    if (userId !== null) {
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    }

    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Tenant transaction failed and rollback also failed.",
        );
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
