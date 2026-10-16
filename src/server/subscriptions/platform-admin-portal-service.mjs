import { randomUUID, randomBytes } from "node:crypto";
import { hashPassword } from "../auth/passwords.mjs";
import { createAdminControlService } from "./admin-control-service.mjs";
import { lockPlanSessions, controlError } from "../auth/session-limits.mjs";

export function restaurantSlug(code, id) {
  const base = String(code).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).replace(/-$/, "") || "restaurant";
  return `${base}-${id}`;
}

export function publicAuditMetadata(value) {
  if (Array.isArray(value)) return value.map(publicAuditMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/password|secret|token|credential/i.test(key))
    .map(([key, item]) => [key, publicAuditMetadata(item)]));
}

export function createPlatformAdminPortalService({ pool, passwordPepper, clock = () => new Date() }) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("A PostgreSQL connection pool is required.");
  }

  async function recordAudit({ client, restaurantId, adminId, action, resourceType, resourceId, metadata }) {
    await client.query(
      `INSERT INTO audit_logs (restaurant_id, actor_admin_id, actor_type, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'platform_admin', $3, $4, $5, $6)`,
      [restaurantId, adminId, action, resourceType, resourceId, JSON.stringify(metadata ?? {})],
    );
  }

  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  const controls = createAdminControlService({ pool, passwordPepper, clock, recordAudit });
  return Object.freeze({
    ...controls,
    async editRestaurant({ adminId, restaurantId, name, code, phone, address, contactEmail }) {
      return transaction(async client => {
        const existing = (await client.query("SELECT id FROM restaurants WHERE id = $1 FOR UPDATE", [restaurantId])).rows[0];
        if (!existing) throw Object.assign(new Error("Restaurant not found."), { code: "RESTAURANT_NOT_FOUND", statusCode: 404 });
        const changes = {};
        if (name !== undefined) changes.name = name;
        if (code !== undefined) changes.code = code.trim().toLowerCase();
        if (phone !== undefined) changes.phone = phone;
        if (address !== undefined) changes.address = address;
        if (contactEmail !== undefined) changes.contact_email = contactEmail;
        const keys = Object.keys(changes);
        try {
          await client.query(`UPDATE restaurants SET ${keys.map((key, index) => `${key} = $${index + 2}`).join(", ")} WHERE id = $1`,
            [restaurantId, ...keys.map(key => changes[key])]);
        } catch (error) {
          if (error.code === "23505") throw Object.assign(new Error("Restaurant code already exists."), { code: "RESTAURANT_CODE_EXISTS", statusCode: 409 });
          throw error;
        }
        if (code !== undefined) await client.query("UPDATE sessions SET revoked_at = $2 WHERE user_id IN (SELECT user_id FROM restaurant_memberships WHERE restaurant_id = $1) AND revoked_at IS NULL", [restaurantId, clock()]);
        await client.query("UPDATE business_settings SET business_name = COALESCE($2, business_name), phone = CASE WHEN $3 THEN $4 ELSE phone END, address = CASE WHEN $5 THEN $6 ELSE address END WHERE restaurant_id = $1",
          [restaurantId, name ?? null, phone !== undefined, phone ?? null, address !== undefined, address ?? null]);
        await recordAudit({ client, adminId, restaurantId, action: "restaurant.updated", resourceType: "restaurant", resourceId: restaurantId, metadata: { changedFields: keys } });
        return { updated: true };
      });
    },

    async listPlans(input) {
      return controls.listPlanCatalog(input);
    },

    async createUser({ adminId, restaurantId, username, displayName, role, password }) {
      const passwordHash = await hashPassword(password, passwordPepper);
      return transaction(async client => {
        const branch = (await client.query("SELECT id FROM branches WHERE restaurant_id = $1 AND is_default = true LIMIT 1", [restaurantId])).rows[0];
        if (!branch) throw Object.assign(new Error("Restaurant not found."), { code: "RESTAURANT_NOT_FOUND", statusCode: 404 });
        const conflict=await client.query('SELECT id FROM users WHERE restaurant_id=$1 AND normalized_email=lower($2)',[restaurantId,username]);
        if(conflict.rows.length) throw controlError('Username conflicts with an existing login email.','USERNAME_EXISTS',409);
        const userId = randomUUID();
        try {
          await client.query(`INSERT INTO users (id, restaurant_id, username, normalized_username, display_name, password_hash, status, email_verified_at)
            VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`, [userId, restaurantId, username, username.toLowerCase(), displayName, passwordHash, clock()]);
        } catch (error) {
          if (error.code === "23505") throw Object.assign(new Error("This username is already in use. Choose a unique username."), { code: "USERNAME_EXISTS", statusCode: 409 });
          throw error;
        }
        await client.query(`INSERT INTO restaurant_memberships (restaurant_id, user_id, default_branch_id, role, status, joined_at)
          VALUES ($1, $2, $3, $4, 'active', $5)`, [restaurantId, userId, branch.id, role, clock()]);
        await recordAudit({ client, adminId, restaurantId, action: "user.created", resourceType: "user", resourceId: userId, metadata: { username, role } });
        return { user: { id: userId, username, displayName, role, status: "active" } };
      });
    },

    async editUser({ adminId, restaurantId, userId, username, displayName }) {
      return transaction(async client => {
        const user = (await client.query("SELECT id FROM users WHERE id = $1 AND restaurant_id = $2 FOR UPDATE", [userId, restaurantId])).rows[0];
        if (!user) throw Object.assign(new Error("Restaurant user not found."), { code: "USER_NOT_FOUND", statusCode: 404 });
        if(username!==undefined && (await client.query('SELECT id FROM users WHERE restaurant_id=$1 AND id<>$2 AND normalized_email=lower($3)',[restaurantId,userId,username])).rows.length)
          throw controlError('Username conflicts with an existing login email.','USERNAME_EXISTS',409);
        try {
          await client.query(`UPDATE users SET username = COALESCE($3, username), normalized_username = COALESCE(lower($3), normalized_username),
            display_name = COALESCE($4, display_name) WHERE id = $1 AND restaurant_id = $2`, [userId, restaurantId, username ?? null, displayName ?? null]);
        } catch (error) {
          if (error.code === "23505") throw Object.assign(new Error("This username is already in use. Choose a unique username."), { code: "USERNAME_EXISTS", statusCode: 409 });
          throw error;
        }
        if (username !== undefined) await client.query("UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [userId, clock()]);
        await recordAudit({ client, adminId, restaurantId, action: "user.updated", resourceType: "user", resourceId: userId,
          metadata: { changedFields: [username !== undefined ? "username" : null, displayName !== undefined ? "displayName" : null].filter(Boolean), allSessionsRevoked: username !== undefined } });
        return { updated: true, userId };
      });
    },

    async listPayments({ status = "pending", page = 1, limit = 50 } = {}) {
      const values = [status];
      const total = await pool.query("SELECT count(*) AS total FROM manual_payments WHERE ($1::text IS NULL OR status = $1)", values);
      const rows = (await pool.query(`SELECT mp.id, mp.restaurant_id, r.name AS restaurant_name, r.code AS restaurant_code,
        mp.external_reference, mp.amount_minor, mp.currency_code, mp.status, mp.covered_from, mp.covered_until, mp.created_at, p.name AS plan_name
        FROM manual_payments mp JOIN restaurants r ON r.id = mp.restaurant_id JOIN plans p ON p.id = mp.plan_id
        WHERE ($1::text IS NULL OR mp.status = $1) ORDER BY mp.created_at DESC, mp.id DESC LIMIT $2 OFFSET $3`, [...values, limit, (page - 1) * limit])).rows;
      return { payments: rows.map(row => ({ id: row.id, restaurantId: row.restaurant_id, restaurantName: row.restaurant_name, restaurantCode: row.restaurant_code,
        externalReference: row.external_reference, amountMinor: Number(row.amount_minor), currencyCode: row.currency_code, status: row.status,
        coveredFrom: row.covered_from, coveredUntil: row.covered_until, planName: row.plan_name })), totalCount: Number(total.rows[0].total), page, limit };
    },

    async setUserStatus({ adminId, restaurantId, userId, status }) {
      return transaction(async client => {
        const user = (await client.query(`SELECT id FROM users WHERE id = $1 AND restaurant_id = $2
          AND EXISTS(SELECT 1 FROM restaurant_memberships WHERE user_id = $1 AND restaurant_id = $2 AND status <> 'removed') FOR UPDATE`, [userId, restaurantId])).rows[0];
        if (!user) throw Object.assign(new Error("Restaurant user not found."), { code: "USER_NOT_FOUND", statusCode: 404 });
        await client.query("UPDATE users SET status = $2 WHERE id = $1 AND restaurant_id = $3", [userId, status, restaurantId]);
        await client.query("UPDATE restaurant_memberships SET status = $3, joined_at = CASE WHEN $3 = 'active' THEN COALESCE(joined_at, $4) ELSE joined_at END WHERE user_id = $1 AND restaurant_id = $2", [userId, restaurantId, status === "active" ? "active" : "suspended", clock()]);
        if (status === "disabled") await client.query("UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [userId, clock()]);
        await recordAudit({ client, adminId, restaurantId, action: status === "active" ? "user.enabled" : "user.disabled", resourceType: "user", resourceId: userId,
          metadata: { userId, status, sessionsRevoked: status === "disabled" } });
        return { userId, status };
      });
    },

    async listAuditLogs({ restaurantId = null, action = "", page = 1, limit = 50 } = {}) {
      const values = [restaurantId, action ? `%${action}%` : null];
      const where = "($1::uuid IS NULL OR a.restaurant_id = $1) AND ($2::text IS NULL OR a.action ILIKE $2)";
      const total = await pool.query(`SELECT count(*) AS total FROM audit_logs a WHERE ${where}`, values);
      const rows = (await pool.query(`SELECT a.id, a.restaurant_id, a.actor_admin_id, a.actor_user_id, a.actor_type, a.action,
        a.resource_type, a.resource_id, a.metadata, a.created_at, pa.username AS admin_username, u.display_name AS user_name
        FROM audit_logs a LEFT JOIN platform_administrators pa ON pa.id = a.actor_admin_id
        LEFT JOIN users u ON u.id = a.actor_user_id WHERE ${where}
        ORDER BY a.created_at DESC, a.id DESC LIMIT $3 OFFSET $4`, [...values, limit, (page - 1) * limit])).rows;
      return { audits: rows.map(row => ({ id: row.id, restaurantId: row.restaurant_id, actorAdminId: row.actor_admin_id,
        actorUserId: row.actor_user_id, actorType: row.actor_type, actorName: row.admin_username ?? row.user_name ?? row.actor_type,
        action: row.action, resourceType: row.resource_type, resourceId: row.resource_id,
        metadata: publicAuditMetadata(row.metadata), createdAt: row.created_at })), totalCount: Number(total.rows[0].total), page, limit };
    },
    async resetUserPassword({ adminId, restaurantId, userId, newPassword, generateTemporary = false }) {
      const password = generateTemporary ? randomBytes(24).toString("base64url") : newPassword;
      const passwordHash = await hashPassword(password, passwordPepper);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const restaurant = (await client.query("SELECT id FROM restaurants WHERE id = $1 FOR SHARE", [restaurantId])).rows[0];
        const user = (await client.query(`SELECT id FROM users WHERE id = $1 AND restaurant_id = $2
          AND EXISTS(SELECT 1 FROM restaurant_memberships WHERE restaurant_id = $2 AND user_id = $1) FOR UPDATE`, [userId, restaurantId])).rows[0];
        if (!restaurant || !user) throw Object.assign(new Error("Restaurant user not found."), { code: "USER_NOT_FOUND", statusCode: 404 });
        const now = clock();
        await client.query("UPDATE users SET password_hash = $2, updated_at = $3 WHERE id = $1 AND restaurant_id = $4", [userId, passwordHash, now, restaurantId]);
        await client.query("UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [userId, now]);
        await recordAudit({ client, restaurantId, adminId, action: "user.password_reset", resourceType: "user", resourceId: userId,
          metadata: { userId, generatedTemporary: generateTemporary, allSessionsRevoked: true } });
        await client.query("COMMIT");
        return { reset: true, userId, ...(generateTemporary ? { temporaryPassword: password } : {}) };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
    async getDashboardStats() {
      const client = await pool.connect();
      try {
        const restStats = await client.query(
          `SELECT
             count(*) FILTER (WHERE status = 'active') AS active_count,
             count(*) FILTER (WHERE status = 'suspended') AS suspended_count,
             count(*) AS total_count
           FROM restaurants`,
        );
        const payStats = await client.query(
          `SELECT
             count(*) FILTER (WHERE status = 'pending') AS pending_payments,
             count(*) FILTER (WHERE status = 'approved') AS approved_payments
           FROM manual_payments`,
        );
        const storageStats = await client.query(
          `SELECT COALESCE(sum(used_storage_bytes), 0) AS total_bytes FROM tenant_storage_allowances`,
        );
        const kpis=(await client.query(`SELECT
          (SELECT count(*) FROM plans WHERE is_active) AS active_plans,
          count(*) FILTER(WHERE r.status='active' AND s.status='trialing' AND s.trial_ends_at>$1) AS trials,
          count(*) FILTER(WHERE r.status='active' AND s.status IN ('active','trialing','cancel_at_period_end')
            AND CASE WHEN s.status='trialing' THEN s.trial_ends_at ELSE s.current_period_end END>$1
            AND CASE WHEN s.status='trialing' THEN s.trial_ends_at ELSE s.current_period_end END<=$1::timestamptz+interval '7 days') AS expiring
          FROM restaurants r LEFT JOIN LATERAL(SELECT * FROM subscriptions WHERE restaurant_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1) s ON true`,[clock()])).rows[0];
        return {
          activePlans:Number(kpis.active_plans),activeTrials:Number(kpis.trials),expiringSoon:Number(kpis.expiring),
          totalRestaurants: Number(restStats.rows[0].total_count),
          activeRestaurants: Number(restStats.rows[0].active_count),
          suspendedRestaurants: Number(restStats.rows[0].suspended_count),
          pendingPayments: Number(payStats.rows[0].pending_payments),
          approvedPayments: Number(payStats.rows[0].approved_payments),
          totalStorageUsedBytes: String(storageStats.rows[0].total_bytes),
        };
      } finally {
        client.release();
      }
    },

    async listRestaurants({ search = "", status = null, limit = 50, page = 1, includeTotal = false } = {}) {
      const client = await pool.connect();
      try {
        const offset = (page - 1) * limit;
        const normSearch = search ? `%${search.trim().toLowerCase()}%` : null;

        const result = await client.query(
          `SELECT r.id, r.name, r.code, r.slug, r.status, r.created_at,
                  s.status AS subscription_status, s.current_period_start, s.current_period_end,
                  p.name AS plan_name, p.code AS plan_code,
                  COALESCE(sa.max_storage_bytes, 5368709120) AS max_storage_bytes,
                  COALESCE(sa.used_storage_bytes, 0) AS used_storage_bytes
             FROM restaurants r
             LEFT JOIN LATERAL(SELECT * FROM subscriptions WHERE restaurant_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1) s ON true
             LEFT JOIN plans p ON p.id = s.plan_id
             LEFT JOIN tenant_storage_allowances sa ON sa.restaurant_id = r.id
            WHERE ($1::text IS NULL OR lower(r.name) LIKE $1 OR lower(r.code) LIKE $1 OR lower(r.slug) LIKE $1)
              AND ($2::text IS NULL OR r.status = $2)
            ORDER BY r.created_at DESC, r.id DESC
            LIMIT $3 OFFSET $4`,
          [normSearch, status, limit, offset],
        );

        const restaurants = result.rows.map((row) => ({
          id: row.id,
          name: row.name,
          code: row.code,
          slug: row.slug,
          status: row.status,
          subscriptionStatus: row.subscription_status ?? "none",
          planName: row.plan_name ?? "No Plan",
          planCode: row.plan_code ?? null,
          currentPeriodStart: row.current_period_start,
          currentPeriodEnd: row.current_period_end,
          maxStorageBytes: String(row.max_storage_bytes),
          usedStorageBytes: String(row.used_storage_bytes),
          createdAt: row.created_at,
        }));
        if (!includeTotal) return restaurants;
        const count = await client.query(`SELECT count(*) AS total FROM restaurants r
          WHERE ($1::text IS NULL OR lower(r.name) LIKE $1 OR lower(r.code) LIKE $1 OR lower(r.slug) LIKE $1)
          AND ($2::text IS NULL OR r.status = $2)`, [normSearch, status]);
        return { restaurants, totalCount: Number(count.rows[0].total), page, limit };
      } finally {
        client.release();
      }
    },

    async createRestaurant({ adminId, name, code, ownerUsername, ownerPassword, ownerDisplayName, ownerEmail, phone, planCode = "GROWTH" }) {
      const client = await pool.connect();
      const restaurantId = randomUUID();
      const userId = randomUUID();
      const branchId = randomUUID();
      const normCode = String(code).trim().toLowerCase();
      const normUsername = String(ownerUsername).trim().toLowerCase();

      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.restaurant_id', $1, true)", [restaurantId]);

        // Check if plan exists
        const planResult = await client.query(
          `SELECT id, name, trial_days FROM plans WHERE code = $1 AND is_active = true LIMIT 1`,
          [planCode.toUpperCase()],
        );
        const plan = planResult.rows[0];
        if (!plan) throw Object.assign(new Error("Choose an available plan."), { code: "PLAN_NOT_FOUND", statusCode: 404 });
        await lockPlanSessions(client, plan.id);
        if (!(await client.query("SELECT id FROM plans WHERE id=$1 AND is_active=true", [plan.id])).rows.length)
          throw controlError("Choose an active plan.", "PLAN_NOT_FOUND", 404);

        const passwordHash = await hashPassword(ownerPassword, passwordPepper);

        // Insert restaurant
        await client.query(
          `INSERT INTO restaurants (id, name, code, slug, status, phone)
           VALUES ($1, $2, $3, $4, 'active', $5)`,
          [restaurantId, String(name).trim(), normCode, restaurantSlug(normCode, restaurantId), phone ?? null],
        );

        // Insert default branch
        await client.query(
          `INSERT INTO branches (id, restaurant_id, code, name, is_default)
           VALUES ($1, $2, 'MAIN', 'Main Branch', true)`,
          [branchId, restaurantId],
        );

        // Insert owner user
        await client.query(
          `INSERT INTO users (
             id, restaurant_id, username, normalized_username, password_hash, display_name,
             platform_role, status, email_verified_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'user', 'active', now())`,
          [userId, restaurantId, String(ownerUsername).trim(), normUsername, passwordHash, String(ownerDisplayName || ownerUsername).trim()],
        );

        if (ownerEmail) await client.query("UPDATE users SET email=$2,normalized_email=lower($2) WHERE id=$1", [userId, ownerEmail]);

        // Insert owner membership
        await client.query(
          `INSERT INTO restaurant_memberships (
             restaurant_id, user_id, default_branch_id, role, status, joined_at
           ) VALUES ($1, $2, $3, 'owner', 'active', now())`,
          [restaurantId, userId, branchId],
        );

        // Insert business settings & financial account
        await client.query(
          `INSERT INTO business_settings (restaurant_id, default_branch_id, business_name)
           VALUES ($1, $2, $3)`,
          [restaurantId, branchId, String(name).trim()],
        );
        await client.query(
          `INSERT INTO financial_accounts (restaurant_id, branch_id, account_type, display_name)
           VALUES ($1, $2, 'cash', 'Cash')`,
          [restaurantId, branchId],
        );

        // Insert default trial subscription
        const now = clock();
        const trialEnds = new Date(now.getTime() + Number(plan.trial_days ?? 14) * 24 * 60 * 60 * 1000);
        if (plan) {
          await client.query(
            `INSERT INTO subscriptions (restaurant_id, plan_id, status, current_period_start, current_period_end, trial_ends_at)
             VALUES ($1, $2, 'trialing', $3, $4, $4)`,
            [restaurantId, plan.id, now, trialEnds],
          );
        }

        // Insert storage allowance (5 GB)
        await client.query(
          `INSERT INTO tenant_storage_allowances (restaurant_id, max_storage_bytes, used_storage_bytes)
           VALUES ($1, 5368709120, 0)`,
          [restaurantId],
        );

        await recordAudit({
          client,
          restaurantId,
          adminId,
          action: "restaurant.created",
          resourceType: "restaurant",
          resourceId: restaurantId,
          metadata: { code: normCode, ownerUsername: normUsername },
        });

        await client.query("COMMIT");

        return {
          id: restaurantId,
          name: String(name).trim(),
          code: normCode,
          owner: {
            id: userId,
            username: String(ownerUsername).trim(),
          },
        };
      } catch (error) {
        await client.query("ROLLBACK");
        if (["42703", "42P01"].includes(error.code)) throw controlError("Database migrations are required before provisioning restaurants.", "SCHEMA_OUTDATED", 503);
        if (error.code === "42501") throw controlError("The control database role needs provisioning grants.", "CONTROL_ROLE_GRANTS_REQUIRED", 503);
        if (error.code === "23505") {
          if (/restaurants_code_unique_idx|code/i.test(error.constraint ?? "")) {
            const err = new Error("Restaurant code already exists.");
            err.code = "RESTAURANT_CODE_EXISTS";
            err.statusCode = 409;
            throw err;
          }
          if (/username/i.test(error.constraint ?? "")) {
            const err = new Error("This username is already in use. Choose a unique username.");
            err.code = "USERNAME_EXISTS";
            err.statusCode = 409;
            throw err;
          }
          if (/normalized_email/i.test(error.constraint ?? "")) throw controlError("Owner email is already in use.", "EMAIL_EXISTS", 409);
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async getRestaurantDetails(restaurantId) {
      const client = await pool.connect();
      try {
        const restResult = await client.query(
          `SELECT r.id, r.name, r.code, r.slug, r.status, r.phone, r.address, r.contact_email, r.created_at,
                  s.id AS subscription_id, s.status AS subscription_status, s.current_period_start, s.current_period_end,
                  p.name AS plan_name, p.code AS plan_code, p.id AS plan_id, p.max_devices, p.trial_days,
                  COALESCE(sa.max_storage_bytes, 5368709120) AS max_storage_bytes,
                  COALESCE(sa.used_storage_bytes, 0) AS used_storage_bytes
             FROM restaurants r
             LEFT JOIN LATERAL(SELECT * FROM subscriptions WHERE restaurant_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1) s ON true
             LEFT JOIN plans p ON p.id = s.plan_id
             LEFT JOIN tenant_storage_allowances sa ON sa.restaurant_id = r.id
            WHERE r.id = $1`,
          [restaurantId],
        );
        const restaurant = restResult.rows[0];
        if (!restaurant) return null;

        const usersResult = await client.query(
          `SELECT u.id, u.username, u.email, u.display_name, u.status, m.role
             FROM users u
             JOIN restaurant_memberships m ON m.user_id = u.id AND m.restaurant_id = u.restaurant_id
            WHERE u.restaurant_id = $1 ORDER BY lower(u.username), u.id`,
          [restaurantId],
        );

        const paymentsResult = await client.query(
          `SELECT mp.id, mp.amount_minor, mp.currency_code, mp.payment_date, mp.covered_from, mp.covered_until,
                  mp.payment_method, mp.external_reference, mp.whatsapp_reference_text, mp.administrator_note,
                  mp.status, mp.reviewed_at, p.name AS plan_name, pa.username AS reviewed_by_admin
             FROM manual_payments mp
             JOIN plans p ON p.id = mp.plan_id
             LEFT JOIN platform_administrators pa ON pa.id = mp.reviewed_by_admin_id
            WHERE mp.restaurant_id = $1
            ORDER BY mp.created_at DESC`,
          [restaurantId],
        );

        const auditsResult = await client.query(
          `SELECT id, actor_type, action, resource_type, metadata, created_at
             FROM audit_logs
            WHERE restaurant_id = $1
            ORDER BY created_at DESC
            LIMIT 50`,
          [restaurantId],
        );

        const branchesResult = await client.query(
          `SELECT id, code, name, timezone, phone, address, is_default, is_active, created_at, updated_at
             FROM branches
            WHERE restaurant_id = $1
            ORDER BY is_default DESC, name ASC`,
          [restaurantId],
        );

        const syncStatusResult = await client.query(
          `SELECT device_uid, branch_id, device_name, platform, app_version,
                  pending_orders_count, failed_sync_count, last_sync_at,
                  last_error_message, last_error_at, last_seen_at
             FROM device_sync_status
            WHERE restaurant_id = $1
            ORDER BY last_seen_at DESC`,
          [restaurantId],
        );

        return {
          restaurant: {
            id: restaurant.id,
            name: restaurant.name,
            code: restaurant.code,
            slug: restaurant.slug,
            status: restaurant.status,
            phone: restaurant.phone,
            address: restaurant.address,
            contactEmail: restaurant.contact_email,
            createdAt: restaurant.created_at,
          },
          subscription: {
            id: restaurant.subscription_id,
            status: restaurant.subscription_status ?? "none",
            planName: restaurant.plan_name ?? "No Plan",
            planCode: restaurant.plan_code ?? null,
            planId: restaurant.plan_id ?? null,
            maxDevices: Number(restaurant.max_devices ?? 20),
            trialDays: Number(restaurant.trial_days ?? 14),
            currentPeriodStart: restaurant.current_period_start,
            currentPeriodEnd: restaurant.current_period_end,
          },
          storage: {
            maxStorageBytes: String(restaurant.max_storage_bytes),
            usedStorageBytes: String(restaurant.used_storage_bytes),
          },
          branches: branchesResult.rows.map((b) => ({
            id: b.id,
            code: b.code,
            name: b.name,
            timezone: b.timezone,
            phone: b.phone,
            address: b.address,
            isDefault: b.is_default,
            isActive: b.is_active,
            createdAt: b.created_at,
            updatedAt: b.updated_at,
          })),
          syncStatus: syncStatusResult.rows.map((s) => ({
            deviceUid: s.device_uid,
            branchId: s.branch_id,
            deviceName: s.device_name || "POS Terminal",
            platform: s.platform,
            appVersion: s.app_version,
            pendingOrdersCount: Number(s.pending_orders_count || 0),
            failedSyncCount: Number(s.failed_sync_count || 0),
            lastSyncAt: s.last_sync_at,
            lastErrorMessage: s.last_error_message,
            lastErrorAt: s.last_error_at,
            lastSeenAt: s.last_seen_at,
            isOnline: (new Date() - new Date(s.last_seen_at)) < 15 * 60 * 1000,
          })),
          users: usersResult.rows.map((u) => ({
            id: u.id,
            username: u.username,
            email: u.email,
            displayName: u.display_name,
            status: u.status,
            role: u.role,
          })),
          payments: paymentsResult.rows.map((p) => ({
            id: p.id,
            amountMinor: Number(p.amount_minor),
            currencyCode: p.currency_code,
            paymentDate: p.payment_date,
            coveredFrom: p.covered_from,
            coveredUntil: p.covered_until,
            paymentMethod: p.payment_method,
            externalReference: p.external_reference,
            whatsappReferenceText: p.whatsapp_reference_text,
            administratorNote: p.administrator_note,
            status: p.status,
            reviewedAt: p.reviewed_at,
            reviewedByAdmin: p.reviewed_by_admin,
            planName: p.plan_name,
          })),
          audits: auditsResult.rows.map((a) => ({
            id: a.id,
            actorType: a.actor_type,
            action: a.action,
            resourceType: a.resource_type,
            metadata: publicAuditMetadata(a.metadata),
            createdAt: a.created_at,
          })),
        };
      } finally {
        client.release();
      }
    },

    async recordManualPayment({
      adminId,
      restaurantId,
      planCode,
      amountMinor,
      currencyCode = "PKR",
      paymentDate,
      coveredFrom,
      coveredUntil,
      paymentMethod = "manual_bank_transfer",
      externalReference,
      whatsappReferenceText = null,
      administratorNote = null,
    }) {
      const client = await pool.connect();
      const paymentId = randomUUID();

      try {
        await client.query("BEGIN");

        const restaurant = (await client.query("SELECT id FROM restaurants WHERE id = $1 FOR SHARE", [restaurantId])).rows[0];
        if (!restaurant) throw Object.assign(new Error("Restaurant not found."), { code: "RESTAURANT_NOT_FOUND", statusCode: 404 });

        const planResult = await client.query(`SELECT id, name FROM plans WHERE code = $1 AND is_active = true LIMIT 1`, [planCode.toUpperCase()]);
        const plan = planResult.rows[0];
        if (!plan) {
          const err = new Error(`Plan code ${planCode} not found.`);
          err.code = "PLAN_NOT_FOUND";
          err.statusCode = 404;
          throw err;
        }

        const manualPrice = (
          await client.query(
            "SELECT currency_code FROM plan_prices WHERE plan_id=$1 AND provider='manual' AND is_active ORDER BY created_at DESC LIMIT 1",
            [plan.id],
          )
        ).rows[0];
        if (manualPrice && manualPrice.currency_code !== currencyCode) {
          throw controlError(
            "Payment currency must match the plan's current manual price.",
            "PAYMENT_CURRENCY_MISMATCH", 400,
          );
        }

        await client.query(
          `INSERT INTO manual_payments (
             id, restaurant_id, plan_id, amount_minor, currency_code, payment_date,
             covered_from, covered_until, payment_method, external_reference,
             whatsapp_reference_text, administrator_note, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')`,
          [
            paymentId,
            restaurantId,
            plan.id,
            amountMinor,
            currencyCode,
            paymentDate,
            coveredFrom,
            coveredUntil,
            paymentMethod,
            externalReference,
            whatsappReferenceText,
            administratorNote,
          ],
        );

        await recordAudit({
          client,
          restaurantId,
          adminId,
          action: "payment.recorded",
          resourceType: "manual_payment",
          resourceId: paymentId,
          metadata: { externalReference, amountMinor, planCode },
        });

        await client.query("COMMIT");
        return { paymentId, status: "pending" };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async approveManualPayment({ adminId, paymentId }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Lock payment row FOR UPDATE to ensure idempotency & prevent race conditions
        const payResult = await client.query(
          `SELECT id, restaurant_id, plan_id, amount_minor, currency_code, covered_from, covered_until, status
             FROM manual_payments
            WHERE id = $1
            FOR UPDATE`,
          [paymentId],
        );
        const payment = payResult.rows[0];
        if (!payment) {
          const err = new Error("Payment record not found.");
          err.code = "PAYMENT_NOT_FOUND";
          err.statusCode = 404;
          throw err;
        }

        // Serialize every subscription change on the tenant, including different payment rows.
        await client.query("SELECT id FROM restaurants WHERE id = $1 FOR UPDATE", [payment.restaurant_id]);
        if (payment.status === "approved") {
          // Idempotent return: already approved
          const subResult = await client.query(
            `SELECT id, status, current_period_start, current_period_end FROM subscriptions WHERE restaurant_id = $1 AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1`,
            [payment.restaurant_id],
          );
          await client.query("COMMIT");
          return { approved: true, replayed: true, subscription: subResult.rows[0] };
        }

        if (payment.status === "rejected") {
          const err = new Error("Cannot approve a rejected payment.");
          err.code = "PAYMENT_REJECTED";
          err.statusCode = 400;
          throw err;
        }

        const duplicates = await client.query(`SELECT id FROM manual_payments
          WHERE id <> $1 AND lower(btrim(external_reference)) =
          (SELECT lower(btrim(external_reference)) FROM manual_payments WHERE id = $1) AND status = 'approved'`, [paymentId]);
        if (duplicates.rows.length) throw Object.assign(new Error("This payment reference was already approved."), { code: "DUPLICATE_PAYMENT_REFERENCE", statusCode: 409 });
        const now = clock();

        // Lock existing subscription FOR UPDATE
        const subResult = await client.query(
          `SELECT id, current_period_end, status, provider FROM subscriptions WHERE restaurant_id = $1 AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [payment.restaurant_id],
        );
        const existingSub = subResult.rows[0];
        if (existingSub?.provider && existingSub.provider !== "manual") {
          throw controlError(
            "Provider-managed subscriptions must be changed through their billing provider.",
            "PROVIDER_MANAGED", 409,
          );
        }

        // Documented Policy: Renewal begins from the later of current expiry or payment coverage start
        let periodStart = new Date(payment.covered_from);
        if (existingSub?.current_period_end && new Date(existingSub.current_period_end) > periodStart) {
          periodStart = new Date(existingSub.current_period_end);
        }

        // Calculate extension duration from payment covered_from to covered_until
        const durationMs = new Date(payment.covered_until).getTime() - new Date(payment.covered_from).getTime();
        const periodEnd = new Date(periodStart.getTime() + Math.max(durationMs, 1000));

        if (existingSub) {
          await client.query(
            `UPDATE subscriptions
                SET plan_id = $2, status = 'active', status_before_suspend = NULL, current_period_start = $3, current_period_end = $4, updated_at = $5
              WHERE id = $1`,
            [existingSub.id, payment.plan_id, periodStart, periodEnd, now],
          );
        } else {
          await client.query(
            `INSERT INTO subscriptions (restaurant_id, plan_id, status, current_period_start, current_period_end)
             VALUES ($1, $2, 'active', $3, $4)`,
            [payment.restaurant_id, payment.plan_id, periodStart, periodEnd],
          );
        }

        // Payment approval does not undo an administrative restaurant suspension.

        // Update payment status to approved
        await client.query(
          `UPDATE manual_payments
              SET status = 'approved', reviewed_by_admin_id = $2, reviewed_at = $3, updated_at = $3
            WHERE id = $1`,
          [paymentId, adminId, now],
        );

        await recordAudit({
          client,
          restaurantId: payment.restaurant_id,
          adminId,
          action: "payment.approved",
          resourceType: "manual_payment",
          resourceId: paymentId,
          metadata: { periodStart, periodEnd },
        });

        await client.query("COMMIT");
        return { approved: true, replayed: false, periodStart, periodEnd };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async rejectManualPayment({ adminId, paymentId, note = null }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const payResult = await client.query(`SELECT id, restaurant_id, status FROM manual_payments WHERE id = $1 FOR UPDATE`, [paymentId]);
        const payment = payResult.rows[0];
        if (!payment) {
          const err = new Error("Payment record not found.");
          err.code = "PAYMENT_NOT_FOUND";
          err.statusCode = 404;
          throw err;
        }

        if (payment.status === "approved") throw Object.assign(new Error("Approved payments require an audited correction; they cannot be rejected."), { code: "PAYMENT_ALREADY_APPROVED", statusCode: 409 });
        if (payment.status === "rejected") { await client.query("COMMIT"); return { rejected: true, replayed: true }; }
        const now = clock();
        await client.query(
          `UPDATE manual_payments
              SET status = 'rejected', administrator_note = COALESCE($2, administrator_note),
                  reviewed_by_admin_id = $3, reviewed_at = $4, updated_at = $4
            WHERE id = $1`,
          [paymentId, note, adminId, now],
        );

        await recordAudit({
          client,
          restaurantId: payment.restaurant_id,
          adminId,
          action: "payment.rejected",
          resourceType: "manual_payment",
          resourceId: paymentId,
          metadata: { note },
        });

        await client.query("COMMIT");
        return { rejected: true };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async suspendRestaurant({ adminId, restaurantId, reason = null }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const now = clock();
        const restaurant = await client.query("SELECT id FROM restaurants WHERE id = $1 FOR UPDATE", [restaurantId]);
        if (!restaurant.rows[0]) throw Object.assign(new Error("Restaurant not found."), { code: "RESTAURANT_NOT_FOUND", statusCode: 404 });

        await client.query(`UPDATE restaurants SET status = 'suspended', updated_at = $2 WHERE id = $1`, [restaurantId, now]);
        await client.query(
          `UPDATE subscriptions SET status_before_suspend = status, status = 'suspended', updated_at = $2 WHERE restaurant_id = $1 AND status IN ('active', 'trialing', 'past_due', 'cancel_at_period_end')`,
          [restaurantId, now],
        );

        await recordAudit({
          client,
          restaurantId,
          adminId,
          action: "restaurant.suspended",
          resourceType: "restaurant",
          resourceId: restaurantId,
          metadata: { reason },
        });

        await client.query("COMMIT");
        return { suspended: true };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async restoreRestaurant({ adminId, restaurantId }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const now = clock();
        const restaurant = await client.query("SELECT id FROM restaurants WHERE id = $1 FOR UPDATE", [restaurantId]);
        if (!restaurant.rows[0]) throw Object.assign(new Error("Restaurant not found."), { code: "RESTAURANT_NOT_FOUND", statusCode: 404 });

        await client.query(`UPDATE restaurants SET status = 'active', updated_at = $2 WHERE id = $1`, [restaurantId, now]);
        await client.query(
          `UPDATE subscriptions SET status = COALESCE(status_before_suspend, CASE WHEN trial_ends_at IS NOT NULL THEN 'trialing' ELSE 'active' END),
            status_before_suspend = NULL, updated_at = $2 WHERE restaurant_id = $1 AND status = 'suspended'`,
          [restaurantId, now],
        );

        await recordAudit({
          client,
          restaurantId,
          adminId,
          action: "restaurant.restored",
          resourceType: "restaurant",
          resourceId: restaurantId,
        });

        await client.query("COMMIT");
        return { restored: true };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async updateStorageAllowance({ adminId, restaurantId, maxStorageBytes }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const now = clock();

        await client.query(
          `INSERT INTO tenant_storage_allowances (restaurant_id, max_storage_bytes, used_storage_bytes, updated_at)
           VALUES ($1, $2, 0, $3)
           ON CONFLICT (restaurant_id) DO UPDATE
           SET max_storage_bytes = EXCLUDED.max_storage_bytes, updated_at = EXCLUDED.updated_at`,
          [restaurantId, maxStorageBytes, now],
        );

        await recordAudit({
          client,
          restaurantId,
          adminId,
          action: "storage_allowance.updated",
          resourceType: "tenant_storage_allowance",
          resourceId: restaurantId,
          metadata: { maxStorageBytes: String(maxStorageBytes) },
        });

        await client.query("COMMIT");
        return { maxStorageBytes: String(maxStorageBytes) };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async listBranches({ restaurantId }) {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT id, restaurant_id, code, name, timezone, phone, address, is_default, is_active, created_at, updated_at
             FROM branches
            WHERE restaurant_id = $1
            ORDER BY is_default DESC, name ASC`,
          [restaurantId],
        );
        return {
          branches: result.rows.map((b) => ({
            id: b.id,
            restaurantId: b.restaurant_id,
            code: b.code,
            name: b.name,
            timezone: b.timezone,
            phone: b.phone,
            address: b.address,
            isDefault: b.is_default,
            isActive: b.is_active,
            createdAt: b.created_at,
            updatedAt: b.updated_at,
          })),
        };
      } finally {
        client.release();
      }
    },

    async createBranch({
      adminId,
      restaurantId,
      name,
      code,
      phone = null,
      address = null,
      timezone = "Asia/Karachi",
      isDefault = false,
      isActive = true,
    }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const restCheck = await client.query(
          "SELECT id FROM restaurants WHERE id = $1 FOR UPDATE",
          [restaurantId],
        );
        if (!restCheck.rows[0]) {
          throw Object.assign(new Error("Restaurant not found."), {
            code: "RESTAURANT_NOT_FOUND",
            statusCode: 404,
          });
        }

        const sanitizedCode = String(code).trim().toLowerCase();
        if (isDefault) {
          await client.query(
            "UPDATE branches SET is_default = false WHERE restaurant_id = $1",
            [restaurantId],
          );
        }

        let branchRow;
        try {
          const insertRes = await client.query(
            `INSERT INTO branches (restaurant_id, code, name, timezone, phone, address, is_default, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, restaurant_id, code, name, timezone, phone, address, is_default, is_active, created_at, updated_at`,
            [
              restaurantId,
              sanitizedCode,
              name.trim(),
              timezone.trim() || "Asia/Karachi",
              phone ? phone.trim() : null,
              address ? address.trim() : null,
              Boolean(isDefault),
              Boolean(isActive),
            ],
          );
          branchRow = insertRes.rows[0];
        } catch (err) {
          if (err.code === "23505") {
            throw Object.assign(
              new Error("A branch with this code already exists for this restaurant."),
              { code: "BRANCH_CODE_EXISTS", statusCode: 409 },
            );
          }
          throw err;
        }

        await recordAudit({
          client,
          restaurantId,
          adminId,
          action: "branch.created",
          resourceType: "branch",
          resourceId: branchRow.id,
          metadata: { name: branchRow.name, code: branchRow.code, isDefault: branchRow.is_default },
        });

        await client.query("COMMIT");
        return {
          branch: {
            id: branchRow.id,
            restaurantId: branchRow.restaurant_id,
            code: branchRow.code,
            name: branchRow.name,
            timezone: branchRow.timezone,
            phone: branchRow.phone,
            address: branchRow.address,
            isDefault: branchRow.is_default,
            isActive: branchRow.is_active,
            createdAt: branchRow.created_at,
            updatedAt: branchRow.updated_at,
          },
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async editBranch({
      adminId,
      restaurantId,
      branchId,
      name,
      code,
      phone,
      address,
      timezone,
      isActive,
      isDefault,
    }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const existing = (
          await client.query(
            "SELECT id, is_default FROM branches WHERE id = $1 AND restaurant_id = $2 FOR UPDATE",
            [branchId, restaurantId],
          )
        ).rows[0];
        if (!existing) {
          throw Object.assign(new Error("Branch not found."), {
            code: "BRANCH_NOT_FOUND",
            statusCode: 404,
          });
        }

        if (isDefault === true) {
          await client.query(
            "UPDATE branches SET is_default = false WHERE restaurant_id = $1 AND id <> $2",
            [restaurantId, branchId],
          );
        }

        const changes = {};
        if (name !== undefined) changes.name = name.trim();
        if (code !== undefined) changes.code = code.trim().toLowerCase();
        if (phone !== undefined) changes.phone = phone ? phone.trim() : null;
        if (address !== undefined) changes.address = address ? address.trim() : null;
        if (timezone !== undefined) changes.timezone = timezone.trim();
        if (isActive !== undefined) changes.is_active = Boolean(isActive);
        if (isDefault !== undefined) changes.is_default = Boolean(isDefault);

        const keys = Object.keys(changes);
        let updatedRow;
        try {
          const updateRes = await client.query(
            `UPDATE branches
                SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")}, updated_at = now()
              WHERE id = $1 AND restaurant_id = $2
              RETURNING id, restaurant_id, code, name, timezone, phone, address, is_default, is_active, created_at, updated_at`,
            [branchId, restaurantId, ...keys.map((k) => changes[k])],
          );
          updatedRow = updateRes.rows[0];
        } catch (err) {
          if (err.code === "23505") {
            throw Object.assign(
              new Error("A branch with this code already exists for this restaurant."),
              { code: "BRANCH_CODE_EXISTS", statusCode: 409 },
            );
          }
          throw err;
        }

        await recordAudit({
          client,
          restaurantId,
          adminId,
          action: "branch.updated",
          resourceType: "branch",
          resourceId: branchId,
          metadata: { changedFields: keys },
        });

        await client.query("COMMIT");
        return {
          branch: {
            id: updatedRow.id,
            restaurantId: updatedRow.restaurant_id,
            code: updatedRow.code,
            name: updatedRow.name,
            timezone: updatedRow.timezone,
            phone: updatedRow.phone,
            address: updatedRow.address,
            isDefault: updatedRow.is_default,
            isActive: updatedRow.is_active,
            createdAt: updatedRow.created_at,
            updatedAt: updatedRow.updated_at,
          },
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async recordDeviceSyncTelemetry({
      restaurantId,
      deviceUid,
      branchId = null,
      deviceName = null,
      platform = null,
      appVersion = null,
      pendingOrdersCount = 0,
      failedSyncCount = 0,
      lastSyncAt = null,
      lastErrorMessage = null,
    }) {
      const client = await pool.connect();
      try {
        const now = clock();
        await client.query(
          `INSERT INTO device_sync_status (
            restaurant_id, device_uid, branch_id, device_name, platform, app_version,
            pending_orders_count, failed_sync_count, last_sync_at, last_error_message,
            last_error_at, last_seen_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $10 IS NOT NULL THEN $11 ELSE NULL END, $11, $11)
          ON CONFLICT (restaurant_id, device_uid) DO UPDATE SET
            branch_id = COALESCE(EXCLUDED.branch_id, device_sync_status.branch_id),
            device_name = COALESCE(EXCLUDED.device_name, device_sync_status.device_name),
            platform = COALESCE(EXCLUDED.platform, device_sync_status.platform),
            app_version = COALESCE(EXCLUDED.app_version, device_sync_status.app_version),
            pending_orders_count = EXCLUDED.pending_orders_count,
            failed_sync_count = EXCLUDED.failed_sync_count,
            last_sync_at = COALESCE(EXCLUDED.last_sync_at, device_sync_status.last_sync_at),
            last_error_message = EXCLUDED.last_error_message,
            last_error_at = CASE WHEN EXCLUDED.last_error_message IS NOT NULL THEN $11 ELSE device_sync_status.last_error_at END,
            last_seen_at = $11,
            updated_at = $11`,
          [
            restaurantId,
            deviceUid,
            branchId,
            deviceName,
            platform,
            appVersion,
            Math.max(0, Number(pendingOrdersCount) || 0),
            Math.max(0, Number(failedSyncCount) || 0),
            lastSyncAt ? new Date(lastSyncAt) : null,
            lastErrorMessage,
            now,
          ],
        );
        return { ok: true };
      } finally {
        client.release();
      }
    },

    async getRestaurantSyncStatus({ restaurantId }) {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT device_uid, branch_id, device_name, platform, app_version,
                  pending_orders_count, failed_sync_count, last_sync_at,
                  last_error_message, last_error_at, last_seen_at
             FROM device_sync_status
            WHERE restaurant_id = $1
            ORDER BY last_seen_at DESC`,
          [restaurantId],
        );
        return {
          devices: result.rows.map((s) => ({
            deviceUid: s.device_uid,
            branchId: s.branch_id,
            deviceName: s.device_name || "POS Terminal",
            platform: s.platform,
            appVersion: s.app_version,
            pendingOrdersCount: Number(s.pending_orders_count || 0),
            failedSyncCount: Number(s.failed_sync_count || 0),
            lastSyncAt: s.last_sync_at,
            lastErrorMessage: s.last_error_message,
            lastErrorAt: s.last_error_at,
            lastSeenAt: s.last_seen_at,
            isOnline: (new Date() - new Date(s.last_seen_at)) < 15 * 60 * 1000,
          })),
        };
      } finally {
        client.release();
      }
    },

    async getSyncMonitoringOverview() {
      const client = await pool.connect();
      try {
        const summary = (await client.query(`
          SELECT
            COUNT(*)::int AS total_devices,
            COUNT(CASE WHEN last_seen_at > now() - INTERVAL '15 minutes' THEN 1 END)::int AS online_devices,
            COALESCE(SUM(pending_orders_count), 0)::int AS total_pending_orders,
            COALESCE(SUM(failed_sync_count), 0)::int AS total_failed_syncs,
            COUNT(CASE WHEN failed_sync_count > 0 OR last_error_message IS NOT NULL THEN 1 END)::int AS devices_with_errors
          FROM device_sync_status
        `)).rows[0];

        const devices = (await client.query(`
          SELECT d.*, r.name AS restaurant_name, r.code AS restaurant_code, b.name AS branch_name
          FROM device_sync_status d
          JOIN restaurants r ON r.id = d.restaurant_id
          LEFT JOIN branches b ON b.id = d.branch_id
          ORDER BY d.last_seen_at DESC
          LIMIT 100
        `)).rows;

        return {
          summary: {
            totalDevices: summary?.total_devices ?? 0,
            onlineDevices: summary?.online_devices ?? 0,
            totalPendingOrders: summary?.total_pending_orders ?? 0,
            totalFailedSyncs: summary?.total_failed_syncs ?? 0,
            devicesWithErrors: summary?.devices_with_errors ?? 0,
          },
          devices: devices.map((d) => ({
            deviceUid: d.device_uid,
            restaurantId: d.restaurant_id,
            restaurantName: d.restaurant_name,
            restaurantCode: d.restaurant_code,
            branchName: d.branch_name,
            deviceName: d.device_name || "POS Terminal",
            platform: d.platform,
            appVersion: d.app_version,
            pendingOrdersCount: Number(d.pending_orders_count || 0),
            failedSyncCount: Number(d.failed_sync_count || 0),
            lastSyncAt: d.last_sync_at,
            lastErrorMessage: d.last_error_message,
            lastErrorAt: d.last_error_at,
            lastSeenAt: d.last_seen_at,
            isOnline: (new Date() - new Date(d.last_seen_at)) < 15 * 60 * 1000,
          })),
        };
      } finally {
        client.release();
      }
    },

    async getFinancialAnalytics() {
      const client = await pool.connect();
      try {
        const subs = (await client.query(`
          SELECT s.status, s.restaurant_id, p.id AS plan_id, p.name AS plan_name, p.code AS plan_code,
                 pr.amount_minor, pr.currency_code, pr.billing_interval
            FROM subscriptions s
            JOIN plans p ON p.id = s.plan_id
            LEFT JOIN LATERAL (
              SELECT amount_minor, currency_code, billing_interval
                FROM plan_prices
               WHERE plan_id = p.id AND is_active = true
               ORDER BY id ASC LIMIT 1
            ) pr ON true
        `)).rows;

        let mrrByCurrency = {};
        let activeSubscribers = 0;
        let trialSubscribers = 0;
        let churnedSubscribers = 0;
        let planBreakdown = {};

        for (const sub of subs) {
          const cur = sub.currency_code || "PKR";
          if (!mrrByCurrency[cur]) mrrByCurrency[cur] = 0;

          if (!planBreakdown[sub.plan_code]) {
            planBreakdown[sub.plan_code] = {
              name: sub.plan_name,
              code: sub.plan_code,
              activeCount: 0,
              totalCount: 0,
              mrrMinor: 0,
              currency: cur,
            };
          }
          planBreakdown[sub.plan_code].totalCount++;

          if (sub.status === "active") {
            activeSubscribers++;
            planBreakdown[sub.plan_code].activeCount++;
            const amount = Number(sub.amount_minor) || 0;
            let monthly = 0;
            if (sub.billing_interval === "month") monthly = amount;
            else if (sub.billing_interval === "quarter") monthly = Math.round(amount / 3);
            else if (sub.billing_interval === "year") monthly = Math.round(amount / 12);
            mrrByCurrency[cur] += monthly;
            planBreakdown[sub.plan_code].mrrMinor += monthly;
          } else if (sub.status === "trialing" || sub.status === "trial") {
            trialSubscribers++;
          } else if (["cancelled", "suspended", "expired"].includes(sub.status)) {
            churnedSubscribers++;
          }
        }

        const totalTracked = activeSubscribers + churnedSubscribers;
        const churnRate = totalTracked > 0 ? (churnedSubscribers / totalTracked) * 100 : 0;

        const payTotals = (await client.query(`
          SELECT
            COALESCE(SUM(CASE WHEN status = 'approved' THEN amount_minor ELSE 0 END), 0)::bigint AS total_approved_minor,
            COALESCE(SUM(CASE WHEN status = 'approved' AND payment_date >= now() - INTERVAL '30 days' THEN amount_minor ELSE 0 END), 0)::bigint AS last_30d_minor,
            COALESCE(SUM(CASE WHEN status = 'pending' THEN amount_minor ELSE 0 END), 0)::bigint AS pending_amount_minor,
            COUNT(CASE WHEN status = 'pending' THEN 1 END)::int AS pending_count,
            COUNT(CASE WHEN status = 'approved' THEN 1 END)::int AS approved_count
          FROM manual_payments
        `)).rows[0];

        const recentPayments = (await client.query(`
          SELECT mp.id, mp.amount_minor, mp.currency_code, mp.payment_date, mp.status, mp.external_reference,
                 r.name AS restaurant_name, r.code AS restaurant_code, p.name AS plan_name
          FROM manual_payments mp
          JOIN restaurants r ON r.id = mp.restaurant_id
          JOIN plans p ON p.id = mp.plan_id
          WHERE mp.status = 'approved'
          ORDER BY mp.payment_date DESC
          LIMIT 10
        `)).rows;

        const defaultCurrency = Object.keys(mrrByCurrency)[0] || "PKR";
        const totalMrrMinor = mrrByCurrency[defaultCurrency] || 0;
        const totalApprovedMinor = Number(payTotals?.total_approved_minor || 0);
        const last30DaysMinor = Number(payTotals?.last_30d_minor || 0);
        const roundedChurnRate = Math.round(churnRate * 10) / 10;

        const plansBreakdownList = Object.values(planBreakdown).map((p) => ({
          name: p.name,
          code: p.code,
          activeSubscribers: p.activeCount,
          totalSubscribers: p.totalCount,
          mrrContributionMinor: p.mrrMinor,
          currency: p.currency,
        }));

        const overview = {
          mrrMinor: totalMrrMinor,
          arrMinor: totalMrrMinor * 12,
          totalVerifiedRevenueMinor: totalApprovedMinor,
          revenueLast30DaysMinor: last30DaysMinor,
          pendingAmountMinor: Number(payTotals?.pending_amount_minor || 0),
          pendingCount: Number(payTotals?.pending_count || 0),
          approvedCount: Number(payTotals?.approved_count || 0),
          activeSubscriptions: activeSubscribers,
          trialSubscriptions: trialSubscribers,
          churnedSubscriptions: churnedSubscribers,
          churnRatePercentage: roundedChurnRate,
          currency: defaultCurrency,
        };

        return {
          overview,
          plansBreakdown: plansBreakdownList,
          mrr: {
            totalMinor: totalMrrMinor,
            currency: defaultCurrency,
            byCurrency: mrrByCurrency,
          },
          arr: {
            totalMinor: totalMrrMinor * 12,
            currency: defaultCurrency,
          },
          revenue: {
            totalApprovedMinor,
            last30DaysMinor,
            pendingAmountMinor: Number(payTotals?.pending_amount_minor || 0),
            pendingCount: Number(payTotals?.pending_count || 0),
            approvedCount: Number(payTotals?.approved_count || 0),
            currency: defaultCurrency,
          },
          subscribers: {
            active: activeSubscribers,
            trial: trialSubscribers,
            churned: churnedSubscribers,
            churnRate: roundedChurnRate,
          },
          planBreakdown: plansBreakdownList,
          recentPayments: recentPayments.map((p) => ({
            id: p.id,
            amountMinor: Number(p.amount_minor),
            currencyCode: p.currency_code,
            paymentDate: p.payment_date,
            restaurantName: p.restaurant_name,
            restaurantCode: p.restaurant_code,
            planName: p.plan_name,
            externalReference: p.external_reference,
          })),
        };
      } finally {
        client.release();
      }
    },

    async getPaymentsExportCsv() {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT mp.id, r.name AS restaurant_name, r.code AS restaurant_code, p.code AS plan_code,
                 mp.amount_minor, mp.currency_code, mp.status, mp.payment_method, mp.external_reference,
                 mp.whatsapp_reference_text, mp.payment_date, mp.covered_from, mp.covered_until,
                 pa.username AS reviewed_by, mp.created_at
          FROM manual_payments mp
          JOIN restaurants r ON r.id = mp.restaurant_id
          JOIN plans p ON p.id = mp.plan_id
          LEFT JOIN platform_administrators pa ON pa.id = mp.reviewed_by_admin_id
          ORDER BY mp.created_at DESC
        `);

        const header = [
          "Payment ID",
          "Restaurant Name",
          "Restaurant Code",
          "Plan",
          "Amount",
          "Currency",
          "Status",
          "Payment Method",
          "External Reference",
          "WhatsApp Reference",
          "Payment Date",
          "Covered From",
          "Covered Until",
          "Reviewed By",
          "Created At",
        ];

        const escapeCsv = (val) => {
          const s = String(val ?? "").replace(/"/g, '""');
          return /[",\n\r]/.test(s) ? `"${s}"` : s;
        };

        const lines = [header.join(",")];
        for (const r of result.rows) {
          lines.push(
            [
              escapeCsv(r.id),
              escapeCsv(r.restaurant_name),
              escapeCsv(r.restaurant_code),
              escapeCsv(r.plan_code),
              escapeCsv((Number(r.amount_minor) / 100).toFixed(2)),
              escapeCsv(r.currency_code),
              escapeCsv(r.status),
              escapeCsv(r.payment_method),
              escapeCsv(r.external_reference),
              escapeCsv(r.whatsapp_reference_text),
              escapeCsv(r.payment_date ? new Date(r.payment_date).toISOString() : ""),
              escapeCsv(r.covered_from ? new Date(r.covered_from).toISOString() : ""),
              escapeCsv(r.covered_until ? new Date(r.covered_until).toISOString() : ""),
              escapeCsv(r.reviewed_by || ""),
              escapeCsv(r.created_at ? new Date(r.created_at).toISOString() : ""),
            ].join(","),
          );
        }

        return lines.join("\r\n");
      } finally {
        client.release();
      }
    },

    // ==========================================
    // Phase: Dedicated Device Management Module
    // ==========================================

    // Documented Thresholds:
    // Online: last_seen_at >= now() - 5 minutes
    // Offline: 5 minutes < now() - last_seen_at <= 24 hours
    // Stale: last_seen_at is NULL or > 24 hours ago
    // Revoked: status = 'revoked'
    calculateDeviceStatus(status, lastSeenAt) {
      if (status === "revoked") return "revoked";
      if (!lastSeenAt) return "stale";
      const diffMs = Date.now() - new Date(lastSeenAt).getTime();
      if (diffMs <= 5 * 60 * 1000) return "online";
      if (diffMs <= 24 * 60 * 60 * 1000) return "offline";
      return "stale";
    },

    formatDevice(d) {
      if (!d) return null;
      return {
        id: d.id,
        restaurantId: d.restaurant_id,
        branchId: d.branch_id,
        deviceUid: d.device_uid,
        name: d.name,
        platform: d.platform,
        os: d.os,
        deviceType: d.device_type,
        appVersion: d.app_version,
        status: d.status,
        calculatedStatus: this.calculateDeviceStatus(d.status, d.last_seen_at),
        lastSeenAt: d.last_seen_at,
        lastSyncAt: d.last_sync_at,
        revokedAt: d.revoked_at,
        revocationReason: d.revocation_reason,
        reactivatedAt: d.reactivated_at,
        reactivationReason: d.reactivation_reason,
        createdAt: d.created_at,
        updatedAt: d.updated_at,
      };
    },

    async listDevices({
      page = 1,
      limit = 20,
      search = "",
      status = "all",
      restaurantId = null,
      branchId = null,
      deviceType = null,
      version = null,
      sort = "last_seen_at",
      order = "DESC",
    } = {}) {
      const client = await pool.connect();
      try {
        const offset = (Math.max(1, Number(page)) - 1) * Math.max(1, Number(limit));
        const conditions = [];
        const values = [];

        if (restaurantId) {
          values.push(restaurantId);
          conditions.push(`d.restaurant_id = $${values.length}`);
        }

        if (branchId) {
          values.push(branchId);
          conditions.push(`d.branch_id = $${values.length}`);
        }

        if (deviceType) {
          values.push(deviceType.toLowerCase());
          conditions.push(`d.device_type = $${values.length}`);
        }

        if (version) {
          values.push(`%${version.trim()}%`);
          conditions.push(`d.app_version ILIKE $${values.length}`);
        }

        if (search && search.trim()) {
          values.push(`%${search.trim()}%`);
          const idx = values.length;
          conditions.push(`(
            d.name ILIKE $${idx} OR
            d.device_uid ILIKE $${idx} OR
            r.name ILIKE $${idx} OR
            r.code ILIKE $${idx} OR
            COALESCE(b.name, '') ILIKE $${idx}
          )`);
        }

        if (status && status !== "all") {
          const s = status.toLowerCase();
          if (s === "revoked") {
            conditions.push(`d.status = 'revoked'`);
          } else if (s === "online") {
            conditions.push(`d.status = 'active' AND d.last_seen_at >= now() - INTERVAL '5 minutes'`);
          } else if (s === "offline") {
            conditions.push(`d.status = 'active' AND d.last_seen_at < now() - INTERVAL '5 minutes' AND d.last_seen_at >= now() - INTERVAL '24 hours'`);
          } else if (s === "stale") {
            conditions.push(`d.status = 'active' AND (d.last_seen_at < now() - INTERVAL '24 hours' OR d.last_seen_at IS NULL)`);
          }
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

        const allowedSorts = {
          last_seen_at: "d.last_seen_at",
          name: "d.name",
          created_at: "d.created_at",
          last_sync_at: "d.last_sync_at",
          restaurant_name: "r.name",
        };
        const sortCol = allowedSorts[sort] || "d.last_seen_at";
        const sortOrder = order && order.toUpperCase() === "ASC" ? "ASC NULLS FIRST" : "DESC NULLS LAST";

        const countQuery = `
          SELECT COUNT(*)::int AS count
          FROM devices d
          JOIN restaurants r ON r.id = d.restaurant_id
          LEFT JOIN branches b ON b.id = d.branch_id
          ${whereClause}
        `;
        const totalCount = (await client.query(countQuery, values)).rows[0]?.count ?? 0;

        const summaryValues = restaurantId ? [restaurantId] : [];
        const summaryWhere = restaurantId ? "WHERE d.restaurant_id = $1" : "";
        const summaryRes = (await client.query(`
          SELECT
            COUNT(*)::int AS total_devices,
            COUNT(CASE WHEN d.status = 'revoked' THEN 1 END)::int AS revoked_count,
            COUNT(CASE WHEN d.status = 'active' AND d.last_seen_at >= now() - INTERVAL '5 minutes' THEN 1 END)::int AS online_count,
            COUNT(CASE WHEN d.status = 'active' AND d.last_seen_at < now() - INTERVAL '5 minutes' AND d.last_seen_at >= now() - INTERVAL '24 hours' THEN 1 END)::int AS offline_count,
            COUNT(CASE WHEN d.status = 'active' AND (d.last_seen_at < now() - INTERVAL '24 hours' OR d.last_seen_at IS NULL) THEN 1 END)::int AS stale_count
          FROM devices d
          ${summaryWhere}
        `, summaryValues)).rows[0];

        const selectValues = [...values, Math.max(1, Number(limit)), offset];
        const pageQuery = `
          SELECT
            d.id,
            d.restaurant_id,
            d.branch_id,
            d.device_uid,
            d.name,
            d.platform,
            d.os,
            d.device_type,
            d.app_version,
            d.status,
            d.last_seen_at,
            d.last_sync_at,
            d.revoked_at,
            d.revocation_reason,
            d.reactivated_at,
            d.created_at,
            d.updated_at,
            r.name AS restaurant_name,
            r.code AS restaurant_code,
            b.name AS branch_name,
            b.code AS branch_code,
            (SELECT COUNT(*)::int FROM sessions s WHERE s.device_id = d.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions_count
          FROM devices d
          JOIN restaurants r ON r.id = d.restaurant_id
          LEFT JOIN branches b ON b.id = d.branch_id
          ${whereClause}
          ORDER BY ${sortCol} ${sortOrder}
          LIMIT $${selectValues.length - 1} OFFSET $${selectValues.length}
        `;
        const rows = (await client.query(pageQuery, selectValues)).rows;

        return {
          devices: rows.map((d) => ({
            id: d.id,
            restaurantId: d.restaurant_id,
            restaurantName: d.restaurant_name,
            restaurantCode: d.restaurant_code,
            branchId: d.branch_id,
            branchName: d.branch_name,
            branchCode: d.branch_code,
            deviceUid: d.device_uid,
            name: d.name,
            platform: d.platform,
            os: d.os,
            deviceType: d.device_type,
            appVersion: d.app_version,
            status: d.status,
            calculatedStatus: this.calculateDeviceStatus(d.status, d.last_seen_at),
            lastSeenAt: d.last_seen_at,
            lastSyncAt: d.last_sync_at,
            revokedAt: d.revoked_at,
            revocationReason: d.revocation_reason,
            reactivatedAt: d.reactivated_at,
            activeSessionsCount: d.active_sessions_count,
            createdAt: d.created_at,
            updatedAt: d.updated_at,
          })),
          totalCount,
          page: Number(page),
          limit: Number(limit),
          summary: {
            totalDevices: summaryRes?.total_devices ?? 0,
            onlineCount: summaryRes?.online_count ?? 0,
            onlineDevices: summaryRes?.online_count ?? 0,
            offlineCount: summaryRes?.offline_count ?? 0,
            offlineDevices: summaryRes?.offline_count ?? 0,
            staleCount: summaryRes?.stale_count ?? 0,
            staleDevices: summaryRes?.stale_count ?? 0,
            revokedCount: summaryRes?.revoked_count ?? 0,
            revokedDevices: summaryRes?.revoked_count ?? 0,
          },
        };
      } finally {
        client.release();
      }
    },

    async getDeviceDetails(deviceId) {
      const client = await pool.connect();
      try {
        const devRes = await client.query(`
          SELECT
            d.*,
            r.name AS restaurant_name,
            r.code AS restaurant_code,
            r.status AS restaurant_status,
            b.name AS branch_name,
            b.code AS branch_code,
            p.max_devices,
            pa_rev.username AS revoked_by_admin,
            pa_act.username AS reactivated_by_admin
          FROM devices d
          JOIN restaurants r ON r.id = d.restaurant_id
          LEFT JOIN branches b ON b.id = d.branch_id
          LEFT JOIN subscriptions sub ON sub.restaurant_id = r.id
          LEFT JOIN plans p ON p.id = sub.plan_id
          LEFT JOIN platform_administrators pa_rev ON pa_rev.id = d.revoked_by_admin_id
          LEFT JOIN platform_administrators pa_act ON pa_act.id = d.reactivated_by_admin_id
          WHERE d.id = $1
          LIMIT 1
        `, [deviceId]);

        const d = devRes.rows[0];
        if (!d) {
          throw controlError("Device not found.", "DEVICE_NOT_FOUND", 404);
        }

        const sessionsRes = await client.query(`
          SELECT
            s.id,
            s.user_id,
            s.ip_address,
            s.user_agent,
            s.created_at,
            s.last_seen_at,
            s.expires_at,
            s.revoked_at,
            u.username,
            u.display_name
          FROM sessions s
          JOIN users u ON u.id = s.user_id
          WHERE s.device_id = $1
          ORDER BY s.last_seen_at DESC
          LIMIT 20
        `, [d.id]);

        const syncRes = await client.query(`
          SELECT *
          FROM device_sync_status
          WHERE restaurant_id = $1 AND device_uid = $2
          LIMIT 1
        `, [d.restaurant_id, d.device_uid]);

        const auditRes = await client.query(`
          SELECT a.id, a.actor_type, a.action, a.metadata, a.created_at, pa.username AS admin_username
          FROM audit_logs a
          LEFT JOIN platform_administrators pa ON pa.id = a.actor_admin_id
          WHERE (a.resource_type = 'device' AND a.resource_id = $1)
             OR (a.restaurant_id = $2 AND a.action LIKE 'device.%')
          ORDER BY a.created_at DESC
          LIMIT 20
        `, [d.id, d.restaurant_id]);

        return {
          device: {
            id: d.id,
            restaurantId: d.restaurant_id,
            restaurantName: d.restaurant_name,
            restaurantCode: d.restaurant_code,
            restaurantStatus: d.restaurant_status,
            branchId: d.branch_id,
            branchName: d.branch_name,
            branchCode: d.branch_code,
            deviceUid: d.device_uid,
            name: d.name,
            platform: d.platform,
            os: d.os,
            deviceType: d.device_type,
            appVersion: d.app_version,
            status: d.status,
            calculatedStatus: this.calculateDeviceStatus(d.status, d.last_seen_at),
            lastSeenAt: d.last_seen_at,
            lastSyncAt: d.last_sync_at,
            revokedAt: d.revoked_at,
            revocationReason: d.revocation_reason,
            revokedByAdmin: d.revoked_by_admin,
            reactivatedAt: d.reactivated_at,
            reactivationReason: d.reactivation_reason,
            reactivatedByAdmin: d.reactivated_by_admin,
            createdAt: d.created_at,
            updatedAt: d.updated_at,
            maxDevicesAllowed: Number(d.max_devices ?? 20),
          },
          sessions: sessionsRes.rows.map((s) => ({
            id: s.id,
            userId: s.user_id,
            username: s.username,
            displayName: s.display_name,
            ipAddress: s.ip_address,
            userAgent: s.user_agent,
            createdAt: s.created_at,
            lastSeenAt: s.last_seen_at,
            expiresAt: s.expires_at,
            revokedAt: s.revoked_at,
            isActive: !s.revoked_at && new Date(s.expires_at) > new Date(),
          })),
          syncTelemetry: syncRes.rows[0] ? {
            pendingOrdersCount: Number(syncRes.rows[0].pending_orders_count || 0),
            failedSyncCount: Number(syncRes.rows[0].failed_sync_count || 0),
            lastSyncAt: syncRes.rows[0].last_sync_at,
            lastErrorMessage: syncRes.rows[0].last_error_message,
            status: syncRes.rows[0].status,
          } : null,
          auditLogs: auditRes.rows.map((a) => ({
            id: a.id,
            actorType: a.actor_type,
            actorName: a.admin_username || "System",
            action: a.action,
            metadata: a.metadata,
            createdAt: a.created_at,
          })),
        };
      } finally {
        client.release();
      }
    },

    async registerDevice({
      adminId = null,
      restaurantId,
      branchId = null,
      deviceUid,
      name,
      deviceType = "desktop",
      platform = "Web",
      os = null,
      appVersion = "1.0",
    }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const restRes = await client.query(
          "SELECT id, name, code, status FROM restaurants WHERE id = $1 FOR SHARE",
          [restaurantId],
        );
        const restaurant = restRes.rows[0];
        if (!restaurant) {
          throw controlError("Restaurant not found.", "RESTAURANT_NOT_FOUND", 404);
        }
        if (restaurant.status !== "active") {
          throw controlError("Cannot register devices for an inactive or suspended restaurant.", "RESTAURANT_INACTIVE", 403);
        }

        let targetBranchId = branchId;
        if (targetBranchId) {
          const branchRes = await client.query(
            "SELECT id FROM branches WHERE restaurant_id = $1 AND id = $2",
            [restaurantId, targetBranchId],
          );
          if (!branchRes.rows[0]) {
            throw controlError("Branch not found for this restaurant.", "BRANCH_NOT_FOUND", 404);
          }
        } else {
          const defBranch = await client.query(
            "SELECT id FROM branches WHERE restaurant_id = $1 AND is_default = true LIMIT 1",
            [restaurantId],
          );
          if (defBranch.rows[0]) targetBranchId = defBranch.rows[0].id;
        }

        const planLimitRes = await client.query(`
          SELECT p.max_devices, sub.status AS subscription_status
          FROM subscriptions sub
          JOIN plans p ON p.id = sub.plan_id
          WHERE sub.restaurant_id = $1
          ORDER BY sub.created_at DESC, sub.id DESC
          LIMIT 1
        `, [restaurantId]);
        const planLimit = Number(planLimitRes.rows[0]?.max_devices ?? 20);
        const subStatus = planLimitRes.rows[0]?.subscription_status;
        if (subStatus && !["active", "trialing"].includes(subStatus)) {
          throw controlError("Cannot register devices on suspended or cancelled subscriptions.", "SUBSCRIPTION_INELIGIBLE", 403);
        }

        const countRes = await client.query(
          "SELECT COUNT(*)::int AS total FROM devices WHERE restaurant_id = $1 AND status = 'active'",
          [restaurantId],
        );
        const activeDeviceCount = countRes.rows[0]?.total ?? 0;
        if (activeDeviceCount >= planLimit) {
          throw controlError(
            `Restaurant device limit of ${planLimit} reached. Upgrade plan or revoke unused devices.`,
            "DEVICE_LIMIT_REACHED",
            409,
          );
        }

        const cleanUid = String(deviceUid).trim();
        const existing = await client.query(
          "SELECT id, status FROM devices WHERE restaurant_id = $1 AND device_uid = $2",
          [restaurantId, cleanUid],
        );
        if (existing.rows[0]) {
          throw controlError(
            `A device with UID "${cleanUid}" is already registered under this restaurant.`,
            "DEVICE_UID_EXISTS",
            409,
          );
        }

        const insertRes = await client.query(`
          INSERT INTO devices (
            restaurant_id, branch_id, device_uid, name, platform, os, device_type, app_version, status, last_seen_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', NULL)
          RETURNING *
        `, [
          restaurantId,
          targetBranchId,
          cleanUid,
          name.trim(),
          platform,
          os,
          deviceType,
          appVersion,
        ]);
        const newDevice = insertRes.rows[0];

        await client.query(`
          INSERT INTO audit_logs (
            restaurant_id, actor_admin_id, actor_type, action, resource_type, resource_id, metadata
          ) VALUES ($1, $2, 'platform_admin', 'device.registered', 'device', $3, $4)
        `, [
          restaurantId,
          adminId,
          newDevice.id,
          JSON.stringify({
            deviceUid: cleanUid,
            name: newDevice.name,
            deviceType: newDevice.device_type,
            branchId: targetBranchId,
          }),
        ]);

        await client.query("COMMIT");
        return this.formatDevice(newDevice);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async updateDevice({
      adminId = null,
      deviceId,
      name = null,
      branchId = null,
      deviceType = null,
      platform = null,
      os = null,
      appVersion = null,
    }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const curRes = await client.query("SELECT * FROM devices WHERE id = $1 FOR UPDATE", [deviceId]);
        const cur = curRes.rows[0];
        if (!cur) throw controlError("Device not found.", "DEVICE_NOT_FOUND", 404);

        if (branchId !== undefined && branchId !== null) {
          const branchRes = await client.query(
            "SELECT id FROM branches WHERE restaurant_id = $1 AND id = $2",
            [cur.restaurant_id, branchId],
          );
          if (!branchRes.rows[0]) throw controlError("Branch not found.", "BRANCH_NOT_FOUND", 404);
        }

        const updateRes = await client.query(`
          UPDATE devices
          SET
            name = COALESCE($2, name),
            branch_id = CASE WHEN $3::boolean THEN $4 ELSE branch_id END,
            device_type = COALESCE($5, device_type),
            platform = COALESCE($6, platform),
            os = COALESCE($7, os),
            app_version = COALESCE($8, app_version),
            updated_at = now()
          WHERE id = $1
          RETURNING *
        `, [
          deviceId,
          name ? name.trim() : null,
          branchId !== undefined,
          branchId || null,
          deviceType || null,
          platform || null,
          os || null,
          appVersion || null,
        ]);
        const updated = updateRes.rows[0];

        await client.query(`
          INSERT INTO audit_logs (
            restaurant_id, actor_admin_id, actor_type, action, resource_type, resource_id, metadata
          ) VALUES ($1, $2, 'platform_admin', 'device.updated', 'device', $3, $4)
        `, [
          cur.restaurant_id,
          adminId,
          deviceId,
          JSON.stringify({ name: updated.name, branchId: updated.branch_id, deviceType: updated.device_type }),
        ]);

        await client.query("COMMIT");
        return this.formatDevice(updated);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async revokeDevice({
      adminId = null,
      deviceId,
      reason,
      revokeSessions = true,
    }) {
      if (!reason || !reason.trim() || reason.trim().length < 3) {
        throw controlError("A valid revocation reason (at least 3 characters) is required.", "INVALID_REASON", 400);
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const devRes = await client.query("SELECT * FROM devices WHERE id = $1 FOR UPDATE", [deviceId]);
        const dev = devRes.rows[0];
        if (!dev) throw controlError("Device not found.", "DEVICE_NOT_FOUND", 404);

        const updateRes = await client.query(`
          UPDATE devices
          SET status = 'revoked',
              revoked_at = now(),
              revocation_reason = $2,
              revoked_by_admin_id = $3,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `, [deviceId, reason.trim(), adminId]);
        const revokedDev = updateRes.rows[0];

        let sessionsRevokedCount = 0;
        if (revokeSessions) {
          const sessRes = await client.query(`
            UPDATE sessions
            SET revoked_at = now()
            WHERE (device_id = $1 OR (device_id IS NULL AND restaurant_id = $2)) AND revoked_at IS NULL
            RETURNING id
          `, [deviceId, dev.restaurant_id]);
          sessionsRevokedCount = sessRes.rows.length;
        }

        await client.query(`
          INSERT INTO audit_logs (
            restaurant_id, actor_admin_id, actor_type, action, resource_type, resource_id, metadata
          ) VALUES ($1, $2, 'platform_admin', 'device.revocation', 'device', $3, $4)
        `, [
          dev.restaurant_id,
          adminId,
          deviceId,
          JSON.stringify({ reason: reason.trim(), sessionsRevoked: sessionsRevokedCount }),
        ]);

        await client.query("COMMIT");
        return this.formatDevice(revokedDev);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async reactivateDevice({
      adminId = null,
      deviceId,
      reason,
    }) {
      if (!reason || !reason.trim() || reason.trim().length < 3) {
        throw controlError("A valid reactivation reason (at least 3 characters) is required.", "INVALID_REASON", 400);
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const devRes = await client.query("SELECT * FROM devices WHERE id = $1 FOR UPDATE", [deviceId]);
        const dev = devRes.rows[0];
        if (!dev) throw controlError("Device not found.", "DEVICE_NOT_FOUND", 404);
        if (dev.status === "active") throw controlError("Device is already active.", "DEVICE_ALREADY_ACTIVE", 400);

        const planLimitRes = await client.query(`
          SELECT p.max_devices, sub.status AS subscription_status
          FROM subscriptions sub
          JOIN plans p ON p.id = sub.plan_id
          WHERE sub.restaurant_id = $1
          ORDER BY sub.created_at DESC, sub.id DESC
          LIMIT 1
        `, [dev.restaurant_id]);
        const planLimit = Number(planLimitRes.rows[0]?.max_devices ?? 20);
        const subStatus = planLimitRes.rows[0]?.subscription_status;
        if (subStatus && !["active", "trialing"].includes(subStatus)) {
          throw controlError("Cannot reactivate device: restaurant subscription is not active.", "SUBSCRIPTION_INELIGIBLE", 403);
        }

        const countRes = await client.query(
          "SELECT COUNT(*)::int AS total FROM devices WHERE restaurant_id = $1 AND status = 'active'",
          [dev.restaurant_id],
        );
        if ((countRes.rows[0]?.total ?? 0) >= planLimit) {
          throw controlError(
            `Cannot reactivate: plan limit of ${planLimit} active devices reached.`,
            "DEVICE_LIMIT_REACHED",
            409,
          );
        }

        const updateRes = await client.query(`
          UPDATE devices
          SET status = 'active',
              revoked_at = NULL,
              revocation_reason = NULL,
              reactivated_at = now(),
              reactivation_reason = $2,
              reactivated_by_admin_id = $3,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `, [deviceId, reason.trim(), adminId]);
        const reactivatedDev = updateRes.rows[0];

        await client.query(`
          INSERT INTO audit_logs (
            restaurant_id, actor_admin_id, actor_type, action, resource_type, resource_id, metadata
          ) VALUES ($1, $2, 'platform_admin', 'device.reactivation', 'device', $3, $4)
        `, [
          dev.restaurant_id,
          adminId,
          deviceId,
          JSON.stringify({ reason: reason.trim() }),
        ]);

        await client.query("COMMIT");
        return this.formatDevice(reactivatedDev);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async revokeDeviceSessions({
      adminId = null,
      deviceId,
      reason = "Sessions revoked by administrator",
    }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const devRes = await client.query("SELECT * FROM devices WHERE id = $1 FOR SHARE", [deviceId]);
        const dev = devRes.rows[0];
        if (!dev) throw controlError("Device not found.", "DEVICE_NOT_FOUND", 404);

        const sessRes = await client.query(`
          UPDATE sessions
          SET revoked_at = now()
          WHERE device_id = $1 AND revoked_at IS NULL
          RETURNING id
        `, [deviceId]);
        const count = sessRes.rows.length;

        await client.query(`
          INSERT INTO audit_logs (
            restaurant_id, actor_admin_id, actor_type, action, resource_type, resource_id, metadata
          ) VALUES ($1, $2, 'platform_admin', 'device.sessions_revoked', 'device', $3, $4)
        `, [
          dev.restaurant_id,
          adminId,
          deviceId,
          JSON.stringify({ reason, sessionsRevoked: count }),
        ]);

        await client.query("COMMIT");
        return { success: true, revokedCount: count };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async recordDeviceHeartbeat({
      restaurantId = null,
      deviceId = null,
      deviceUid = null,
      name = null,
      deviceType = null,
      platform = null,
      os = null,
      appVersion = null,
      sessionId = null,
      syncStatus = null,
    }) {
      const client = await pool.connect();
      try {
        let dev = null;
        if (deviceId) {
          const res = await client.query("SELECT * FROM devices WHERE id = $1", [deviceId]);
          dev = res.rows[0];
        } else if (restaurantId && deviceUid) {
          const cleanUid = String(deviceUid).trim();
          const res = await client.query(
            "SELECT * FROM devices WHERE restaurant_id = $1 AND device_uid = $2",
            [restaurantId, cleanUid],
          );
          dev = res.rows[0];
        }

        if (dev && dev.status === "revoked") {
          const err = new Error("This device has been revoked by a platform administrator.");
          err.code = "DEVICE_REVOKED";
          err.statusCode = 403;
          throw err;
        }

        let updatedDev = null;
        if (dev) {
          const res = await client.query(`
            UPDATE devices
            SET last_seen_at = now(),
                last_sync_at = CASE WHEN $2::boolean THEN now() ELSE last_sync_at END,
                os = COALESCE($3, os),
                platform = COALESCE($4, platform),
                app_version = COALESCE($5, app_version),
                name = COALESCE($6, name),
                device_type = COALESCE($7, device_type),
                updated_at = now()
            WHERE id = $1
            RETURNING *
          `, [dev.id, Boolean(syncStatus), os, platform, appVersion, name, deviceType]);
          updatedDev = res.rows[0];
        } else if (restaurantId && deviceUid) {
          const cleanUid = String(deviceUid).trim();
          const defBranch = await client.query(
            "SELECT id FROM branches WHERE restaurant_id = $1 AND is_default = true LIMIT 1",
            [restaurantId],
          );
          const ins = await client.query(`
            INSERT INTO devices (
              restaurant_id, branch_id, device_uid, name, platform, os, device_type, app_version, status, last_seen_at, last_sync_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', now(), CASE WHEN $9::boolean THEN now() ELSE NULL END)
            RETURNING *
          `, [
            restaurantId,
            defBranch.rows[0]?.id || null,
            cleanUid,
            name || "POS Device",
            platform || "Web",
            os,
            deviceType || "desktop",
            appVersion || "1.0",
            Boolean(syncStatus),
          ]);
          updatedDev = ins.rows[0];
        } else {
          throw controlError("Device not found.", "DEVICE_NOT_FOUND", 404);
        }

        if (sessionId && updatedDev) {
          await client.query(
            "UPDATE sessions SET device_id = $1 WHERE id = $2 AND device_id IS NULL",
            [updatedDev.id, sessionId],
          );
        }

        return {
          ok: true,
          status: "online",
          device: this.formatDevice(updatedDev),
          timestamp: new Date().toISOString(),
        };
      } finally {
        client.release();
      }
    },
  });
}

