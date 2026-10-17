import { apiRequest } from "./api-client.mjs";

export function escapeFinanceText(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function money(value) { return `PKR ${(Number(value) / 100).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

export function createFinanceUI({ container, request = apiRequest, timezone = "Asia/Karachi", reportOnly = false, storage = null } = {}) {
  let page = 1, attempt = null, requestId = 0;
  function businessToday() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: typeof timezone === "function" ? timezone() : timezone,
      year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
  function message(text, error = false) {
    const node = container.querySelector("[data-message]"); node.textContent = text; node.style.color = error ? "#b91c1c" : "#166534";
  }
  async function refresh() {
    const id = ++requestId;
    const startDate = container.querySelector("[name=startDate]").value, endDate = container.querySelector("[name=endDate]").value;
    if (startDate > endDate) { message("Start date must not follow end date.", true); return; }
    message("Loading shared records…");
    const query = new URLSearchParams({ startDate, endDate, page, limit: 20 });
    try {
      if (reportOnly) {
        const report = await request(`/pos/reports/profit-loss?${query}`);
        if (id !== requestId) return;
        container.querySelector("[data-results]").innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px">${[
          ["Net sales", report.netSalesMinor], ["Cost of goods", report.costOfGoodsMinor], ["Gross profit", report.grossProfitMinor], ["Operating expenses", report.operatingExpensesMinor], ["Net profit / loss", report.netProfitMinor],
        ].map(([label, amount]) => `<article style="padding:14px;border:1px solid #cbd5e1;border-radius:8px"><strong>${label}</strong><p>${money(amount)}</p></article>`).join("")}</div>
          <p>Accrual basis: unpaid sales count as revenue. Costs use checkout snapshots; purchases enter cost of goods when sold. Restocked refunds reverse their item costs; refunds without restocking retain those costs. Pre-migration estimates need review.</p>`;
      } else {
        const [data, accounts] = await Promise.all([request(`/pos/expenses?${query}`), request("/pos/finance/accounts")]);
        if (id !== requestId) return;
        const select = container.querySelector("[name=financialAccountId]"), selected = select.value;
        select.innerHTML = accounts.accounts.map(account => `<option value="${escapeFinanceText(account.id)}">${escapeFinanceText(account.displayName)} · ${money(account.balanceMinor)}</option>`).join("");
        if (accounts.accounts.some(account => account.id === selected)) select.value = selected;
        container.querySelector("[data-results]").innerHTML = `
          <div style="display:flex; gap:14px; margin-bottom:16px; flex-wrap:wrap;">
            <div style="background:#fee2e2; border-left:4px solid #dc2626; border-radius:8px; padding:12px 18px; min-width:180px;">
              <span style="font-size:11px; font-weight:700; color:#991b1b; text-transform:uppercase; letter-spacing:0.5px;">💸 Total Expenses</span>
              <div style="font-size:20px; font-weight:800; color:#991b1b; margin-top:2px;">${money(data.totalMinor)}</div>
            </div>
            <div style="background:#f1f5f9; border-left:4px solid #64748b; border-radius:8px; padding:12px 18px; min-width:140px;">
              <span style="font-size:11px; font-weight:700; color:#475569; text-transform:uppercase; letter-spacing:0.5px;">📋 Entries</span>
              <div style="font-size:20px; font-weight:800; color:#1e293b; margin-top:2px;">${data.totalCount} records</div>
            </div>
          </div>
          <div style="overflow-x:auto; border-radius:8px; border:1px solid #e2e8f0;">
            <table class="history-table" style="width:100%; border-collapse:collapse; font-size:13px;">
              <thead>
                <tr style="background:#f8fafc; text-align:left; border-bottom:1px solid #e2e8f0;">
                  <th style="padding:10px 14px; font-weight:700; color:#475569;">Date</th>
                  <th style="padding:10px 14px; font-weight:700; color:#475569;">Category</th>
                  <th style="padding:10px 14px; font-weight:700; color:#475569;">Description</th>
                  <th style="padding:10px 14px; font-weight:700; color:#475569; text-align:right;">Amount</th>
                </tr>
              </thead>
              <tbody>${data.expenses.length ? data.expenses.map(expense => `
                <tr style="border-bottom:1px solid #f1f5f9;">
                  <td style="padding:10px 14px; color:#1e293b; font-weight:600;">${escapeFinanceText(expense.businessDate)}</td>
                  <td style="padding:10px 14px;"><span style="background:#e0e7ff; color:#3730a3; padding:2px 8px; border-radius:4px; font-weight:600; font-size:12px;">${escapeFinanceText(expense.categoryName)}</span></td>
                  <td style="padding:10px 14px; color:#64748b;">${escapeFinanceText(expense.description || "—")}</td>
                  <td style="padding:10px 14px; color:#dc2626; font-weight:700; text-align:right;">${money(expense.amountMinor)}</td>
                </tr>`).join("") : '<tr><td colspan="4" style="padding:24px; text-align:center; color:#94a3b8;">No shared expenses found for this date range.</td></tr>'}
              </tbody>
            </table>
          </div>
        `;
        container.querySelector("[data-prev]").disabled = page <= 1;
        container.querySelector("[data-next]").disabled = page * 20 >= data.totalCount;
        container.querySelector("[data-page]").textContent = `Page ${page} of ${Math.max(1, Math.ceil(data.totalCount / 20))}`;
      }
      message("Shared records updated.");
    } catch (error) { if (id === requestId) message(error.message, true); }
  }
  function mount() {
    if (!container) return;
    if (!container.dataset.mounted) {
      const today = businessToday();
      container.dataset.mounted = "true";
      container.innerHTML = `
        <div class="finance-workspace" style="background: white; border-radius: 12px; padding: 22px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); margin-bottom: 24px;">
          <div class="workspace-header finance-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px; border-bottom:1px solid #e2e8f0; padding-bottom:14px; margin-bottom:18px;">
            <div>
              <h2 style="margin:0 0 4px; font-size:22px; color:#0f172a; font-weight:700;">${reportOnly ? "📊 Profit & Loss Statement" : "💵 Expenses"}</h2>
              <p style="margin:0; font-size:14px; color:#64748b;">${reportOnly ? "Financial performance summary and cost analysis." : "Log and monitor operational expenses across all till terminals."}</p>
            </div>
            <div class="finance-date-controls" style="display:flex; align-items:center; gap:8px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:6px 12px; flex-wrap:wrap;">
              <label style="font-size:12px; font-weight:600; color:#475569; display:flex; align-items:center; gap:4px;">From: <input name="startDate" type="date" value="${today}" required style="padding:5px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:12px;"></label>
              <label style="font-size:12px; font-weight:600; color:#475569; display:flex; align-items:center; gap:4px;">To: <input name="endDate" type="date" value="${today}" required style="padding:5px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:12px;"></label>
              <button type="button" data-refresh style="padding:6px 12px; background:#0f172a; color:white; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">🔄 Refresh</button>
            </div>
          </div>
          <p data-message role="status" aria-live="polite" style="margin:0 0 14px; font-size:14px; font-weight:600;"></p>
          ${reportOnly ? "" : `
          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:16px; margin-bottom:20px;">
            <h3 style="margin:0 0 12px; font-size:14px; font-weight:700; color:#1e293b;">➕ Record New Expense</h3>
            <form data-expense style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; align-items:end;">
              <div>
                <label for="expense-categoryName" style="display:block; font-size:12px; font-weight:700; color:#475569; margin-bottom:4px;">Category</label>
                <input id="expense-categoryName" name="categoryName" required maxlength="120" placeholder="e.g. Rent, Gas, Supplies" style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;">
              </div>
              <div>
                <label for="expense-amount" style="display:block; font-size:12px; font-weight:700; color:#475569; margin-bottom:4px;">Amount (PKR)</label>
                <input id="expense-amount" name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;">
              </div>
              <div>
                <label for="expense-businessDate" style="display:block; font-size:12px; font-weight:700; color:#475569; margin-bottom:4px;">Business Date</label>
                <input id="expense-businessDate" name="businessDate" type="date" value="${today}" required style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;">
              </div>
              <div>
                <label for="expense-financialAccountId" style="display:block; font-size:12px; font-weight:700; color:#475569; margin-bottom:4px;">Paid From Account</label>
                <select id="expense-financialAccountId" name="financialAccountId" required style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; background:white;"></select>
              </div>
              <div>
                <label for="expense-description" style="display:block; font-size:12px; font-weight:700; color:#475569; margin-bottom:4px;">Description / Note</label>
                <input id="expense-description" name="description" maxlength="1000" placeholder="Optional notes" style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;">
              </div>
              <div>
                <button type="submit" style="width:100%; padding:9px 16px; background:#2563eb; color:white; border:none; border-radius:6px; font-size:13px; font-weight:700; cursor:pointer;">💾 Save Expense</button>
              </div>
            </form>
          </div>
          `}
          <div data-results></div>
          ${reportOnly ? "" : `
          <div style="display:flex; justify-content:space-between; align-items:center; margin-top:14px; padding-top:10px; border-top:1px solid #e2e8f0;">
            <div style="display:flex; gap:6px;">
              <button data-prev style="padding:5px 12px; border:1px solid #cbd5e1; background:white; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">Previous</button>
              <button data-next style="padding:5px 12px; border:1px solid #cbd5e1; background:white; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">Next</button>
            </div>
            <span data-page style="font-size:12px; color:#64748b; font-weight:600;"></span>
          </div>`}
        </div>
      `;
      container.querySelector("[data-refresh]").onclick = () => { page = 1; void refresh(); };
      if (!reportOnly) {
        container.querySelector("[data-prev]").onclick = () => { page--; void refresh(); };
        container.querySelector("[data-next]").onclick = () => { page++; void refresh(); };
        container.querySelector("[data-expense]").onsubmit = async event => {
          event.preventDefault(); const form = event.target, button = event.submitter; button.disabled = true;
          const input = { categoryName: form.elements.categoryName.value.trim(), amountMinor: Math.round(Number(form.elements.amount.value) * 100), businessDate: form.elements.businessDate.value, financialAccountId: form.elements.financialAccountId.value, description: form.elements.description.value.trim() };
          const fingerprint = JSON.stringify(input);
          try {
            if (storage) attempt = await storage.get("pos_expense_attempt");
            if (attempt && attempt.fingerprint !== fingerprint) throw new Error("Retry the unconfirmed expense with its original details before entering another expense.");
            attempt ??= { fingerprint, idempotencyKey: crypto.randomUUID() };
            if (storage) await storage.set("pos_expense_attempt", attempt);
            await request("/pos/expenses", { method: "POST", body: { ...input, idempotencyKey: attempt.idempotencyKey } });
            if (storage) await storage.set("pos_expense_attempt", null);
            attempt = null; form.elements.amount.value = ""; form.elements.description.value = ""; await refresh(); message("Expense saved in the cloud.");
          } catch (error) {
            if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
              attempt = null; if (storage) await storage.set("pos_expense_attempt", null);
            }
            message(error.message, true);
          } finally { button.disabled = false; }
        };
      }
    }
    void refresh();
  }
  return { mount, refresh };
}
