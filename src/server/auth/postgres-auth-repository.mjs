import { lockPlanSessions, controlError } from "./session-limits.mjs";
import { randomUUID } from "node:crypto";
import { withUserContextTransaction } from "../database/tenant-transaction.mjs";

function slugFor(name, restaurantId) {
  const base =
    String(name)
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
        await client.query("SELECT set_config('app.restaurant_id', $1, true)", [
          restaurantId,
        ]);
        const userResult = await client.query(
          `INSERT INTO users (
             id, email, normalized_email, password_hash, display_name,
             platform_role, status
           ) VALUES ($1, $2, $3, $4, $5, 'user', 'pending_verification')
           RETURNING id, email, display_name, platform_role, status,
                     email_verified_at, password_hash`,
          [
            userId,
            input.email,
            input.normalizedEmail,
            input.passwordHash,
            input.displayName,
          ],
        );
        await client.query(
          `INSERT INTO restaurants (id, name, slug, status)
           VALUES ($1, $2, $3, 'active')`,
          [
            restaurantId,
            input.restaurantName,
            slugFor(input.restaurantName, restaurantId),
          ],
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
          [
            verificationId,
            userId,
            restaurantId,
            input.verificationTokenHash,
            input.verificationExpiresAt,
          ],
        );
        await client.query("COMMIT");
        return mapUser(userResult.rows[0]);
      } catch (error) {
        await rollback(client, error);
        if (
          error.code === "23505" &&
          /normalized_email|global_username/i.test(error.constraint ?? "")
        ) {
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
        await client.query("SELECT set_config('app.restaurant_id', $1, true)", [
          token.restaurant_id,
        ]);
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
        if (!userResult.rows[0])
          throw new Error("Verification account is no longer pending.");
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
        `SELECT id, email, username, restaurant_id, display_name, platform_role, status,
                email_verified_at, password_hash
           FROM users WHERE normalized_email = $1`,
        [normalizedEmail],
      );
      return mapUser(result.rows[0]);
    },

    async createSession({
      userId,
      tokenHash,
      ipAddress,
      userAgent,
      expiresAt,
      expectedPasswordHash,
      expectedUsername = null,
      expectedRestaurantId = null,
      expectedRestaurantCode = null,
      expectedEmail = undefined,
      previousTokenHash = null,
      now = new Date(),
    }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout='15s'");
        const membership = (
          await client.query(
            `SELECT restaurant_id FROM restaurant_memberships WHERE user_id=$1 AND status='active'
          AND ($2::uuid IS NULL OR restaurant_id=$2) ORDER BY restaurant_id LIMIT 1`,
            [userId, expectedRestaurantId],
          )
        ).rows[0];
        const restaurantId = membership?.restaurant_id;
        if (!restaurantId)
          throw controlError(
            "Active restaurant membership is required.",
            "INVALID_CREDENTIALS",
            401,
          );
        const initial = (
          await client.query(
            "SELECT plan_id FROM subscriptions WHERE restaurant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
            [restaurantId],
          )
        ).rows[0];
        await lockPlanSessions(client, initial?.plan_id);
        const restaurant = (
          await client.query(
            "SELECT code,status FROM restaurants WHERE id=$1 FOR UPDATE",
            [restaurantId],
          )
        ).rows[0];
        if (!restaurant || restaurant.status !== "active")
          throw controlError(
            "Restaurant access is suspended.",
            "RESTAURANT_SUSPENDED",
            403,
          );
        if (
          expectedRestaurantCode &&
          restaurant.code !== expectedRestaurantCode
        )
          throw controlError(
            "Restaurant credentials changed. Please sign in again.",
            "INVALID_CREDENTIALS",
            401,
          );
        const plan = (
          await client.query(
            `SELECT s.plan_id,p.max_devices FROM subscriptions s JOIN plans p ON p.id=s.plan_id
          WHERE s.restaurant_id=$1 ORDER BY s.created_at DESC,s.id DESC LIMIT 1`,
            [restaurantId],
          )
        ).rows[0];
        if ((plan?.plan_id ?? null) !== (initial?.plan_id ?? null))
          throw controlError(
            "Subscription changed during login. Please try again.",
            "SUBSCRIPTION_CHANGED",
            409,
          );
        const row = (
          await client.query(
            "SELECT password_hash,status,username,email FROM users WHERE id=$1 FOR SHARE",
            [userId],
          )
        ).rows[0];
        if (
          !row ||
          row.status !== "active" ||
          row.password_hash !== expectedPasswordHash ||
          (expectedUsername && row.username !== expectedUsername) ||
          (expectedEmail !== undefined && row.email !== expectedEmail)
        )
          throw controlError(
            "Credentials changed. Please sign in again.",
            "INVALID_CREDENTIALS",
            401,
          );
        if (previousTokenHash)
          await client.query(
            "UPDATE sessions SET revoked_at=$3 WHERE user_id=$1 AND token_hash=$2 AND restaurant_id=$4 AND revoked_at IS NULL",
            [userId, previousTokenHash, now, restaurantId],
          );
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('device_limit:' || $1::text, 0))",
          [restaurantId],
        );
        const limit = Number(plan?.max_devices ?? 20);
        const count = (
          await client.query(
            `SELECT count(*) AS total FROM sessions s JOIN users u ON u.id=s.user_id AND u.status='active'
          JOIN restaurant_memberships m ON m.user_id=s.user_id AND m.restaurant_id=s.restaurant_id AND m.status='active'
          WHERE s.restaurant_id=$1 AND s.revoked_at IS NULL AND s.expires_at>$2`,
            [restaurantId, now],
          )
        ).rows[0];
        if (Number(count.total) >= limit) {
          const activeSessions = (
            await client.query(
              `SELECT s.id, s.ip_address, s.user_agent, s.last_seen_at, s.created_at,
                      u.username, u.display_name
                 FROM sessions s
                 JOIN users u ON u.id = s.user_id
                WHERE s.restaurant_id = $1 AND s.revoked_at IS NULL AND s.expires_at > $2
                ORDER BY s.last_seen_at DESC, s.created_at DESC`,
              [restaurantId, now],
            )
          ).rows;
          const err = controlError(
            `The restaurant's ${limit}-device limit is reached. Sign out another device or contact support.`,
            "DEVICE_LIMIT_REACHED",
            409,
          );
          err.limit = limit;
          err.deviceLimit = limit;
          err.activeSessions = activeSessions.map((s) => ({
            id: s.id,
            ipAddress: s.ip_address,
            userAgent: s.user_agent,
            lastSeenAt: s.last_seen_at || s.created_at,
            createdAt: s.created_at,
            username: s.username,
            displayName: s.display_name,
          }));
          throw err;
        }
        await client.query(
          `INSERT INTO sessions(user_id,token_hash,ip_address,user_agent,expires_at,restaurant_id)
          VALUES($1,$2,$3,$4,$5,$6)`,
          [userId, tokenHash, ipAddress, userAgent, expiresAt, restaurantId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await rollback(client, error);
        throw error;
      } finally {
        client.release();
      }
    },

    async revokeAndCreateSession({
      userId,
      expectedPasswordHash,
      expectedUsername,
      expectedEmail,
      sessionToRevokeId,
      now,
      expectedRestaurantId = null,
      expectedRestaurantCode = null,
      tokenHash,
      ipAddress,
      userAgent,
      expiresAt,
    }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        let restaurantId = expectedRestaurantId;
        if (!restaurantId && expectedRestaurantCode) {
          const res = (await client.query("SELECT id FROM restaurants WHERE code=$1", [String(expectedRestaurantCode).trim().toLowerCase()])).rows[0];
          restaurantId = res?.id ?? null;
        }
        if (!restaurantId) {
          const res = (await client.query("SELECT restaurant_id FROM restaurant_memberships WHERE user_id=$1 AND status='active' ORDER BY created_at LIMIT 1", [userId])).rows[0];
          restaurantId = res?.restaurant_id ?? null;
        }
        if (!restaurantId) {
          const res = (await client.query("SELECT restaurant_id FROM users WHERE id=$1", [userId])).rows[0];
          restaurantId = res?.restaurant_id ?? null;
        }
        if (!restaurantId) throw controlError("Restaurant not found.", "RESTAURANT_NOT_FOUND", 404);

        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('device_limit:' || $1::text, 0))",
          [restaurantId],
        );

        const row = (
          await client.query(
            "SELECT password_hash,status,username,email FROM users WHERE id=$1 FOR SHARE",
            [userId],
          )
        ).rows[0];
        if (
          !row ||
          row.status !== "active" ||
          row.password_hash !== expectedPasswordHash ||
          (expectedUsername && row.username !== expectedUsername) ||
          (expectedEmail !== undefined && row.email !== expectedEmail)
        )
          throw controlError(
            "Credentials changed. Please sign in again.",
            "INVALID_CREDENTIALS",
            401,
          );

        if (sessionToRevokeId) {
          await client.query(
            "UPDATE sessions SET revoked_at=$2 WHERE id=$1 AND restaurant_id=$3 AND revoked_at IS NULL",
            [sessionToRevokeId, now, restaurantId],
          );
        }

        const plan = (
          await client.query(
            `SELECT s.plan_id,p.max_devices FROM subscriptions s JOIN plans p ON p.id=s.plan_id
             WHERE s.restaurant_id=$1 ORDER BY s.created_at DESC,s.id DESC LIMIT 1`,
            [restaurantId],
          )
        ).rows[0];
        const limit = Number(plan?.max_devices ?? 20);

        const count = (
          await client.query(
            `SELECT count(*) AS total FROM sessions s JOIN users u ON u.id=s.user_id AND u.status='active'
             JOIN restaurant_memberships m ON m.user_id=s.user_id AND m.restaurant_id=s.restaurant_id AND m.status='active'
             WHERE s.restaurant_id=$1 AND s.revoked_at IS NULL AND s.expires_at>$2`,
            [restaurantId, now],
          )
        ).rows[0];
        if (Number(count.total) >= limit) {
          const err = controlError(
            `The restaurant's ${limit}-device limit is reached. Sign out another device or contact support.`,
            "DEVICE_LIMIT_REACHED",
            409,
          );
          err.limit = limit;
          err.deviceLimit = limit;
          throw err;
        }

        await client.query(
          `INSERT INTO sessions(user_id,token_hash,ip_address,user_agent,expires_at,restaurant_id)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [userId, tokenHash, ipAddress, userAgent, expiresAt, restaurantId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await rollback(client, error);
        throw error;
      } finally {
        client.release();
      }
    },

    async listRestaurantSessions(restaurantIdOrOpts, now = new Date()) {
      const restaurantId = typeof restaurantIdOrOpts === "object" ? restaurantIdOrOpts?.restaurantId : restaurantIdOrOpts;
      const effectiveNow = (typeof restaurantIdOrOpts === "object" && restaurantIdOrOpts?.now) ? restaurantIdOrOpts.now : (now || new Date());
      const result = await pool.query(
        `SELECT s.id, s.ip_address, s.user_agent, s.last_seen_at, s.created_at, s.expires_at,
                u.id AS user_id, u.username, u.display_name, m.role
           FROM sessions s
           JOIN users u ON u.id = s.user_id AND u.status = 'active'
           JOIN restaurant_memberships m ON m.user_id = s.user_id AND m.restaurant_id = s.restaurant_id AND m.status = 'active'
          WHERE s.restaurant_id = $1 AND s.revoked_at IS NULL AND s.expires_at > $2
          ORDER BY s.last_seen_at DESC, s.created_at DESC`,
        [restaurantId, effectiveNow],
      );
      return result.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        lastSeenAt: row.last_seen_at || row.created_at,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      }));
    },

    async revokeRestaurantSession(restaurantIdOrOpts, sessionId, now = new Date()) {
      const restaurantId = typeof restaurantIdOrOpts === "object" ? restaurantIdOrOpts?.restaurantId : restaurantIdOrOpts;
      const effectiveSessionId = typeof restaurantIdOrOpts === "object" ? restaurantIdOrOpts?.sessionId : sessionId;
      const effectiveNow = (typeof restaurantIdOrOpts === "object" && restaurantIdOrOpts?.now) ? restaurantIdOrOpts.now : (now || new Date());
      const result = await pool.query(
        `UPDATE sessions SET revoked_at = $3
          WHERE id = $1 AND restaurant_id = $2 AND revoked_at IS NULL
          RETURNING id`,
        [effectiveSessionId, restaurantId, effectiveNow],
      );
      return result.rowCount > 0;
    },

    async changePassword({
      userId,
      sessionTokenHash,
      passwordHash,
      verifyCurrentPassword,
      now,
      newUsername,
    }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const user = (
          await client.query(
            "SELECT id, restaurant_id, password_hash FROM users WHERE id = $1 AND status = 'active' FOR UPDATE",
            [userId],
          )
        ).rows[0];
        const session = (
          await client.query(
            `SELECT id FROM sessions WHERE user_id = $1 AND token_hash = $2
          AND revoked_at IS NULL AND expires_at > $3 FOR UPDATE`,
            [userId, sessionTokenHash, now],
          )
        ).rows[0];
        if (!user || !session)
          throw Object.assign(new Error("Authentication is required."), {
            code: "UNAUTHENTICATED",
            statusCode: 401,
          });
        if (!(await verifyCurrentPassword(user.password_hash)))
          throw Object.assign(new Error("Current password is incorrect."), {
            code: "INVALID_CURRENT_PASSWORD",
            statusCode: 400,
          });
        if (newUsername) {
          const normUsername = String(newUsername).trim().toLowerCase();
          await client.query(
            "UPDATE users SET password_hash = $2, username = $3, normalized_username = $4, updated_at = $5 WHERE id = $1",
            [userId, passwordHash, String(newUsername).trim(), normUsername, now],
          );
        } else {
          await client.query(
            "UPDATE users SET password_hash = $2, updated_at = $3 WHERE id = $1",
            [userId, passwordHash, now],
          );
        }
        await client.query(
          "UPDATE sessions SET revoked_at = $3 WHERE user_id = $1 AND token_hash <> $2 AND revoked_at IS NULL",
          [userId, sessionTokenHash, now],
        );
        await client.query(
          `INSERT INTO audit_logs(restaurant_id, actor_user_id, actor_type, action, resource_type, resource_id, metadata)
          VALUES($1,$2,'user','user.password_changed','user',$3,$4)`,
          [
            user.restaurant_id,
            userId,
            userId,
            JSON.stringify({ otherSessionsRevoked: true, ...(newUsername ? { usernameChanged: true } : {}) }),
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await rollback(client, error);
        if (error.code === "23505" && /username|login_identifier/i.test(error.constraint ?? "")) {
          throw controlError("This username is already in use. Choose a unique username.", "USERNAME_EXISTS", 409);
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async findActiveSession(tokenHash, now) {
      const result = await pool.query(
        `WITH eligible AS (
          SELECT target.id FROM sessions target JOIN users account ON account.id=target.user_id AND account.status='active'
          WHERE target.token_hash=$1 AND target.revoked_at IS NULL AND target.expires_at>$2
            AND EXISTS(SELECT 1 FROM restaurant_memberships WHERE user_id=target.user_id AND restaurant_id=target.restaurant_id AND status='active')
            AND (SELECT count(*) FROM sessions other JOIN users u2 ON u2.id=other.user_id AND u2.status='active'
              JOIN restaurant_memberships m2 ON m2.user_id=other.user_id AND m2.restaurant_id=other.restaurant_id AND m2.status='active'
              WHERE other.restaurant_id=target.restaurant_id AND other.revoked_at IS NULL AND other.expires_at>$2
              AND (other.last_seen_at,other.created_at,other.id)>(target.last_seen_at,target.created_at,target.id))
              < COALESCE((SELECT p.max_devices FROM subscriptions sub JOIN plans p ON p.id=sub.plan_id WHERE sub.restaurant_id=target.restaurant_id ORDER BY sub.created_at DESC,sub.id DESC LIMIT 1),20)
        ), active_session AS (
           UPDATE sessions SET last_seen_at=$2 WHERE id IN(SELECT id FROM eligible)
           RETURNING user_id,expires_at,restaurant_id
         )
         SELECT u.id, u.email, u.username, u.restaurant_id, u.display_name, u.platform_role, u.status,
                u.email_verified_at, u.password_hash, s.expires_at, s.restaurant_id AS session_restaurant_id
           FROM active_session s JOIN users u ON u.id = s.user_id
          WHERE u.status = 'active'`,
        [tokenHash, now],
      );
      const row = result.rows[0];
      return row
        ? {
            user: mapUser(row),
            expiresAt: row.expires_at,
            restaurantId: row.session_restaurant_id,
          }
        : null;
    },

    async revokeSession(tokenHash, now) {
      await pool.query(
        `UPDATE sessions SET revoked_at = COALESCE(revoked_at, $2)
          WHERE token_hash = $1`,
        [tokenHash, now],
      );
    },

    async findUserByRestaurantAndUsername({ restaurantCode, username }) {
      const normCode = String(restaurantCode ?? "")
        .trim()
        .toLowerCase();
      const normUsername = String(username ?? "")
        .trim()
        .toLowerCase();

      const restResult = await pool.query(
        `SELECT id, name, code, status FROM restaurants WHERE code = $1`,
        [normCode],
      );
      const restaurant = restResult.rows[0];
      if (!restaurant) return { restaurant: null, user: null };

      const userResult = await pool.query(
        `SELECT id, email, username, restaurant_id, display_name, platform_role, status,
                email_verified_at, password_hash
           FROM users
          WHERE restaurant_id = $1 AND (normalized_username = $2 OR normalized_email = $2)`,
        [restaurant.id, normUsername],
      );
      const user = userResult.rows.length === 1 ? userResult.rows[0] : null;
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

    async findUserByUsernameOnly({ username }) {
      const normUsername = String(username ?? "")
        .trim()
        .toLowerCase();
      const userResult = await pool.query(
        `SELECT u.id, u.email, u.username, u.restaurant_id, u.display_name, u.platform_role, u.status,
                u.email_verified_at, u.password_hash,
                r.id as rest_id, r.name as rest_name, r.code as rest_code, r.status as rest_status
           FROM users u
           LEFT JOIN restaurants r ON r.id = u.restaurant_id
          WHERE (u.normalized_username = $1 OR u.normalized_email = $1)
          LIMIT 2`,
        [normUsername],
      );
      // Older tenant-scoped usernames can collide. Never guess a tenant or
      // test passwords across accounts; support can rename these accounts.
      if (userResult.rows.length !== 1) return { restaurant: null, user: null };
      const row = userResult.rows[0];
      const restaurant = row.rest_id ? {
        id: row.rest_id,
        name: row.rest_name,
        code: row.rest_code,
        status: row.rest_status,
      } : null;
      return {
        restaurant,
        user: mapUser(row),
      };
    },

    async createTenantUser({
      restaurantId,
      username,
      passwordHash,
      displayName,
      role = "cashier",
    }) {
      const client = await pool.connect();
      const userId = randomUUID();
      const normUsername = String(username ?? "")
        .trim()
        .toLowerCase();

      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.restaurant_id', $1, true)", [
          restaurantId,
        ]);

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
          [
            userId,
            restaurantId,
            String(username).trim(),
            normUsername,
            passwordHash,
            String(displayName).trim(),
          ],
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
        if (
          error.code === "23505" &&
          /username/i.test(error.constraint ?? "")
        ) {
          const duplicate = new Error(
            "This username is already in use. Choose a unique username.",
          );
          duplicate.code = "USERNAME_EXISTS";
          duplicate.statusCode = 409;
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
                  r.status AS restaurant_status, r.currency_code, r.timezone AS restaurant_timezone,
                  m.role, m.default_branch_id
             FROM restaurant_memberships m
             JOIN restaurants r ON r.id = m.restaurant_id
            WHERE m.user_id = $1 AND m.status = 'active'
            ORDER BY r.name`,
          [userId],
        );
        return result.rows.map((row) =>
          Object.freeze({
            restaurantId: row.restaurant_id,
            name: row.restaurant_name,
            status: row.restaurant_status,
            currencyCode: row.currency_code,
            timezone: row.restaurant_timezone,
            role: row.role,
            defaultBranchId: row.defaultBranch_id ?? row.default_branch_id,
          }),
        );
      });
    },
  });
}
