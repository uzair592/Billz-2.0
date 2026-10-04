/**
 * Order history UI — connects the legacy history screen to
 * GET /api/pos/orders.
 *
 * When a catalog has been imported to the cloud (the CLOUD_CONTEXT_KEY
 * context exists), the history is served by the cloud API with
 * server-side search, status/payment filtering, date ranges and
 * cursor pagination.
 *
 * Fallback rules:
 *  * no cloud context, or a genuine network failure (the cloud
 *    is unreachable) — the original local IndexedDB rendering runs
 *    unchanged, so a sale or a history view never fails just
 *    because the network is down;
 *  * any other API answer (401, 402, 403, 404, 409, 422, 429,
 *    5xx, malformed response) is a real response, not an outage —
 *    it is shown as a user-facing error and the local ledger is
 *    never presented as if it were cloud history.
 *
 * The legacy "Edited" filter has no server-side equivalent (the
 * list endpoint does not carry per-order edit trails), so it falls
 * back to the local ledger, which keeps the full edit trail for
 * every order this device has synced.
 *
 * Requests are sequenced: a filter change supersedes an in-flight
 * request, so a slow earlier response can never overwrite newer
 * results, and appended pages are de-duplicated by order id.
 */

import {
  ApiErrorKind,
  classifyApiError,
  describeCloudError,
  isRetriableApiError,
  orderHistoryApi,
} from "./api-client.mjs";
import {
  isCloudOrderId,
  mapCloudOrderSummary,
  mapCloudSummary,
} from "./cloud-order-mapper.mjs";
import { CLOUD_CONTEXT_KEY } from "./legacy-cloud-adapter.mjs";

const PAGE_SIZE = 50;

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function createOrderHistoryUI({
  storage,
  legacyRender,
} = {}) {
  if (!storage || typeof storage.get !== "function") {
    throw new TypeError("storage must provide a get function.");
  }
  if (typeof legacyRender !== "function") {
    throw new TypeError("legacyRender must be a function.");
  }

  let cursor = null;
  let loadingMore = false;
  let requestSequence = 0;
  let renderedOrderIds = new Set();

  async function cloudConfigured() {
    try {
      const context = await storage.get(CLOUD_CONTEXT_KEY);
      return Boolean(context?.restaurantId);
    } catch {
      return false;
    }
  }

  function element(id) {
    return document.getElementById(id);
  }

  function readFilters() {
    return {
      search: element("history-search")?.value?.trim() || null,
      from: element("history-date-from")?.value || null,
      to: element("history-date-to")?.value || null,
      payment: element("history-payment-filter")?.value || "All",
      status: element("history-status-filter")?.value || "All",
    };
  }

  function toCloudParams(filters) {
    const params = { limit: PAGE_SIZE };
    if (filters.search) params.search = filters.search;
    if (filters.from) params.from = filters.from;
    if (filters.to) params.to = filters.to;
    if (filters.payment === "Paid") params.paymentStatus = "paid";
    if (filters.payment === "Unpaid") params.paymentStatus = "unpaid";
    if (filters.status === "Completed") params.orderStatus = "completed";
    if (filters.status === "Cancelled") params.orderStatus = "cancelled";
    if (cursor) params.cursor = cursor;
    return params;
  }

  function showNotice(message) {
    const notice = element("history-cloud-notice");
    if (!notice) return;
    notice.textContent = message;
    notice.classList.remove("hidden");
  }

  function hideNotice() {
    element("history-cloud-notice")?.classList.add("hidden");
  }

  function showError(message, { retry } = {}) {
    const errorEl = element("history-error");
    if (!errorEl) return;
    errorEl.innerHTML = "";
    const text = document.createElement("span");
    text.textContent = message;
    errorEl.appendChild(text);
    if (retry) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Retry";
      button.className = "history-retry-btn";
      button.addEventListener("click", retry);
      errorEl.appendChild(button);
    }
    errorEl.classList.remove("hidden");
  }

  function hideError() {
    element("history-error")?.classList.add("hidden");
  }

  function showLoading(show) {
    element("history-loader")?.classList.toggle("hidden", !show);
  }

  function updateSummary(summary) {
    const countEl = element("history-results-count-text");
    if (countEl) {
      countEl.innerText = `${summary.orderCount} order${
        summary.orderCount === 1 ? "" : "s"
      } found${summary.cancelledCount ? ` (${summary.cancelledCount} cancelled)` : ""}`;
    }
    const salesEl = element("filtered-sales-amount");
    if (salesEl) {
      const visible = typeof isSalesVisible === "undefined"
        || isSalesVisible;
      salesEl.innerText = visible
        ? `Rs. ${summary.sales.toLocaleString()}`
        : "Rs. ****";
    }
  }

  function createOrderRow(order) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";

    const cancelled = order.orderStatus === "Cancelled";
    const unpaid = order.paymentStatus === "Unpaid";
    const paymentBadge = unpaid
      ? `<span class="badge badge-unpaid">❌ Unpaid</span>`
      : `<span class="badge badge-paid">✅ Paid</span>`;
    const statusBadge = cancelled
      ? `<span class="badge" style="background:#fee2e2; color:#991b1b;">❌ Cancelled</span>`
      : paymentBadge;

    if (cancelled) {
      tr.style.background = "#f8fafc";
      tr.style.opacity = "0.7";
    }

    const remainingDue = unpaid ? order.totalBill : 0;
    const typeClass = order.orderType === "Dine-In"
      ? "badge-dinein"
      : order.orderType === "Delivery"
        ? "badge-delivery"
        : "badge-takeaway";

    tr.innerHTML = `
      <td><strong>#${escapeHtml(String(order.orderNumber))}</strong>${order.legacyOrderId != null ? `<div style="font-size:10px;color:#94a3b8;">local #${escapeHtml(String(order.legacyOrderId))}</div>` : ""}</td>
      <td>${escapeHtml(order.date)} <span style="color:#94a3b8; font-size:12px; margin-left:4px;">${escapeHtml(order.time || "")}</span></td>
      <td><strong>${escapeHtml(order.customerName || "Walk-In Customer")}</strong>${order.statusReason ? `<div style="font-size:11px;color:#94a3b8;">${escapeHtml(order.statusReason)}</div>` : ""}</td>
      <td><span class="badge ${typeClass}">${escapeHtml(order.orderType)}</span>${order.orderType === "Dine-In" && order.tableNumber ? ` <span class="badge" style="background:#e0e7ff; color:#3730a3;">🪑 #${escapeHtml(order.tableNumber)}</span>` : ""}</td>
      <td style="max-width:250px; color:#94a3b8; font-size:12px;">—</td>
      <td style="font-weight:bold; color:#dc2626;">${remainingDue > 0 ? `Rs. ${remainingDue}` : '<span style="color:#94a3b8;">Rs. 0</span>'}</td>
      <td style="font-weight:bold; ${cancelled ? "text-decoration:line-through; color:#94a3b8;" : unpaid ? "color:#dc2626;" : "color:var(--text-dark);"}">Rs. ${escapeHtml(String(order.totalBill))}</td>
      <td style="color:#94a3b8; font-size:12px;">—</td>
      <td style="text-align:center;">${statusBadge}</td>
      <td style="text-align:center; white-space:nowrap;">
        <button type="button" class="edit-item-btn history-reprint-btn" style="margin:0; background:#0ea5e9; padding:4px 10px;">🖨️ Print</button>
        ${cancelled ? "" : `<button type="button" class="delete-item-btn history-cancel-btn" style="margin:0 0 0 4px; padding:4px 10px;">❌ Cancel</button>`}
      </td>
    `;

    // Event listeners instead of inline handlers: order ids and
    // names can never leak into a JavaScript string literal.
    tr.addEventListener("click", () => {
      window.showOrderInvoiceDetailsView(order.id);
    });
    tr.querySelector(".history-reprint-btn")?.addEventListener("click", (event) => {
      event.stopPropagation();
      window.reprintOrderReceipt(order.id);
    });
    tr.querySelector(".history-cancel-btn")?.addEventListener("click", (event) => {
      event.stopPropagation();
      window.cancelCloudOrder(order.id);
    });
    return tr;
  }

  function renderRows(orders, append) {
    const tbody = element("history-orders-rows");
    if (!tbody) return;
    if (!append) tbody.innerHTML = "";
    if (orders.length === 0 && !append) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; color:gray; padding:20px;">No matching transaction orders found.</td></tr>`;
      return;
    }
    orders.forEach((order) => tbody.appendChild(createOrderRow(order)));
  }

  function showLoadMore(hasMore) {
    element("history-load-more")?.classList.toggle("hidden", !hasMore);
  }

  /**
   * A genuine network failure is the only condition under which
   * the local ledger may stand in for cloud history.
   */
  function handleHistoryError(error) {
    if (classifyApiError(error) === ApiErrorKind.UNREACHABLE) {
      renderedOrderIds = new Set();
      showNotice("Cloud unavailable — showing this device's local orders.");
      showLoadMore(false);
      legacyRender();
      return;
    }
    console.warn("Cloud order history failed:", error);
    showError(describeCloudError(error), {
      retry: isRetriableApiError(error) ? renderOrdersHistory : null,
    });
    showLoadMore(false);
  }

  async function renderOrdersHistory() {
    if (!(await cloudConfigured())) {
      legacyRender();
      return;
    }

    const filters = readFilters();
    if (filters.status === "Edited") {
      // The cloud list endpoint carries no per-order edit trail;
      // this device's ledger keeps the full trail for synced orders.
      renderedOrderIds = new Set();
      showNotice(
        "Cloud history is active — the edit-history filter shows this device's local ledger.",
      );
      legacyRender();
      return;
    }

    // A newer request supersedes any in-flight one, so a slow
    // earlier response can never overwrite newer filter results.
    const sequence = (requestSequence += 1);
    cursor = null;
    showLoading(true);
    hideError();
    try {
      const response = await orderHistoryApi.list(toCloudParams(filters));
      if (sequence !== requestSequence) return;
      const orders = (response.orders ?? []).map(mapCloudOrderSummary);
      const summary = mapCloudSummary(response.summary ?? {});
      cursor = response.nextCursor || null;
      renderedOrderIds = new Set(orders.map((order) => order.id));
      renderRows(orders, false);
      updateSummary(summary);
      showLoadMore(Boolean(cursor));
      hideNotice();
    } catch (error) {
      if (sequence !== requestSequence) return;
      handleHistoryError(error);
    } finally {
      if (sequence === requestSequence) showLoading(false);
    }
  }

  async function loadMore() {
    if (!cursor || loadingMore) return;
    loadingMore = true;
    const sequence = (requestSequence += 1);
    showLoading(true);
    hideError();
    try {
      const response = await orderHistoryApi.list(toCloudParams(readFilters()));
      if (sequence !== requestSequence) return;
      const orders = (response.orders ?? []).map(mapCloudOrderSummary);
      const summary = mapCloudSummary(response.summary ?? {});
      cursor = response.nextCursor || null;
      // The same order can appear on overlapping cursor pages;
      // never render a row twice.
      const fresh = orders.filter((order) => !renderedOrderIds.has(order.id));
      fresh.forEach((order) => renderedOrderIds.add(order.id));
      renderRows(fresh, true);
      updateSummary(summary);
      showLoadMore(Boolean(cursor));
    } catch (error) {
      if (sequence !== requestSequence) return;
      console.warn("Cloud order history page failed:", error);
      showError(describeCloudError(error), {
        retry: isRetriableApiError(error) ? loadMore : null,
      });
    } finally {
      if (sequence === requestSequence) {
        loadingMore = false;
        showLoading(false);
      }
    }
  }

  function bind() {
    const search = element("history-search");
    if (search) {
      let debounce;
      search.addEventListener("input", () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          renderOrdersHistory();
        }, 300);
      });
    }
    ["history-date-from", "history-date-to",
      "history-payment-filter", "history-status-filter"].forEach((id) => {
      const el = element(id);
      if (el) {
        el.addEventListener("change", () => {
          renderOrdersHistory();
        });
      }
    });
    const loadMoreBtn = element("history-load-more-btn");
    if (loadMoreBtn) loadMoreBtn.addEventListener("click", loadMore);
  }

  bind();

  return Object.freeze({
    renderOrdersHistory,
    loadMore,
    isCloudOrderId,
  });
}
