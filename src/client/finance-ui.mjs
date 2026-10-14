import { apiRequest } from "./api-client.mjs";

export function escapeFinanceText(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function money(value) { return `PKR ${(Number(value) / 100).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

export function createFinanceUI({ container, request = apiRequest, timezone = "Asia/Karachi", reportOnly = false, storage = null } = {}) {
  let page = 1, attempt = null, requestId = 0;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
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
        container.querySelector("[data-results]").innerHTML = `<p><strong>Expenses: ${money(data.totalMinor)}</strong> · ${data.totalCount} records</p><div style="overflow:auto"><table class="history-table"><thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th></tr></thead><tbody>${data.expenses.length ? data.expenses.map(expense => `<tr><td>${escapeFinanceText(expense.businessDate)}</td><td>${escapeFinanceText(expense.categoryName)}</td><td>${escapeFinanceText(expense.description)}</td><td>${money(expense.amountMinor)}</td></tr>`).join("") : '<tr><td colspan="4">No shared expenses in this period.</td></tr>'}</tbody></table></div>`;
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
      container.dataset.mounted = "true";
      container.innerHTML = `<h2>${reportOnly ? "Cloud profit & loss" : "Cloud expenses"}</h2><p>Shared across restaurant devices. ${reportOnly ? "Server financial totals for the selected business dates." : "Record an expense once; retries keep the same reference until confirmed. Existing local expenses require reconciliation before entering them here."}</p>
        <div style="display:flex;flex-wrap:wrap;gap:12px"><label>From<input name="startDate" type="date" value="${today}" required></label><label>To<input name="endDate" type="date" value="${today}" required></label><button type="button" data-refresh>Refresh</button></div><p data-message role="status" aria-live="polite"></p>
        ${reportOnly ? "" : `<form data-expense style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;align-items:end"><label>Category<input name="categoryName" required maxlength="120" placeholder="e.g. Rent"></label><label>Amount (PKR)<input name="amount" type="number" min="0.01" step="0.01" required></label><label>Business date<input name="businessDate" type="date" value="${today}" required></label><label>Paid from<select name="financialAccountId" required></select></label><label>Description<input name="description" maxlength="1000"></label><button type="submit">Save expense</button></form>`}
        <div data-results></div>${reportOnly ? "" : '<div style="display:flex;gap:12px;align-items:center;margin-top:12px"><button data-prev>Previous</button><span data-page></span><button data-next>Next</button></div>'}`;
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
