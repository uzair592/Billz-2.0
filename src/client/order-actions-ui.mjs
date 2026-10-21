import { orderActionsApi, orderHistoryApi, menuApi, describeCloudError } from "./api-client.mjs";
import { escapeFinanceText as escapeHtml } from "./finance-ui.mjs";
import { CLOUD_CONTEXT_KEY } from "./legacy-cloud-adapter.mjs";

export function paymentMinor(value) {
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error("Enter an amount with up to two decimal places.");
  const minor = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error("Enter an amount greater than zero.");
  return minor;
}
export function remainingPayment(detail) {
  const paid = (detail.payments || []).filter(row => row.status === "captured")
    .reduce((sum,row) => sum + Number(row.amountMinor), 0);
  return Math.max(0, Number(detail.order.totalMinor) - paid);
}
function money(value) { return `Rs. ${(Number(value) / 100).toLocaleString("en-PK", {minimumFractionDigits:2,maximumFractionDigits:2})}`; }
function actionError(error) {
  const messages = {
    ORDER_ALREADY_PAID: "This bill is already paid. Close and reopen it to see the latest payment.",
    ORDER_VERSION_CONFLICT: "Another device changed this bill. Close and reopen it before editing.",
    ORDER_NOT_EDITABLE: "This bill is no longer an unpaid open order. Use Refund or Cancel Order for a paid bill.",
    ORDER_CANCELLED: "This bill was cancelled. No payment was taken.",
    HISTORICAL_ORDER_READ_ONLY: "This restored bill needs payment reconciliation. Ask your restaurant owner.",
    PAYMENT_EXCEEDS_REMAINING: "Another payment changed the balance. Reopen the bill to see the amount still due.",
    PAYMENT_ACCOUNT_REQUIRED: "Ask the owner to set up an active cash or bank account.",
    INVALID_PAYMENT_ACCOUNT: "Choose an active account for the selected payment method.",
    IDEMPOTENCY_CONFLICT: "This retry belongs to different changes. Close and reopen this bill.",
  };
  return messages[error.code] || (error.status !== undefined ? describeCloudError(error) : error.message);
}

export function createOrderActionsUI({ storage, onUpdated = () => {} } = {}) {
  let dialog = null, opening = false;
  const actionNames = { setInvoiceOrderPaymentStatus:"payment", updateOrderRemainingDue:"payment", enterEditOrderMode:"edit", deleteBill:"cancel" };
  async function retryKey(orderId, operation) {
    const context = await storage.get(CLOUD_CONTEXT_KEY);
    const restaurantId = await globalThis.BiteTechCloudSession?.activeRestaurant?.() || context?.restaurantId;
    if (!restaurantId) throw new Error("Sign in and select your restaurant before continuing.");
    return `pos_order_action:${restaurantId}:${orderId}:${operation}`;
  }
  function close() { dialog?.remove(); dialog = null; }
  function frame(title, subtitle) {
    close();
    const overlay = document.createElement("div");
    overlay.className = "order-action-overlay";
    overlay.innerHTML = `<section class="order-action-dialog" role="dialog" aria-modal="true" aria-labelledby="order-action-title">
      <header><div><h2 id="order-action-title">${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div><button type="button" data-back aria-label="Close">×</button></header>
      <p data-message role="status" aria-live="polite"></p><div data-body></div></section>`;
    const previousFocus = document.activeElement;
    overlay.querySelector("[data-back]").onclick = () => { close(); previousFocus?.focus(); };
    overlay.addEventListener("keydown", event => {
      if (event.key === "Escape" && !overlay.dataset.busy) { close(); previousFocus?.focus(); }
      if (event.key === "Tab") {
        const focusable = [...overlay.querySelectorAll('button,input,select,[tabindex="0"]')].filter(node => !node.disabled && !node.hidden);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    document.body.append(overlay); dialog = overlay;
    overlay.querySelector("[data-back]").focus();
    return overlay;
  }
  async function send(overlay, key, orderId, operation, payload) {
    if (overlay.dataset.busy) return;
    overlay.dataset.busy = "true";
    const controls = [...overlay.querySelectorAll("input,select,button")];
    controls.forEach(node => { node.disabled = true; });
    const message = overlay.querySelector("[data-message]");
    try {
      let attempt = await storage.get(key);
      if (!attempt) {
        attempt = { payload: {...payload,idempotencyKey:crypto.randomUUID()} };
        await storage.set(key, attempt);
      }
      message.textContent = "Saving…";
      if (operation === "payment") await orderActionsApi.pay(orderId, attempt.payload);
      else await orderActionsApi.amend(orderId, attempt.payload);
      await storage.set(key, null);
      close();
      await onUpdated(orderId);
      await window.showOrderInvoiceDetailsView(orderId);
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && ![408,429].includes(error.status)) {
        await storage.set(key, null);
      }
      message.textContent = actionError(error);
      message.setAttribute("role", "alert");
      const pending = await storage.get(key);
      if (pending) {
        message.textContent += " Payment or changes may already be saved. Press Retry to confirm; they will not be recorded twice.";
        const submit = overlay.querySelector('[type="submit"]');
        if (submit) submit.textContent = "Retry safely";
        // Freeze the original values while the outcome is uncertain.
        controls.filter(node => node.matches("[data-back], [type=submit]")).forEach(node => { node.disabled = false; });
      } else controls.forEach(node => { node.disabled = false; });
    } finally { delete overlay.dataset.busy; }
  }
  function pendingForm(overlay, key, orderId, operation) {
    overlay.querySelector("[data-body]").innerHTML = `<p>A previous save was interrupted. Confirm its result before starting another change.</p>
      <form><button type="submit" class="order-action-primary">Retry safely</button></form>`;
    overlay.querySelector("form").onsubmit = event => { event.preventDefault(); void send(overlay,key,orderId,operation); };
  }
  async function openPayment(orderId) {
    const [detail,key] = await Promise.all([orderHistoryApi.get(orderId),retryKey(orderId,"payment")]);
    const pending = await storage.get(key);
    const due = remainingPayment(detail);
    if (!pending && (detail.order.restored || detail.order.orderStatus === "cancelled" || due <= 0 || detail.actions?.canPay === false)) {
      throw new Error(detail.order.restored ? "Ask the owner to reconcile this restored bill." : due <= 0 ? "This bill is already paid." : "You cannot take payment for this bill.");
    }
    const overlay = frame(`Take Payment · Bill #${detail.order.orderNumber}`, `${detail.order.customerName || "Walk-in customer"} · Remaining ${money(due)}`);
    if (pending) { pendingForm(overlay,key,orderId,"payment"); return; }
    const result = await orderActionsApi.paymentAccounts();
    const accounts = result.accounts || [];
    overlay.querySelector("[data-body]").innerHTML = `<form>
      <label for="order-payment-amount">Amount received (Rs.)</label><input id="order-payment-amount" name="amount" type="number" min="0.01" step="0.01" max="${due/100}" value="${(due/100).toFixed(2)}" required>
      <label for="order-payment-method">Payment method</label><select id="order-payment-method" name="method"><option value="cash">Cash</option><option value="bank_account">Bank account</option></select>
      <label for="order-payment-account">Receive into</label><select id="order-payment-account" name="account"></select>
      <p>Enter a smaller amount for a partial payment. The remaining balance stays due.</p>
      <button type="submit" class="order-action-primary">Record Payment</button></form>`;
    const form = overlay.querySelector("form");
    function accountOptions() {
      const type = form.elements.method.value === "cash" ? "cash" : "bank";
      form.elements.account.innerHTML = accounts.filter(row=>row.accountType===type)
        .map(row=>`<option value="${escapeHtml(row.id)}">${escapeHtml(row.displayName)}</option>`).join("")
        || (type === "cash" ? '<option value="">Main cash account</option>' : '<option value="">No bank account available</option>');
      form.elements.account.required = type === "bank";
    }
    accountOptions(); form.elements.method.onchange = accountOptions;
    form.onsubmit = event => {
      event.preventDefault();
      try {
        const amountMinor = paymentMinor(form.elements.amount.value);
        if (amountMinor > due) throw new Error("The payment cannot exceed the remaining balance.");
        void send(overlay,key,orderId,"payment",{amountMinor,paymentMethod:form.elements.method.value,
          ...(form.elements.account.value ? {financialAccountId:form.elements.account.value} : {})});
      } catch (error) { overlay.querySelector("[data-message]").textContent = error.message; }
    };
    form.elements.amount.focus(); form.elements.amount.select();
  }
  async function openEdit(orderId) {
    const [detail,key] = await Promise.all([orderHistoryApi.get(orderId),retryKey(orderId,"edit")]);
    const pending = await storage.get(key);
    if (!pending && (detail.order.restored || detail.actions?.canEdit === false || detail.order.paymentStatus !== "unpaid"
        || ["completed","cancelled"].includes(detail.order.orderStatus))) {
      throw new Error("Only unpaid open orders can be edited. Use Refund or Cancel Order for a paid bill.");
    }
    const overlay = frame(`Edit Order · Bill #${detail.order.orderNumber}`, "Change items before payment. Existing prices stay unchanged.");
    if (pending) { pendingForm(overlay,key,orderId,"edit"); return; }
    const catalog = await menuApi.list();
    const lines = detail.items.map(row=>({orderItemId:row.id,name:row.name,quantity:row.quantity}));
    overlay.querySelector("[data-body]").innerHTML = `<form>
      <div class="order-action-fields"><div><label for="order-edit-name">Customer name</label><input id="order-edit-name" name="customerName" maxlength="160" value="${escapeHtml(detail.order.customerName || "")}"></div>
      <div><label for="order-edit-phone">Phone (optional)</label><input id="order-edit-phone" name="customerPhone" type="tel" maxlength="40" value="${escapeHtml(detail.order.customerPhone || "")}"></div></div>
      <h3>Items</h3><div data-lines></div>
      <label for="order-edit-add">Add a menu item</label><div class="order-action-add"><select id="order-edit-add"><option value="">Choose an item</option>${(catalog.items||[]).map(row=>`<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)}</option>`).join("")}</select><button type="button" data-add>Add item</button></div>
      <div class="order-action-fields"><div><label for="order-edit-discount-type">Discount type</label><select id="order-edit-discount-type" name="discountType"><option value="flat">Rupees</option><option value="percent">Percent</option></select></div>
      <div><label for="order-edit-discount">Discount</label><input id="order-edit-discount" name="discount" type="number" min="0" step="0.01" value="${detail.order.discountType === "percent" ? Number(detail.order.discountValue)||0 : Number(detail.order.discountMinor)/100}" required></div>
      <div><label for="order-edit-delivery">Delivery charges (Rs.)</label><input id="order-edit-delivery" name="delivery" type="number" min="0" step="0.01" value="${Number(detail.order.deliveryMinor)/100}" required></div></div>
      <p>The saved bill will show the recalculated total. Item changes are sent to the kitchen as ADD / REMOVE instructions.</p>
      <button type="submit" class="order-action-primary">Save Changes</button></form>`;
    const form = overlay.querySelector("form");
    form.elements.discountType.value = detail.order.discountType === "percent" ? "percent" : "flat";
    function renderLines() {
      overlay.querySelector("[data-lines]").innerHTML = lines.map((line,index)=>`<div class="order-action-line"><span>${escapeHtml(line.name)}</span>
        <input type="number" min="1" max="999" step="1" value="${Number(line.quantity)}" data-index="${index}" aria-label="Quantity for ${escapeHtml(line.name)}" required>
        <button type="button" data-remove="${index}" aria-label="Remove ${escapeHtml(line.name)}">Remove</button></div>`).join("");
      form.querySelector('[type="submit"]').disabled = lines.length === 0;
      overlay.querySelectorAll("[data-index]").forEach(node=>node.oninput=()=>{lines[Number(node.dataset.index)].quantity=Number(node.value);});
      overlay.querySelectorAll("[data-remove]").forEach(node=>node.onclick=()=>{lines.splice(Number(node.dataset.remove),1);renderLines();});
    }
    renderLines();
    overlay.querySelector("[data-add]").onclick = () => {
      const item = (catalog.items||[]).find(row=>row.id===overlay.querySelector("#order-edit-add").value);
      if (item) { lines.push({menuItemId:item.id,name:item.name,quantity:1});renderLines(); }
    };
    form.onsubmit = event => {
      event.preventDefault();
      const percent = form.elements.discountType.value === "percent";
      const discount = Number(form.elements.discount.value), delivery = Number(form.elements.delivery.value);
      if (!Number.isFinite(discount) || discount < 0 || (percent && discount > 100) || !Number.isFinite(delivery) || delivery < 0) return;
      void send(overlay,key,orderId,"edit",{expectedVersion:detail.order.version,
        customerName:form.elements.customerName.value.trim(),customerPhone:form.elements.customerPhone.value.trim(),
        items:lines.map(({orderItemId,menuItemId,quantity})=>({...(orderItemId ? {orderItemId} : {menuItemId}),quantity})),
        discount:percent?{type:"percent",value:discount}:{type:"flat",valueMinor:Math.round(discount*100)},deliveryMinor:Math.round(delivery*100)});
    };
    form.elements.customerName.focus();
  }
  async function handle(name,orderId,status) {
    if (opening) return;
    opening = true;
    try {
      if (name === "setInvoiceOrderPaymentStatus" && status === "Unpaid") throw new Error("Use Refund to reverse a payment. A received payment cannot be erased.");
      const operation = actionNames[name] || name;
      if (operation === "cancel") await window.cancelCloudOrder(orderId);
      else if (operation === "edit") await openEdit(orderId);
      else await openPayment(orderId);
    } catch (error) { alert(actionError(error)); }
    finally { opening = false; }
  }
  async function decorate(orderId, detail) {
    const modal = document.getElementById("invoice-modal-content");
    if (!modal) return;
    // Replace device-only toggles with the allowed server actions, including for served KOTs.
    for (const node of modal.querySelectorAll("button")) {
      const handler = node.getAttribute("onclick") || "";
      if (/setInvoiceOrderPaymentStatus|updateOrderRemainingDue|enterEditOrderMode|deleteBill|openCancelOrderModal/.test(handler)) node.remove();
      if (/closeInvoiceModal/.test(handler) && /Complete/.test(node.textContent)) node.textContent = "Close";
    }
    const dueInput = modal.querySelector("#invoice-remaining-due-input");
    dueInput?.closest("[style*='background: #fef2f2']")?.remove();
    modal.querySelectorAll("[data-order-actions], [data-order-status]").forEach(node=>node.remove());
    const status = document.createElement("p"); status.dataset.orderStatus = "true";
    const labels = {new:"New",preparing:"In preparation",ready:"Ready",served:"Served",completed:"Completed",cancelled:"Cancelled"};
    status.className = "order-action-status";
    status.textContent = `${labels[detail.order.orderStatus] || "Order"} · Payment: ${detail.order.paymentStatus.replaceAll("_"," ")}`;
    modal.prepend(status);
    const bar = document.createElement("div"); bar.dataset.orderActions = "true"; bar.className = "order-action-bar";
    const raw = detail.order;
    const pendingPayment = await storage.get(await retryKey(orderId,"payment"));
    const pendingEdit = await storage.get(await retryKey(orderId,"edit"));
    const active = !raw.restored && raw.orderStatus !== "cancelled";
    function button(label,operation,primary=false) {
      const node = document.createElement("button");node.type="button";node.textContent=label;
      node.dataset.orderAction=operation;if(primary)node.className="order-action-primary";
      node.onclick=()=>{void handle(operation,orderId);};bar.append(node);
    }
    if (pendingPayment || (active && remainingPayment(detail)>0 && detail.actions?.canPay!==false)) button(pendingPayment?"Check previous payment":"Take Payment","payment",true);
    if (pendingEdit || (active && !["completed","cancelled"].includes(raw.orderStatus) && raw.paymentStatus === "unpaid" && detail.actions?.canEdit!==false)) button(pendingEdit?"Check previous changes":"Edit Order","edit");
    if (active && detail.actions?.canCancel!==false) button("Cancel Order","cancel");
    modal.append(bar);
  }
  return Object.freeze({handle,decorate});
}
