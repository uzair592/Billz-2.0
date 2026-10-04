/**
 * Order refund UI — connects the order detail interface to
 * POST /api/pos/orders/:orderId/refunds and GET /api/pos/orders/:orderId/refunds.
 *
 * Implements item selection, quantity pickers, restock options, refund reason,
 * live preview, double-submit protection, idempotency key preservation on retries,
 * and clear offline failure messaging.
 */

import {
  ApiErrorKind,
  classifyApiError,
  generateIdempotencyKey,
  orderHistoryApi,
  orderRefundApi,
} from "./api-client.mjs";
import { isCloudOrderId } from "./cloud-order-mapper.mjs";
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
  return `PKR ${(Math.round(Number(minor) || 0) / 100).toFixed(2)}`;
}

export function createOrderRefundUI({ storage, onRefunded } = {}) {
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

  function describeRefundError(error) {
    switch (classifyApiError(error)) {
      case ApiErrorKind.UNREACHABLE:
        return "You're offline. Cloud refunds require an active server connection. Local checkout operations continue normally.";
      case ApiErrorKind.AUTHENTICATION:
        return "Your session has expired. Please sign in again to create a refund.";
      case ApiErrorKind.AUTHORIZATION:
        return "You do not have permission to refund orders for this restaurant.";
      case ApiErrorKind.SUBSCRIPTION:
        return "An active subscription is required to process cloud refunds.";
      case ApiErrorKind.VALIDATION:
        return error.message || "Invalid refund parameters. Please check the quantities and reason.";
      case ApiErrorKind.NOT_FOUND:
        return "The order or item was not found in the cloud.";
      case ApiErrorKind.CONFLICT:
        if (error.code === "IDEMPOTENCY_PAYLOAD_MISMATCH") {
          return "This idempotency key was previously submitted with a different refund request.";
        }
        if (error.code === "AMOUNT_EXCEEDS_REFUNDABLE" || error.code === "QUANTITY_EXCEEDS_REFUNDABLE") {
          return error.message || "Refund request exceeds the remaining refundable balance or quantity.";
        }
        return error.message || "Order refund conflict. The order was modified by another user.";
      case ApiErrorKind.RATE_LIMITED:
        return "Too many requests. Please wait a moment and try again.";
      case ApiErrorKind.SERVER:
        return "Server error while processing refund. Please try again.";
      default:
        return error.message || "An unexpected error occurred while processing the refund.";
    }
  }

  /**
   * Opens the refund modal for a cloud order.
   */
  async function openRefundModal(orderId) {
    if (!isCloudOrderId(orderId)) {
      alert("Partial refunds are supported for cloud orders. Local orders keep their existing local behaviour.");
      return;
    }

    if (!(await cloudConfigured())) {
      alert("Cloud connection is required to process refunds. Please sign in first.");
      return;
    }

    let detail;
    let existingRefunds = [];
    try {
      detail = await orderHistoryApi.get(orderId);
      existingRefunds = await orderRefundApi.listRefunds(orderId);
    } catch (error) {
      alert(describeRefundError(error));
      return;
    }

    const order = detail.order;
    if (order.orderStatus === "cancelled") {
      alert("This order is cancelled and cannot be refunded.");
      return;
    }

    const orderTotalMinor = Number(order.totalMinor);
    const totalRefundedSoFar = existingRefunds.reduce(
      (sum, r) => sum + Number(r.totalRefundedMinor),
      0,
    );
    const remainingRefundableMinor = Math.max(0, orderTotalMinor - totalRefundedSoFar);

    if (remainingRefundableMinor <= 0) {
      alert("This order is already fully refunded.");
      return;
    }

    // Map item previous refunds
    const prevItemRefundsMap = new Map();
    for (const r of existingRefunds) {
      for (const item of r.items || []) {
        const prev = prevItemRefundsMap.get(item.orderItemId) || 0;
        prevItemRefundsMap.set(item.orderItemId, prev + Number(item.quantity));
      }
    }

    const items = (detail.items || []).map((item) => {
      const origQty = Number(item.quantity);
      const refundedQty = prevItemRefundsMap.get(item.id) || 0;
      const availableQty = Math.max(0, origQty - refundedQty);
      return {
        id: item.id,
        name: item.name,
        unitPriceMinor: Number(item.unitPriceMinor),
        lineTotalMinor: Number(item.lineTotalMinor),
        origQty,
        refundedQty,
        availableQty,
        selectedQty: 0,
        restock: true,
      };
    });

    closeDialog();

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "cloud-refund-modal-overlay";
    overlay.style.cssText =
      "position:fixed; inset:0; background:rgba(15,23,42,0.6); display:flex; align-items:center; justify-content:center; z-index:1050; padding:16px;";

    overlay.innerHTML = `
      <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="refund-modal-title"
           style="background:white; border-radius:12px; padding:24px; max-width:640px; width:100%; box-shadow:0 25px 50px -12px rgba(0,0,0,0.25); max-height:90vh; overflow-y:auto;">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #e2e8f0; padding-bottom:12px; margin-bottom:16px;">
          <div>
            <h2 id="refund-modal-title" style="margin:0; font-size:20px; color:#0f172a;">
              ↩️ Refund Order #${escapeHtml(order.orderNumber)}
            </h2>
            <div style="font-size:12px; color:#64748b; margin-top:2px;">
              Original Total: ${formatMinor(orderTotalMinor)} | Remaining Refundable: <strong style="color:#059669;" id="remaining-refundable-text">${formatMinor(remainingRefundableMinor)}</strong>
            </div>
          </div>
          <button type="button" id="refund-close-btn" style="background:none; border:none; font-size:24px; cursor:pointer; color:#64748b;">&times;</button>
        </div>

        <div style="margin-bottom:16px;">
          <h3 style="font-size:14px; margin:0 0 8px; color:#334155;">Select Items to Refund</h3>
          <div style="border:1px solid #e2e8f0; border-radius:8px; overflow:hidden;">
            <table style="width:100%; border-collapse:collapse; font-size:13px; text-align:left;">
              <thead style="background:#f8fafc; border-bottom:1px solid #e2e8f0; color:#475569;">
                <tr>
                  <th style="padding:8px 12px;">Item</th>
                  <th style="padding:8px 12px; text-align:center;">Avail / Sold</th>
                  <th style="padding:8px 12px; text-align:center;">Refund Qty</th>
                  <th style="padding:8px 12px; text-align:center;">Restock</th>
                </tr>
              </thead>
              <tbody id="refund-items-tbody">
                ${items
                  .map(
                    (item, idx) => `
                  <tr style="border-bottom:1px solid #f1f5f9;">
                    <td style="padding:10px 12px;">
                      <div style="font-weight:600; color:#1e293b;">${escapeHtml(item.name)}</div>
                      <div style="font-size:11px; color:#64748b;">${formatMinor(item.unitPriceMinor)} each</div>
                    </td>
                    <td style="padding:10px 12px; text-align:center; color:#475569;">
                      ${item.availableQty} / ${item.origQty}
                    </td>
                    <td style="padding:10px 12px; text-align:center;">
                      <input type="number" min="0" max="${item.availableQty}" step="1" value="0"
                             data-index="${idx}" class="refund-qty-input"
                             ${item.availableQty <= 0 ? "disabled" : ""}
                             style="width:64px; padding:6px; border:1px solid #cbd5e1; border-radius:6px; text-align:center; font-size:14px;">
                    </td>
                    <td style="padding:10px 12px; text-align:center;">
                      <input type="checkbox" data-index="${idx}" class="refund-restock-checkbox" checked
                             ${item.availableQty <= 0 ? "disabled" : ""}>
                    </td>
                  </tr>
                `,
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>

        <div style="background:#f8fafc; border-radius:8px; padding:12px 16px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <span style="font-size:13px; color:#64748b;">Estimated Refund Amount:</span>
          </div>
          <div>
            <strong id="refund-preview-amount" style="font-size:18px; color:#2563eb;">PKR 0.00</strong>
          </div>
        </div>

        <div style="margin-bottom:16px;">
          <label for="refund-reason-input" style="display:block; font-size:13px; font-weight:600; color:#334155; margin-bottom:4px;">
            Refund Reason <span style="color:#dc2626;">*</span>
          </label>
          <input type="text" id="refund-reason-input" placeholder="e.g. Wrong order item, quality issue, customer return"
                 maxlength="200" required
                 style="width:100%; padding:8px 12px; border:1px solid #cbd5e1; border-radius:6px; font-size:14px; box-sizing:border-box;">
        </div>

        <div style="margin-bottom:20px;">
          <label for="refund-notes-input" style="display:block; font-size:13px; font-weight:600; color:#334155; margin-bottom:4px;">
            Notes (Optional)
          </label>
          <textarea id="refund-notes-input" placeholder="Additional details..." rows="2" maxlength="500"
                    style="width:100%; padding:8px 12px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; box-sizing:border-box; resize:vertical;"></textarea>
        </div>

        <div id="refund-error-msg" style="display:none; background:#fef2f2; border:1px solid #fecaca; color:#991b1b; padding:10px 12px; border-radius:6px; font-size:13px; margin-bottom:16px;"></div>

        <div style="display:flex; justify-content:flex-end; gap:12px;">
          <button type="button" id="refund-cancel-btn"
                  style="padding:9px 18px; background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; border-radius:6px; font-weight:600; cursor:pointer;">
            Cancel
          </button>
          <button type="button" id="refund-submit-btn" disabled
                  style="padding:9px 24px; background:#2563eb; color:white; border:none; border-radius:6px; font-weight:600; cursor:pointer; opacity:0.6;">
            Confirm Refund
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    dialog = overlay;

    const qtyInputs = overlay.querySelectorAll(".refund-qty-input");
    const restockCheckboxes = overlay.querySelectorAll(".refund-restock-checkbox");
    const reasonInput = overlay.querySelector("#refund-reason-input");
    const notesInput = overlay.querySelector("#refund-notes-input");
    const previewAmountEl = overlay.querySelector("#refund-preview-amount");
    const submitBtn = overlay.querySelector("#refund-submit-btn");
    const cancelBtn = overlay.querySelector("#refund-cancel-btn");
    const closeBtn = overlay.querySelector("#refund-close-btn");
    const errorMsgEl = overlay.querySelector("#refund-error-msg");

    // Track active logical attempt's idempotency key so retries preserve the same key
    let attemptIdempotencyKey = generateIdempotencyKey();
    let submitting = false;

    function updatePreview() {
      let calcSubtotalMinor = 0;
      qtyInputs.forEach((inputEl) => {
        const idx = Number(inputEl.getAttribute("data-index"));
        const qty = Math.max(0, Number(inputEl.value) || 0);
        items[idx].selectedQty = qty;

        if (qty > 0) {
          const rawSub = Math.round(items[idx].unitPriceMinor * qty);
          calcSubtotalMinor += rawSub;
        }
      });

      restockCheckboxes.forEach((chk) => {
        const idx = Number(chk.getAttribute("data-index"));
        items[idx].restock = chk.checked;
      });

      // Apply proportional discount and charge scaling
      const orderSub = Number(order.subtotalMinor) || 1;
      const orderDisc = Number(order.discountMinor) || 0;
      const orderCharge = Number(order.additionalChargesMinor) || 0;

      const estDiscountMinor = orderSub > 0 ? Math.floor((calcSubtotalMinor * orderDisc) / orderSub) : 0;
      const estChargeMinor = orderSub > 0 ? Math.floor((calcSubtotalMinor * orderCharge) / orderSub) : 0;
      const estTotalMinor = calcSubtotalMinor - estDiscountMinor + estChargeMinor;

      previewAmountEl.textContent = formatMinor(estTotalMinor);

      const isValidReason = Boolean(reasonInput.value.trim());
      const hasSelectedItems = calcSubtotalMinor > 0;

      if (isValidReason && hasSelectedItems) {
        submitBtn.disabled = false;
        submitBtn.style.opacity = "1";
      } else {
        submitBtn.disabled = true;
        submitBtn.style.opacity = "0.6";
      }
    }

    qtyInputs.forEach((el) => el.addEventListener("input", updatePreview));
    restockCheckboxes.forEach((el) => el.addEventListener("change", updatePreview));
    reasonInput.addEventListener("input", updatePreview);

    cancelBtn.addEventListener("click", closeDialog);
    closeBtn.addEventListener("click", closeDialog);

    submitBtn.addEventListener("click", async () => {
      if (submitting) return;

      errorMsgEl.style.display = "none";

      const selectedItems = items
        .filter((i) => i.selectedQty > 0)
        .map((i) => ({
          orderItemId: i.id,
          quantity: i.selectedQty,
          restock: i.restock,
        }));

      if (selectedItems.length === 0) {
        errorMsgEl.textContent = "Please select at least one item quantity to refund.";
        errorMsgEl.style.display = "block";
        return;
      }

      const reason = reasonInput.value.trim();
      if (!reason) {
        errorMsgEl.textContent = "A refund reason is required.";
        errorMsgEl.style.display = "block";
        return;
      }

      // Lock UI during submit
      submitting = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "Processing...";

      try {
        const result = await orderRefundApi.createRefund(
          orderId,
          {
            items: selectedItems,
            reason,
            notes: notesInput.value.trim() || undefined,
          },
          attemptIdempotencyKey,
        );

        closeDialog();

        const msg = result.replayed
          ? `Refund ${result.refund.refundNumber} was replayed successfully (amount: ${formatMinor(result.refund.totalRefundedMinor)}).`
          : `Refund ${result.refund.refundNumber} completed successfully (${formatMinor(result.refund.totalRefundedMinor)}).`;
        alert(msg);

        if (typeof onRefunded === "function") {
          onRefunded(orderId, result);
        }
      } catch (error) {
        console.warn("Refund attempt failed:", error);
        errorMsgEl.textContent = describeRefundError(error);
        errorMsgEl.style.display = "block";

        submitBtn.disabled = false;
        submitBtn.textContent = "Confirm Refund";

        // Keep attemptIdempotencyKey unchanged so retrying the same attempt sends the same key!
      } finally {
        submitting = false;
      }
    });
  }

  return Object.freeze({
    openRefundModal,
    describeRefundError,
  });
}
