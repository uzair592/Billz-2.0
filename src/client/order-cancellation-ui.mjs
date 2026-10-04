/**
 * Order cancellation — connects the legacy cancel flow to
 * POST /api/pos/orders/:orderId/cancel.
 *
 * Cancelling a cloud order is a server-side compensating
 * transaction: the cloud reverses stock, refunds captured
 * payments into their financial accounts and excludes the order
 * from revenue, all atomically and idempotently. The local
 * restock checklist therefore does not apply — the device only
 * collects a reason and confirms.
 *
 * Every request carries a fresh idempotency key, so a retry
 * after a network failure replays the recorded cancellation
 * instead of compensating twice.
 */

import {
  ApiErrorKind,
  CloudApiError,
  classifyApiError,
  generateIdempotencyKey,
  orderCancellationApi,
  orderHistoryApi,
} from "./api-client.mjs";
import {
  isCloudOrderId,
  mapCloudOrderDetail,
} from "./cloud-order-mapper.mjs";
import { CLOUD_CONTEXT_KEY } from "./legacy-cloud-adapter.mjs";

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatMinor(minor) {
  return `Rs. ${Math.round(Number(minor) || 0) / 100}`;
}

export function createOrderCancellationUI({
  storage,
  onCancelled,
} = {}) {
  if (!storage || typeof storage.get !== "function") {
    throw new TypeError("storage must provide a get function.");
  }

  let dialog = null;

  async function cloudConfigured() {
    try {
      const context = await storage.get(CLOUD_CONTEXT_KEY);
      return Boolean(context?.restaurantId);
    } catch {
      return false;
    }
  }

  function closeDialog() {
    if (!dialog) return;
    dialog.remove();
    dialog = null;
  }

  /**
   * A small confirmation dialog with a reason field.
   * Resolves with the reason text, or null when dismissed.
   */
  function askCancellationReason(order) {
    return new Promise((resolve) => {
      closeDialog();

      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.id = "cloud-cancel-dialog-overlay";
      overlay.style.cssText =
        "position:fixed; inset:0; background:rgba(15,23,42,0.55); display:flex; align-items:center; justify-content:center; z-index:1000; padding:16px;";

      const items = (order.items ?? [])
        .map((item) => escapeHtml(`${item.qty}x ${item.name}`))
        .join(", ") || "No items";

      overlay.innerHTML = `
        <div class="modal-content" role="dialog" aria-modal="true"
             aria-labelledby="cloud-cancel-title"
             style="background:white; border-radius:12px; padding:24px; max-width:520px; width:100%; box-shadow:0 20px 40px rgba(0,0,0,0.25);">
          <h2 id="cloud-cancel-title" style="margin:0 0 6px; color:#dc2626; font-size:18px;">
            ❌ Cancel cloud order #${escapeHtml(order.orderNumber)}
          </h2>
          <p style="margin:0 0 10px; font-size:13px; color:#64748b;">
            ${escapeHtml(order.customerName || "Walk-In Customer")} ·
            ${escapeHtml(order.orderType)} · ${formatMinor(order.totalMinor ?? 0)}
          </p>
          <p style="margin:0 0 6px; font-size:12px; color:#94a3b8; overflow-wrap:anywhere;">
            ${items}
          </p>
          <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:10px 12px; font-size:12px; color:#991b1b; margin-bottom:14px;">
            The cloud will reverse the stock, refund any captured payment and
            exclude this order from revenue. This is recorded permanently and
            cannot be undone.
          </div>
          <label for="cloud-cancel-reason" style="font-size:13px; font-weight:700; display:block; margin-bottom:6px;">
            Reason (optional)
          </label>
          <input type="text" id="cloud-cancel-reason" maxlength="200"
                 placeholder="e.g., customer changed mind, wrong order"
                 style="width:100%; padding:9px 11px; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box; font-size:14px;">
          <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:18px;">
            <button type="button" id="cloud-cancel-back"
                    style="padding:8px 20px; background:#94a3b8; color:white; border:none; border-radius:6px; cursor:pointer; font-weight:700;">
              ✕ Go Back
            </button>
            <button type="button" id="cloud-cancel-confirm"
                    style="padding:8px 20px; background:#dc2626; color:white; border:none; border-radius:6px; cursor:pointer; font-weight:700;">
              ✅ Confirm Cancel
            </button>
          </div>
        </div>
      `;

      const reasonInput = overlay.querySelector("#cloud-cancel-reason");
      const finish = (value) => {
        closeDialog();
        resolve(value);
      };

      overlay.querySelector("#cloud-cancel-back").addEventListener("click", () => finish(null));
      overlay.querySelector("#cloud-cancel-confirm").addEventListener("click", () => {
        finish(reasonInput.value.trim() || null);
      });
      reasonInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(reasonInput.value.trim() || null);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          finish(null);
        }
      });
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) finish(null);
      });

      document.body.appendChild(overlay);
      dialog = overlay;
      reasonInput.focus();
    });
  }

  function describeError(error) {
    switch (classifyApiError(error)) {
      case ApiErrorKind.UNREACHABLE:
        return "You're offline. Orders stored in the cloud can't be cancelled until the connection is back.";
      case ApiErrorKind.AUTHENTICATION:
        return "Your cloud session expired. Sign in again to cancel this order.";
      case ApiErrorKind.AUTHORIZATION:
        return "You don't have permission to cancel orders for this restaurant.";
      case ApiErrorKind.SUBSCRIPTION:
        return "This restaurant's subscription is not active. Open Billing to restore access.";
      case ApiErrorKind.VALIDATION:
        return "The cancellation request was not valid. Review the reason and try again.";
      case ApiErrorKind.NOT_FOUND:
        return "This order no longer exists in the cloud.";
      case ApiErrorKind.CONFLICT:
        return error.code === "ORDER_ALREADY_CANCELLED"
          ? "This order was already cancelled."
          : "This order was changed just now. Review it and try again.";
      case ApiErrorKind.RATE_LIMITED:
        return "Too many requests. Wait a moment and try again.";
      case ApiErrorKind.SERVER:
        return "The cloud could not cancel this order right now. Please try again.";
      case ApiErrorKind.INVALID_RESPONSE:
        return "The cloud returned an unreadable response.";
      default:
        return "The order could not be cancelled.";
    }
  }

  async function cancelCloudOrder(orderId) {
    if (!isCloudOrderId(orderId)) return;
    if (!await cloudConfigured()) {
      alert(
        "This order lives in the cloud. Sign in and copy this till's catalog to the cloud before cancelling cloud orders.",
      );
      return;
    }

    let order;
    try {
      const detail = await orderHistoryApi.get(orderId);
      order = mapCloudOrderDetail(detail);
    } catch (error) {
      alert(describeError(error));
      return;
    }

    if (order.orderStatus === "Cancelled") {
      alert("This order is already cancelled.");
      return;
    }

    const reason = await askCancellationReason(order);
    if (reason === null) return;

    const confirmButton = dialog?.querySelector("#cloud-cancel-confirm");
    try {
      const result = await orderCancellationApi.cancel(orderId, {
        reason,
        idempotencyKey: generateIdempotencyKey(),
      });
      alert(
        result.replayed
          ? "Cancellation confirmed — it was already recorded for this order."
          : "Order cancelled. Stock was reversed and any captured payment was refunded.",
      );
      if (typeof closeInvoiceModal === "function") closeInvoiceModal();
      onCancelled?.(orderId);
    } catch (error) {
      console.warn("Cloud order cancellation failed:", error);
      alert(describeError(error));
    }
  }

  // The history rows and the invoice modal both open the cancel
  // flow through openCancelOrderModal; cloud orders take the
  // cloud path (which alerts when the cloud is not configured),
  // local orders keep the restock checklist.
  const legacyOpenCancelOrderModal = window.openCancelOrderModal;
  if (typeof legacyOpenCancelOrderModal === "function") {
    window.openCancelOrderModal = async function wrapped(orderId) {
      if (isCloudOrderId(orderId)) {
        await cancelCloudOrder(orderId);
        return;
      }
      return legacyOpenCancelOrderModal(orderId);
    };
  }

  window.cancelCloudOrder = cancelCloudOrder;

  return Object.freeze({ cancelCloudOrder });
}
