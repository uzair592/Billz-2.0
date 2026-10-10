/**
 * Cloud connection status indicator.
 *
 * States, in priority order:
 *  * browser offline — local sales keep working;
 *  * cloud unreachable (network failure) — local sales keep
 *    working, sync is queued;
 *  * session expired (401) — sign-in required;
 *  * subscription problem (past due / unpaid / canceled /
 *    expired) — billing access only;
 *  * not configured — the device has not copied its catalog
 *    to the cloud yet;
 *  * outbox has failed records — sync failed;
 *  * outbox has pending records — syncing;
 *  * otherwise — connected.
 *
 * Subscription and authentication problems are never labelled
 * "offline" or "sync failed". Overlapping refreshes are
 * sequenced so a stale response can never overwrite a
 * newer status.
 */

import {
  ApiErrorKind,
  billingApi,
  classifyApiError,
} from "./api-client.mjs";
import { CLOUD_CONTEXT_KEY } from "./legacy-cloud-adapter.mjs";

const SUBSCRIPTION_PROBLEM_STATUSES = new Set([
  "past_due",
  "unpaid",
  "canceled",
  "expired",
]);

export function createCloudStatus({
  storage,
  refreshIntervalMs = 60_000,
  managed = Boolean(globalThis.BILLZ_MANAGED),
} = {}) {
  if (!storage || typeof storage.get !== "function") {
    throw new TypeError("storage must provide a get function.");
  }

  let timer = null;
  let started = false;
  let refreshGeneration = 0;

  function badge() {
    return document.querySelector(".status-badge");
  }

  function render({ tone, text }) {
    const el = badge();
    if (!el) return;
    el.textContent = text;
    el.className = `status-badge status-${tone}`;
  }

  async function readOutbox() {
    try {
      const records = await storage.get("pos_cloud_order_outbox_v1");
      return Array.isArray(records) ? records : [];
    } catch {
      return [];
    }
  }

  /**
   * The billing overview is reachable without a paid
   * subscription, so it doubles as a session probe: a 401
   * means the session expired, and a network failure means
   * the cloud is unreachable.
   */
  async function readConnectionProblem() {
    let data;
    try {
      data = await billingApi.overview();
    } catch (error) {
      const kind = classifyApiError(error);
      if (kind === ApiErrorKind.AUTHENTICATION) {
        return {
          tone: "amber",
          text: "Sign in required — cloud features are limited",
        };
      }
      if (kind === ApiErrorKind.UNREACHABLE) {
        return {
          tone: "amber",
          text: managed ? "Cloud unreachable — checkout paused" : "Cloud unreachable — sales keep working locally",
        };
      }
      return null;
    }
    const status = data?.subscription?.status;
    if (status && SUBSCRIPTION_PROBLEM_STATUSES.has(status)) {
      return {
        tone: "red",
        text: "Subscription problem — billing access only",
      };
    }
    return null;
  }

  async function refresh() {
    const generation = (refreshGeneration += 1);
    const apply = (state) => {
      if (generation === refreshGeneration) render(state);
    };

    if (!navigator.onLine) {
      apply({
        tone: "gray",
        text: managed ? "Offline — checkout paused" : "Offline — sales keep working locally",
      });
      return;
    }

    const problem = await readConnectionProblem();
    if (problem) {
      apply(problem);
      return;
    }

    const context = await storage.get(CLOUD_CONTEXT_KEY);
    if (!context?.restaurantId) {
      apply({ tone: "gray", text: managed ? "Import your catalog to enable checkout" : "Offline & ready" });
      return;
    }

    const records = await readOutbox();
    const pending = records.filter(
      (record) => record.status === "pending"
        || record.status === "retrying",
    ).length;
    const failed = records.filter(
      (record) => record.status === "failed",
    ).length;

    if (failed > 0) {
      apply({ tone: "red", text: `Cloud sync failed (${failed})` });
      return;
    }
    if (pending > 0) {
      apply({ tone: "amber", text: `Cloud syncing (${pending} pending)` });
      return;
    }
    apply({ tone: "green", text: "Cloud connected" });
  }

  function start() {
    if (started) return;
    started = true;
    refresh();
    timer = setInterval(refresh, refreshIntervalMs);
    globalThis.addEventListener("online", () => {
      refresh();
    });
    globalThis.addEventListener("offline", () => {
      refresh();
    });
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    started = false;
  }

  // The indicator refreshes from the moment it is created,
  // matching the legacy app's boot sequence; start() is
  // idempotent for callers that prefer to control it.
  start();

  return Object.freeze({ start, stop, refresh });
}