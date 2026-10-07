import { randomUUID } from "node:crypto";
import { withUserContextTransaction } from "../database/tenant-transaction.mjs";

function slugFor(name, restaurantId) {
  const base = String(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "restaurant";
  return `${base}-${restaurantId.slice(0, 8)}`;
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    restaurantId: row.restaurant_id,
    displayName: row.display_name,
    platformRole: row.platform_role,
    status: row.status,
    emailVerifiedAt: row.email_verified_at,
    passwordHash: row.password_hash,
  };
}

async function rollback(client, originalError) {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      "Authentication transaction failed and rollback also failed.",
    );
  }
}

export function createPostgresAuthRepository(pool) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("A PostgreSQL-compatible connection pool is required.");
  }

  return Object.freeze({
    async createPendingOwner(input) {
      const client = await pool.connect();
      const userId = randomUUID();
      const restaurantId = randomUUID();
      const branchId = randomUUID();
      const verificationId = randomUUID();

      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '15s'");
        await client.query(
          "SELECT set_config('app.restaurant_id', $1, true)",
          [restaurantId],
        );
        const userResult = await client.query(
          `INSERT INTO users (
             id, email, normalized_email, password_hash, display_name,
             platform_role, status
           ) VALUES ($1, $2, $3, $4, $5, 'user', 'pending_verification')
           RETURNING id, email, display_name, platform_role, status,
                     email_verified_at, password_hash`,
          [userId, input.email, input.normalizedEmail, input.passwordHash, input.displayName],
        );
        await client.query(
          `INSERT INTO restaurants (id, name, slug, status)
           VALUES ($1, $2, $3, 'active')`,
          [restaurantId, input.restaurantName, slugFor(input.restaurantName, restaurantId)],
        );
        await client.query(
          `INSERT INTO branches (id, restaurant_id, code, name, is_default)
           VALUES ($1, $2, 'MAIN', 'Main Branch', true)`,
          [branchId, restaurantId],
        );
        await client.query(
          `INSERT INTO restaurant_memberships (
             restaurant_id, user_id, default_branch_id, role, status
           ) VALUES ($1, $2, $3, 'owner', 'invited')`,
          [restaurantId, userId, branchId],
        );
        await client.query(
          `INSERT INTO business_settings (
             restaurant_id, default_branch_id, business_name
           ) VALUES ($1, $2, $3)`,
          [restaurantId, branchId, input.restaurantName],
        );
        await client.query(
          `INSERT INTO financial_accounts (
             restaurant_id, branch_id, account_type, display_name
           ) VALUES ($1, $2, 'cash', 'Cash')`,
          [restaurantId, branchId],
        );
        await client.query(
          `INSERT INTO email_verification_tokens (
             id, user_id, restaurant_id, token_hash, expires_at
           ) VALUES ($1, $2, $3, $4, $5)`,
          [verificationId, userId, restaurantId, input.verificationTokenHash, input.verificationExpiresAt],
        );
        await client.query("COMMIT");
        return mapUser(userResult.rows[0]);
      } catch (error) {
        await rollback(client, error);
        if (error.code === "23505" && /normalized_email/i.test(error.constraint ?? "")) {
          const duplicate = new Error("Registration is already pending.");
          duplicate.code = "EMAIL_EXISTS";
          throw duplicate;
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async consumeEmailVerification({ tokenHash, now }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tokenResult = await client.query(
          `SELECT id, user_id, restaurant_id
             FROM email_verification_tokens
            WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2
            FOR UPDATE`,
          [tokenHash, now],
        );
        const token = tokenResult.rows[0];
        if (!token) {
          await client.query("ROLLBACK");
          return null;
        }
        await client.query(
          "SELECT set_config('app.restaurant_id', $1, true)",
          [token.restaurant_id],
        );
        await client.query(
          "UPDATE email_verification_tokens SET consumed_at = $2 WHERE id = $1",
          [token.id, now],
        );
        const userResult = await client.query(
          `UPDATE users
              SET status = 'active', email_verified_at = $2, updated_at = $2
            WHERE id = $1 AND status = 'pending_verification'
          RETURNING id, email, display_name, platform_role, status,
                    email_verified_at, password_hash`,
          [token.user_id, now],
        );
        if (!userResult.rows[0]) throw new Error("Verification account is no longer pending.");
        await client.query(
          `UPDATE restaurant_memberships
              SET status = 'active', joined_at = $3, updated_at = $3
            WHERE restaurant_id = $1 AND user_id = $2`,
          [token.restaurant_id, token.user_id, now],
        );
        await client.query("COMMIT");
        return mapUser(userResult.rows[0]);
      } catch (error) {
        await rollback(client, error);
        throw error;
      } finally {
        client.release();
      }
    },

    async findUserByEmail(normalizedEmail) {
      const result = await pool.query(
        `SELECT id, email, display_name, platform_role, status,
                email_verified_at, password_hash
           FROM users WHERE normalized_email = $1`,
        [normalizedEmail],
      );
      return mapUser(result.rows[0]);
    },

    async createSession({ userId, tokenHash, ipAddress, userAgent, expiresAt }) {
      await pool.query(
        `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, tokenHash, ipAddress, userAgent, expiresAt],
      );
    },

    async findActiveSession(tokenHash, now) {
      const result = await pool.query(
        `WITH active_session AS (
           UPDATE sessions SET last_seen_at = $2
            WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2
          RETURNING user_id, expires_at
         )
         SELECT u.id, u.email, u.display_name, u.platform_role, u.status,
                u.email_verified_at, u.password_hash, s.expires_at
           FROM active_session s JOIN users u ON u.id = s.user_id
          WHERE u.status = 'active'`,
        [tokenHash, now],
      );
      const row = result.rows[0];
      return row ? { user: mapUser(row), expiresAt: row.expires_at } : null;
    },

    async revokeSession(tokenHash, now) {
      await pool.query(
        `UPDATE sessions SET revoked_at = COALESCE(revoked_at, $2)
          WHERE token_hash = $1`,
        [tokenHash, now],
      );
    },

    async findUserByRestaurantAndUsername({ restaurantCode, username }) {
      const normCode = String(restaurantCode ?? "").trim().toLowerCase();
      const normUsername = String(username ?? "").trim().toLowerCase();

      const restResult = await pool.query(
        `SELECT id, name, code, status FROM restaurants WHERE code = $1 OR slug = $1`,
        [normCode],
      );
      const restaurant = restResult.rows[0];
      if (!restaurant) return { restaurant: null, user: null };

      const userResult = await pool.query(
        `SELECT id, email, username, restaurant_id, display_name, platform_role, status,
                email_verified_at, password_hash
           FROM users
          WHERE restaurant_id = $1 AND normalized_username = $2`,
        [restaurant.id, normUsername],
      );
      const user = userResult.rows[0];
      return {
        restaurant: {
          id: restaurant.id,
          name: restaurant.name,
          code: restaurant.code,
          status: restaurant.status,
        },
        user: mapUser(user),
      };
    },

    async createTenantUser({ restaurantId, username, passwordHash, displayName, role = "cashier" }) {
      const client = await pool.connect();
      const userId = randomUUID();
      const normUsername = String(username ?? "").trim().toLowerCase();

      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.restaurant_id', $1, true)", [restaurantId]);

        const branchResult = await client.query(
          `SELECT id FROM branches WHERE restaurant_id = $1 AND is_default = true LIMIT 1`,
          [restaurantId],
        );
        const branchId = branchResult.rows[0]?.id;

        const userResult = await client.query(
          `INSERT INTO users (
             id, restaurant_id, username, normalized_username, password_hash, display_name,
             platform_role, status, email_verified_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'user', 'active', now())
           RETURNING id, email, username, restaurant_id, display_name, platform_role, status,
                     email_verified_at, password_hash`,
          [userId, restaurantId, String(username).trim(), normUsername, passwordHash, String(displayName).trim()],
        );

        await client.query(
          `INSERT INTO restaurant_memberships (
             restaurant_id, user_id, default_branch_id, role, status, joined_at
           ) VALUES ($1, $2, $3, $4, 'active', now())`,
          [restaurantId, userId, branchId, role],
        );

        await client.query("COMMIT");
        return mapUser(userResult.rows[0]);
      } catch (error) {
        await rollback(client, error);
        if (error.code === "23505" && /username/i.test(error.constraint ?? "")) {
          const duplicate = new Error("Username already exists in this restaurant.");
          duplicate.code = "USERNAME_EXISTS";
          throw duplicate;
        }
        throw error;
      } finally {
        client.release();
      }
    },

    /**
     * Lists only the restaurants this user is an active member of. The query
     * runs without a tenant context, so row-level security restricts it to the
     * caller's own membership rows.
     */
    async listRestaurantsForUser(userId) {
      return withUserContextTransaction(pool, { userId }, async (client) => {
        const result = await client.query(
          `SELECT m.restaurant_id, r.name AS restaurant_name,
                  r.status AS restaurant_status, r.currency_code,
                  m.role, m.default_branch_id
             FROM restaurant_memberships m
             JOIN restaurants r ON r.id = m.restaurant_id
            WHERE m.user_id = $1 AND m.status = 'active'
            ORDER BY r.name`,
          [userId],
        );
        return result.rows.map((row) => Object.freeze({
          restaurantId: row.restaurant_id,
          name: row.restaurant_name,
          status: row.restaurant_status,
          currencyCode: row.currency_code,
          role: row.role,
          defaultBranchId: row.defaultBranch_id ?? row.default_branch_id,
        }));
      });
    },
  });
}
