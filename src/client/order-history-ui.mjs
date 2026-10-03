/**
 * Order history UI — connects the legacy history screen to
 * GET /api/pos/orders.
 *
 * When a catalog has been imported to the cloud (the CLOUD_CONTEXT_KEY
 * context exists), the history is served by the cloud API with
 * server-side search, status/payment filtering, date ranges and
 * cursor pagination. If the cloud is unreachable — or no catalog
 * was ever imported — the original local IndexedDB rendering runs
 * unchanged, so a sale or a history view never fails just because
 * the network is down.
 *
 * The legacy "Edited" filter has no server-side equivalent (the
 * list endpoint does not carry per-order edit trails), so it falls
 * back to the local ledger, which keeps the full edit trail for
 * every order this device has synced.
 */

import { orderHistoryApi } from "./api-client.mjs";
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
  let loading = false;

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

  function showError(message) {
    const errorEl = element("history-error");
    if (!errorEl) return;
    errorEl.textContent = message;
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
    const orderId = escapeHtml(order.id);
    tr.setAttribute(
      "onclick",
      `showOrderInvoiceDetailsView('${orderId}')`,
    );

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
      <td><strong>#${order.orderNumber}</strong>${order.legacyOrderId != null ? `<div style="font-size:10px;color:#94a3b8;">local #${order.legacyOrderId}</div>` : ""}</td>
      <td>${escapeHtml(order.date)} <span style="color:#94a3b8; font-size:12px; margin-left:4px;">${escapeHtml(order.time || "")}</span></td>
      <td><strong>${escapeHtml(order.customerName || "Walk-In Customer")}</strong>${order.statusReason ? `<div style="font-size:11px;color:#94a3b8;">${escapeHtml(order.statusReason)}</div>` : ""}</td>
      <td><span class="badge ${typeClass}">${escapeHtml(order.orderType)}</span>${order.orderType === "Dine-In" && order.tableNumber ? ` <span class="badge" style="background:#e0e7ff; color:#3730a3;">🪑 #${escapeHtml(order.tableNumber)}</span>` : ""}</td>
      <td style="max-width:250px; color:#94a3b8; font-size:12px;">—</td>
      <td style="font-weight:bold; color:#dc2626;">${remainingDue > 0 ? `Rs. ${remainingDue}` : '<span style="color:#94a3b8;">Rs. 0</span>'}</td>
      <td style="font-weight:bold; ${cancelled ? "text-decoration:line-through; color:#94a3b8;" : unpaid ? "color:#dc2626;" : "color:var(--text-dark);"}">Rs. ${order.totalBill}</td>
      <td style="color:#94a3b8; font-size:12px;">—</td>
      <td style="text-align:center;">${statusBadge}</td>
      <td style="text-align:center; white-space:nowrap;">
        <button type="button" class="edit-item-btn" style="margin:0; background:#0ea5e9; padding:4px 10px;" onclick="event.stopPropagation(); reprintOrderReceipt('${orderId}');">🖨️ Print</button>
        ${cancelled ? "" : `<button type="button" class="delete-item-btn" style="margin:0 0 0 4px; padding:4px 10px;" onclick="event.stopPropagation(); cancelCloudOrder('${orderId}');">❌ Cancel</button>`}
      </td>
    `;
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

  async function loadCloudHistory(append = false) {
    if (loading) return;
    loading = true;
    showLoading(true);
    hideError();
    try {
      const response = await orderHistoryApi.list(toCloudParams(readFilters()));
      const orders = (response.orders ?? []).map(mapCloudOrderSummary);
      const summary = mapCloudSummary(response.summary ?? {});
      cursor = response.nextCursor || null;

      renderRows(orders, append);
      updateSummary(summary);
      showLoadMore(Boolean(cursor));
      hideNotice();
    } finally {
      loading = false;
      showLoading(false);
    }
  }

  async function renderOrdersHistory() {
    if (await cloudConfigured()) {
      const filters = readFilters();
      if (filters.status === "Edited") {
        // The cloud list endpoint carries no per-order edit trail;
        // this device's ledger keeps the full trail for synced orders.
        showNotice(
          "Cloud history is active — the edit-history filter shows this device's local ledger.",
        );
        legacyRender();
        return;
      }
      try {
        cursor = null;
        await loadCloudHistory(false);
        return;
      } catch (error) {
        console.warn("Cloud order history unavailable:", error);
        showNotice(
          "Cloud unavailable — showing this device's local orders.",
        );
        showLoadMore(false);
      }
    }
    legacyRender();
  }

  async function loadMore() {
    if (!cursor) return;
    try {
      await loadCloudHistory(true);
    } catch (error) {
      console.warn("Cloud order history page failed:", error);
      showError("Could not load the next page. Try again.");
    }
  }

  function bind() {
    const search = element("history-search");
    if (search) {
      let debounce;
      search.addEventListener("input", () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          cursor = null;
          renderOrdersHistory();
        }, 300);
      });
    }
    ["history-date-from", "history-date-to",
      "history-payment-filter", "history-status-filter"].forEach((id) => {
      const el = element(id);
      if (el) {
        el.addEventListener("change", () => {
          cursor = null;
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
