/**
 * Purchases screen — connects the POS to the
 * /api/pos/purchases and /api/pos/suppliers
 * endpoints.
 *
 * The screen manages suppliers and purchasing
 * documents: a draft purchase is created with
 * inventory lines, the server computes every
 * total, and receiving a draft adds the stock to
 * inventory through the immutable ledger.
 *
 * A received purchase is immutable: its lines are
 * rendered read-only and the edit and receive
 * actions are withdrawn. Every mutation sends a
 * fresh idempotency key and disables its submit
 * button while in flight.
 */

import {
  generateIdempotencyKey,
  inventoryApi,
  purchaseApi,
  supplierApi,
} from "./api-client.mjs";

const PAGE_SIZE = 20;

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatMinor(minor) {
  return `Rs. ${(Math.round(Number(minor) || 0) / 100).toLocaleString()}`;
}

function formatQuantity(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatDate(iso) {
  if (!iso) return "—";
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString();
}

function statusBadge(status) {
  const labels = {
    draft: '<span class="badge badge-muted">DRAFT</span>',
    received: '<span class="badge badge-ok">RECEIVED</span>',
    cancelled: '<span class="badge badge-negative">CANCELLED</span>',
  };
  return labels[status] || escapeHtml(status);
}

function emptyState(message) {
  const el = document.createElement('div');
  el.className = 'inventory-empty';
  el.textContent = message || '';
  return el;
}

function errorState(message) {
  const el = document.createElement('div');
  el.className = 'inventory-error';
  el.setAttribute('role', 'alert');
  el.textContent = message || '';
  return el;
}

function loadingState() {
  const el = document.createElement('div');
  el.className = 'inventory-loading';
  el.textContent = 'Loading...';
  return el;
}

function describeError(error) {
  if (error && error.statusCode === 409) {
    return `Conflict: ${error.message || "the resource was modified by another session."}`;
  }
  if (error && error.statusCode === 403) {
    return "You do not have permission to perform this action.";
  }
  if (error && error.statusCode === 404) {
    return "The resource was not found.";
  }
  if (error && error.category === "unreachable") {
    return "The cloud is unreachable. Check your connection and try again.";
  }
  if (error && error.category === "validation") {
    const issues = error.issues;
    if (Array.isArray(issues) && issues.length) {
      return issues.map((issue) => issue.message).join("; ");
    }
  }
  return error?.message || "An unexpected error occurred.";
}

function setError(container, message) {
  container.textContent = "";
  if (message) {
    const errorEl = document.createElement("div");
    errorEl.className = "inventory-form-error";
    errorEl.setAttribute("role", "alert");
    errorEl.textContent = message;
    container.appendChild(errorEl);
  }
}

function labeledField(labelText, inputEl, hint) {
  const wrap = document.createElement("div");
  wrap.className = "inventory-field";
  const label = document.createElement("label");
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(inputEl);
  if (hint) {
    const hintEl = document.createElement("div");
    hintEl.className = "inventory-field-hint";
    hintEl.textContent = hint;
    wrap.appendChild(hintEl);
  }
  return wrap;
}

function textInput({ value = "", type = "text", placeholder = "" } = {}) {
  const input = document.createElement("input");
  input.type = type;
  input.className = "inventory-input";
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  return input;
}

function numberInput({ value = "", min = "", step = "any" } = {}) {
  const input = document.createElement("input");
  input.type = "number";
  input.className = "inventory-input";
  input.value = value;
  if (min) input.min = min;
  input.step = step;
  return input;
}

function selectInput(options, { value = "" } = {}) {
  const select = document.createElement("select");
  select.className = "inventory-input";
  for (const option of options) {
    const optionEl = document.createElement("option");
    optionEl.value = option.value;
    optionEl.textContent = option.label;
    if (option.value === value) optionEl.selected = true;
    select.appendChild(optionEl);
  }
  return select;
}

/**
 * A confirmation dialog for destructive or
 * stock-moving actions.
 */
function confirmDialog({ title, message, confirmLabel, onConfirm }) {
  const body = document.createElement("div");
  const messageEl = document.createElement("p");
  messageEl.textContent = message;
  body.appendChild(messageEl);

  let busy = false;
  const overlay = document.createElement("div");
  overlay.className = "inventory-modal-overlay";
  const dialog = document.createElement("div");
  dialog.className = "inventory-modal";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const heading = document.createElement("h2");
  heading.className = "inventory-modal-title";
  heading.textContent = title;
  dialog.appendChild(heading);
  dialog.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "inventory-modal-actions";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "inventory-btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", close);
  footer.appendChild(cancel);

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "inventory-btn inventory-btn-primary";
  confirm.textContent = confirmLabel;
  confirm.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    confirm.disabled = true;
    try {
      await onConfirm();
      close();
    } finally {
      busy = false;
    }
  });
  footer.appendChild(confirm);
  dialog.appendChild(footer);

  overlay.appendChild(dialog);

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(event) {
    if (event.key === "Escape") close();
  }
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });

  document.body.appendChild(overlay);
}

export function createPurchasesUI({
  containerEl,
  purchases = purchaseApi,
  suppliers = supplierApi,
  inventory = inventoryApi,
} = {}) {
  const state = {
    purchaseList: [],
    nextCursor: null,
    cursorStack: [],
    status: null,
    loading: false,
    error: null,
    supplierList: [],
    suppliersLoading: false,
    suppliersError: null,
  };

  let root = null;

  function render() {
    if (!root) return;
    root.textContent = "";

    const header = document.createElement("div");
    header.className = "inventory-header";
    const title = document.createElement("h1");
    title.textContent = "Purchases";
    header.appendChild(title);

    const newButton = document.createElement("button");
    newButton.type = "button";
    newButton.className = "inventory-btn inventory-btn-primary";
    newButton.textContent = "New purchase";
    newButton.addEventListener("click", () => openPurchaseForm());
    header.appendChild(newButton);

    root.appendChild(header);

    root.appendChild(renderSuppliers());

    if (state.error) {
      root.appendChild(errorState(state.error));
    }

    const toolbar = document.createElement("div");
    toolbar.className = "inventory-toolbar";
    const statusFilter = selectInput(
      [
        { value: "", label: "All statuses" },
        { value: "draft", label: "Drafts" },
        { value: "received", label: "Received" },
        { value: "cancelled", label: "Cancelled" },
      ],
      { value: state.status || "" },
    );
    statusFilter.addEventListener("change", () => {
      state.status = statusFilter.value === "" ? null : statusFilter.value;
      state.cursorStack = [];
      state.nextCursor = null;
      loadPurchases();
    });
    toolbar.appendChild(statusFilter);
    root.appendChild(toolbar);

    if (state.loading) {
      root.appendChild(loadingState());
    } else if (state.purchaseList.length === 0) {
      root.appendChild(emptyState(
        "No purchases yet. Create a draft purchase to begin.",
      ));
    } else {
      root.appendChild(renderPurchaseTable());
      root.appendChild(renderPagination());
    }
  }

  function renderSuppliers() {
    const section = document.createElement("section");
    section.className = "inventory-suppliers";

    const header = document.createElement("div");
    header.className = "inventory-suppliers-header";
    const title = document.createElement("h2");
    title.textContent = "Suppliers";
    header.appendChild(title);

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "inventory-btn inventory-btn-sm";
    addButton.textContent = "Add supplier";
    addButton.addEventListener("click", openSupplierForm);
    header.appendChild(addButton);
    section.appendChild(header);

    if (state.suppliersLoading) {
      section.appendChild(loadingState());
      return section;
    }
    if (state.suppliersError) {
      section.appendChild(errorState(state.suppliersError));
      return section;
    }
    if (state.supplierList.length === 0) {
      section.appendChild(emptyState("No suppliers yet."));
      return section;
    }

    const list = document.createElement("ul");
    list.className = "inventory-supplier-list";
    for (const supplier of state.supplierList) {
      const row = document.createElement("li");
      row.className = "inventory-supplier-row";

      const name = document.createElement("span");
      name.className = "inventory-supplier-name";
      name.textContent = supplier.name;
      row.appendChild(name);

      const detail = document.createElement("span");
      detail.className = "inventory-supplier-detail";
      const parts = [];
      if (supplier.contactPerson) parts.push(supplier.contactPerson);
      if (supplier.phone) parts.push(supplier.phone);
      if (supplier.email) parts.push(supplier.email);
      detail.textContent = parts.join(" · ") || "—";
      row.appendChild(detail);

      const status = document.createElement("span");
      status.className = "inventory-supplier-status";
      status.textContent = supplier.isActive ? "Active" : "Inactive";
      row.appendChild(status);

      list.appendChild(row);
    }
    section.appendChild(list);
    return section;
  }

  function renderPurchaseTable() {
    const table = document.createElement("table");
    table.className = "inventory-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const column of [
      "Purchase #", "Supplier", "Date", "Status", "Subtotal",
      "Discount", "Tax", "Total", "",
    ]) {
      const th = document.createElement("th");
      th.textContent = column;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const purchase of state.purchaseList) {
      const row = document.createElement("tr");

      const numberCell = document.createElement("td");
      numberCell.textContent = purchase.purchaseNumber;
      row.appendChild(numberCell);

      const supplierCell = document.createElement("td");
      supplierCell.textContent = purchase.supplierName || "—";
      row.appendChild(supplierCell);

      const dateCell = document.createElement("td");
      dateCell.textContent = formatDate(purchase.purchaseDate);
      row.appendChild(dateCell);

      const statusCell = document.createElement("td");
      statusCell.innerHTML = statusBadge(purchase.status);
      row.appendChild(statusCell);

      const subtotalCell = document.createElement("td");
      subtotalCell.textContent = formatMinor(purchase.subtotalMinor);
      row.appendChild(subtotalCell);

      const discountCell = document.createElement("td");
      discountCell.textContent = formatMinor(purchase.discountMinor);
      row.appendChild(discountCell);

      const taxCell = document.createElement("td");
      taxCell.textContent = formatMinor(purchase.taxMinor);
      row.appendChild(taxCell);

      const totalCell = document.createElement("td");
      totalCell.textContent = formatMinor(purchase.totalMinor);
      row.appendChild(totalCell);

      const actionsCell = document.createElement("td");
      actionsCell.className = "inventory-actions";

      if (purchase.status === "draft") {
        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.className = "inventory-btn inventory-btn-sm";
        editButton.textContent = "Edit";
        editButton.addEventListener("click", () => openPurchaseForm(purchase));
        actionsCell.appendChild(editButton);

        const receiveButton = document.createElement("button");
        receiveButton.type = "button";
        receiveButton.className = "inventory-btn inventory-btn-sm inventory-btn-primary";
        receiveButton.textContent = "Receive";
        receiveButton.addEventListener("click", () => confirmReceive(purchase));
        actionsCell.appendChild(receiveButton);
      }

      const viewButton = document.createElement("button");
      viewButton.type = "button";
      viewButton.className = "inventory-btn inventory-btn-sm";
      viewButton.textContent = "View";
      viewButton.addEventListener("click", () => openPurchaseDetail(purchase));
      actionsCell.appendChild(viewButton);

      row.appendChild(actionsCell);
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    return table;
  }

  function renderPagination() {
    const nav = document.createElement("div");
    nav.className = "inventory-pagination";

    const prevButton = document.createElement("button");
    prevButton.type = "button";
    prevButton.className = "inventory-btn";
    prevButton.textContent = "Previous";
    prevButton.disabled = state.cursorStack.length === 0;
    prevButton.addEventListener("click", () => {
      if (state.cursorStack.length === 0) return;
      state.nextCursor = state.cursorStack.pop();
      loadPurchases();
    });
    nav.appendChild(prevButton);

    const nextButton = document.createElement("button");
    nextButton.type = "button";
    nextButton.className = "inventory-btn";
    nextButton.textContent = "Next";
    nextButton.disabled = !state.nextCursor;
    nextButton.addEventListener("click", () => {
      if (!state.nextCursor) return;
      state.cursorStack.push(state.nextCursor);
      loadPurchases();
    });
    nav.appendChild(nextButton);

    return nav;
  }

  async function loadPurchases() {
    state.loading = true;
    state.error = null;
    render();
    try {
      const result = await purchases.list({
        status: state.status,
        limit: PAGE_SIZE,
        cursor: state.nextCursor || undefined,
      });
      state.purchaseList = result.purchases;
      state.nextCursor = result.nextCursor;
    } catch (error) {
      state.error = describeError(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadSuppliers() {
    state.suppliersLoading = true;
    state.suppliersError = null;
    render();
    try {
      const result = await suppliers.list({ isActive: null });
      state.supplierList = result.suppliers;
    } catch (error) {
      state.suppliersError = describeError(error);
    } finally {
      state.suppliersLoading = false;
      render();
    }
  }

  /** Supplier creation form. */
  function openSupplierForm() {
    const errorContainer = document.createElement("div");

    const nameInput = textInput({ placeholder: "Supplier name" });
    const contactInput = textInput({ placeholder: "Optional" });
    const phoneInput = textInput({ placeholder: "Optional" });
    const emailInput = textInput({ placeholder: "Optional", type: "email" });
    const addressInput = textInput({ placeholder: "Optional" });
    const notesInput = textInput({ placeholder: "Optional" });

    const body = document.createElement("div");
    body.appendChild(labeledField("Name", nameInput));
    body.appendChild(labeledField("Contact person", contactInput));
    body.appendChild(labeledField("Phone", phoneInput));
    body.appendChild(labeledField("Email", emailInput));
    body.appendChild(labeledField("Address", addressInput));
    body.appendChild(labeledField("Notes", notesInput));
    body.appendChild(errorContainer);

    let busy = false;
    const modal = document.createElement("div");
    const overlay = document.createElement("div");
    overlay.className = "inventory-modal-overlay";
    const dialog = document.createElement("div");
    dialog.className = "inventory-modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const heading = document.createElement("h2");
    heading.className = "inventory-modal-title";
    heading.textContent = "Add supplier";
    dialog.appendChild(heading);
    dialog.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "inventory-modal-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "inventory-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    footer.appendChild(cancel);

    const save = document.createElement("button");
    save.type = "button";
    save.className = "inventory-btn inventory-btn-primary";
    save.textContent = "Create supplier";
    save.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      setError(errorContainer, null);
      try {
        await suppliers.create({
          name: nameInput.value,
          contactPerson: contactInput.value || null,
          phone: phoneInput.value || null,
          email: emailInput.value || null,
          address: addressInput.value || null,
          notes: notesInput.value || null,
        });
        close();
        await loadSuppliers();
      } catch (error) {
        setError(errorContainer, describeError(error));
      } finally {
        busy = false;
      }
    });
    footer.appendChild(save);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);

    function close() {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    }
    function onKey(event) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    document.body.appendChild(overlay);
    modal.appendChild(overlay);
  }

  /**
   * Purchase draft create/edit form. The server
   * computes every total; the client shows a live
   * estimate for convenience only.
   */
  async function openPurchaseForm(purchase = null) {
    const isEdit = Boolean(purchase);
    const errorContainer = document.createElement("div");

    let supplierOptions = [];
    let itemOptions = [];
    try {
      const [supplierResult, itemResult] = await Promise.all([
        suppliers.list({ isActive: true }),
        inventory.list({ limit: 200, isActive: true }),
      ]);
      supplierOptions = supplierResult.suppliers;
      itemOptions = itemResult.items;
    } catch (error) {
      errorContainer.textContent = describeError(error);
    }

    let lines = [];
    let supplierId = "";
    let invoiceNumber = "";
    let purchaseDate = "";
    let discountMinor = "";
    let taxMinor = "";
    let notes = "";

    if (isEdit) {
      try {
        const detail = await purchases.get(purchase.id);
        const current = detail.purchase;
        supplierId = current.supplierId;
        invoiceNumber = current.supplierInvoiceNumber || "";
        purchaseDate = current.purchaseDate;
        discountMinor = String(current.discountMinor);
        taxMinor = String(current.taxMinor);
        notes = current.notes || "";
        lines = detail.items.map((item) => ({
          inventoryItemId: item.inventoryItemId,
          quantity: String(item.quantity),
          unitCostMinor: String(item.unitCostMinor),
        }));
      } catch (error) {
        errorContainer.textContent = describeError(error);
        lines = [];
      }
    } else {
      purchaseDate = new Date().toISOString().slice(0, 10);
      lines = [{ inventoryItemId: "", quantity: "", unitCostMinor: "" }];
    }

    const body = document.createElement("div");
    body.appendChild(errorContainer);

    const supplierSelect = selectInput(
      supplierOptions.map((supplier) => ({
        value: supplier.id,
        label: supplier.name,
      })),
      { value: supplierId },
    );
    body.appendChild(labeledField("Supplier", supplierSelect));

    const invoiceInput = textInput({ value: invoiceNumber, placeholder: "Optional" });
    body.appendChild(labeledField("Supplier invoice #", invoiceInput));

    const dateInput = textInput({ value: purchaseDate, type: "date" });
    body.appendChild(labeledField("Purchase date", dateInput));

    const linesContainer = document.createElement("div");
    linesContainer.className = "inventory-purchase-lines";
    body.appendChild(linesContainer);

    const addLineButton = document.createElement("button");
    addLineButton.type = "button";
    addLineButton.className = "inventory-btn inventory-btn-sm";
    addLineButton.textContent = "Add line";
    body.appendChild(addLineButton);

    const discountInput = numberInput({ value: discountMinor, min: "0", step: "1" });
    body.appendChild(labeledField("Discount (minor units)", discountInput));

    const taxInput = numberInput({ value: taxMinor, min: "0", step: "1" });
    body.appendChild(labeledField("Tax (minor units)", taxInput));

    const notesInput = textInput({ value: notes, placeholder: "Optional" });
    body.appendChild(labeledField("Notes", notesInput));

    const totals = document.createElement("dl");
    totals.className = "inventory-purchase-totals";
    body.appendChild(totals);

    function renderTotals() {
      totals.textContent = "";
      const estimate = lines.reduce((sum, line) => {
        const quantity = Number(line.quantity) || 0;
        const cost = Number(line.unitCostMinor) || 0;
        return sum + Math.round(quantity * cost);
      }, 0);
      const discount = Number(discountInput.value) || 0;
      const tax = Number(taxInput.value) || 0;
      const entries = [
        ["Estimated subtotal", formatMinor(estimate)],
        ["Discount", formatMinor(discount)],
        ["Tax", formatMinor(tax)],
        ["Estimated total", formatMinor(estimate - discount + tax)],
      ];
      for (const [term, value] of entries) {
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.textContent = value;
        totals.appendChild(dt);
        totals.appendChild(dd);
      }
      const note = document.createElement("p");
      note.className = "inventory-field-hint";
      note.textContent = "The server computes the authoritative totals on save.";
      totals.appendChild(note);
    }

    function renderLines() {
      linesContainer.textContent = "";
      lines.forEach((line, index) => {
        const rowEl = document.createElement("div");
        rowEl.className = "inventory-purchase-line";

        const itemSelect = selectInput(
          itemOptions.map((item) => ({
            value: item.id,
            label: `${item.name}${item.sku ? ` (${item.sku})` : ""} — ${item.baseUnit}`,
          })),
          { value: line.inventoryItemId },
        );
        itemSelect.addEventListener("change", () => {
          line.inventoryItemId = itemSelect.value;
        });

        const quantityInput = numberInput({
          value: line.quantity,
          min: "0",
        });
        quantityInput.addEventListener("input", () => {
          line.quantity = quantityInput.value;
          renderTotals();
        });

        const costInput = numberInput({
          value: line.unitCostMinor,
          min: "0",
          step: "1",
        });
        costInput.addEventListener("input", () => {
          line.unitCostMinor = costInput.value;
          renderTotals();
        });

        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "inventory-btn inventory-btn-sm";
        removeButton.textContent = "Remove";
        removeButton.addEventListener("click", () => {
          lines.splice(index, 1);
          renderLines();
          renderTotals();
        });

        rowEl.appendChild(itemSelect);
        rowEl.appendChild(quantityInput);
        rowEl.appendChild(costInput);
        rowEl.appendChild(removeButton);
        linesContainer.appendChild(rowEl);
      });
      renderTotals();
    }

    addLineButton.addEventListener("click", () => {
      lines.push({ inventoryItemId: "", quantity: "", unitCostMinor: "" });
      renderLines();
    });

    discountInput.addEventListener("input", renderTotals);
    taxInput.addEventListener("input", renderTotals);

    renderLines();

    let busy = false;
    const overlay = document.createElement("div");
    overlay.className = "inventory-modal-overlay";
    const dialog = document.createElement("div");
    dialog.className = "inventory-modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const heading = document.createElement("h2");
    heading.className = "inventory-modal-title";
    heading.textContent = isEdit ? "Edit draft purchase" : "New draft purchase";
    dialog.appendChild(heading);
    dialog.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "inventory-modal-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "inventory-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    footer.appendChild(cancel);

    const save = document.createElement("button");
    save.type = "button";
    save.className = "inventory-btn inventory-btn-primary";
    save.textContent = isEdit ? "Save draft" : "Create draft";
    save.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      setError(errorContainer, null);
      try {
        const payload = {
          supplierId: supplierSelect.value,
          supplierInvoiceNumber: invoiceInput.value || null,
          purchaseDate: dateInput.value,
          discountMinor: discountInput.value === "" ? 0 : Number(discountInput.value),
          taxMinor: taxInput.value === "" ? 0 : Number(taxInput.value),
          notes: notesInput.value || null,
          items: lines
            .filter((line) => line.inventoryItemId && line.quantity !== "" && line.unitCostMinor !== "")
            .map((line) => ({
              inventoryItemId: line.inventoryItemId,
              quantity: Number(line.quantity),
              unitCostMinor: Number(line.unitCostMinor),
            })),
        };
        if (payload.items.length === 0) {
          setError(errorContainer, "Add at least one purchase line.");
          return;
        }
        if (isEdit) {
          await purchases.update(purchase.id, payload);
        } else {
          payload.idempotencyKey = generateIdempotencyKey();
          await purchases.create(payload);
        }
        close();
        await loadPurchases();
      } catch (error) {
        setError(errorContainer, describeError(error));
      } finally {
        busy = false;
      }
    });
    footer.appendChild(save);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);

    function close() {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    }
    function onKey(event) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    document.body.appendChild(overlay);
  }

  /** Receive a draft purchase, with confirmation. */
  function confirmReceive(purchase) {
    confirmDialog({
      title: "Receive purchase",
      message: `Receive ${purchase.purchaseNumber} from ${purchase.supplierName || "the supplier"}? This adds ${purchase.totalMinor ? formatMinor(purchase.totalMinor) : ""} of stock to inventory and records a receipt movement for every line. A received purchase cannot be edited or received again.`,
      confirmLabel: "Receive purchase",
      onConfirm: async () => {
        await purchases.receive(purchase.id, generateIdempotencyKey());
        await loadPurchases();
      },
    });
  }

  /** Read-only purchase detail with its lines. */
  async function openPurchaseDetail(purchase) {
    const body = document.createElement("div");
    body.appendChild(loadingState());

    const overlay = document.createElement("div");
    overlay.className = "inventory-modal-overlay";
    const dialog = document.createElement("div");
    dialog.className = "inventory-modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const heading = document.createElement("h2");
    heading.className = "inventory-modal-title";
    heading.textContent = `Purchase ${purchase.purchaseNumber}`;
    dialog.appendChild(heading);
    dialog.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "inventory-modal-actions";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "inventory-btn";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", close);
    footer.appendChild(closeButton);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);

    function close() {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    }
    function onKey(event) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    document.body.appendChild(overlay);

    try {
      const detail = await purchases.get(purchase.id);
      const current = detail.purchase;
      body.textContent = "";

      const summary = document.createElement("dl");
      summary.className = "inventory-purchase-totals";
      const entries = [
        ["Supplier", current.supplierName || "—"],
        ["Status", current.status],
        ["Date", formatDate(current.purchaseDate)],
        ["Invoice #", current.supplierInvoiceNumber || "—"],
        ["Subtotal", formatMinor(current.subtotalMinor)],
        ["Discount", formatMinor(current.discountMinor)],
        ["Tax", formatMinor(current.taxMinor)],
        ["Total", formatMinor(current.totalMinor)],
        ["Received at", current.receivedAt ? new Date(current.receivedAt).toLocaleString() : "—"],
      ];
      for (const [term, value] of entries) {
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.textContent = value;
        summary.appendChild(dt);
        summary.appendChild(dd);
      }
      body.appendChild(summary);

      if (detail.items.length > 0) {
        const table = document.createElement("table");
        table.className = "inventory-table";
        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const column of ["Item", "Quantity", "Unit cost", "Line total"]) {
          const th = document.createElement("th");
          th.textContent = column;
          headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        for (const item of detail.items) {
          const row = document.createElement("tr");
          const nameCell = document.createElement("td");
          nameCell.textContent = item.itemName || "—";
          row.appendChild(nameCell);
          const qtyCell = document.createElement("td");
          qtyCell.textContent = `${formatQuantity(item.quantity)} ${item.baseUnit || ""}`;
          row.appendChild(qtyCell);
          const costCell = document.createElement("td");
          costCell.textContent = formatMinor(item.unitCostMinor);
          row.appendChild(costCell);
          const totalCell = document.createElement("td");
          totalCell.textContent = formatMinor(item.lineTotalMinor);
          row.appendChild(totalCell);
          tbody.appendChild(row);
        }
        table.appendChild(tbody);
        body.appendChild(table);
      }

      if (current.status !== "draft") {
        const note = document.createElement("p");
        note.className = "inventory-field-hint";
        note.textContent = "This purchase is no longer a draft, so its lines are locked.";
        body.appendChild(note);
      }
    } catch (error) {
      body.textContent = "";
      body.appendChild(errorState(describeError(error)));
    }
  }

  async function mount() {
    if (!containerEl) return;
    root = containerEl;
    await Promise.all([loadPurchases(), loadSuppliers()]);
  }

  return {
    mount,
    render,
    loadPurchases,
    loadSuppliers,
  };
}
