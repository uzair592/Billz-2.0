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
 */

import { orderHistoryApi } from "./api-client.mjs";
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
