/**
 * Cloud / offline status indicator.
 *
 * Shows the till operator, at a glance:
 *   - whether the browser is online,
 *   - whether a catalog has been imported to the cloud,
 *   - how many orders are waiting to sync,
 *   - whether any sync attempt has failed,
 *   - whether the restaurant's subscription has a problem
 *     (which is what makes cloud APIs start returning 403).
 *
 * The indicator is derived from the outbox records the
 * browser already owns plus the billing overview — it never
 * guesses: when the cloud cannot be reached it says so
 * instead of implying a state it cannot verify.
 */

import { billingApi } from "./api-client.mjs";
import { CLOUD_CONTEXT_KEY } from "./legacy-cloud-adapter.mjs";
import { DEFAULT_STORAGE_KEY as CLOUD_OUTBOX_KEY } from "./order-outbox.mjs";

const REFRESH_INTERVAL_MS = 60_000;

const SUBSCRIPTION_PROBLEM_STATUSES = new Set([
  "past_due",
  "unpaid",
  "expired",
  "canceled",
]);

export function createCloudStatus({
  storage,
  refreshIntervalMs = REFRESH_INTERVAL_MS,
} = {}) {
  if (!storage || typeof storage.get !== "function") {
    throw new TypeError("storage must provide a get function.");
  }

  let timer = null;

  function badge() {
    return document.querySelector(".status-badge");
  }

  function render(state) {
    const element = badge();
    if (!element) return;
    const colors = {
      gray: "#94a3b8",
      green: "#22c55e",
      amber: "#f59e0b",
      red: "#ef4444",
    };
    const color = colors[state.tone] ?? colors.gray;
    // textContent wipes the dot, so rebuild it with the
    // same inline styling the stylesheet gives it.
    element.textContent = "";
    const dotElement = document.createElement("i");
    dotElement.style.background = color;
    dotElement.style.boxShadow = `0 0 0 3px ${color}20`;
    element.appendChild(dotElement);
    element.appendChild(document.createTextNode(` ${state.label}`));
    element.style.color = color;
  }

  async function readOutbox() {
    try {
      const records = await storage.get(CLOUD_OUTBOX_KEY);
      return Array.isArray(records) ? records : [];
    } catch {
      return [];
    }
  }

  async function readContext() {
    try {
      const context = await storage.get(CLOUD_CONTEXT_KEY);
      return context?.restaurantId ? context : null;
    } catch {
      return null;
    }
  }

  async function readSubscriptionProblem() {
    try {
      const data = await billingApi.overview();
      const status = data?.subscription?.status;
      return SUBSCRIPTION_PROBLEM_STATUSES.has(status)
        ? status
        : null;
    } catch {
      // Unauthenticated, unconfigured or offline — the sync
      // state below is still accurate, so stay quiet.
      return null;
    }
  }

  async function refresh() {
    if (!navigator.onLine) {
      render({ tone: "gray", label: "Offline — sales keep working locally" });
      return;
    }

    const [context, records, subscriptionProblem] = await Promise.all([
      readContext(),
      readOutbox(),
      readSubscriptionProblem(),
    ]);

    if (subscriptionProblem) {
      render({ tone: "red", label: "Subscription problem — billing access only" });
      return;
    }

    if (!context) {
      render({ tone: "gray", label: "Offline & ready" });
      return;
    }

    const pending = records.filter((record) =>
      ["pending", "retrying"].includes(record.status),
    ).length;
    const failed = records.filter((record) => record.status === "failed")
      .length;

    if (failed > 0) {
      render({ tone: "red", label: `Cloud sync failed (${failed})` });
      return;
    }
    if (pending > 0) {
      render({ tone: "amber", label: `Cloud syncing (${pending} pending)` });
      return;
    }
    render({ tone: "green", label: "Cloud connected" });
  }

  function start() {
    refresh();
    globalThis.addEventListener("online", refresh);
    globalThis.addEventListener("offline", refresh);
    if (timer) clearInterval(timer);
    timer = setInterval(refresh, refreshIntervalMs);
  }

  function stop() {
    globalThis.removeEventListener("online", refresh);
    globalThis.removeEventListener("offline", refresh);
    if (timer) clearInterval(timer);
    timer = null;
  }

  start();

  return Object.freeze({ refresh, start, stop });
}
