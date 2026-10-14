import { randomUUID, randomBytes } from "node:crypto";
import { hashPassword } from "../auth/passwords.mjs";
import {
  lockPlanSessions,
  revokeExcessSessions,
  controlError,
} from "../auth/session-limits.mjs";

export function subscriptionBoundary(start, interval, trialDays = 14) {
  const result = new Date(start);
  if (interval === "trial") {
    result.setUTCDate(result.getUTCDate() + trialDays);
    return result;
  }
  const months = { month: 1, quarter: 3, year: 12 }[interval];
  if (!months || !Number.isFinite(result.getTime()))
    throw controlError("Choose a valid billing interval.", "INVALID_INTERVAL");
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const last = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result;
}

function planDTO(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.is_active,
    maxDevices: Number(row.max_devices),
    trialDays: Number(row.trial_days),
    prices: (row.prices || []).map((p) => ({
      ...p,
      amountMinor: Number(p.amountMinor),
    })),
  };
}
export function createAdminControlService({
  pool,
  passwordPepper,
  clock,
  recordAudit,
}) {
  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='15s'");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      if (e.code === "23503")
        throw controlError(
          "This plan has billing history. Archive it instead.",
          "PLAN_IN_USE",
          409,
        );
      if (e.code === "23505")
        throw controlError(
          "That plan code or login email is already in use.",
          "IDENTIFIER_EXISTS",
          409,
        );
      throw e;
    } finally {
      client.release();
    }
  }
  async function restaurant(client, id) {
    const r = (
      await client.query(
        "SELECT id,status FROM restaurants WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!r)
      throw controlError("Restaurant not found.", "RESTAURANT_NOT_FOUND", 404);
    return r;
  }
  async function activePlan(client, id) {
    await lockPlanSessions(client, id);
    const plan = (
      await client.query("SELECT * FROM plans WHERE id=$1 AND is_active=true", [
        id,
      ])
    ).rows[0];
    if (!plan)
      throw controlError(
        "Choose an active subscription plan.",
        "PLAN_NOT_FOUND",
        404,
      );
    return plan;
  }
  async function writePrice(client, planId, input) {
    // Preserve subscribed/history prices; only the newly published manual price is offered.
    await client.query(
      "UPDATE plan_prices SET is_active=false WHERE plan_id=$1 AND provider='manual'",
      [planId],
    );
    const id = randomUUID();
    await client.query(
      `INSERT INTO plan_prices(id,plan_id,currency_code,amount_minor,billing_interval,provider,provider_price_id)
      VALUES($1,$2,$3,$4,$5,'manual',$6)`,
      [
        id,
        planId,
        input.currencyCode,
        input.amountMinor,
        input.billingInterval,
        `manual_${id}`,
      ],
    );
    return id;
  }
  async function sessionRows(client, id) {
    return (
      await client.query(
        `SELECT s.id,u.username,u.display_name,s.ip_address,s.user_agent,s.created_at,s.last_seen_at,s.expires_at
      FROM sessions s JOIN users u ON u.id=s.user_id AND u.status='active'
      JOIN restaurant_memberships m ON m.user_id=s.user_id AND m.restaurant_id=s.restaurant_id AND m.status='active'
      WHERE s.restaurant_id=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 ORDER BY s.last_seen_at DESC,s.id DESC`,
        [id, clock()],
      )
    ).rows.map((s) => ({
      id: s.id,
      username: s.username,
      displayName: s.display_name,
      ipAddress: s.ip_address,
      userAgent: s.user_agent,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
    }));
  }
  return {
    async listPlanCatalog({
      includeInactive = false,
      page = 1,
      limit = 50,
    } = {}) {
      const rows = (
        await pool.query(
          `SELECT p.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',pp.id,'currencyCode',pp.currency_code,
        'amountMinor',pp.amount_minor,'billingInterval',pp.billing_interval) ORDER BY pp.created_at DESC)
        FROM plan_prices pp WHERE pp.plan_id=p.id AND pp.provider='manual' AND pp.is_active),'[]') AS prices
        FROM plans p WHERE ($1 OR p.is_active) ORDER BY p.code LIMIT $2 OFFSET $3`,
          [includeInactive, limit, (page - 1) * limit],
        )
      ).rows;
      const total = (
        await pool.query(
          "SELECT count(*) AS total FROM plans WHERE ($1 OR is_active)",
          [includeInactive],
        )
      ).rows[0];
      return {
        plans: rows.map(planDTO),
        totalCount: Number(total.total),
        page,
        limit,
      };
    },
    async createPlan({ adminId, ...input }) {
      return transaction(async (client) => {
        const id = randomUUID();
        await client.query(
          `INSERT INTO plans(id,code,name,max_devices,trial_days,is_active) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            id,
            input.code.toUpperCase(),
            input.name,
            input.maxDevices,
            input.trialDays,
            input.isActive,
          ],
        );
        await writePrice(client, id, input);
        await recordAudit({
          client,
          adminId,
          restaurantId: null,
          action: "plan.created",
          resourceType: "plan",
          resourceId: id,
          metadata: { ...input },
        });
        return { id };
      });
    },
    async editPlan({ adminId, planId, ...input }) {
      return transaction(async (client) => {
        await lockPlanSessions(client, planId, true);
        const tenants = (
          await client.query(
            `SELECT r.id FROM restaurants r WHERE EXISTS(SELECT 1 FROM subscriptions s WHERE s.restaurant_id=r.id AND s.plan_id=$1)
          ORDER BY r.id FOR UPDATE`,
            [planId],
          )
        ).rows;
        const old = (
          await client.query("SELECT * FROM plans WHERE id=$1 FOR UPDATE", [
            planId,
          ])
        ).rows[0];
        if (!old) throw controlError("Plan not found.", "PLAN_NOT_FOUND", 404);
        await client.query(
          "UPDATE plans SET code=$2,name=$3,max_devices=$4,trial_days=$5,is_active=$6 WHERE id=$1",
          [
            planId,
            input.code.toUpperCase(),
            input.name,
            input.maxDevices,
            input.trialDays,
            input.isActive,
          ],
        );
        await writePrice(client, planId, input);
        let revoked = 0;
        for (const tenant of tenants) {
          const assigned = (
            await client.query(
              "SELECT plan_id FROM subscriptions WHERE restaurant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
              [tenant.id],
            )
          ).rows[0];
          if (assigned?.plan_id === planId)
            revoked += await revokeExcessSessions(
              client,
              tenant.id,
              input.maxDevices,
              clock(),
            );
        }
        await recordAudit({
          client,
          adminId,
          restaurantId: null,
          action: "plan.updated",
          resourceType: "plan",
          resourceId: planId,
          metadata: { ...input, sessionsRevoked: revoked },
        });
        return { updated: true, sessionsRevoked: revoked };
      });
    },
    async archivePlan({ adminId, planId }) {
      return transaction(async (client) => {
        await lockPlanSessions(client, planId, true);
        const row = (
          await client.query(
            "UPDATE plans SET is_active=false WHERE id=$1 RETURNING id",
            [planId],
          )
        ).rows[0];
        if (!row) throw controlError("Plan not found.", "PLAN_NOT_FOUND", 404);
        await recordAudit({
          client,
          adminId,
          restaurantId: null,
          action: "plan.archived",
          resourceType: "plan",
          resourceId: planId,
        });
        return { archived: true };
      });
    },
    async activatePlan({ adminId, planId }) {
      return transaction(async (client) => {
        await lockPlanSessions(client, planId, true);
        const r = (
          await client.query(
            "UPDATE plans SET is_active=true WHERE id=$1 RETURNING id",
            [planId],
          )
        ).rows[0];
        if (!r) throw controlError("Plan not found.", "PLAN_NOT_FOUND", 404);
        await recordAudit({
          client,
          adminId,
          restaurantId: null,
          action: "plan.activated",
          resourceType: "plan",
          resourceId: planId,
        });
        return { activated: true };
      });
    },
    async deletePlan({ adminId, planId }) {
      return transaction(async (client) => {
        await lockPlanSessions(client, planId, true);
        const p = (
          await client.query("SELECT id FROM plans WHERE id=$1 FOR UPDATE", [
            planId,
          ])
        ).rows[0];
        if (!p) throw controlError("Plan not found.", "PLAN_NOT_FOUND", 404);
        const used = (
          await client.query(
            `SELECT EXISTS(SELECT 1 FROM subscriptions WHERE plan_id=$1) OR EXISTS(SELECT 1 FROM manual_payments WHERE plan_id=$1)
          OR EXISTS(SELECT 1 FROM checkout_attempts WHERE plan_code=(SELECT code FROM plans WHERE id=$1)) AS used`,
            [planId],
          )
        ).rows[0];
        if (used.used)
          throw controlError(
            "This plan has billing history. Archive it instead.",
            "PLAN_IN_USE",
            409,
          );
        await client.query("DELETE FROM plan_prices WHERE plan_id=$1", [
          planId,
        ]);
        await client.query("DELETE FROM plans WHERE id=$1", [planId]);
        await recordAudit({
          client,
          adminId,
          restaurantId: null,
          action: "plan.deleted",
          resourceType: "plan",
          resourceId: planId,
        });
        return { deleted: true };
      });
    },
    async setSubscription({
      adminId,
      restaurantId,
      planId,
      mode,
      expiresAt,
      reason,
    }) {
      return transaction(async (client) => {
        const plan = await activePlan(client, planId);
        const r = await restaurant(client, restaurantId);
        const previous = (
          await client.query(
            "SELECT * FROM subscriptions WHERE restaurant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",
            [restaurantId],
          )
        ).rows[0];
        if (previous?.provider && previous.provider !== "manual")
          throw controlError(
            "Provider-managed subscriptions must be changed through their billing provider.",
            "PROVIDER_MANAGED",
            409,
          );
        const price = (
          await client.query(
            "SELECT * FROM plan_prices WHERE plan_id=$1 AND provider='manual' AND is_active ORDER BY created_at DESC LIMIT 1",
            [planId],
          )
        ).rows[0];
        if (!price)
          throw controlError(
            "This plan needs an active manual price.",
            "PRICE_NOT_FOUND",
            409,
          );
        const now = clock();
        const trial = mode === "trial" || price.billing_interval === "trial";
        const start =
          !trial &&
          previous?.current_period_end &&
          new Date(previous.current_period_end) > now
            ? new Date(previous.current_period_end)
            : now;
        const end = expiresAt
          ? new Date(expiresAt)
          : subscriptionBoundary(
              start,
              trial ? "trial" : price.billing_interval,
              plan.trial_days,
            );
        if (end <= now || end <= start)
          throw controlError(
            "The new expiry must follow the current renewal boundary.",
            "INVALID_EXPIRY",
          );
        const status =
          r.status === "suspended"
            ? "suspended"
            : trial
              ? "trialing"
              : "active";
        const effective = trial ? "trialing" : "active";
        const id = previous?.id || randomUUID();
        if (previous)
          await client.query(
            `UPDATE subscriptions SET plan_id=$2,plan_price_id=$3,provider='manual',status=$4,current_period_start=$5,
          current_period_end=$6,trial_ends_at=$7,grace_ends_at=NULL,cancel_at_period_end=false,cancelled_at=NULL,status_before_suspend=$8 WHERE id=$1`,
            [
              id,
              planId,
              price.id,
              status,
              start,
              end,
              trial ? end : null,
              status === "suspended" ? effective : null,
            ],
          );
        else
          await client.query(
            `INSERT INTO subscriptions(id,restaurant_id,plan_id,plan_price_id,provider,status,current_period_start,current_period_end,trial_ends_at,status_before_suspend)
          VALUES($1,$2,$3,$4,'manual',$5,$6,$7,$8,$9)`,
            [
              id,
              restaurantId,
              planId,
              price.id,
              status,
              start,
              end,
              trial ? end : null,
              status === "suspended" ? effective : null,
            ],
          );
        const revoked = await revokeExcessSessions(
          client,
          restaurantId,
          plan.max_devices,
          now,
        );
        await recordAudit({
          client,
          adminId,
          restaurantId,
          action: "subscription.admin_updated",
          resourceType: "subscription",
          resourceId: id,
          metadata: {
            planId,
            mode,
            expiresAt: end.toISOString(),
            reason,
            sessionsRevoked: revoked,
          },
        });
        return {
          updated: true,
          expiresAt: end.toISOString(),
          sessionsRevoked: revoked,
        };
      });
    },
    async manageOwnerCredentials({
      adminId,
      restaurantId,
      email,
      newPassword,
      generateTemporary = false,
      reason,
    }) {
      const temporary = generateTemporary
        ? randomBytes(24).toString("base64url")
        : null;
      const passwordHash =
        temporary || newPassword
          ? await hashPassword(temporary || newPassword, passwordPepper)
          : null;
      return transaction(async (client) => {
        await restaurant(client, restaurantId);
        const owners = (
          await client.query(
            `SELECT u.id,u.username FROM users u JOIN restaurant_memberships m ON m.user_id=u.id AND m.restaurant_id=u.restaurant_id
          WHERE u.restaurant_id=$1 AND m.role='owner' AND m.status<>'removed' ORDER BY u.created_at,u.id FOR UPDATE OF u`,
            [restaurantId],
          )
        ).rows;
        if (owners.length !== 1)
          throw controlError(
            "Choose an owner from the user table; this restaurant must have exactly one owner for this shortcut.",
            "OWNER_AMBIGUOUS",
            409,
          );
        const owner = owners[0];
        if (
          email &&
          (
            await client.query(
              "SELECT id FROM users WHERE restaurant_id=$1 AND id<>$2 AND normalized_username=lower($3)",
              [restaurantId, owner.id, email],
            )
          ).rows.length
        )
          throw controlError(
            "That email conflicts with another user login.",
            "IDENTIFIER_EXISTS",
            409,
          );
        await client.query(
          `UPDATE users SET email=COALESCE($2,email),normalized_email=COALESCE(lower($2),normalized_email),
          email_verified_at=CASE WHEN $2 IS NOT NULL THEN $4 ELSE email_verified_at END,password_hash=COALESCE($3,password_hash),password_changed_at=$4 WHERE id=$1`,
          [owner.id, email ?? null, passwordHash, clock()],
        );
        await client.query(
          "UPDATE sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL",
          [owner.id, clock()],
        );
        await recordAudit({
          client,
          adminId,
          restaurantId,
          action: "owner.credentials_updated",
          resourceType: "user",
          resourceId: owner.id,
          metadata: {
            emailChanged: email !== undefined,
            passwordChanged: Boolean(passwordHash),
            allSessionsRevoked: true,
            reason,
          },
        });
        return {
          updated: true,
          userId: owner.id,
          ...(temporary ? { temporaryPassword: temporary } : {}),
        };
      });
    },
    async listSessions({ restaurantId }) {
      return transaction(async (client) => {
        await restaurant(client, restaurantId);
        return { sessions: await sessionRows(client, restaurantId) };
      });
    },
    async logoutDevices({ adminId, restaurantId, reason }) {
      return transaction(async (client) => {
        await restaurant(client, restaurantId);
        const result = await client.query(
          "UPDATE sessions SET revoked_at=$2 WHERE restaurant_id=$1 AND revoked_at IS NULL AND expires_at>$2 RETURNING id",
          [restaurantId, clock()],
        );
        await recordAudit({
          client,
          adminId,
          restaurantId,
          action: "restaurant.devices_revoked",
          resourceType: "restaurant",
          resourceId: restaurantId,
          metadata: { count: result.rows.length, reason },
        });
        return { revokedSessions: result.rows.length };
      });
    },
  };
}
