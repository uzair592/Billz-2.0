/**
 * Sales Report UI — renders server-authoritative sales reporting dashboards,
 * date presets, trend tables, tender breakdowns, and CSV export triggers.
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
  return `PKR ${(Math.round(Number(minor) || 0) / 100).toLocaleString("en-PK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Formats an instant as a YYYY-MM-DD calendar day in `timeZone` using
 * the locale-aware formatter (en-CA yields ISO-like year-month-day).
 * This is the browser-side counterpart of the server's
 * businessDateInTimezone() and deliberately avoids toISOString(),
 * which would convert the instant to UTC first.
 */
function formatDateInTimezone(instant, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Parses a YYYY-MM-DD string into its calendar components. */
function parseCalendarDate(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

/** Formats calendar components back into a YYYY-MM-DD string. */
function formatCalendarDate(year, month, day) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Adds (or subtracts) whole calendar days to a YYYY-MM-DD date using
 * true calendar arithmetic via the proleptic Gregorian day-number
 * formula. This is correct across daylight-saving transitions and
 * month/year boundaries, unlike adding 24-hour instants, which can
 * skip or repeat a calendar day when the offset changes.
 *
 * The algorithm converts the date to an absolute day number (the
 * Howard Hinnant civil-from-days / days-from-civil pair), adds the
 * delta, and converts back. It never touches the clock or timezone,
 * so a DST spring-forward or fall-back cannot shift the result.
 */
function shiftCalendarDate(dateStr, dayDelta) {
  const parsed = parseCalendarDate(dateStr);
  if (!parsed) return dateStr;

  // Days from civil (Howard Hinnant's algorithm).
  const { year, month, day } = parsed;
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const dayNumber = era * 146097 + doe - 719468;

  // Civil from days.
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

  // The restaurant's configured timezone. It starts as the
  // constructor default and is replaced by the value the server
  // reports in its first response, so presets always match the
  // restaurant's own business-date calendar. Until the first
  // response arrives, the initial request omits startDate/endDate
  // entirely and lets the server resolve the restaurant's current
  // business day — the UI never assumes a timezone it has not
  // observed.
  let activeTimezone = restaurantTimezone;
  let hasObservedTimezone = false;

  // Monotonic request token: a response is only rendered when it belongs
  // to the most recent request, so a slow older request can never
  // overwrite the results of a newer filter request.
  let requestToken = 0;

  function getPresetDates(preset) {
    const zone = activeTimezone;

    switch (preset) {
      case "yesterday": {
        // Calendar-day arithmetic, correct across DST transitions.
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
        // First day of the current calendar month in the restaurant's
        // timezone, derived from the in-zone today string.
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
    // Preserve the operator's current filter selections so a
    // reload (initial load, pagination, or filter change) does
    // not reset the visible controls to their defaults.
    const { startDate, endDate, orderType, paymentMethod, preset } = currentFilters;
    const selectedPreset = preset || "today";
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
            <button type="button" class="preset-btn${selectedPreset === "today" ? " active" : ""}" data-preset="today" style="padding:6px 12px; border:1px solid #cbd5e1; background:#f8fafc; border-radius:6px; font-size:13px; cursor:pointer;">Today</button>
            <button type="button" class="preset-btn${selectedPreset === "yesterday" ? " active" : ""}" data-preset="yesterday" style="padding:6px 12px; border:1px solid #cbd5e1; background:#f8fafc; border-radius:6px; font-size:13px; cursor:pointer;">Yesterday</button>
            <button type="button" class="preset-btn${selectedPreset === "last7days" ? " active" : ""}" data-preset="last7days" style="padding:6px 12px; border:1px solid #cbd5e1; background:#f8fafc; border-radius:6px; font-size:13px; cursor:pointer;">Last 7 Days</button>
            <button type="button" class="preset-btn${selectedPreset === "month" ? " active" : ""}" data-preset="month" style="padding:6px 12px; border:1px solid #cbd5e1; background:#f8fafc; border-radius:6px; font-size:13px; cursor:pointer;">Current Month</button>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <input type="date" id="report-start-date" value="${startDate ? startDate.replace(/"/g, "&quot;") : ""}" style="padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;">
            <span style="font-size:13px; color:#64748b;">to</span>
            <input type="date" id="report-end-date" value="${endDate ? endDate.replace(/"/g, "&quot;") : ""}" style="padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;">
          </div>
          <div style="display:flex; gap:8px;">
            <select id="report-ordertype-filter" style="padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;">
              <option value=""${orderType === "" ? " selected" : ""}>All Order Types</option>
              <option value="dine_in"${orderType === "dine_in" ? " selected" : ""}>Dine In</option>
              <option value="takeaway"${orderType === "takeaway" ? " selected" : ""}>Takeaway</option>
              <option value="delivery"${orderType === "delivery" ? " selected" : ""}>Delivery</option>
            </select>
            <select id="report-paymentmethod-filter" style="padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;">
              <option value=""${paymentMethod === "" ? " selected" : ""}>All Payment Methods</option>
              <option value="cash"${paymentMethod === "cash" ? " selected" : ""}>Cash</option>
              <option value="bank_account"${paymentMethod === "bank_account" ? " selected" : ""}>Bank Account</option>
              <option value="other"${paymentMethod === "other" ? " selected" : ""}>Other</option>
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
    const pagination = data.detailedRows?.pagination || { page: 1, limit: 50, totalRows: 0, totalPages: 0 };
    const rows = data.detailedRows?.rows || [];

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
        ${rows.length === 0 ? `
          <div style="padding:32px; text-align:center; color:#64748b; background:#f8fafc; border-radius:8px;">
            No orders match the selected filters.
          </div>
        ` : `
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
              ${rows
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
        `}

        <!-- Pagination Controls -->
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:16px; padding-top:12px; border-top:1px solid #e2e8f0; flex-wrap:wrap; gap:8px;">
          <div style="font-size:13px; color:#64748b;" id="report-pagination-info">
            Page ${pagination.page} of ${pagination.totalPages || 1} · ${pagination.totalRows} rows
          </div>
          <div style="display:flex; gap:8px;">
            <button type="button" id="report-prev-page" ${pagination.page <= 1 ? "disabled" : ""} style="padding:6px 14px; border:1px solid #cbd5e1; background:#f8fafc; border-radius:6px; font-size:13px; cursor:${pagination.page <= 1 ? "default" : "pointer"}; ${pagination.page <= 1 ? "opacity:0.5;" : ""}">Previous</button>
            <button type="button" id="report-next-page" ${pagination.page >= (pagination.totalPages || 1) ? "disabled" : ""} style="padding:6px 14px; border:1px solid #cbd5e1; background:#f8fafc; border-radius:6px; font-size:13px; cursor:${pagination.page >= (pagination.totalPages || 1) ? "default" : "pointer"}; ${pagination.page >= (pagination.totalPages || 1) ? "opacity:0.5;" : ""}">Next</button>
          </div>
        </div>
      </div>
    `;
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

  async function loadReport() {
    renderSkeleton();

    // On the very first load — before the restaurant's timezone
    // has been observed from any server response — omit the dates
    // entirely and let the server resolve the restaurant's current
    // business day in its own timezone. The UI must not assume
    // Asia/Karachi (or any other zone) for a restaurant that may
    // be configured differently. Once the first response arrives,
    // hasObservedTimezone flips and subsequent loads compute dates
    // in the observed zone.
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

    // Capture this request's token; only the newest token may render.
    const myToken = ++requestToken;

    try {
      const report = await salesReportApi.getSalesReport({
        // Omit startDate/endDate on the initial load so the server
        // applies its own business-day default.
        startDate: currentFilters.startDate || undefined,
        endDate: currentFilters.endDate || undefined,
        orderType: currentFilters.orderType || undefined,
        paymentMethod: currentFilters.paymentMethod || undefined,
        groupBy: currentFilters.groupBy,
        page: currentFilters.page,
        limit: currentFilters.limit,
      });

      // Stale-response suppression: a slower older request must not
      // overwrite the results of a newer filter request.
      if (myToken !== requestToken) return;

      // Adopt the restaurant's configured timezone from the
      // response so subsequent preset calculations use the
      // server's business calendar.
      if (report.restaurant?.timezone) {
        activeTimezone = report.restaurant.timezone;
        hasObservedTimezone = true;
      }
      // Only adopt the server-resolved filter dates when the
      // request omitted them (the initial load). When the
      // operator chose an explicit range or preset, the
      // response's dates merely echo the request and must not
      // overwrite the operator's selection.
      if (isInitialLoad) {
        if (report.filters?.startDate) {
          currentFilters.startDate = report.filters.startDate;
        }
        if (report.filters?.endDate) {
          currentFilters.endDate = report.filters.endDate;
        }
        // Reflect the server-resolved dates in the visible inputs.
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
        // Any filter change resets to the first page.
        currentFilters.page = 1;
        loadReport();
      });
    });

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
        // Date / order-type / payment-method changes reset to page 1.
        currentFilters.page = 1;
        loadReport();
      });
    }

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
        const totalPages = containerEl.querySelector("#report-pagination-info")?.dataset?.totalPages;
        currentFilters.page += 1;
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
      // Filter changes reset to the first page.
      if (newFilters.preset !== undefined || newFilters.startDate !== undefined
          || newFilters.endDate !== undefined || newFilters.orderType !== undefined
          || newFilters.paymentMethod !== undefined || newFilters.groupBy !== undefined) {
        currentFilters.page = 1;
      }
      return loadReport();
    },
  });
}
