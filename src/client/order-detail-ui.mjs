/**
 * Order detail & receipt reprint — connects the legacy invoice
 * modal and receipt printer to GET /api/pos/orders/:orderId.
 *
 * Cloud orders (UUID identifiers) are fetched from the cloud and
 * mapped onto the legacy order shape, then shown through the
 * existing modal renderer. The mapped order is swapped into the
 * local ledger only for the synchronous render and restored
 * immediately after, so the local ledger is never polluted and
 * dashboard/report totals are never double-counted.
 *
 * Local orders (numeric identifiers) keep using the original
 * local lookup, and everything works exactly as before when the
 * cloud is unreachable.
 *
 * Cloud orders are server-authoritative: local mutations
 * (editing, payment-status flips, remaining-due edits, local
 * deletion) are blocked for them — the cloud only exposes
 * cancellation as a compensating action.
 *
 * Only a genuine network failure falls back to the local
 * renderer (the order may exist in this device's ledger if
 * it was synced here). Any other API answer is a real
 * response and is surfaced to the user instead of silently
 * rendering nothing.
 */

import {
  classifyApiError,
  describeCloudError,
  orderHistoryApi,
} from "./api-client.mjs";
import {
  isCloudOrderId,
  mapCloudOrderDetail,
} from "./cloud-order-mapper.mjs";
import { CLOUD_CONTEXT_KEY } from "./legacy-cloud-adapter.mjs";

const CLOUD_MUTATION_MESSAGE =
  "This order is stored in the cloud and cannot be changed from this device. Cancel it instead if it was placed in error.";

export function createOrderDetailUI({ storage } = {}) {
  if (!storage || typeof storage.get !== "function") {
    throw new TypeError("storage must provide a get function.");
  }

  async function cloudConfigured() {
    try {
      const context = await storage.get(CLOUD_CONTEXT_KEY);
      return Boolean(context?.restaurantId);
    } catch {
      return false;
    }
  }

  async function fetchCloudOrder(orderId) {
    const detail = await orderHistoryApi.get(orderId);
    return mapCloudOrderDetail(detail);
  }

  /**
   * Runs `render` with the mapped cloud order visible to the
   * legacy renderer, then restores the ledger byte-for-byte.
   * A cloud order that was synced from this device replaces its
   * local twin (same order, authoritative snapshot); a cloud-only
   * order is appended and removed again.
   */
  function withCloudOrderVisible(mapped, render) {
    const legacyId = mapped.legacyOrderId;
    const localIndex = legacyId != null
      ? orders.findIndex((order) => order.id === legacyId)
      : -1;
    const saved = localIndex >= 0 ? orders[localIndex] : null;

    if (localIndex >= 0) {
      orders[localIndex] = mapped;
    } else {
      orders.push(mapped);
    }
    try {
      render();
    } finally {
      if (saved) {
        orders[localIndex] = saved;
      } else {
        orders.pop();
      }
    }
  }

  async function showCloudOrderDetails(orderId) {
    const mapped = await fetchCloudOrder(orderId);
    withCloudOrderVisible(mapped, () => {
      legacyShowOrderInvoiceDetailsView(mapped.id);
    });
    injectCloudRefundButton(orderId, mapped);
  }

  /**
   * Adds a "Refund" action to the invoice modal for cloud
   * orders that are completed and have a captured payment.
   * The refund modal itself re-checks the remaining
   * refundable balance, so a fully-refunded order is
   * rejected there rather than hiding the entry point.
   */
  function injectCloudRefundButton(orderId, mapped) {
    if (typeof window.openRefundModal !== "function") return;
    const modalContent = document.getElementById("invoice-modal-content");
    if (!modalContent) return;

    const status = String(mapped.orderStatus ?? "").toLowerCase();
    const payment = String(mapped.paymentStatus ?? "").toLowerCase();
    const eligible = status === "completed" && payment === "paid";
    if (!eligible) return;

    modalContent
      .querySelectorAll("[data-cloud-refund-btn]")
      .forEach((node) => node.remove());

    const printButton = Array.from(
      modalContent.querySelectorAll("button"),
    ).find((button) =>
      (button.getAttribute("onclick") || "").includes("reprintOrderReceipt"),
    );
    if (!printButton || !printButton.parentElement) return;

    const refundButton = document.createElement("button");
    refundButton.type = "button";
    refundButton.className = "clear-dates-btn";
    refundButton.setAttribute("data-cloud-refund-btn", "true");
    refundButton.addEventListener("click", (event) => {
      event.stopPropagation();
      window.openRefundModal(orderId);
    });
    refundButton.style.cssText =
      "margin: 0; padding: 8px 20px; background: #7c3aed; color: white;";
    refundButton.textContent = "↩️ Refund";
    printButton.parentElement.insertBefore(refundButton, printButton);
  }

  async function reprintCloudOrder(orderId) {
    const mapped = await fetchCloudOrder(orderId);
    await populateReceiptSlipAndPrint(mapped);
  }

  function wrapGlobal(name, handler) {
    const original = window[name];
    if (typeof original !== "function") {
      throw new TypeError(`The legacy script must define ${name}.`);
    }
    window[name] = async function wrapped(...args) {
      if (isCloudOrderId(args[0]) && await cloudConfigured()) {
        try {
          await handler(args[0]);
          return;
        } catch (error) {
          console.warn(`${name} failed for cloud order ${args[0]}:`, error);
          if (classifyApiError(error) !== "unreachable") {
            alert(describeCloudError(error));
            return;
          }
        }
      }
      return original(...args);
    };
    return original;
  }

  const legacyShowOrderInvoiceDetailsView = wrapGlobal(
    "showOrderInvoiceDetailsView",
    showCloudOrderDetails,
  );

  const legacyReprintOrderReceipt = wrapGlobal(
    "reprintOrderReceipt",
    reprintCloudOrder,
  );

  // Cloud orders are read-only outside the cancellation flow.
  ["updateOrderRemainingDue", "setInvoiceOrderPaymentStatus",
    "enterEditOrderMode", "deleteBill"].forEach((name) => {
    const original = window[name];
    if (typeof original !== "function") return;
    window[name] = function guarded(...args) {
      if (isCloudOrderId(args[0])) {
        alert(CLOUD_MUTATION_MESSAGE);
        return;
      }
      return original(...args);
    };
  });

  return Object.freeze({
    showCloudOrderDetails,
    reprintCloudOrder,
    legacyShowOrderInvoiceDetailsView,
    legacyReprintOrderReceipt,
  });
}
