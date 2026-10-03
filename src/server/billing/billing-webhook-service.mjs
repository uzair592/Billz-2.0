import { createHash, randomUUID } from "node:crypto";
import { withTenantTransaction } from "../database/tenant-transaction.mjs";
import {
  billingError,
  normalizeBillingEvent,
} from "./payment-provider.mjs";

const BILLING_STATUS_BY_EVENT = Object.freeze({
  "checkout.completed": "active",
  "subscription.started": "active",
  "subscription.renewed": "active",
  "subscription.past_due": "past_due",
  "subscription.cancelled": "cancelled",
  "subscription.expired": "expired",
});

/**
 * Every transition the state machine permits. Anything not listed here is
 * refused rather than applied, so a surprising event can never move a
 * subscription into a state the rest of the system does not understand.
 *
 * `cancelled` and `expired` may return to `pending_checkout` or `active`
 * because re-subscribing is a real business flow; reaching `active` still
 * additionally requires a paid period. `suspended` is a platform decision and
 * deliberately cannot be left through a provider event.
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  pending_checkout: new Set([
    "pending_checkout", "trialing", "active", "past_due",
    "cancel_at_period_end", "cancelled", "expired",
  ]),
  trialing: new Set([
    "trialing", "active", "past_due", "cancel_at_period_end", "cancelled", "expired",
  ]),
  active: new Set([
    "active", "trialing", "past_due", "cancel_at_period_end", "cancelled", "expired",
  ]),
  past_due: new Set([
    "past_due", "active", "cancel_at_period_end", "cancelled", "expired",
  ]),
  cancel_at_period_end: new Set([
    "cancel_at_period_end", "active", "past_due", "cancelled", "expired",
  ]),
  cancelled: new Set(["cancelled", "pending_checkout", "trialing", "active"]),
  expired: new Set(["expired", "pending_checkout", "trialing", "active"]),
  suspended: new Set(["suspended", "cancelled", "expired"]),
});

/** Statuses that a provider event is allowed to finish with. */
const PROVIDER_DRIVEN_STATUSES = new Set(Object.keys(ALLOWED_TRANSITIONS));

function laterOf(current, incoming) {
  if (!incoming) return current ?? null;
  if (!current) return incoming;
  const currentTime = new Date(current).getTime();
  const incomingTime = new Date(incoming).getTime();
  if (!Number.isFinite(currentTime)) return incoming;
  if (!Number.isFinite(incomingTime)) return current;
  return incomingTime > currentTime ? incoming : current;
}

function coercePeriod(periodStart, periodEnd) {
  const start = periodStart ? new Date(periodStart) : null;
  const end = periodEnd ? new Date(periodEnd) : null;
  const startValid = start && Number.isFinite(start.getTime()) ? start : null;
  const endValid = end && Number.isFinite(end.getTime()) ? end : null;
  // A period that ends before it begins would violate the schema constraint and
  // roll the whole event back. Dropping it keeps a malformed event from
  // consuming every retry.
  if (startValid && endValid && endValid <= startValid) {
    return { periodStart: startValid, periodEnd: null };
  }
  return { periodStart: startValid, periodEnd: endValid };
}

/**
 * Processes payment-provider webhooks.
 *
 * The order is deliberate and is the security property of this whole feature:
 *
 *   1. the signature is verified first, and an unverified payload is only
 *      recorded as rejected — it is never applied;
 *   2. the event is claimed under a unique provider key, and a claim is a lease:
 *      a claim that later fails is released back to `failed` so the provider's
 *      next delivery is processed instead of discarded as a duplicate;
 *   3. only then is the restaurant resolved and the subscription updated inside
 *      a normal tenant transaction.
 *
 * A browser request can therefore never activate a paid subscription, and a
 * transient database failure can never cost a restaurant a payment it made.
 */
export function createBillingWebhookService({
  pool,
  provider,
  graceDays = 7,
  maxAttempts = 8,
  leaseSeconds = 300,
  clock = () => new Date(),
  logger = null,
}) {
  if (!provider || typeof provider.verifyWebhook !== "function") {
    throw new TypeError("A payment provider with verifyWebhook() is required.");
  }

  const log = {
    info(context, message) {
      logger?.info?.({ ...context, message });
    },
    warn(context, message) {
      logger?.warn?.({ ...context, message });
    },
    error(context, message) {
      logger?.error?.({ ...context, message });
    },
  };

  function logContext(event, extra = {}) {
    return {
      provider: provider.name,
      providerEventId: event?.providerEventId ?? null,
      eventType: event?.type ?? null,
      providerSubscriptionId: event?.providerSubscriptionId ?? null,
      ...extra,
    };
  }

  /**
   * Decides the subscription state an event may move to.
   *
   * Access is only ever extended by an event that also carries a paid period. An
   * event without a usable period can never grant access, and an already active
   * subscription is never demoted because a later event happened to carry less
   * information.
   */
  function nextSubscriptionStatus({ current, event, target, periodEnd, now }) {
    if (["past_due", "cancelled", "expired"].includes(target)) return target;

    const periodIsPaid = Boolean(periodEnd) && new Date(periodEnd) > now;

    // A trial is a state the provider reports, not one inferred from a period.
    // Its end date is the trial end, and the access policy grants access until
    // then, so it must not be reported as an active paid period.
    if (event.describesSubscription && event.status === "trialing") return "trialing";

    if (!periodIsPaid) return current === "active" ? current : "pending_checkout";
    if (event.describesSubscription && event.cancelAtPeriodEnd) {
      return "cancel_at_period_end";
    }
    return "active";
  }

  /**
   * Claims an event for processing.
   *
   * The claim is a lease, not a one-way door. A first delivery inserts the row;
   * a retry may take over a row that is `pending` or `failed`, but only through
   * a conditional update, so two simultaneous deliveries of the same event can
   * never both process it. `processed`, `ignored`, and exhausted rows are
   * terminal.
   *
   * A `processing` row with an expired lease is reclaimed. A `processing` row
   * with an active lease is treated as in-progress and the caller should
   * return a retryable 503 so the provider retries.
   */
  async function claimEvent({
    providerEventId, eventType, verified, payload, now, processingStatus = null,
  }) {
    const inserted = await pool.query(
      `INSERT INTO webhook_events (
         id, provider, provider_event_id, event_type, signature_verified,
         payload, processing_status, attempts, received_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 1, $8)
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING id, processing_status, attempts, received_at`,
      [
        randomUUID(), provider.name, providerEventId, eventType ?? "unrecognized",
        verified, JSON.stringify(payload ?? {}),
        // A verified event that is about to be processed is marked
        // `processing` immediately, so a failure can release it and a crashed
        // process leaves a row the lease sweep can recover.
        processingStatus ?? (verified ? "processing" : "ignored"), now,
      ],
    );
    if (inserted.rows[0]) {
      return { claimed: true, attempts: 1, retry: false, processingStatus: inserted.rows[0].processing_status };
    }

    // Row exists - check its state and decide what to do
    const existing = await pool.query(
      `SELECT processing_status, attempts, received_at
         FROM webhook_events
        WHERE provider = $1 AND provider_event_id = $2`,
      [provider.name, providerEventId],
    );
    const row = existing.rows[0];
    if (!row) {
      // Should not happen, but handle gracefully
      return { claimed: false, processingStatus: null, attempts: 0, exhausted: false, inProgress: false };
    }

    const leaseExpired = row.processing_status === "processing"
      && new Date(row.received_at).getTime() < now.getTime() - leaseSeconds * 1_000;

    // If the event is being processed and the lease has expired, reclaim it
    if (row.processing_status === "processing" && leaseExpired) {
      const reclaimed = await pool.query(
        `UPDATE webhook_events
            SET processing_status = 'processing',
                attempts = attempts + 1,
                received_at = $4
          WHERE provider = $1
            AND provider_event_id = $2
            AND processing_status = 'processing'
            AND received_at < $5
          RETURNING id, processing_status, attempts`,
        [provider.name, providerEventId, maxAttempts, now, new Date(now.getTime() - leaseSeconds * 1_000)],
      );
      if (reclaimed.rows[0]) {
        return { claimed: true, attempts: reclaimed.rows[0].attempts, retry: true, processingStatus: "processing", reclaimed: true };
      }
      // Another process reclaimed it first, fall through to re-check
    }

    // If currently being processed and lease not expired, it's actively in progress
    if (row.processing_status === "processing" && !leaseExpired) {
      return { claimed: false, processingStatus: "processing", attempts: row.attempts, exhausted: false, inProgress: true };
    }

    // Terminal states - no retry
    if (row.processing_status === "processed" || row.processing_status === "ignored") {
      return {
        claimed: false,
        processingStatus: row.processing_status,
        attempts: row.attempts,
        exhausted: false,
        inProgress: false,
      };
    }

    // Retryable states: pending or failed, with attempts remaining
    if (["pending", "failed"].includes(row.processing_status) && row.attempts < maxAttempts) {
      const claimed = await pool.query(
        `UPDATE webhook_events
            SET processing_status = 'processing',
                attempts = attempts + 1,
                received_at = $4
          WHERE provider = $1
            AND provider_event_id = $2
            AND processing_status IN ('pending', 'failed')
            AND attempts < $3
          RETURNING id, processing_status, attempts`,
        [provider.name, providerEventId, maxAttempts, now],
      );
      if (claimed.rows[0]) {
        return { claimed: true, attempts: claimed.rows[0].attempts, retry: true, processingStatus: "processing" };
      }
      // Another process claimed it, fall through to re-check
    }

    // Exhausted: failed/pending but attempts >= maxAttempts, or processing with expired lease but reclaimed by another
    const exhausted = row.attempts >= maxAttempts
      || (row.processing_status === "processing" && leaseExpired);
    return {
      claimed: false,
      processingStatus: row.processing_status,
      attempts: row.attempts,
      exhausted,
      inProgress: false,
    };
  }

  async function releaseClaim(providerEventId, message) {
    await pool.query(
      `UPDATE webhook_events
          SET processing_status = 'failed',
              last_error = $3
        WHERE provider = $1 AND provider_event_id = $2
          AND processing_status = 'processing'`,
      [provider.name, providerEventId, String(message).slice(0, 500)],
    );
  }

  async function markProcessed(providerEventId, now) {
    await pool.query(
      `UPDATE webhook_events
          SET processing_status = 'processed', processed_at = $3, last_error = NULL
        WHERE provider = $1 AND provider_event_id = $2`,
      [provider.name, providerEventId, now],
    );
  }

  async function markIgnored(providerEventId, reason, now) {
    await pool.query(
      `UPDATE webhook_events
          SET processing_status = 'ignored', processed_at = $3, last_error = $4
        WHERE provider = $1 AND provider_event_id = $2`,
      [provider.name, providerEventId, now, String(reason).slice(0, 500)],
    );
  }

  /**
   * Returns a stuck `processing` row to `failed` so it can be retried.
   *
   * A claim left behind by a crashed process is otherwise invisible: it is not
   * `pending`, not `failed`, and not terminal, so nothing would ever move it.
   */
  async function releaseExpiredClaims(now) {
    const result = await pool.query(
      `UPDATE webhook_events
          SET processing_status = 'failed',
              last_error = 'processing lease expired'
        WHERE provider = $1
          AND processing_status = 'processing'
          AND received_at < $2`,
      [provider.name, new Date(now.getTime() - leaseSeconds * 1_000)],
    );
    return result.rowCount ?? 0;
  }

  async function resolveRoute(event) {
    const references = [
      event.providerSubscriptionId,
      event.providerCustomerId,
      event.providerCheckoutSessionId,
    ].filter((reference) => Boolean(reference));

    for (const reference of references) {
      const result = await pool.query(
        `SELECT restaurant_id
           FROM provider_tenant_routes
          WHERE provider = $1 AND provider_reference = $2`,
        [provider.name, reference],
      );
      if (result.rows[0]) {
        return { restaurantId: result.rows[0].restaurant_id, reference };
      }
    }
    return null;
  }

  async function applyEvent(event, now) {
    const target = BILLING_STATUS_BY_EVENT[event.type];
    if (!target) {
      await markIgnored(event.providerEventId, `event_type:${event.type}`, now);
      return { applied: false, retryable: false, reason: "unknown_event_type" };
    }

    const route = await resolveRoute(event);
    if (!route) {
      // A paid event that names a restaurant we hold no route for is a
      // server-side inconsistency, not a bad request. The claim is released
      // rather than closed, so the provider's next delivery is processed
      // instead of taking the money and dropping the event with no trace.
      log.error(
        logContext(event, { restaurantRouteReference: null }),
        "billing_event_route_missing",
      );
      return { applied: false, retryable: true, reason: "restaurant_route_missing" };
    }
    const restaurantId = route.restaurantId;

    const outcome = await withTenantTransaction(
      pool,
      { restaurantId, userId: null },
      async (client) => {
        const subscriptionResult = await client.query(
          `SELECT id, status, current_period_start, current_period_end, grace_ends_at,
                  provider_subscription_id
             FROM subscriptions
            WHERE provider = $1
              AND (provider_subscription_id = $2
                   OR billing_customer_id IN (
                     SELECT id FROM billing_customers
                      WHERE restaurant_id = $3 AND provider_customer_id = $4
                   ))
            ORDER BY created_at DESC
            LIMIT 1
            FOR UPDATE`,
          [
            provider.name, event.providerSubscriptionId, restaurantId,
            event.providerCustomerId,
          ],
        );
        const subscription = subscriptionResult.rows[0];
        if (!subscription) {
          return { applied: false, retryable: true, reason: "subscription_not_found" };
        }

        // The stored period only ever moves forward. A late event carrying an
        // older period must never truncate access a newer payment already
        // bought.
        const periodStart = laterOf(
          subscription.current_period_start,
          coercePeriod(event.currentPeriodStart, event.currentPeriodEnd).periodStart,
        );
        const periodEnd = laterOf(
          subscription.current_period_end,
          coercePeriod(event.currentPeriodStart, event.currentPeriodEnd).periodEnd,
        );

        const nextStatus = nextSubscriptionStatus({
          current: subscription.status,
          event,
          target,
          periodEnd,
          now,
        });

        if (!PROVIDER_DRIVEN_STATUSES.has(nextStatus)
          || !ALLOWED_TRANSITIONS[subscription.status]?.has(nextStatus)) {
          log.warn(
            logContext(event, {
              restaurantId,
              from: subscription.status,
              to: nextStatus,
            }),
            "billing_event_transition_refused",
          );
          return {
            applied: false,
            retryable: false,
            reason: "illegal_transition",
            from: subscription.status,
            to: nextStatus,
          };
        }

        const graceEndsAt = nextStatus === "past_due"
          ? new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1_000)
          : subscription.grace_ends_at;
        // Only an event that actually carries the subscription may move the
        // cancel-at-period-end flag. An invoice says nothing about it, so an
        // unrelated failure must not silently clear a pending cancellation.
        const cancelAtPeriodEnd = event.describesSubscription
          ? event.cancelAtPeriodEnd
          : subscription.cancel_at_period_end ?? false;
        // A new provider subscription replaces the old identifier. Keeping the
        // first one ever seen would leave cancel, resume, and plan changes
        // pointed at a subscription that no longer exists.
        const providerSubscriptionId = event.providerSubscriptionId
          ?? subscription.provider_subscription_id;

        await client.query(
          `UPDATE subscriptions
              SET status = $3,
                  current_period_start = CASE
                    WHEN $4::timestamptz IS NULL THEN current_period_start
                    WHEN current_period_start IS NULL THEN $4
                    WHEN $4 > current_period_start THEN $4
                    ELSE current_period_start END,
                  current_period_end = CASE
                    WHEN $5::timestamptz IS NULL THEN current_period_end
                    WHEN current_period_end IS NULL THEN $5
                    WHEN $5 > current_period_end THEN $5
                    ELSE current_period_end END,
                  trial_ends_at = CASE
                    WHEN $11::timestamptz IS NULL THEN trial_ends_at
                    ELSE $11 END,
                  grace_ends_at = $6::timestamptz,
                  cancel_at_period_end = $7,
                  cancelled_at = CASE
                    WHEN $3 IN ('active', 'trialing', 'cancel_at_period_end')
                      THEN NULL
                    WHEN $3 = 'cancelled' THEN $8::timestamptz
                    ELSE cancelled_at END,
                  provider_subscription_id = $10,
                  provider_state = provider_state || $9::jsonb,
                  updated_at = $8::timestamptz
            WHERE restaurant_id = $1 AND id = $2`,
          [
            restaurantId, subscription.id, nextStatus,
            periodStart, periodEnd,
            graceEndsAt,
            cancelAtPeriodEnd, now,
            JSON.stringify({
              lastEvent: event.type,
              providerStatus: event.status,
              amountMinor: event.amountMinor,
              currencyCode: event.currencyCode,
            }),
            providerSubscriptionId,
            nextStatus === "trialing" ? periodEnd : null,
          ],
        );

        // The provider tells us its own subscription identifier only on the
        // webhook, so it is recorded here. Later events can then be routed to
        // this restaurant by subscription id alone.
        if (event.providerSubscriptionId) {
          await client.query(
            `INSERT INTO provider_tenant_routes (
               provider, provider_reference, provider_reference_type, restaurant_id
             ) VALUES ($1, $2, 'subscription', $3)
             ON CONFLICT (provider, provider_reference) DO NOTHING`,
            [provider.name, event.providerSubscriptionId, restaurantId],
          );
        }

        await client.query(
          `INSERT INTO audit_logs (
             id, restaurant_id, actor_user_id, actor_type, action,
             resource_type, resource_id, after_state, metadata
           ) VALUES (
             gen_random_uuid(), $1, NULL, 'webhook', $2, 'subscription', $3,
             $4::jsonb, $5::jsonb
           )`,
          [
            restaurantId,
            `subscription.${nextStatus}`,
            subscription.id,
            JSON.stringify({
              status: nextStatus,
              currentPeriodEnd: periodEnd,
              cancelAtPeriodEnd,
              providerSubscriptionId,
            }),
            JSON.stringify({
              provider: provider.name,
              providerEventId: event.providerEventId,
              eventType: event.type,
            }),
          ],
        );

        if (event.providerPaymentId) {
          await client.query(
            `INSERT INTO billing_payments (
               id, restaurant_id, subscription_id, provider, provider_payment_id,
               status, currency_code, amount_minor, failure_code, failure_message,
               paid_at, provider_state
             ) VALUES (
               gen_random_uuid(), $1, $2, $3, $4,
               $5, $6, $7, $8, $9,
               $10, $11::jsonb
             )
             ON CONFLICT (provider, provider_payment_id)
               WHERE provider_payment_id IS NOT NULL
             DO UPDATE SET status = EXCLUDED.status,
                           amount_minor = EXCLUDED.amount_minor,
                           failure_code = EXCLUDED.failure_code,
                           failure_message = EXCLUDED.failure_message,
                           paid_at = EXCLUDED.paid_at,
                           updated_at = $10`,
            [
              restaurantId, subscription.id, provider.name, event.providerPaymentId,
              nextStatus === "past_due" ? "failed" : "succeeded",
              event.currencyCode ?? "XXX",
              Math.max(0, Number(event.amountMinor ?? 0)),
              event.failureCode, event.failureMessage,
              nextStatus === "past_due" ? null : now,
              JSON.stringify({ lastEvent: event.type }),
            ],
          );
        }

        return {
          applied: true,
          subscriptionId: subscription.id,
          status: nextStatus,
          paymentRecorded: Boolean(event.providerPaymentId),
        };
      },
    );

    if (!outcome.applied) {
      if (outcome.retryable) {
        // Released, not closed: the next delivery must be able to take it.
        await releaseClaim(event.providerEventId, outcome.reason);
        log.error(
          logContext(event, { restaurantId, reason: outcome.reason }),
          "billing_event_unresolved",
        );
      } else {
        await markIgnored(event.providerEventId, outcome.reason, now);
        log.warn(
          logContext(event, { restaurantId, reason: outcome.reason }),
          "billing_event_ignored",
        );
      }
    } else {
      await markProcessed(event.providerEventId, now);
      log.info(logContext(event, { restaurantId, status: outcome.status }), "billing_event_applied");
    }
    return outcome;
  }

  return Object.freeze({
    webhookSignatureHeader: provider.webhookSignatureHeader ?? "x-billing-signature",

    async handle({ rawBody, signatureHeader }) {
      const now = clock();
      const verification = provider.verifyWebhook({ rawBody, signatureHeader });

      if (!verification.verified) {
        await claimEvent({
          providerEventId: `unverified:${fingerprint(rawBody)}`,
          eventType: "unverified",
          verified: false,
          payload: null,
          now,
        });
        // An unverified event is logged and refused. Nothing about a paid
        // subscription ever depends on it.
        log.warn(
          {
            provider: provider.name,
            reason: verification.reason ?? "signature_invalid",
            hasSignature: Boolean(signatureHeader),
          },
          "billing_webhook_rejected",
        );
        return { accepted: false, retryable: false, reason: verification.reason ?? "signature_invalid" };
      }

      let payload = null;
      try {
        payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
      } catch {
        payload = null;
      }
      const event = {
        ...(normalizeBillingEvent(verification.event) ?? {}),
        providerEventId: verification.event?.providerEventId ?? null,
      };

      if (!event.type || !event.providerEventId) {
        // Kept for the audit trail, and terminal on purpose: the provider sends
        // event types we do not model, and retrying those for days would only
        // bury real failures in noise.
        await claimEvent({
          providerEventId: event.providerEventId ?? `unrecognized:${fingerprint(rawBody)}`,
          eventType: "unrecognized",
          verified: true,
          payload,
          now,
          processingStatus: "ignored",
        });
        log.warn(
          { provider: provider.name, reason: "unrecognized_event" },
          "billing_webhook_unrecognized",
        );
        return { accepted: true, ignored: true, retryable: false, reason: "unrecognized_event" };
      }

      const claim = await claimEvent({
        providerEventId: event.providerEventId,
        eventType: event.type,
        verified: true,
        payload,
        now,
      });

      // A processing event with an active lease is in progress - return 503 so
      // the provider retries. We must not return 200 for an in-progress event
      // because the original worker may still be processing it.
      if (!claim.claimed && claim.inProgress) {
        log.warn(
          logContext(event, { attempts: claim.attempts, processingStatus: claim.processingStatus }),
          "billing_event_in_progress",
        );
        return { accepted: false, retryable: true, reason: "event_in_progress" };
      }

      if (!claim.claimed) {
        if (claim.exhausted) {
          // Retrying further cannot succeed and would loop. The event stays in
          // the table as `failed` for an operator, and the drop is logged at
          // error level so monitoring sees it.
          log.error(
            logContext(event, { attempts: claim.attempts, processingStatus: claim.processingStatus }),
            "billing_event_exhausted",
          );
          return {
            accepted: true,
            ignored: true,
            retryable: false,
            exhausted: true,
            reason: "event_exhausted",
          };
        }
        return {
          accepted: true,
          duplicate: true,
          retryable: false,
          reason: "event_already_received",
        };
      }

      try {
        const outcome = await applyEvent(event, now);
        return {
          // An event that could not be resolved is not accepted. Answering 200
          // would tell the provider to stop retrying a payment it already took.
          accepted: outcome.retryable !== true,
          duplicate: false,
          ...outcome,
        };
      } catch (error) {
        // The claim is released rather than left behind, so the provider's next
        // delivery is processed instead of being discarded as a duplicate.
        await releaseClaim(event.providerEventId, error.message);
        log.error(
          logContext(event, { attempts: claim.attempts, error: error.message }),
          "billing_event_failed",
        );
        throw billingError(
          "The billing event could not be applied.",
          "BILLING_EVENT_FAILED",
          500,
        );
      }
    },

    /**
     * Moves a restaurant's subscriptions whose paid period has elapsed into
     * `expired`.
     *
     * Provider events cannot produce this state on their own: Stripe reports the
     * end of a subscription by deleting it, which is recorded as `cancelled`.
     * Expiry is a fact about the clock, so it is derived here instead.
     *
     * This runs inside a tenant transaction because `subscriptions` enforces
     * forced row-level security. A platform-wide sweep is not possible from the
     * application role by design, so a scheduler must invoke this per
     * restaurant, and only for restaurants it has already resolved.
     */
    async expireElapsedSubscriptions({ restaurantId, batchSize = 100 }) {
      const capped = Math.min(1_000, Math.max(1, Number(batchSize) || 100));
      const now = clock();
      const expired = await withTenantTransaction(
        pool,
        { restaurantId, userId: null },
        async (client) => {
          const result = await client.query(
            `UPDATE subscriptions
                SET status = 'expired', updated_at = $2
              WHERE restaurant_id = $1
                AND status IN ('active', 'cancel_at_period_end', 'past_due', 'trialing')
                AND current_period_end IS NOT NULL
                AND current_period_end <= $2
                AND id IN (
                  SELECT id FROM subscriptions
                   WHERE restaurant_id = $1
                   ORDER BY current_period_end
                   LIMIT $3
                   FOR UPDATE SKIP LOCKED
                )
              RETURNING id`,
            [restaurantId, now, capped],
          );
          if (result.rows.length > 0) {
            await client.query(
              `INSERT INTO audit_logs (
                 id, restaurant_id, actor_user_id, actor_type, action,
                 resource_type, resource_id, metadata
               ) VALUES (
                 gen_random_uuid(), $1, NULL, 'system', 'subscription.expired',
                 'subscription', $2, $3::jsonb
               )`,
              [
                restaurantId,
                result.rows[0].id,
                JSON.stringify({ expiredCount: result.rows.length }),
              ],
            );
          }
          return result.rows.map((row) => row.id);
        },
      );
      if (expired.length > 0) {
        log.warn(
          { provider: provider.name, restaurantId, subscriptions: expired },
          "subscription_expired",
        );
      }
      return expired;
    },

    releaseExpiredClaims({ now = clock() } = {}) {
      return releaseExpiredClaims(now);
    },
  });
}

/**
 * A stable identifier for a payload that cannot be trusted to carry one.
 *
 * A 128-bit digest is used instead of a short rolling hash: an attacker who can
 * reach the endpoint must not be able to collide two refused deliveries, or
 * pre-seed a key to hide their own attempts from the audit trail.
 */
function fingerprint(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
  return createHash("sha256").update(buffer).digest("hex").slice(0, 32);
}