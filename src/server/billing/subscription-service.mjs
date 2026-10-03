import { createHash, randomUUID } from "node:crypto";
import { withTenantTransaction } from "../database/tenant-transaction.mjs";
import { billingError } from "./payment-provider.mjs";

const MAX_CHECKOUT_URL_LENGTH = 2_000;

function publicPlan(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    features: row.features ?? {},
    prices: row.prices ?? [],
  };
}

function publicSubscription(row, plan) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    plan: plan
      ? { id: plan.id, code: plan.code, name: plan.name }
      : { id: row.plan_id, code: null, name: null },
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    trialEndsAt: row.trial_ends_at,
    graceEndsAt: row.grace_ends_at,
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    cancelledAt: row.cancelled_at,
    provider: row.provider,
  };
}

function assertAbsoluteUrl(value, label) {
  const url = String(value ?? "").trim();
  if (!/^https?:\/\/[^\s]+$/i.test(url)) {
    throw billingError(`A valid ${label} is required.`, "BILLING_URL_INVALID");
  }
  return url.slice(0, MAX_CHECKOUT_URL_LENGTH);
}

/**
 * A redirect the browser is sent to after paying must not be attacker-chosen.
 *
 * Without this check an owner could hand a colleague a checkout link that
 * returns them to a hostile page carrying the session, so only HTTPS URLs on a
 * configured application origin are accepted.
 */
function assertRedirectUrl(value, label, trustedOrigins) {
  const url = assertAbsoluteUrl(value, label);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw billingError(
      `The ${label} must use HTTPS.`,
      "BILLING_URL_NOT_TRUSTED",
    );
  }
  const allowed = new Set((trustedOrigins ?? []).map((origin) => new URL(origin).origin));
  if (!allowed.has(parsed.origin)) {
    throw billingError(
      `The ${label} must point at this application.`,
      "BILLING_URL_NOT_TRUSTED",
    );
  }
  return url;
}

/**
 * Normalizes a caller-supplied page size.
 *
 * An absent or unparseable value falls back to the default, while a real number
 * is clamped. `0` is a real number, so it becomes `1` rather than silently
 * becoming the default.
 */
function normalizeLimit(value, fallback = 20, max = 100) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(parsed)));
}

/**
 * Computes a deterministic hash of the checkout parameters that affect the
 * provider session. Used to detect when the same idempotency key is reused
 * with a different payload.
 */
function computePlanHash({ planCode, successUrl, cancelUrl }) {
  const canonical = `${planCode.toUpperCase()}|${successUrl}|${cancelUrl}`;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

async function recordAudit(client, {
  restaurantId, userId, action, subscriptionId, before = null, after = null, metadata = {},
}) {
  await client.query(
    `INSERT INTO audit_logs (
       id, restaurant_id, actor_user_id, actor_type, action,
       resource_type, resource_id, before_state, after_state, metadata
     ) VALUES (
       gen_random_uuid(), $1, $2, 'user', $3, 'subscription', $4, $5::jsonb, $6::jsonb, $7::jsonb
     )`,
    [
      restaurantId, userId, action, subscriptionId,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      JSON.stringify(metadata),
    ],
  );
}

/**
 * Plan browsing, checkout, plan changes, cancellation, and payment history.
 *
 * Every method operates on the tenant transaction of the restaurant the caller
 * belongs to, so a restaurant can only ever see and change its own billing
 * state. Nothing here grants access: it records intent with the provider, and a
 * verified webhook is what later moves the subscription state.
 *
 * Provider calls are made outside database transactions. Holding a transaction
 * open across a network round trip to a payment provider ties up a connection
 * for the provider's latency, runs into the tenant transaction timeout, and
 * turns a provider outage into database contention. Each method therefore reads
 * state in one short transaction, calls the provider, and writes the result in
 * another.
 */
export function createSubscriptionService(pool, {
  provider,
  trustedOrigins = [],
  clock = () => new Date(),
}) {
  if (!provider || typeof provider.createCheckoutSession !== "function") {
    throw new TypeError("A payment provider adapter is required.");
  }

  async function loadPlans(client, currencyCode) {
    const result = await client.query(
      `SELECT p.id, p.code, p.name, p.description, p.features,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'id', pp.id,
                    'currencyCode', pp.currency_code,
                    'amountMinor', pp.amount_minor,
                    'interval', pp.billing_interval
                  ) ORDER BY pp.amount_minor
                ) FILTER (WHERE pp.id IS NOT NULL),
                '[]'::jsonb
              ) AS prices
         FROM plans p
         LEFT JOIN plan_prices pp
           ON pp.plan_id = p.id AND pp.provider = $1 AND pp.is_active = true
        WHERE p.is_active = true
        GROUP BY p.id
        ORDER BY p.sort_order, p.name`,
      [provider.name],
    );
    return result.rows
      .map((row) => publicPlan({ ...row, prices: row.prices }))
      .filter((plan) => plan.prices.some((price) => price.currencyCode === currencyCode));
  }

  async function loadSubscription(client, restaurantId, { forUpdate = false } = {}) {
    const result = await client.query(
      `SELECT s.id, s.plan_id, s.status, s.current_period_start, s.current_period_end,
              s.trial_ends_at, s.grace_ends_at, s.cancel_at_period_end, s.cancelled_at,
              s.provider, s.provider_subscription_id, s.billing_customer_id,
              s.provider_state,
              p.code AS plan_code, p.name AS plan_name
         FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.restaurant_id = $1
        ORDER BY s.created_at DESC
        LIMIT 1${forUpdate ? " FOR UPDATE OF s" : ""}`,
      [restaurantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      row,
      view: publicSubscription(row, { id: row.plan_id, code: row.plan_code, name: row.plan_name }),
    };
  }

  async function resolvePrice(client, planCode, currencyCode) {
    // Plan codes are stored uppercase by the schema. Normalizing here turns a
    // case mismatch into a successful lookup instead of a confusing 404.
    const normalizedCode = String(planCode ?? "").trim().toUpperCase();
    const priceResult = await client.query(
      `SELECT pp.id, pp.plan_id, pp.amount_minor, pp.currency_code, pp.provider_price_id,
              p.code AS plan_code, p.name AS plan_name
         FROM plan_prices pp
         JOIN plans p ON p.id = pp.plan_id
        WHERE p.code = $1 AND p.is_active = true AND pp.is_active = true
          AND pp.provider = $2
          AND pp.currency_code = $3
        ORDER BY pp.amount_minor
        LIMIT 1`,
      [normalizedCode, provider.name, currencyCode],
    );
    const price = priceResult.rows[0];
    if (!price) {
      throw billingError("That plan is not available.", "PLAN_NOT_AVAILABLE", 404);
    }
    return price;
  }

  async function recordRoute(client, { reference, referenceType, restaurantId }) {
    if (!reference) return;
    await client.query(
      `INSERT INTO provider_tenant_routes (
         provider, provider_reference, provider_reference_type, restaurant_id
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, provider_reference) DO NOTHING`,
      [provider.name, reference, referenceType, restaurantId],
    );
  }

  /**
   * Returns the provider customer for a restaurant, creating it on first use.
   *
   * The provider call happens outside the transaction. If the insert then loses
   * a race, the unique constraint keeps exactly one row and the local state
   * stays correct; the only residue is an unused customer at the provider, which
   * is far cheaper than holding a transaction open across the network.
   */
  async function ensureBillingCustomer({ restaurantId, userId, email, restaurantName }) {
    const lookup = await withTenantTransaction(
      pool,
      { restaurantId, userId },
      async (client) => {
        const existing = await client.query(
          `SELECT id, provider_customer_id
             FROM billing_customers
            WHERE restaurant_id = $1 AND provider = $2`,
          [restaurantId, provider.name],
        );
        return existing.rows[0] ?? null;
      },
    );
    if (lookup) return lookup;

    const created = await provider.createCustomer({
      restaurantId,
      email,
      name: restaurantName,
    });

    return withTenantTransaction(
      pool,
      { restaurantId, userId },
      async (client) => {
        const result = await client.query(
          `INSERT INTO billing_customers (
             id, restaurant_id, provider, provider_customer_id
           ) VALUES ($1, $2, $3, $4)
           ON CONFLICT (restaurant_id, provider) DO UPDATE
             SET provider_customer_id = EXCLUDED.provider_customer_id
           RETURNING id, provider_customer_id`,
          [randomUUID(), restaurantId, provider.name, created.providerCustomerId],
        );
        await recordRoute(client, {
          reference: result.rows[0].provider_customer_id,
          referenceType: "customer",
          restaurantId,
        });
        return result.rows[0];
      },
    );
  }

  return Object.freeze({
    async overview({ tenant, user }) {
      const restaurantId = tenant.restaurant.id;
      return withTenantTransaction(
        pool,
        { restaurantId, userId: user?.id ?? null },
        async (client) => {
          const subscription = await loadSubscription(client, restaurantId);
          return {
            plans: await loadPlans(client, tenant.restaurant.currencyCode ?? "PKR"),
            subscription: subscription?.view ?? null,
          };
        },
      );
    },

/**
   * Starts a provider checkout for the requested plan.
   *
   * Three short steps, so no transaction is held across the provider call:
   *
   *   1. lock the restaurant's subscription, create/reuse a checkout attempt,
   *      and record the idempotency key;
   *   2. create the provider customer and checkout session;
   *   3. record the routing reference, checkout URL, and mark attempt complete.
   *
   * The restaurant row lock in step 1 serializes checkout requests. The
   * checkout_attempts table provides durable idempotency: a repeated request
   * with the same key returns the stored session; a conflicting payload is
   * rejected; a failed attempt can be retried; an expired attempt is cleaned up.
   */
  async startCheckout({ tenant, user, planCode, successUrl, cancelUrl, idempotencyKey }) {
    const restaurantId = tenant.restaurant.id;
    const currencyCode = tenant.restaurant.currencyCode ?? "PKR";
    const trustedSuccess = assertRedirectUrl(successUrl, "success URL", trustedOrigins);
    const trustedCancel = assertRedirectUrl(cancelUrl, "cancel URL", trustedOrigins);
    const key = String(idempotencyKey ?? "").trim();
    if (!key) {
      throw billingError("An idempotency key is required.", "IDEMPOTENCY_KEY_REQUIRED", 400);
    }
    const planHash = computePlanHash({ planCode, successUrl, cancelUrl });

    // Step 1: lock restaurant, check for existing attempt, create or reuse attempt
    const prepared = await withTenantTransaction(
      pool,
      { restaurantId, userId: user.id },
      async (client) => {
        // Serialize on the restaurant itself
        await client.query(
          "SELECT id FROM restaurants WHERE id = $1 FOR UPDATE",
          [restaurantId],
        );

        // Check for existing attempt with this idempotency key
        const existingAttempt = await client.query(
          `SELECT id, status, provider_checkout_session_id, provider_checkout_url,
                  provider_customer_id, plan_hash
             FROM checkout_attempts
            WHERE restaurant_id = $1 AND idempotency_key = $2`,
          [restaurantId, key],
        );

        if (existingAttempt.rows[0]) {
          const attempt = existingAttempt.rows[0];

          // Reject if same key used with different payload
          if (attempt.plan_hash !== planHash) {
            throw billingError(
              "Idempotency key already used with a different plan or redirect URLs.",
              "IDEMPOTENCY_KEY_CONFLICT",
              409,
            );
          }

          // If already created, return the stored session
          if (attempt.status === "created" && attempt.provider_checkout_url) {
            return {
              replayed: true,
              checkout: {
                checkoutUrl: attempt.provider_checkout_url,
                providerCheckoutSessionId: attempt.provider_checkout_session_id,
              },
              price: null, // Will be resolved after
            };
          }

          // If creating (in progress by another request), wait or conflict
          if (attempt.status === "creating") {
            throw billingError(
              "A checkout with this idempotency key is already in progress.",
              "CHECKOUT_IN_PROGRESS",
              409,
            );
          }

          // If failed or expired, we can retry by updating the attempt
          if (attempt.status === "failed" || attempt.status === "expired") {
            await client.query(
              `UPDATE checkout_attempts
                  SET status = 'creating', plan_hash = $3, success_url = $4,
                      cancel_url = $5, error_message = NULL, expires_at = now() + interval '1 hour',
                      updated_at = now()
                WHERE id = $1`,
              [attempt.id, key, planHash, trustedSuccess, trustedCancel],
            );
            return { replayed: false, attemptId: attempt.id };
          }
        }

        // Serialize on the restaurant itself
        // A restaurant that has never subscribed has no row to lock, so two
        // simultaneous first checkouts would both pass a row check and race
        // into the one-current-subscription index.
        await client.query(
          "SELECT id FROM restaurants WHERE id = $1 FOR UPDATE",
          [restaurantId],
        );

        const price = await resolvePrice(client, planCode, currencyCode);
        const existing = await loadSubscription(client, restaurantId, { forUpdate: true });

        if (existing
          && ["active", "trialing", "past_due", "cancel_at_period_end"].includes(
            existing.view.status,
          )) {
          throw billingError(
            "This restaurant already has a subscription. Change the plan instead.",
            "SUBSCRIPTION_ALREADY_ACTIVE",
            409,
          );
        }

        // Create new checkout attempt
        const providerIdempotencyKey = `ca_${randomUUID()}`;
        const attemptResult = await client.query(
          `INSERT INTO checkout_attempts (
             id, restaurant_id, idempotency_key, plan_code, plan_hash,
             success_url, cancel_url, status, provider_idempotency_key, expires_at
           ) VALUES ($1, $2, $3, $4, $5, $5, $6, 'creating', $7, now() + interval '1 hour')
           RETURNING id`,
          [
            randomUUID(), restaurantId, key, price.plan_code, planHash,
            trustedSuccess, trustedCancel, providerIdempotencyKey,
          ],
        );
        const attemptId = attemptResult.rows[0].id;

        const existingSub = await loadSubscription(client, restaurantId, { forUpdate: true });

        if (existingSub
          && ["active", "trialing", "past_due", "cancel_at_period_end"].includes(
            existingSub.view.status,
          )) {
          throw billingError(
            "This restaurant already has a subscription. Change the plan instead.",
            "SUBSCRIPTION_ALREADY_ACTIVE",
            409,
          );
        }

        let subscriptionId;
        if (!existing) {
          const created = await client.query(
            `INSERT INTO subscriptions (
               id, restaurant_id, plan_id, plan_price_id, provider, status, provider_state
             ) VALUES ($1, $2, $3, $4, $5, 'pending_checkout', $6::jsonb)
             RETURNING id`,
            [
              randomUUID(), restaurantId, price.plan_id, price.id, provider.name,
              JSON.stringify({ planCode: price.plan_code }),
            ],
          );
          subscriptionId = created.rows[0].id;
          await recordAudit(client, {
            restaurantId, userId: user.id, action: "subscription.checkout_started",
            subscriptionId, after: { status: "pending_checkout", planCode: price.plan_code },
            metadata: { idempotencyKey: key, checkoutAttemptId: attemptId },
          });
        } else if (existing.view.status === "pending_checkout") {
          subscriptionId = existing.row.id;
          await client.query(
            `UPDATE subscriptions
                SET plan_id = $3, plan_price_id = $4, provider_state = provider_state || $5::jsonb,
                    updated_at = $6::timestamptz
              WHERE restaurant_id = $1 AND id = $2`,
            [
              restaurantId, subscriptionId, price.plan_id, price.id,
              JSON.stringify({ planCode: price.plan_code }), clock(),
            ],
          );
        } else {
          const created = await client.query(
            `INSERT INTO subscriptions (
               id, restaurant_id, plan_id, plan_price_id, provider, status, provider_state
             ) VALUES ($1, $2, $3, $4, $5, 'pending_checkout', $6::jsonb)
             RETURNING id`,
            [
              randomUUID(), restaurantId, price.plan_id, price.id, provider.name,
              JSON.stringify({ planCode: price.plan_code }),
            ],
          );
          subscriptionId = created.rows[0].id;
          await recordAudit(client, {
            restaurantId,
            userId: user.id,
            action: "subscription.resubscribe_started",
            subscriptionId,
            before: { status: existing.view.status, planCode: existing.row.plan_code },
            after: { status: "pending_checkout", planCode: price.plan_code },
            metadata: { replacesSubscriptionId: existing.row.id, idempotencyKey: key, checkoutAttemptId: attemptId },
          });
        }

        await recordAudit(client, {
          restaurantId, userId: user.id, action: "subscription.checkout_attempt_created",
          subscriptionId, after: { status: "creating", checkoutAttemptId: attemptId },
          metadata: { idempotencyKey: key, planCode: price.plan_code },
        });

        return { replayed: false, attemptId, subscriptionId, price };
      },
    );

    if (prepared.replayed) {
      // Need to resolve price for response
      const price = await withTenantTransaction(
        pool,
        { restaurantId, userId: user.id },
        async (client) => resolvePrice(client, planCode, currencyCode),
      );
      return {
        replayed: true,
        checkoutUrl: prepared.checkout.checkoutUrl,
        plan: { code: price.plan_code, name: price.plan_name },
        amountMinor: Number(price.amount_minor),
        currencyCode: price.currency_code,
        status: "awaiting_payment",
      };
    }

    // Step 2: Provider calls outside transaction
    const customer = await ensureBillingCustomer({
      restaurantId,
      userId: user.id,
      email: user.email,
      restaurantName: tenant.restaurant.name,
    });

    const checkout = await provider.createCheckoutSession({
      providerCustomerId: customer.provider_customer_id,
      providerPriceId: prepared.price.provider_price_id,
      successUrl: trustedSuccess,
      cancelUrl: trustedCancel,
      clientReferenceId: restaurantId,
      idempotencyKey: `ca_${prepared.attemptId}`, // Use attempt ID as provider idempotency key
    });

    // Step 3: Record route, checkout URL, mark attempt complete
    await withTenantTransaction(
      pool,
      { restaurantId, userId: user.id },
      async (client) => {
        await recordRoute(client, {
          reference: checkout.providerCheckoutSessionId,
          referenceType: "checkout_session",
          restaurantId,
        });
        await client.query(
          `UPDATE checkout_attempts
              SET status = 'created',
                  provider_customer_id = $3,
                  provider_checkout_session_id = $4,
                  provider_checkout_url = $5,
                  updated_at = now()
            WHERE id = $1`,
          [prepared.attemptId, customer.provider_customer_id, checkout.providerCheckoutSessionId, checkout.checkoutUrl],
        );
        await client.query(
          `UPDATE subscriptions
              SET provider_state = provider_state || $3::jsonb,
                  billing_customer_id = COALESCE(billing_customer_id, $4),
                  updated_at = $5::timestamptz
            WHERE restaurant_id = $1 AND id = $2`,
          [
            restaurantId, prepared.subscriptionId,
            JSON.stringify({ checkout: { idempotencyKey: key, checkoutUrl: checkout.checkoutUrl, providerCheckoutSessionId: checkout.providerCheckoutSessionId } }),
            customer.id, clock(),
          ],
        );
        await recordAudit(client, {
          restaurantId,
          userId: user.id,
          action: "subscription.checkout_created",
          subscriptionId: prepared.subscriptionId,
          after: { providerCheckoutSessionId: checkout.providerCheckoutSessionId, checkoutAttemptId: prepared.attemptId },
        });
      },
    );

    return {
      replayed: false,
      checkoutUrl: checkout.checkoutUrl,
      plan: { code: prepared.price.plan_code, name: prepared.price.plan_name },
      amountMinor: Number(prepared.price.amount_minor),
      currencyCode: prepared.price.currency_code,
      status: "awaiting_payment",
    };
  },

    async changePlan({ tenant, user, planCode }) {
      const restaurantId = tenant.restaurant.id;
      const state = await withTenantTransaction(
        pool,
        { restaurantId, userId: user?.id ?? null },
        async (client) => {
          const price = await resolvePrice(
            client,
            planCode,
            tenant.restaurant.currencyCode ?? "PKR",
          );
          const subscription = await loadSubscription(client, restaurantId, { forUpdate: true });
          if (!subscription?.row.provider_subscription_id) {
            throw billingError(
              "This restaurant has no provider subscription to change.",
              "SUBSCRIPTION_NOT_PROVIDER_MANAGED",
              409,
            );
          }
          return { price, subscription };
        },
      );

      const result = await provider.changeSubscription({
        providerSubscriptionId: state.subscription.row.provider_subscription_id,
        providerPriceId: state.price.provider_price_id,
      });

      return withTenantTransaction(
        pool,
        { restaurantId, userId: user?.id ?? null },
        async (client) => {
          await client.query(
            `UPDATE subscriptions
                SET plan_id = $3,
                    plan_price_id = $4,
                    provider_state = provider_state || $5::jsonb,
                    updated_at = $6
              WHERE restaurant_id = $1 AND id = $2`,
            [
              restaurantId, state.subscription.row.id, state.price.plan_id, state.price.id,
              JSON.stringify({ providerStatus: result.status ?? null }), clock(),
            ],
          );
          await recordAudit(client, {
            restaurantId,
            userId: user?.id ?? null,
            action: "subscription.plan_changed",
            subscriptionId: state.subscription.row.id,
            before: { planCode: state.subscription.row.plan_code },
            after: { planCode: state.price.plan_code, providerStatus: result.status ?? null },
          });
          return {
            plan: { code: state.price.plan_code, name: state.price.plan_name },
            providerStatus: result.status ?? null,
          };
        },
      );
    },

    async cancel({ tenant, user, cancelAtPeriodEnd = true }) {
      const restaurantId = tenant.restaurant.id;
      const subscription = await withTenantTransaction(
        pool,
        { restaurantId, userId: user?.id ?? null },
        async (client) => {
          const current = await loadSubscription(client, restaurantId, { forUpdate: true });
          if (!current?.row.provider_subscription_id) {
            throw billingError(
              "This restaurant has no provider subscription to cancel.",
              "SUBSCRIPTION_NOT_PROVIDER_MANAGED",
              409,
            );
          }
          return current;
        },
      );

      const result = await provider.cancelSubscription({
        providerSubscriptionId: subscription.row.provider_subscription_id,
        cancelAtPeriodEnd,
      });

      return withTenantTransaction(
        pool,
        { restaurantId, userId: user?.id ?? null },
        async (client) => {
          const now = clock();
          await client.query(
            `UPDATE subscriptions
                SET cancel_at_period_end = $3,
                    status = CASE WHEN $3 THEN 'cancel_at_period_end' ELSE 'cancelled' END,
                    cancelled_at = CASE WHEN $3 THEN NULL ELSE $4::timestamptz END,
                    provider_state = provider_state || $5::jsonb,
                    updated_at = $4::timestamptz
              WHERE restaurant_id = $1 AND id = $2`,
            [
              restaurantId, subscription.row.id, cancelAtPeriodEnd, now,
              JSON.stringify({ providerStatus: result.status ?? null }),
            ],
          );
          await recordAudit(client, {
            restaurantId,
            userId: user?.id ?? null,
            action: cancelAtPeriodEnd ? "subscription.cancel_scheduled" : "subscription.cancelled",
            subscriptionId: subscription.row.id,
            before: { status: subscription.view.status },
            after: { status: cancelAtPeriodEnd ? "cancel_at_period_end" : "cancelled" },
          });
          return {
            cancelAtPeriodEnd,
            accessUntil: cancelAtPeriodEnd ? subscription.row.current_period_end : null,
          };
        },
      );
    },

    async resume({ tenant, user }) {
      const restaurantId = tenant.restaurant.id;
      const subscription = await withTenantTransaction(
        pool,
        { restaurantId, userId: user?.id ?? null },
        async (client) => {
          const current = await loadSubscription(client, restaurantId, { forUpdate: true });
          if (!current?.row.provider_subscription_id) {
            throw billingError(
              "This restaurant has no provider subscription to resume.",
              "SUBSCRIPTION_NOT_PROVIDER_MANAGED",
              409,
            );
          }
          return current;
        },
      );

      const result = await provider.resumeSubscription({
        providerSubscriptionId: subscription.row.provider_subscription_id,
      });

      return withTenantTransaction(
        pool,
        { restaurantId, userId: user?.id ?? null },
        async (client) => {
          const now = clock();
          const activated = subscription.view.status === "cancel_at_period_end";
          await client.query(
            `UPDATE subscriptions
                SET cancel_at_period_end = false,
                    status = CASE WHEN $3 THEN 'active' ELSE status END,
                    cancelled_at = NULL,
                    provider_state = provider_state || $4::jsonb,
                    updated_at = $5::timestamptz
              WHERE restaurant_id = $1 AND id = $2`,
            [
              restaurantId, subscription.row.id, activated,
              JSON.stringify({ providerStatus: result.status ?? null }), now,
            ],
          );
          await recordAudit(client, {
            restaurantId,
            userId: user?.id ?? null,
            action: "subscription.resumed",
            subscriptionId: subscription.row.id,
            before: { status: subscription.view.status },
            after: { status: activated ? "active" : subscription.view.status },
            metadata: { providerStatus: result.status ?? null },
          });
          return { status: activated ? "active" : subscription.view.status };
        },
      );
    },

    async paymentHistory({ tenant, limit = 20 }) {
      const restaurantId = tenant.restaurant.id;
      const capped = normalizeLimit(limit);
      return withTenantTransaction(
        pool,
        { restaurantId, userId: null },
        async (client) => {
          const result = await client.query(
            `SELECT id, provider, provider_payment_id, status, currency_code,
                    amount_minor, failure_code, failure_message, paid_at, created_at
               FROM billing_payments
              WHERE restaurant_id = $1
              ORDER BY created_at DESC
              LIMIT $2`,
            [restaurantId, capped],
          );
          return result.rows.map((row) => ({
            id: row.id,
            provider: row.provider,
            providerPaymentId: row.provider_payment_id,
            status: row.status,
            amountMinor: Number(row.amount_minor),
            currencyCode: row.currency_code,
            failureCode: row.failure_code,
            failureMessage: row.failure_message,
            paidAt: row.paid_at,
            createdAt: row.created_at,
          }));
        },
      );
    },
  });
}