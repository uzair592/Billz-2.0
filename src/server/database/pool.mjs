import pg from "pg";

/**
 * Production PostgreSQL pool factory.
 *
 * Managed PostgreSQL services (RDS, Cloud SQL, Render, Supabase, etc.)
 * typically require SSL. The pool is configured from the environment so
 * the same code runs against a local development database (no SSL) and a
 * managed production database (SSL, possibly a custom CA) without any
 * code change.
 *
 * The pool never logs credentials or the full connection string. Only a
 * redacted host/port and the SSL mode are ever reported.
 */

/**
 * Parses DATABASE_SSL_MODE into an explicit, allowlisted SSL
 * configuration.
 *
 * The semantics are deliberately strict so a managed PostgreSQL
 * connection cannot silently fall back to an insecure mode:
 *
 *   * `disable`  -> no `ssl` option at all (plaintext).
 *   * `require`  -> TLS with `rejectUnauthorized: false`
 *                   (encrypts but does not verify the chain).
 *   * `verify-full` -> TLS with `rejectUnauthorized: true`
 *                   (encrypts and verifies the chain).
 *   * any other value is rejected.
 *
 * `DATABASE_SSL_CA` is only honored for `require` and
 * `verify-full`; it is ignored for `disable` because there is no
 * TLS to attach a CA to. The function never returns credentials
 * or certificate contents — only the pg SSL options.
 *
 * @param {object} env - Environment object.
 * @returns {null|{rejectUnauthorized: boolean, ca?: string}}
 */
export function parseSslConfig(env) {
  const mode = String(env.DATABASE_SSL_MODE ?? "").trim().toLowerCase();
  if (!mode) {
    // Default: no explicit SSL mode. The connection is left to
    // pg's own default (no TLS for a plain connection string).
    return null;
  }
  switch (mode) {
    case "disable":
      return null;
    case "require": {
      const ssl = { rejectUnauthorized: false };
      const ca = env.DATABASE_SSL_CA;
      if (ca) ssl.ca = ca;
      return ssl;
    }
    case "verify-full": {
      const ssl = { rejectUnauthorized: true };
      const ca = env.DATABASE_SSL_CA;
      if (ca) ssl.ca = ca;
      return ssl;
    }
    default:
      throw Object.assign(
        new Error(
          `DATABASE_SSL_MODE must be "disable", "require", or "verify-full", not "${mode}".`,
        ),
        { code: "CONFIGURATION_INVALID" },
      );
  }
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.password = "***";
    if (parsed.username) parsed.username = "***";
    return parsed.toString();
  } catch {
    return "<unparseable>";
  }
}

export function createDatabasePool(env = process.env, logger = console) {
  const databaseUrl = String(env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    throw Object.assign(new Error("DATABASE_URL is required."), {
      code: "CONFIGURATION_INVALID",
    });
  }

  const max = Number.isInteger(Number(env.DATABASE_POOL_MAX))
    ? Math.max(1, Number(env.DATABASE_POOL_MAX))
    : 10;
  const idleTimeoutMillis = Number.isInteger(Number(env.DATABASE_IDLE_TIMEOUT_MS))
    ? Number(env.DATABASE_IDLE_TIMEOUT_MS)
    : 30_000;
  const connectionTimeoutMillis = Number.isInteger(Number(env.DATABASE_CONNECT_TIMEOUT_MS))
    ? Number(env.DATABASE_CONNECT_TIMEOUT_MS)
    : 10_000;

  const ssl = parseSslConfig(env);

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    // Keep statement timeouts so a runaway query cannot hold a
    // connection indefinitely.
    options: "-c statement_timeout=15000",
    ...(ssl ? { ssl } : {}),
  });

  pool.on("error", (error) => {
    // An idle client error must not crash the process, but it must be
    // visible. The message never includes the connection string.
    logger.error?.({
      message: "database_pool_error",
      error: error.message,
      code: error.code,
    });
  });

  return pool;
}

/**
 * Proves the database is reachable within a short timeout. Used by the
 * readiness probe and by startup so the process never claims readiness
 * before PostgreSQL is usable.
 */
export async function checkDatabaseReady(pool, { timeoutMs = 3_000 } = {}) {
  const client = await pool.connect();
  try {
    const result = await Promise.race([
      client.query("SELECT 1 AS ok"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("database readiness check timed out")), timeoutMs),
      ),
    ]);
    return result.rows[0].ok === 1;
  } finally {
    client.release();
  }
}

/**
 * Closes the pool gracefully, allowing in-flight queries to finish.
 */
export async function closeDatabasePool(pool, { timeoutMs = 10_000 } = {}) {
  if (!pool) return;
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      // Force-terminate remaining clients if graceful close stalls.
      try {
        pool._clients?.forEach((client) => client.stream?.destroy?.());
      } catch {
        // best effort
      }
      resolve("timeout");
    }, timeoutMs);
  });
  const closed = pool.end();
  await Promise.race([closed, timeout]);
  clearTimeout(timeoutId);
}

export { redactUrl };
