/**
 * Billing screen — connects the POS to /api/billing.
 *
 * The billing endpoints deliberately do not require a paid
 * subscription: a restaurant that has lost POS access must
 * still be able to see its bill and pay to get access back.
 * This screen therefore renders for every signed-in account,
 * whatever the subscription state is.
 *
 * Checkout redirects to the payment provider. The success and
 * cancel URLs are built from the application's own origin —
 * the server only accepts HTTPS URLs on the configured origin,
 * so a checkout started over plain HTTP surfaces the server's
 * BILLING_URL_NOT_TRUSTED error instead of silently failing.
 */

import {
  billingApi,
  generateIdempotencyKey,
} from "./api-client.mjs";

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatMinor(minor) {
  return `Rs. ${(Math.round(Number(minor) || 0) / 100).toLocaleString()}`;
}

function formatDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString();
}

export const DEFAULT_TRUSTED_CHECKOUT_HOSTS = Object.freeze([
  "checkout.stripe.com",
]);

/**
 * Validates that a checkout URL points to an authorized payment provider.
 *
 * Requirements:
 * - valid absolute URL;
 * - HTTPS protocol only (no http, javascript, data, file, blob);
 * - no embedded username or password;
 * - hostname must match an allowed host EXACTLY (case-insensitive);
 * - no substring or deceptive suffix matching (e.g. checkout.stripe.com.evil.example is rejected).
 *
 * @param {string} url
 * @param {Iterable<string>} [allowedHosts]
 * @returns {boolean}
 */
export function isTrustedRedirect(
  url,
  allowedHosts = DEFAULT_TRUSTED_CHECKOUT_HOSTS,
) {
  if (typeof url !== "string" || !url.trim()) return false;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;

  const hostname = parsed.hostname.toLowerCase();
  const hostsSet = new Set(
    Array.from(allowedHosts, (h) => String(h).toLowerCase()),
  );

  return hostsSet.has(hostname);
}

const STATUS_LABELS = {
  active: "✅ Active",
  trialing: "🧪 Trial",
  past_due: "⚠️ Past due",
  cancel_at_period_end: "⏳ Cancels at period end",
  pending_checkout: "🔄 Checkout in progress",
  unpaid: "⚠️ Unpaid",
  canceled: "❌ Canceled",
  expired: "❌ Expired",
};

function statusLabel(status) {
  return STATUS_LABELS[status] ?? escapeHtml(status || "None");
}

export function createBillingUI({
  onUpdated,
  trustedCheckoutHosts = DEFAULT_TRUSTED_CHECKOUT_HOSTS,
} = {}) {
  let busy = false;

  function element(id) {
    return document.getElementById(id);
  }

  function setStatus(message, tone = "info") {
    const status = element("billing-status");
    if (!status) return;
    status.textContent = message;
    status.className = `billing-status billing-status-${tone}`;
    status.classList.remove("hidden");
  }

  function clearStatus() {
    element("billing-status")?.classList.add("hidden");
  }

  function setBusy(value) {
    busy = value;
    element("billing-screen-body")?.classList.toggle("hidden", value);
    element("billing-loader")?.classList.toggle("hidden", !value);
  }

  function renderSubscription(subscription) {
    const container = element("billing-current-subscription");
    if (!container) return;
    if (!subscription) {
      container.innerHTML = `
        <div style="padding:16px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; color:#64748b; font-size:14px;">
          No active subscription — choose a plan below to start one.
        </div>
      `;
      return;
    }
    const period = subscription.currentPeriodEnd
      ? `Renews ${formatDate(subscription.currentPeriodEnd)}`
      : "";
    container.innerHTML = `
      <div style="padding:16px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <div>
            <strong style="font-size:16px;">${escapeHtml(subscription.plan?.name || "Plan")}</strong>
            <span style="margin-left:8px;">${statusLabel(subscription.status)}</span>
            ${subscription.cancelAtPeriodEnd ? '<span style="margin-left:8px; color:#b45309;">(cancellation scheduled)</span>' : ""}
          </div>
          <div style="font-size:13px; color:#64748b;">${period}</div>
        </div>
        ${subscription.trialEndsAt ? `<div style="margin-top:6px; font-size:13px; color:#64748b;">Trial ends ${formatDate(subscription.trialEndsAt)}</div>` : ""}
        ${subscription.graceEndsAt ? `<div style="margin-top:6px; font-size:13px; color:#b45309;">Grace period ends ${formatDate(subscription.graceEndsAt)}</div>` : ""}
      </div>
    `;
  }

  function renderPlans(plans) {
    const container = element("billing-plans");
    if (!container) return;
    if (!plans?.length) {
      container.innerHTML = `<p style="color:#94a3b8;">No plans are available for this restaurant's currency.</p>`;
      return;
    }
    container.innerHTML = plans.map((plan) => {
      const prices = (plan.prices ?? [])
        .map((price) =>
          `<div style="font-size:13px; color:#475569;">${formatMinor(price.amountMinor)} / ${escapeHtml(price.interval || "period")}</div>`,
        )
        .join("");
      const features = Object.entries(plan.features ?? {})
        .filter(([, value]) => Boolean(value))
        .map(([key]) => `<li>${escapeHtml(key)}</li>`)
        .join("");
      return `
        <div class="billing-plan-card" style="border:1px solid #e2e8f0; border-radius:10px; padding:16px; background:white; display:flex; flex-direction:column; gap:10px;">
          <div>
            <strong style="font-size:16px;">${escapeHtml(plan.name)}</strong>
            <div style="font-size:12px; color:#64748b;">${escapeHtml(plan.code)}</div>
          </div>
          ${plan.description ? `<div style="font-size:13px; color:#475569;">${escapeHtml(plan.description)}</div>` : ""}
          ${prices}
          ${features ? `<ul style="margin:0; padding-left:18px; font-size:12px; color:#475569;">${features}</ul>` : ""}
          <button type="button" class="billing-checkout-btn" data-plan="${escapeHtml(plan.code)}"
                  style="margin-top:auto; padding:9px 14px; background:#059669; color:white; border:none; border-radius:6px; font-weight:700; cursor:pointer;">
            ${plan.prices?.length ? "Subscribe / Pay" : "Unavailable"}
          </button>
        </div>
      `;
    }).join("");

    container.querySelectorAll(".billing-checkout-btn").forEach((button) => {
      button.addEventListener("click", () => startCheckout(button.dataset.plan));
    });
  }

  function renderPayments(payments) {
    const container = element("billing-payments");
    if (!container) return;
    if (!payments?.length) {
      container.innerHTML = `<p style="color:#94a3b8;">No payments recorded yet.</p>`;
      return;
    }
    container.innerHTML = `
      <table class="history-table" style="width:100%; border-collapse:collapse; font-size:13px;">
        <thead>
          <tr style="background:#f1f5f9; text-align:left;">
            <th style="padding:8px; border:1px solid #e2e8f0;">Date</th>
            <th style="padding:8px; border:1px solid #e2e8f0;">Provider</th>
            <th style="padding:8px; border:1px solid #e2e8f0;">Amount</th>
            <th style="padding:8px; border:1px solid #e2e8f0;">Status</th>
            <th style="padding:8px; border:1px solid #e2e8f0;">Note</th>
          </tr>
        </thead>
        <tbody>
          ${payments.map((payment) => `
            <tr>
              <td style="padding:8px; border:1px solid #e2e8f0;">${formatDate(payment.paidAt || payment.createdAt)}</td>
              <td style="padding:8px; border:1px solid #e2e8f0;">${escapeHtml(payment.provider || "—")}</td>
              <td style="padding:8px; border:1px solid #e2e8f0;">${formatMinor(payment.amountMinor)} ${escapeHtml(payment.currencyCode || "")}</td>
              <td style="padding:8px; border:1px solid #e2e8f0;">${escapeHtml(payment.status || "—")}</td>
              <td style="padding:8px; border:1px solid #e2e8f0; color:#94a3b8;">${escapeHtml(payment.failureMessage || "")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  async function renderBilling() {
    setBusy(true);
    clearStatus();
    try {
      const data = await billingApi.overview();
      renderSubscription(data.subscription);
      renderPlans(data.plans);
      const payments = await billingApi.payments(20);
      renderPayments(payments);
      renderActions(data.subscription);
    } catch (error) {
      setStatus(
        error.code === "CLOUD_UNREACHABLE"
          ? "The cloud is unreachable — billing details can't be shown while offline."
          : error.message || "Billing details could not be loaded.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  function renderActions(subscription) {
    const container = element("billing-actions");
    if (!container) return;
    const buttons = [];
    if (subscription) {
      const active = ["active", "trialing", "past_due", "cancel_at_period_end"]
        .includes(subscription.status);
      if (active && !subscription.cancelAtPeriodEnd) {
        buttons.push(
          `<button type="button" id="billing-cancel-subscription" style="padding:9px 16px; background:#dc2626; color:white; border:none; border-radius:6px; font-weight:700; cursor:pointer;">Cancel subscription</button>`,
        );
      }
      if (["canceled", "expired", "unpaid"].includes(subscription.status)) {
        buttons.push(
          `<button type="button" id="billing-resume-subscription" style="padding:9px 16px; background:#059669; color:white; border:none; border-radius:6px; font-weight:700; cursor:pointer;">Resume subscription</button>`,
        );
      }
    }
    container.innerHTML = buttons.join("");

    container.querySelector("#billing-cancel-subscription")
      ?.addEventListener("click", cancelSubscription);
    container.querySelector("#billing-resume-subscription")
      ?.addEventListener("click", resumeSubscription);
  }

  async function startCheckout(planCode) {
    if (busy) return;
    setBusy(true);
    clearStatus();
    try {
      const origin = window.location.origin;
      const result = await billingApi.startCheckout({
        planCode,
        successUrl: `${origin}/billing?checkout=success`,
        cancelUrl: `${origin}/billing?checkout=cancelled`,
        idempotencyKey: generateIdempotencyKey(),
      });
      if (result?.checkoutUrl) {
        if (!isTrustedRedirect(result.checkoutUrl, trustedCheckoutHosts)) {
          setStatus(
            "The payment provider returned an untrusted checkout link.",
            "error",
          );
          return;
        }
        window.location.assign(result.checkoutUrl);
        return;
      }
      setStatus("The payment provider did not return a checkout link.", "error");
    } catch (error) {
      setStatus(error.message || "Checkout could not be started.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function cancelSubscription() {
    if (busy) return;
    if (!confirm(
      "Cancel the subscription? The restaurant keeps access until the end of the paid period.",
    )) return;
    setBusy(true);
    clearStatus();
    try {
      await billingApi.cancel(true);
      setStatus("Subscription will cancel at the end of the current period.", "info");
      await renderBilling();
      onUpdated?.();
    } catch (error) {
      setStatus(error.message || "The subscription could not be cancelled.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function resumeSubscription() {
    if (busy) return;
    setBusy(true);
    clearStatus();
    try {
      await billingApi.resume();
      setStatus("Subscription resumed.", "info");
      await renderBilling();
      onUpdated?.();
    } catch (error) {
      setStatus(error.message || "The subscription could not be resumed.", "error");
    } finally {
      setBusy(false);
    }
  }

  element("billing-refresh")?.addEventListener("click", renderBilling);

  return Object.freeze({
    renderBilling,
    startCheckout,
    cancelSubscription,
    resumeSubscription,
  });
}
