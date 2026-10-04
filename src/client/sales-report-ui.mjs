/**
 * Sales Report UI — renders server-authoritative sales reporting dashboards,
 * date presets, trend tables, tender breakdowns, and CSV export triggers.
 */

import {
  ApiErrorKind,
  classifyApiError,
  salesReportApi,
} from "./api-client.mjs";

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatCurrency(minor) {
  return `PKR ${(Math.round(Number(minor) || 0) / 100).toLocaleString("en-PK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function createSalesReportUI({ containerEl } = {}) {
  let currentFilters = {
    preset: "today",
    startDate: "",
    endDate: "",
    orderType: "",
    paymentMethod: "",
    groupBy: "day",
    page: 1,
    limit: 50,
  };

  function getPresetDates(preset) {
    const today = new Date();
    const formatDate = (d) => d.toISOString().substring(0, 10);

    switch (preset) {
      case "yesterday": {
        const y = new Date(today);
        y.setDate(y.getDate() - 1);
        return { startDate: formatDate(y), endDate: formatDate(y) };
      }
      case "last7days": {
        const d = new Date(today);
        d.setDate(d.getDate() - 6);
        return { startDate: formatDate(d), endDate: formatDate(today) };
      }
      case "month": {
        const start = new Date(today.getFullYear(), today.getMonth(), 1);
        return { startDate: formatDate(start), endDate: formatDate(today) };
      }
      case "today":
      default: {
        return { startDate: formatDate(today), endDate: formatDate(today) };
      }
    }
  }

  function renderSkeleton() {
    if (!containerEl) return;
    containerEl.innerHTML = `
      <div style="font-family:system-ui,-apple-system,sans-serif; color:#1e293b; padding:20px; max-width:1200px; margin:0 auto;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
          <div>
            <h1 style="margin:0; font-size:24px; font-weight:700; color:#0f172a;">📊 Sales Reports</h1>
            <div style="font-size:12px; color:#64748b; margin-top:4px;">Server-Authoritative Metrics</div>
          </div>
          <div>
            <button id="sales-export-btn" class="report-btn" style="padding:8px 16px; background:#059669; color:white; border:none; border-radius:6px; font-weight:600; cursor:pointer;">
              📥 Export CSV
            </button>
          </div>
        </div>

        <!-- Date Controls & Filter Bar -->
        <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin-bottom:20px; display:flex; flex-wrap:wrap; gap:12px; align-items:center;">
          <div style="display:flex; gap:6px;">
            <button type="button" class="preset-btn" data-preset="today" style="padding:6px 12px; border:1px solid #cbd5e1; background:#f8fafc; border-radius:6px; font-size:13px; cursor:pointer;">Today</button>
            <button type="button" class="preset-btn" data-preset="yesterday" style="padding:6px 12px; border:1px solid #cbd5e1; background:#f8fafc; border-radius:6px; font-size:13px; cursor:pointer;">Yesterday</button>
            <button type="button" class="preset-btn" data-preset="last7days" style="padding:6px 12px; border:1px solid #cbd5e1; background:#f8fafc; border-radius:6px; font-size:13px; cursor:pointer;">Last 7 Days</button>
            <button type="button" class="preset-btn" data-preset="month" style="padding:6px 12px; border:1px solid #cbd5e1; background:#f8fafc; border-radius:6px; font-size:13px; cursor:pointer;">Current Month</button>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <input type="date" id="report-start-date" style="padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;">
            <span style="font-size:13px; color:#64748b;">to</span>
            <input type="date" id="report-end-date" style="padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;">
          </div>
          <div style="display:flex; gap:8px;">
            <select id="report-ordertype-filter" style="padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;">
              <option value="">All Order Types</option>
              <option value="dine_in">Dine In</option>
              <option value="takeaway">Takeaway</option>
              <option value="delivery">Delivery</option>
            </select>
            <button type="button" id="report-apply-btn" style="padding:6px 16px; background:#2563eb; color:white; border:none; border-radius:6px; font-weight:600; font-size:13px; cursor:pointer;">Apply</button>
          </div>
        </div>

        <div id="report-content-area">
          <div style="padding:40px; text-align:center; color:#64748b;">Loading server sales report...</div>
        </div>
      </div>
    `;
  }

  function renderReportContent(data) {
    const contentArea = containerEl.querySelector("#report-content-area");
    if (!contentArea) return;

    const m = data.metrics;

    contentArea.innerHTML = `
      <!-- Summary Cards Grid -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:16px; margin-bottom:24px;">
        <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
          <div style="font-size:12px; font-weight:600; color:#64748b; text-transform:uppercase;">Gross Sales</div>
          <div style="font-size:22px; font-weight:700; color:#0f172a; margin-top:4px;">${formatCurrency(m.grossSalesMinor)}</div>
          <div style="font-size:11px; color:#94a3b8; margin-top:4px;">Disc: ${formatCurrency(m.discountsMinor)}</div>
        </div>
        <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
          <div style="font-size:12px; font-weight:600; color:#64748b; text-transform:uppercase;">Total Refunds</div>
          <div style="font-size:22px; font-weight:700; color:#dc2626; margin-top:4px;">-${formatCurrency(m.refundTotalMinor)}</div>
          <div style="font-size:11px; color:#94a3b8; margin-top:4px;">${m.refundedOrderCount} orders refunded</div>
        </div>
        <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
          <div style="font-size:12px; font-weight:600; color:#64748b; text-transform:uppercase;">Net Sales</div>
          <div style="font-size:22px; font-weight:700; color:#059669; margin-top:4px;">${formatCurrency(m.netSalesMinor)}</div>
          <div style="font-size:11px; color:#94a3b8; margin-top:4px;">Server authoritative</div>
        </div>
        <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
          <div style="font-size:12px; font-weight:600; color:#64748b; text-transform:uppercase;">Completed Orders</div>
          <div style="font-size:22px; font-weight:700; color:#0f172a; margin-top:4px;">${m.completedOrderCount}</div>
          <div style="font-size:11px; color:#94a3b8; margin-top:4px;">Avg Order: ${formatCurrency(m.averageOrderValueMinor)}</div>
        </div>
      </div>

      <!-- Tender and Order Type Breakdowns -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:20px; margin-bottom:24px;">
        <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
          <h3 style="margin:0 0 12px; font-size:15px; font-weight:600; color:#1e293b;">💳 Payment Method Breakdown</h3>
          <table style="width:100%; border-collapse:collapse; font-size:13px;">
            <thead style="background:#f8fafc; border-bottom:1px solid #e2e8f0;">
              <tr>
                <th style="padding:6px; text-align:left;">Method</th>
                <th style="padding:6px; text-align:right;">Captured</th>
                <th style="padding:6px; text-align:right;">Refunded</th>
                <th style="padding:6px; text-align:right;">Net</th>
              </tr>
            </thead>
            <tbody>
              ${(data.paymentBreakdown || [])
                .map(
                  (p) => `
                <tr style="border-bottom:1px solid #f1f5f9;">
                  <td style="padding:8px 6px; font-weight:600; text-transform:capitalize;">${escapeHtml(p.paymentMethod.replace("_", " "))}</td>
                  <td style="padding:8px 6px; text-align:right;">${formatCurrency(p.capturedMinor)}</td>
                  <td style="padding:8px 6px; text-align:right; color:#dc2626;">${p.refundedMinor > 0 ? "-" : ""}${formatCurrency(p.refundedMinor)}</td>
                  <td style="padding:8px 6px; text-align:right; font-weight:600; color:#059669;">${formatCurrency(p.netMinor)}</td>
                </tr>
              `,
                )
                .join("")}
            </tbody>
          </table>
        </div>

        <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
          <h3 style="margin:0 0 12px; font-size:15px; font-weight:600; color:#1e293b;">🛵 Order Type Breakdown</h3>
          <table style="width:100%; border-collapse:collapse; font-size:13px;">
            <thead style="background:#f8fafc; border-bottom:1px solid #e2e8f0;">
              <tr>
                <th style="padding:6px; text-align:left;">Order Type</th>
                <th style="padding:6px; text-align:center;">Count</th>
                <th style="padding:6px; text-align:right;">Total Sales</th>
              </tr>
            </thead>
            <tbody>
              ${(data.orderTypeBreakdown || [])
                .map(
                  (t) => `
                <tr style="border-bottom:1px solid #f1f5f9;">
                  <td style="padding:8px 6px; font-weight:600; text-transform:capitalize;">${escapeHtml(t.orderType.replace("_", " "))}</td>
                  <td style="padding:8px 6px; text-align:center;">${t.count}</td>
                  <td style="padding:8px 6px; text-align:right; font-weight:600;">${formatCurrency(t.totalMinor)}</td>
                </tr>
              `,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Trend Table -->
      <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin-bottom:24px;">
        <h3 style="margin:0 0 12px; font-size:15px; font-weight:600; color:#1e293b;">📈 Sales & Refund Trend</h3>
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; font-size:13px;">
            <thead style="background:#f8fafc; border-bottom:1px solid #e2e8f0;">
              <tr>
                <th style="padding:8px; text-align:left;">Date</th>
                <th style="padding:8px; text-align:center;">Orders</th>
                <th style="padding:8px; text-align:right;">Gross Sales</th>
                <th style="padding:8px; text-align:right;">Discounts</th>
                <th style="padding:8px; text-align:right;">Refunds</th>
                <th style="padding:8px; text-align:right;">Net Sales</th>
              </tr>
            </thead>
            <tbody>
              ${(data.trends || [])
                .map(
                  (tr) => `
                <tr style="border-bottom:1px solid #f1f5f9;">
                  <td style="padding:8px; font-weight:600;">${escapeHtml(tr.date)}</td>
                  <td style="padding:8px; text-align:center;">${tr.orderCount}</td>
                  <td style="padding:8px; text-align:right;">${formatCurrency(tr.grossSalesMinor)}</td>
                  <td style="padding:8px; text-align:right; color:#64748b;">${formatCurrency(tr.discountMinor)}</td>
                  <td style="padding:8px; text-align:right; color:#dc2626;">${tr.refundTotalMinor > 0 ? "-" : ""}${formatCurrency(tr.refundTotalMinor)}</td>
                  <td style="padding:8px; text-align:right; font-weight:700; color:#059669;">${formatCurrency(tr.netSalesMinor)}</td>
                </tr>
              `,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Detailed Sales Rows -->
      <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
        <h3 style="margin:0 0 12px; font-size:15px; font-weight:600; color:#1e293b;">📋 Detailed Sales Rows</h3>
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; font-size:13px;">
            <thead style="background:#f8fafc; border-bottom:1px solid #e2e8f0;">
              <tr>
                <th style="padding:8px; text-align:left;">Order #</th>
                <th style="padding:8px; text-align:left;">Date</th>
                <th style="padding:8px; text-align:left;">Type</th>
                <th style="padding:8px; text-align:left;">Status</th>
                <th style="padding:8px; text-align:left;">Payment Status</th>
                <th style="padding:8px; text-align:right;">Total</th>
                <th style="padding:8px; text-align:right;">Refunded</th>
                <th style="padding:8px; text-align:right;">Net</th>
              </tr>
            </thead>
            <tbody>
              ${(data.detailedRows?.rows || [])
                .map(
                  (row) => `
                <tr style="border-bottom:1px solid #f1f5f9;">
                  <td style="padding:8px; font-weight:600;">#${escapeHtml(row.orderNumber)}</td>
                  <td style="padding:8px; color:#64748b;">${escapeHtml(row.businessDate)}</td>
                  <td style="padding:8px; text-transform:capitalize;">${escapeHtml(row.orderType)}</td>
                  <td style="padding:8px;"><span style="padding:2px 6px; border-radius:4px; font-size:11px; font-weight:600; ${row.orderStatus === "cancelled" ? "background:#fef2f2; color:#991b1b;" : "background:#f0fdf4; color:#166534;"}">${escapeHtml(row.orderStatus)}</span></td>
                  <td style="padding:8px;"><span style="padding:2px 6px; border-radius:4px; font-size:11px; font-weight:600; ${row.paymentStatus === "refunded" ? "background:#fef2f2; color:#991b1b;" : row.paymentStatus === "partially_refunded" ? "background:#fffbeb; color:#92400e;" : "background:#f0fdf4; color:#166534;"}">${escapeHtml(row.paymentStatus)}</span></td>
                  <td style="padding:8px; text-align:right;">${formatCurrency(row.totalMinor)}</td>
                  <td style="padding:8px; text-align:right; color:#dc2626;">${row.refundedMinor > 0 ? "-" : ""}${formatCurrency(row.refundedMinor)}</td>
                  <td style="padding:8px; text-align:right; font-weight:600;">${formatCurrency(row.netMinor)}</td>
                </tr>
              `,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  async function loadReport() {
    renderSkeleton();

    const dates = currentFilters.preset === "custom"
      ? { startDate: currentFilters.startDate, endDate: currentFilters.endDate }
      : getPresetDates(currentFilters.preset);

    currentFilters.startDate = dates.startDate;
    currentFilters.endDate = dates.endDate;

    const startDateInput = containerEl.querySelector("#report-start-date");
    const endDateInput = containerEl.querySelector("#report-end-date");
    if (startDateInput) startDateInput.value = dates.startDate;
    if (endDateInput) endDateInput.value = dates.endDate;

    try {
      const report = await salesReportApi.getSalesReport({
        startDate: currentFilters.startDate,
        endDate: currentFilters.endDate,
        orderType: currentFilters.orderType || undefined,
        paymentMethod: currentFilters.paymentMethod || undefined,
        groupBy: currentFilters.groupBy,
        page: currentFilters.page,
        limit: currentFilters.limit,
      });

      renderReportContent(report);
      attachEventListeners();
    } catch (error) {
      console.warn("Failed to load sales report:", error);
      const contentArea = containerEl.querySelector("#report-content-area");
      if (contentArea) {
        contentArea.innerHTML = `
          <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:20px; color:#991b1b; text-align:center;">
            <h3>Unable to load sales report</h3>
            <p style="font-size:14px;">${escapeHtml(error.message || "Cloud connection or authorization error.")}</p>
          </div>
        `;
      }
    }
  }

  function attachEventListeners() {
    const exportBtn = containerEl.querySelector("#sales-export-btn");
    if (exportBtn) {
      exportBtn.addEventListener("click", () => {
        salesReportApi.downloadSalesReportCsv({
          startDate: currentFilters.startDate,
          endDate: currentFilters.endDate,
          orderType: currentFilters.orderType || undefined,
          paymentMethod: currentFilters.paymentMethod || undefined,
        });
      });
    }

    containerEl.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const preset = btn.getAttribute("data-preset");
        currentFilters.preset = preset;
        loadReport();
      });
    });

    const applyBtn = containerEl.querySelector("#report-apply-btn");
    if (applyBtn) {
      applyBtn.addEventListener("click", () => {
        const startInput = containerEl.querySelector("#report-start-date");
        const endInput = containerEl.querySelector("#report-end-date");
        const typeSelect = containerEl.querySelector("#report-ordertype-filter");

        currentFilters.preset = "custom";
        currentFilters.startDate = startInput?.value || currentFilters.startDate;
        currentFilters.endDate = endInput?.value || currentFilters.endDate;
        currentFilters.orderType = typeSelect?.value || "";
        loadReport();
      });
    }
  }

  return Object.freeze({
    mount() {
      return loadReport();
    },
    setFilters(newFilters) {
      currentFilters = { ...currentFilters, ...newFilters };
      return loadReport();
    },
  });
}
