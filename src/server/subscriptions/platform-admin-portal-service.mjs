import { randomUUID } from "node:crypto";
import { hashPassword } from "../auth/passwords.mjs";

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

  return Object.freeze({
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
        return {
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

    async listRestaurants({ search = "", status = null, limit = 50, page = 1 } = {}) {
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
             LEFT JOIN subscriptions s ON s.restaurant_id = r.id
                   AND s.status IN ('trialing', 'active', 'past_due', 'cancel_at_period_end', 'suspended')
             LEFT JOIN plans p ON p.id = s.plan_id
             LEFT JOIN tenant_storage_allowances sa ON sa.restaurant_id = r.id
            WHERE ($1::text IS NULL OR lower(r.name) LIKE $1 OR lower(r.code) LIKE $1 OR lower(r.slug) LIKE $1)
              AND ($2::text IS NULL OR r.status = $2)
            ORDER BY r.created_at DESC
            LIMIT $3 OFFSET $4`,
          [normSearch, status, limit, offset],
        );

        return result.rows.map((row) => ({
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
      } finally {
        client.release();
      }
    },

    async createRestaurant({ adminId, name, code, ownerUsername, ownerPassword, ownerDisplayName, planCode = "GROWTH" }) {
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
          `SELECT id, name FROM plans WHERE code = $1 LIMIT 1`,
          [planCode.toUpperCase()],
        );
        let plan = planResult.rows[0];
        if (!plan) {
          const defaultPlan = await client.query(`SELECT id, name FROM plans LIMIT 1`);
          plan = defaultPlan.rows[0];
        }

        const passwordHash = await hashPassword(ownerPassword, passwordPepper);

        // Insert restaurant
        await client.query(
          `INSERT INTO restaurants (id, name, code, slug, status)
           VALUES ($1, $2, $3, $3, 'active')`,
          [restaurantId, String(name).trim(), normCode],
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
        const trialEnds = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14-day trial
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
        if (error.code === "23505") {
          if (/restaurants_code_unique_idx|code/i.test(error.constraint ?? "")) {
            const err = new Error("Restaurant code already exists.");
            err.code = "RESTAURANT_CODE_EXISTS";
            err.statusCode = 409;
            throw err;
          }
          if (/username/i.test(error.constraint ?? "")) {
            const err = new Error("Username already exists in this restaurant.");
            err.code = "USERNAME_EXISTS";
            err.statusCode = 409;
            throw err;
          }
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
          `SELECT r.id, r.name, r.code, r.slug, r.status, r.created_at,
                  s.id AS subscription_id, s.status AS subscription_status, s.current_period_start, s.current_period_end,
                  p.name AS plan_name, p.code AS plan_code, p.id AS plan_id,
                  COALESCE(sa.max_storage_bytes, 5368709120) AS max_storage_bytes,
                  COALESCE(sa.used_storage_bytes, 0) AS used_storage_bytes
             FROM restaurants r
             LEFT JOIN subscriptions s ON s.restaurant_id = r.id
                   AND s.status IN ('trialing', 'active', 'past_due', 'cancel_at_period_end', 'suspended')
             LEFT JOIN plans p ON p.id = s.plan_id
             LEFT JOIN tenant_storage_allowances sa ON sa.restaurant_id = r.id
            WHERE r.id = $1`,
          [restaurantId],
        );
        const restaurant = restResult.rows[0];
        if (!restaurant) return null;

        const usersResult = await client.query(
          `SELECT u.id, u.username, u.display_name, u.status, m.role
             FROM users u
             JOIN restaurant_memberships m ON m.user_id = u.id AND m.restaurant_id = u.restaurant_id
            WHERE u.restaurant_id = $1`,
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

        return {
          restaurant: {
            id: restaurant.id,
            name: restaurant.name,
            code: restaurant.code,
            slug: restaurant.slug,
            status: restaurant.status,
            createdAt: restaurant.created_at,
          },
          subscription: {
            id: restaurant.subscription_id,
            status: restaurant.subscription_status ?? "none",
            planName: restaurant.plan_name ?? "No Plan",
            planCode: restaurant.plan_code ?? null,
            planId: restaurant.plan_id ?? null,
            currentPeriodStart: restaurant.current_period_start,
            currentPeriodEnd: restaurant.current_period_end,
          },
          storage: {
            maxStorageBytes: String(restaurant.max_storage_bytes),
            usedStorageBytes: String(restaurant.used_storage_bytes),
          },
          users: usersResult.rows.map((u) => ({
            id: u.id,
            username: u.username,
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
            metadata: a.metadata,
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

        const planResult = await client.query(`SELECT id, name FROM plans WHERE code = $1 LIMIT 1`, [planCode.toUpperCase()]);
        const plan = planResult.rows[0];
        if (!plan) {
          const err = new Error(`Plan code ${planCode} not found.`);
          err.code = "PLAN_NOT_FOUND";
          err.statusCode = 404;
          throw err;
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
          `SELECT id, current_period_end, status FROM subscriptions WHERE restaurant_id = $1 AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [payment.restaurant_id],
        );
        const existingSub = subResult.rows[0];

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
                SET plan_id = $2, status = 'active', current_period_start = $3, current_period_end = $4, updated_at = $5
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
        await client.query("SELECT id FROM restaurants WHERE id = $1 FOR UPDATE", [restaurantId]);

        await client.query(`UPDATE restaurants SET status = 'suspended', updated_at = $2 WHERE id = $1`, [restaurantId, now]);
        await client.query(
          `UPDATE subscriptions SET status = 'suspended', updated_at = $2 WHERE restaurant_id = $1 AND status IN ('active', 'trialing', 'past_due')`,
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
        await client.query("SELECT id FROM restaurants WHERE id = $1 FOR UPDATE", [restaurantId]);

        await client.query(`UPDATE restaurants SET status = 'active', updated_at = $2 WHERE id = $1`, [restaurantId, now]);
        await client.query(
          `UPDATE subscriptions SET status = 'active', updated_at = $2 WHERE restaurant_id = $1 AND status = 'suspended'`,
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
  });
}
