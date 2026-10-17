/**
 * Sales Report UI — renders server-authoritative sales reporting dashboards,
 * date presets, trend tables, tender breakdowns, bill-wise profitability table,
 * item-level cost drill-down modal, and multi-format (CSV, Excel, PDF) exports.
 *
 * Business dates are computed in the restaurant's configured timezone so a
 * late-night local sale lands on the same calendar day the server reports
 * it on. Dates are never derived through `toISOString()`, which converts
 * to UTC and can move the date backward or forward near midnight.
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
  if (minor === null || minor === undefined) return "—";
  return `PKR ${(Math.round(Number(minor) || 0) / 100).toLocaleString("en-PK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDateInTimezone(instant, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function parseCalendarDate(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function formatCalendarDate(year, month, day) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

function shiftCalendarDate(dateStr, dayDelta) {
  const parsed = parseCalendarDate(dateStr);
  if (!parsed) return dateStr;

  const { year, month, day } = parsed;
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const dayNumber = era * 146097 + doe - 719468;

  const shifted = dayNumber + dayDelta;
  const z = shifted + 719468;
  const era2 = Math.floor(z / 146097);
  const doe2 = z - era2 * 146097;
  const yoe2 = Math.floor((doe2 - Math.floor(doe2 / 1460) + Math.floor(doe2 / 36524) - Math.floor(doe2 / 146096)) / 365);
  const y2 = yoe2 + era2 * 400;
  const doy2 = doe2 - (365 * yoe2 + Math.floor(yoe2 / 4) - Math.floor(yoe2 / 100));
  const mp = Math.floor((5 * doy2 + 2) / 153);
  const d2 = doy2 - Math.floor((153 * mp + 2) / 5) + 1;
  const m2 = mp + (mp < 10 ? 3 : -9);
  const year2 = y2 + (m2 <= 2 ? 1 : 0);

  return formatCalendarDate(year2, m2, d2);
}

export function createSalesReportUI({ containerEl, restaurantTimezone = "Asia/Karachi" } = {}) {
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

  let activeTimezone = restaurantTimezone;
  let hasObservedTimezone = false;
  let requestToken = 0;
  let lastReportData = null;
  let activeTab = "overview";

  function getPresetDates(preset) {
    const zone = activeTimezone;

    switch (preset) {
      case "yesterday": {
        const today = formatDateInTimezone(new Date(), zone);
        const y = shiftCalendarDate(today, -1);
        return { startDate: y, endDate: y };
      }
      case "last7days": {
        const today = formatDateInTimezone(new Date(), zone);
        const start = shiftCalendarDate(today, -6);
        return { startDate: start, endDate: today };
      }
      case "month": {
        const todayStr = formatDateInTimezone(new Date(), zone);
        const monthStart = `${todayStr.substring(0, 8)}01`;
        return { startDate: monthStart, endDate: todayStr };
      }
      case "today":
      default: {
        const today = formatDateInTimezone(new Date(), zone);
        return { startDate: today, endDate: today };
      }
    }
  }

  function renderSkeleton() {
    if (!containerEl) return;
    const { startDate, endDate, orderType, paymentMethod, preset } = currentFilters;
    const selectedPreset = preset || "today";

    containerEl.innerHTML = `
      <div class="report-workspace" style="font-family:system-ui,-apple-system,sans-serif; color:#1e293b; padding:8px 0; max-width:1300px; margin:0 auto;">
        <div class="workspace-header report-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:12px;">
          <div>
            <h1 style="margin:0; font-size:24px; font-weight:700; color:#0f172a;">📊 Reports</h1>
            <div class="report-heading-note" style="font-size:12px; color:#64748b; margin-top:4px;">Shared restaurant reports</div>
          </div>
          <div class="workspace-actions report-exports" style="display:flex; gap:8px; flex-wrap:wrap;">
            <button id="sales-export-btn" class="report-btn" style="padding:8px 14px; background:#059669; color:white; border:none; border-radius:6px; font-weight:600; font-size:13px; cursor:pointer; display:inline-flex; align-items:center; gap:6px;">
              📥 Export CSV
            </button>
            <button id="sales-export-xlsx-btn" class="report-btn" style="padding:8px 14px; background:#0284c7; color:white; border:none; border-radius:6px; font-weight:600; font-size:13px; cursor:pointer; display:inline-flex; align-items:center; gap:6px;">
              📊 Export Excel (.xlsx)
            </button>
            <button id="sales-export-pdf-btn" class="report-btn" style="padding:8px 14px; background:#dc2626; color:white; border:none; border-radius:6px; font-weight:600; font-size:13px; cursor:pointer; display:inline-flex; align-items:center; gap:6px;">
              📄 Export PDF
            </button>
          </div>
        </div>

        <!-- Date Controls & Filter Bar -->
        <div class="report-filters" style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin-bottom:20px; display:flex; flex-wrap:wrap; gap:12px; align-items:center;">
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button type="button" class="preset-btn${selectedPreset === "today" ? " active" : ""}" data-preset="today" style="padding:6px 12px; border:1px solid #cbd5e1; background:${selectedPreset === "today" ? "#2563eb; color:white;" : "#f8fafc;"} border-radius:6px; font-size:13px; cursor:pointer;">Today</button>
            <button type="button" class="preset-btn${selectedPreset === "yesterday" ? " active" : ""}" data-preset="yesterday" style="padding:6px 12px; border:1px solid #cbd5e1; background:${selectedPreset === "yesterday" ? "#2563eb; color:white;" : "#f8fafc;"} border-radius:6px; font-size:13px; cursor:pointer;">Yesterday</button>
            <button type="button" class="preset-btn${selectedPreset === "last7days" ? " active" : ""}" data-preset="last7days" style="padding:6px 12px; border:1px solid #cbd5e1; background:${selectedPreset === "last7days" ? "#2563eb; color:white;" : "#f8fafc;"} border-radius:6px; font-size:13px; cursor:pointer;">This Week</button>
            <button type="button" class="preset-btn${selectedPreset === "month" ? " active" : ""}" data-preset="month" style="padding:6px 12px; border:1px solid #cbd5e1; background:${selectedPreset === "month" ? "#2563eb; color:white;" : "#f8fafc;"} border-radius:6px; font-size:13px; cursor:pointer;">This Month</button>
          </div>
          <div class="report-date-range" style="display:flex; align-items:center; gap:8px;">
            <input type="date" aria-label="Report start date" id="report-start-date" value="${startDate ? startDate.replace(/"/g, "&quot;") : ""}" style="padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;">
            <span style="font-size:13px; color:#64748b;">to</span>
            <input type="date" aria-label="Report end date" id="report-end-date" value="${endDate ? endDate.replace(/"/g, "&quot;") : ""}" style="padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;">
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <select aria-label="Report order type" id="report-ordertype-filter" style="padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;">
              <option value=""${orderType === "" ? " selected" : ""}>All Order Types</option>
              <option value="dine_in"${orderType === "dine_in" ? " selected" : ""}>Dine In</option>
              <option value="takeaway"${orderType === "takeaway" ? " selected" : ""}>Takeaway</option>
              <option value="delivery"${orderType === "delivery" ? " selected" : ""}>Delivery</option>
            </select>
            <select aria-label="Report payment method" id="report-paymentmethod-filter" style="padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;">
              <option value=""${paymentMethod === "" ? " selected" : ""}>All Payment Methods</option>
              <option value="cash"${paymentMethod === "cash" ? " selected" : ""}>Cash</option>
              <option value="bank_account"${paymentMethod === "bank_account" ? " selected" : ""}>Bank Account</option>
              <option value="other"${paymentMethod === "other" ? " selected" : ""}>Other</option>
            </select>
            <button type="button" id="report-apply-btn" style="padding:6px 16px; background:#2563eb; color:white; border:none; border-radius:6px; font-weight:600; font-size:13px; cursor:pointer;">Apply Filters</button>
          </div>
        </div>

        <div class="report-tabs" role="tablist" aria-label="Report sections">
          ${[["overview", "Overview"], ["bills", "Bill Profit & Loss"], ["gross", "Gross Profit"], ["net", "Net Profit"], ["payments", "Payments & Order Types"], ["trends", "Sales Trends"]].map(([id, label]) => `<button type="button" id="report-tab-${id}" role="tab" data-report-tab="${id}" aria-controls="report-content-area" aria-selected="${activeTab === id}">${label}</button>`).join("")}
        </div>
        <div id="report-content-area" role="tabpanel" aria-labelledby="report-tab-${activeTab}">
          <div style="padding:40px; text-align:center; color:#64748b;">Loading server sales report...</div>
        </div>

        <!-- Order Cost Breakdown Modal Container -->
        <div id="report-breakdown-modal" style="display:none; position:fixed; inset:0; background:rgba(15,23,42,0.6); z-index:9999; align-items:center; justify-content:center; padding:16px;">
          <div id="report-breakdown-content" style="background:white; border-radius:10px; max-width:760px; width:100%; max-height:90vh; overflow-y:auto; box-shadow:0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04); padding:24px;">
          </div>
        </div>
      </div>
    `;
  }

  function renderReportContent(data) {
    lastReportData = data;
    const contentArea = containerEl.querySelector("#report-content-area");
    if (!contentArea) return;

    const m = data.metrics;
    const pagination = data.detailedRows?.pagination || { page: 1, limit: 50, totalRows: 0, totalPages: 0 };
    const rows = data.detailedRows?.rows || [];
    const hasProfitAccess = m.costOfGoodsMinor !== null && m.costOfGoodsMinor !== undefined;

    const provisional = m.hasIncompleteCosting ? " (known costs only)" : "";
    const statement = hasProfitAccess ? `<div class="profit-statement" data-report-section="statement"><h3 style="margin:0 0 14px">${activeTab === "net" ? "Net" : "Gross"} Profit${provisional}</h3>
        <dl><dt>Net sales after discounts and refunds</dt><dd>${formatCurrency(m.netSalesMinor)}</dd>
        <dt>Less: cost of goods sold</dt><dd>${formatCurrency(m.costOfGoodsMinor)}</dd>
        <dt>Gross profit${provisional}</dt><dd>${formatCurrency(m.grossProfitMinor)}</dd>
        ${activeTab === "net" ? `<dt>Less: period operating expenses</dt><dd>${formatCurrency(m.operatingExpensesMinor)}</dd>
        <dt>Net profit${provisional}</dt><dd>${formatCurrency(m.netProfitMinor)}</dd>` : ""}</dl>
        <p style="font-size:12px;color:#64748b;margin-bottom:0">Bill profit is net sales less recorded COGS. Operating expenses are deducted once for the reporting period, not from every bill.
        ${currentFilters.orderType || currentFilters.paymentMethod ? "This view uses filtered sales and all restaurant operating expenses in the selected period." : ""}</p></div>` : "";
    contentArea.innerHTML = `
      ${statement}
      ${m.hasIncompleteCosting ? `
        <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:12px 16px; margin-bottom:20px; color:#92400e; font-size:13px; display:flex; align-items:center; gap:8px;">
          <span style="font-size:18px;">⚠️</span>
          <div>
            <strong>Incomplete Costing Notice:</strong> ${m.incompleteCostingOrderCount} completed order(s) have missing recipe or inventory costs.
            Gross profit for these orders excludes unknown ingredient costs. Check Menu Recipe management to assign costs.
          </div>
        </div>
      ` : ""}

      <!-- Summary Cards Grid -->
      <div data-report-section="overview" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:14px; margin-bottom:24px;">
        <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
          <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Gross Sales</div>
          <div style="font-size:22px; font-weight:700; color:#0f172a; margin-top:4px;">${formatCurrency(m.grossSalesMinor)}</div>
          <div style="font-size:11px; color:#94a3b8; margin-top:4px;">Discounts: ${formatCurrency(m.discountsMinor)}</div>
        </div>
        <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
          <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Total Refunds</div>
          <div style="font-size:22px; font-weight:700; color:#dc2626; margin-top:4px;">-${formatCurrency(m.refundTotalMinor)}</div>
          <div style="font-size:11px; color:#94a3b8; margin-top:4px;">${m.refundedOrderCount} order(s) refunded</div>
        </div>
        <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
          <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Net Sales</div>
          <div style="font-size:22px; font-weight:700; color:#059669; margin-top:4px;">${formatCurrency(m.netSalesMinor)}</div>
          <div style="font-size:11px; color:#94a3b8; margin-top:4px;">${m.completedOrderCount} completed orders</div>
        </div>

        <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
          <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Completed Orders</div>
          <div style="font-size:22px; font-weight:700; color:#0f172a; margin-top:4px;">${m.completedOrderCount}</div>
          <div style="font-size:11px; color:#94a3b8; margin-top:4px;">Cancelled: ${m.cancelledOrderCount || 0}</div>
        </div>

        ${hasProfitAccess ? `
          <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
            <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">COGS</div>
            <div style="font-size:22px; font-weight:700; color:#d97706; margin-top:4px;">${formatCurrency(m.costOfGoodsMinor)}</div>
            <div style="font-size:11px; color:#94a3b8; margin-top:4px;">Cost of goods sold</div>
          </div>
          <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
            <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Gross Profit</div>
            <div style="font-size:22px; font-weight:700; color:#059669; margin-top:4px;">${formatCurrency(m.grossProfitMinor)}</div>
            <div style="font-size:11px; color:#059669; font-weight:600; margin-top:4px;">Margin: ${(m.grossMarginPercent || 0).toFixed(1)}%</div>
          </div>
          <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
            <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Net Profit</div>
            <div style="font-size:22px; font-weight:700; color:${(m.netProfitMinor || 0) >= 0 ? "#059669" : "#dc2626"}; margin-top:4px;">${formatCurrency(m.netProfitMinor)}</div>
            <div style="font-size:11px; color:#94a3b8; margin-top:4px;">OPEX: ${formatCurrency(m.operatingExpensesMinor || 0)}</div>
          </div>
        ` : `
          <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
            <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Average Order Value</div>
            <div style="font-size:22px; font-weight:700; color:#0f172a; margin-top:4px;">${formatCurrency(m.averageOrderValueMinor)}</div>
            <div style="font-size:11px; color:#94a3b8; margin-top:4px;">Per completed sale</div>
          </div>
        `}
      </div>

      <!-- Tender and Order Type Breakdowns -->
      <div data-report-section="payments" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:20px; margin-bottom:24px;">
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
                  <td style="padding:8px 6px; font-weight:600; text-transform:capitalize;">${escapeHtml(p.paymentMethod.replace(/_/g, " "))}</td>
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
                  <td style="padding:8px 6px; font-weight:600; text-transform:capitalize;">${escapeHtml(t.orderType.replace(/_/g, " "))}</td>
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
      <div data-report-section="trends" style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin-bottom:24px;">
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

      <!-- Bill-Wise Profitability Table -->
      <div data-report-section="bills" style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin-bottom:24px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
          <h3 style="margin:0; font-size:15px; font-weight:600; color:#1e293b;">📋 Detailed Sales Rows &amp; Bill-Wise Profitability</h3>
          <div style="font-size:12px; color:#64748b;">Click Drilldown on any order to inspect item-level recorded costs</div>
        </div>

        ${rows.length === 0 ? `
          <div style="padding:32px; text-align:center; color:#64748b; background:#f8fafc; border-radius:8px;">
            No orders match the selected filters.
          </div>
        ` : `
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; font-size:12.5px;">
            <thead style="background:#f8fafc; border-bottom:2px solid #cbd5e1;">
              <tr>
                <th style="padding:10px 8px; text-align:left;">Order #</th>
                <th style="padding:10px 8px; text-align:left;">Date &amp; Time</th>
                <th style="padding:10px 8px; text-align:left;">Type</th>
                <th style="padding:10px 8px; text-align:left;">Status</th>
                <th style="padding:10px 8px; text-align:right;">Total Sales</th>
                <th style="padding:10px 8px; text-align:right;">Refunded</th>
                <th style="padding:10px 8px; text-align:right;">Net Sales</th>
                ${hasProfitAccess ? `
                  <th style="padding:10px 8px; text-align:right;">COGS</th>
                  <th style="padding:10px 8px; text-align:right;">Gross Profit</th>
                  <th style="padding:10px 8px; text-align:right;">Margin %</th>
                  <th style="padding:10px 8px; text-align:center;">Cost Status</th>
                ` : ""}
                <th style="padding:10px 8px; text-align:center;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map((row) => {
                  const timeStr = row.orderedAt ? new Date(row.orderedAt).toLocaleTimeString("en-GB", { timeZone: activeTimezone, hour: "2-digit", minute: "2-digit" }) : "";
                  return `
                <tr style="border-bottom:1px solid #f1f5f9; hover-bg:#f8fafc;" class="report-order-row" data-order-id="${escapeHtml(row.id)}">
                  <td style="padding:9px 8px; font-weight:700;">#${escapeHtml(row.orderNumber)}</td>
                  <td style="padding:9px 8px; color:#64748b;">${escapeHtml(row.businessDate)} <small style="color:#94a3b8;">${escapeHtml(timeStr)}</small></td>
                  <td style="padding:9px 8px; text-transform:capitalize;">${escapeHtml(row.orderType.replace(/_/g, " "))}</td>
                  <td style="padding:9px 8px;">
                    <span style="padding:2px 6px; border-radius:4px; font-size:10.5px; font-weight:600; ${row.orderStatus === "cancelled" ? "background:#fef2f2; color:#991b1b;" : "background:#f0fdf4; color:#166534;"}">
                      ${escapeHtml(row.orderStatus)}
                    </span>
                  </td>
                  <td style="padding:9px 8px; text-align:right;">${formatCurrency(row.totalMinor)}</td>
                  <td style="padding:9px 8px; text-align:right; color:#dc2626;">${row.refundedMinor > 0 ? "-" : ""}${formatCurrency(row.refundedMinor)}</td>
                  <td style="padding:9px 8px; text-align:right; font-weight:700;">${formatCurrency(row.netMinor)}</td>
                  ${hasProfitAccess ? `
                    <td style="padding:9px 8px; text-align:right; color:#d97706;">${formatCurrency(row.cogsMinor)}</td>
                    <td style="padding:9px 8px; text-align:right; font-weight:700; color:${(row.grossProfitMinor || 0) >= 0 ? "#059669" : "#dc2626"};">${formatCurrency(row.grossProfitMinor)}</td>
                    <td style="padding:9px 8px; text-align:right; font-weight:600;">${(row.grossMarginPercent || 0).toFixed(1)}%</td>
                    <td style="padding:9px 8px; text-align:center;">
                      ${row.incompleteCosting ? `
                        <span style="background:#fffbeb; color:#b45309; padding:2px 6px; border-radius:4px; font-size:10.5px; font-weight:700;">⚠️ Incomplete</span>
                      ` : `
                        <span style="background:#f0fdf4; color:#15803d; padding:2px 6px; border-radius:4px; font-size:10.5px; font-weight:600;">✓ Verified</span>
                      `}
                    </td>
                  ` : ""}
                  <td style="padding:9px 8px; text-align:center;">
                    <button type="button" class="view-breakdown-btn" data-order-id="${escapeHtml(row.id)}" style="padding:4px 8px; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:4px; font-size:11px; font-weight:600; cursor:pointer;">
                      🔍 Drilldown
                    </button>
                  </td>
                </tr>
              `;
                })
                .join("")}
            </tbody>
            <tfoot style="background:#f8fafc; border-top:2px solid #cbd5e1; font-weight:700;">
              <tr>
                <td style="padding:10px 8px;" colspan="4">TOTALS (Filtered Dataset)</td>
                <td style="padding:10px 8px; text-align:right;">${formatCurrency(m.completedSalesMinor)}</td>
                <td style="padding:10px 8px; text-align:right; color:#dc2626;">-${formatCurrency(m.refundTotalMinor)}</td>
                <td style="padding:10px 8px; text-align:right; color:#059669;">${formatCurrency(m.netSalesMinor)}</td>
                ${hasProfitAccess ? `
                  <td style="padding:10px 8px; text-align:right; color:#d97706;">${formatCurrency(m.costOfGoodsMinor)}</td>
                  <td style="padding:10px 8px; text-align:right; color:#059669;">${formatCurrency(m.grossProfitMinor)}</td>
                  <td style="padding:10px 8px; text-align:right;">${(m.grossMarginPercent || 0).toFixed(1)}%</td>
                  <td style="padding:10px 8px;" colspan="2"></td>
                ` : `
                  <td style="padding:10px 8px;"></td>
                `}
              </tr>
            </tfoot>
          </table>
        </div>
        `}

        <!-- Pagination Controls -->
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:16px; padding-top:12px; border-top:1px solid #e2e8f0; flex-wrap:wrap; gap:8px;">
          <div style="font-size:13px; color:#64748b;" id="report-pagination-info" data-total-pages="${pagination.totalPages || 1}">
            Page ${pagination.page} of ${pagination.totalPages || 1} · ${pagination.totalRows} rows
          </div>
          <div style="display:flex; gap:8px;">
            <button type="button" id="report-prev-page" ${pagination.page <= 1 ? "disabled" : ""} style="padding:6px 14px; border:1px solid #cbd5e1; background:#f8fafc; border-radius:6px; font-size:13px; cursor:${pagination.page <= 1 ? "default" : "pointer"}; ${pagination.page <= 1 ? "opacity:0.5;" : ""}">Previous</button>
            <button type="button" id="report-next-page" ${pagination.page >= (pagination.totalPages || 1) ? "disabled" : ""} style="padding:6px 14px; border:1px solid #cbd5e1; background:#f8fafc; border-radius:6px; font-size:13px; cursor:${pagination.page >= (pagination.totalPages || 1) ? "default" : "pointer"}; ${pagination.page >= (pagination.totalPages || 1) ? "opacity:0.5;" : ""}">Next</button>
          </div>
        </div>
      </div>
    `;
    applyReportTab(hasProfitAccess);
  }

  function applyReportTab(hasProfitAccess) {
    if (!hasProfitAccess && ["bills", "gross", "net"].includes(activeTab)) activeTab = "overview";
    for (const button of containerEl.querySelectorAll("[data-report-tab]")) {
      button.hidden = !hasProfitAccess && ["bills", "gross", "net"].includes(button.dataset.reportTab);
      button.setAttribute("aria-selected", String(button.dataset.reportTab === activeTab));
      button.tabIndex = button.dataset.reportTab === activeTab ? 0 : -1;
    }
    containerEl.querySelector("#report-content-area")?.setAttribute("aria-labelledby", `report-tab-${activeTab}`);
    const visible = activeTab === "overview" ? ["overview", "payments", "trends", "bills"]
      : activeTab === "gross" ? ["statement", "bills"]
        : activeTab === "net" ? ["statement"] : [activeTab];
    for (const panel of containerEl.querySelectorAll("[data-report-section]")) panel.hidden = !visible.includes(panel.dataset.reportSection);
  }

  function renderErrorState(message) {
    const contentArea = containerEl.querySelector("#report-content-area");
    if (!contentArea) return;
    contentArea.innerHTML = `
      <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:20px; color:#991b1b; text-align:center;">
        <h3>Unable to load sales report</h3>
        <p style="font-size:14px;">${escapeHtml(message || "Cloud connection or authorization error.")}</p>
      </div>
    `;
  }

  async function showOrderDrilldown(orderId) {
    const modal = containerEl.querySelector("#report-breakdown-modal");
    const modalContent = containerEl.querySelector("#report-breakdown-content");
    if (!modal || !modalContent) return;

    modalContent.innerHTML = `<div style="text-align:center; padding:30px; color:#64748b;">Loading order #${orderId} cost breakdown...</div>`;
    modal.style.display = "flex";

    try {
      const data = await salesReportApi.getOrderCostBreakdown(orderId);
      const { order, items, isCashier } = data;

      modalContent.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px; border-bottom:1px solid #e2e8f0; padding-bottom:12px;">
          <div>
            <h2 style="margin:0; font-size:20px; color:#0f172a;">Order #${order.orderNumber} Drill-Down</h2>
            <div style="font-size:12px; color:#64748b; margin-top:4px;">
              Date: ${escapeHtml(order.businessDate)} | Type: ${escapeHtml(order.orderType)} | Status: ${escapeHtml(order.orderStatus)}
            </div>
          </div>
          <button type="button" id="close-breakdown-modal-btn" style="background:none; border:none; font-size:20px; cursor:pointer; color:#64748b; padding:4px;">✕</button>
        </div>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:10px; margin-bottom:16px;">
          <div style="background:#f8fafc; padding:10px; border-radius:6px; border:1px solid #e2e8f0;">
            <div style="font-size:10px; color:#64748b; font-weight:700;">TOTAL SALES</div>
            <div style="font-size:15px; font-weight:700; color:#0f172a;">${formatCurrency(order.totalMinor)}</div>
          </div>
          <div style="background:#f8fafc; padding:10px; border-radius:6px; border:1px solid #e2e8f0;">
            <div style="font-size:10px; color:#64748b; font-weight:700;">REFUNDED</div>
            <div style="font-size:15px; font-weight:700; color:#dc2626;">-${formatCurrency(order.refundedMinor)}</div>
          </div>
          <div style="background:#f8fafc; padding:10px; border-radius:6px; border:1px solid #e2e8f0;">
            <div style="font-size:10px; color:#64748b; font-weight:700;">NET SALES</div>
            <div style="font-size:15px; font-weight:700; color:#059669;">${formatCurrency(order.netMinor)}</div>
          </div>
          ${!isCashier ? `
            <div style="background:#f8fafc; padding:10px; border-radius:6px; border:1px solid #e2e8f0;">
              <div style="font-size:10px; color:#64748b; font-weight:700;">COGS</div>
              <div style="font-size:15px; font-weight:700; color:#d97706;">${formatCurrency(order.cogsMinor)}</div>
            </div>
            <div style="background:#f8fafc; padding:10px; border-radius:6px; border:1px solid #e2e8f0;">
              <div style="font-size:10px; color:#64748b; font-weight:700;">GROSS PROFIT</div>
              <div style="font-size:15px; font-weight:700; color:#059669;">${formatCurrency(order.grossProfitMinor)}</div>
            </div>
            <div style="background:#f8fafc; padding:10px; border-radius:6px; border:1px solid #e2e8f0;">
              <div style="font-size:10px; color:#64748b; font-weight:700;">MARGIN %</div>
              <div style="font-size:15px; font-weight:700; color:#059669;">${(order.grossMarginPercent || 0).toFixed(1)}%</div>
            </div>
          ` : ""}
        </div>

        <h4 style="margin:16px 0 8px; font-size:14px; color:#1e293b;">Order Line Items &amp; Recorded Unit Costs</h4>
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; font-size:12px;">
            <thead style="background:#f8fafc; border-bottom:1px solid #e2e8f0;">
              <tr>
                <th style="padding:8px; text-align:left;">Item Name</th>
                <th style="padding:8px; text-align:center;">Qty</th>
                <th style="padding:8px; text-align:right;">Price</th>
                <th style="padding:8px; text-align:right;">Line Total</th>
                ${!isCashier ? `
                  <th style="padding:8px; text-align:right;">Recorded Unit Cost</th>
                  <th style="padding:8px; text-align:right;">Line Cost</th>
                  <th style="padding:8px; text-align:right;">Line Profit</th>
                  <th style="padding:8px; text-align:right;">Margin %</th>
                ` : ""}
              </tr>
            </thead>
            <tbody>
              ${items.map((it) => `
                <tr style="border-bottom:1px solid #f1f5f9;">
                  <td style="padding:8px; font-weight:600;">
                    ${escapeHtml(it.itemName)}
                    ${!it.hasCost && !isCashier ? `<span style="margin-left:6px; color:#b45309; font-size:10px; background:#fffbeb; padding:1px 4px; border-radius:3px;">No Cost</span>` : ""}
                  </td>
                  <td style="padding:8px; text-align:center;">${it.quantity}</td>
                  <td style="padding:8px; text-align:right;">${formatCurrency(it.unitPriceMinor)}</td>
                  <td style="padding:8px; text-align:right; font-weight:600;">${formatCurrency(it.lineTotalMinor)}</td>
                  ${!isCashier ? `
                    <td style="padding:8px; text-align:right; color:#d97706;">${it.hasCost ? formatCurrency(it.unitCostMinor) : "—"}</td>
                    <td style="padding:8px; text-align:right; color:#d97706;">${it.hasCost ? formatCurrency(it.lineCostMinor) : "—"}</td>
                    <td style="padding:8px; text-align:right; font-weight:600; color:${(it.lineGrossProfitMinor || 0) >= 0 ? "#059669" : "#dc2626"};">
                      ${formatCurrency(it.lineGrossProfitMinor)}
                    </td>
                    <td style="padding:8px; text-align:right;">${(it.lineGrossMarginPercent || 0).toFixed(1)}%</td>
                  ` : ""}
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `;

      const closeBtn = modalContent.querySelector("#close-breakdown-modal-btn");
      if (closeBtn) {
        closeBtn.addEventListener("click", () => {
          modal.style.display = "none";
        });
      }
    } catch (err) {
      modalContent.innerHTML = `
        <div style="padding:20px; text-align:center; color:#dc2626;">
          <p>Failed to load order cost breakdown: ${escapeHtml(err.message || err)}</p>
          <button type="button" id="close-breakdown-modal-btn" style="padding:6px 14px; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:6px; cursor:pointer;">Close</button>
        </div>
      `;
      const closeBtn = modalContent.querySelector("#close-breakdown-modal-btn");
      if (closeBtn) {
        closeBtn.addEventListener("click", () => {
          modal.style.display = "none";
        });
      }
    }
  }

  async function loadReport() {
    renderSkeleton();

    const isInitialLoad = !hasObservedTimezone;

    let dates;
    if (isInitialLoad) {
      dates = { startDate: "", endDate: "" };
    } else if (currentFilters.preset === "custom") {
      dates = { startDate: currentFilters.startDate, endDate: currentFilters.endDate };
    } else {
      dates = getPresetDates(currentFilters.preset);
    }

    currentFilters.startDate = dates.startDate;
    currentFilters.endDate = dates.endDate;

    const startDateInput = containerEl.querySelector("#report-start-date");
    const endDateInput = containerEl.querySelector("#report-end-date");
    if (startDateInput) startDateInput.value = dates.startDate;
    if (endDateInput) endDateInput.value = dates.endDate;

    const myToken = ++requestToken;

    try {
      const report = await salesReportApi.getSalesReport({
        startDate: currentFilters.startDate || undefined,
        endDate: currentFilters.endDate || undefined,
        orderType: currentFilters.orderType || undefined,
        paymentMethod: currentFilters.paymentMethod || undefined,
        groupBy: currentFilters.groupBy,
        page: currentFilters.page,
        limit: currentFilters.limit,
      });

      if (myToken !== requestToken) return;

      if (report.restaurant?.timezone) {
        activeTimezone = report.restaurant.timezone;
        hasObservedTimezone = true;
      }
      if (isInitialLoad) {
        if (report.filters?.startDate) {
          currentFilters.startDate = report.filters.startDate;
        }
        if (report.filters?.endDate) {
          currentFilters.endDate = report.filters.endDate;
        }
        const startInput = containerEl.querySelector("#report-start-date");
        const endInput = containerEl.querySelector("#report-end-date");
        if (startInput) startInput.value = currentFilters.startDate;
        if (endInput) endInput.value = currentFilters.endDate;
      }

      renderReportContent(report);
      attachEventListeners();
    } catch (error) {
      if (myToken !== requestToken) return;
      console.warn("Failed to load sales report:", error);
      renderErrorState(error.message);
    }
  }

  function attachEventListeners() {
    for (const button of containerEl.querySelectorAll("[data-report-tab]")) {
      button.addEventListener("click", () => {
        activeTab = button.dataset.reportTab;
        if (lastReportData) { renderReportContent(lastReportData); attachContentEventListeners(); }
      });
      button.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const tabs = [...containerEl.querySelectorAll("[data-report-tab]")].filter(tab => !tab.hidden);
        const index = tabs.indexOf(button);
        const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
        next.click(); next.focus();
      });
    }
    // Export buttons
    const exportCsvBtn = containerEl.querySelector("#sales-export-btn") || containerEl.querySelector("#sales-export-csv-btn");
    if (exportCsvBtn) {
      exportCsvBtn.addEventListener("click", () => {
        salesReportApi.downloadSalesReportCsv({
          startDate: currentFilters.startDate,
          endDate: currentFilters.endDate,
          orderType: currentFilters.orderType || undefined,
          paymentMethod: currentFilters.paymentMethod || undefined,
        });
      });
    }

    const exportXlsxBtn = containerEl.querySelector("#sales-export-xlsx-btn");
    if (exportXlsxBtn) {
      exportXlsxBtn.addEventListener("click", () => {
        salesReportApi.downloadSalesReportXlsx({
          startDate: currentFilters.startDate,
          endDate: currentFilters.endDate,
          orderType: currentFilters.orderType || undefined,
          paymentMethod: currentFilters.paymentMethod || undefined,
        });
      });
    }

    const exportPdfBtn = containerEl.querySelector("#sales-export-pdf-btn");
    if (exportPdfBtn) {
      exportPdfBtn.addEventListener("click", () => {
        salesReportApi.downloadSalesReportPdf({
          startDate: currentFilters.startDate,
          endDate: currentFilters.endDate,
          orderType: currentFilters.orderType || undefined,
          paymentMethod: currentFilters.paymentMethod || undefined,
        });
      });
    }

    // Presets
    containerEl.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const preset = btn.getAttribute("data-preset");
        currentFilters.preset = preset;
        currentFilters.page = 1;
        loadReport();
      });
    });

    // Apply Filter Button
    const applyBtn = containerEl.querySelector("#report-apply-btn");
    if (applyBtn) {
      applyBtn.addEventListener("click", () => {
        const startInput = containerEl.querySelector("#report-start-date");
        const endInput = containerEl.querySelector("#report-end-date");
        const typeSelect = containerEl.querySelector("#report-ordertype-filter");
        const methodSelect = containerEl.querySelector("#report-paymentmethod-filter");

        currentFilters.preset = "custom";
        currentFilters.startDate = startInput?.value || currentFilters.startDate;
        currentFilters.endDate = endInput?.value || currentFilters.endDate;
        currentFilters.orderType = typeSelect?.value || "";
        currentFilters.paymentMethod = methodSelect?.value || "";
        currentFilters.page = 1;
        loadReport();
      });
    }

    attachContentEventListeners();

    // Close modal on backdrop click
    const modal = containerEl.querySelector("#report-breakdown-modal");
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.style.display = "none";
      });
    }
  }

  function attachContentEventListeners() {
    // Pagination
    const prevBtn = containerEl.querySelector("#report-prev-page");
    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        if (currentFilters.page > 1) {
          currentFilters.page -= 1;
          loadReport();
        }
      });
    }

    const nextBtn = containerEl.querySelector("#report-next-page");
    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        currentFilters.page += 1;
        loadReport();
      });
    }

    // Breakdown buttons
    containerEl.querySelectorAll(".view-breakdown-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const orderId = btn.getAttribute("data-order-id");
        if (orderId) showOrderDrilldown(orderId);
      });
    });

  }

  return Object.freeze({
    mount() {
      return loadReport();
    },
    setFilters(newFilters) {
      currentFilters = { ...currentFilters, ...newFilters };
      if (newFilters.preset !== undefined || newFilters.startDate !== undefined
          || newFilters.endDate !== undefined || newFilters.orderType !== undefined
          || newFilters.paymentMethod !== undefined || newFilters.groupBy !== undefined) {
        currentFilters.page = 1;
      }
      return loadReport();
    },
  });
}
