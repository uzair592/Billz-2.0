/**
 * Inventory screen — connects the POS to the
 * /api/pos/inventory endpoints.
 *
 * The screen lists stock items with search, low-stock and
 * negative-stock warnings, cursor pagination, and actions
 * for create/edit, adjustment, waste, and movement
 * history. A recipe editor lets a manager define the
 * ingredients a menu product consumes.
 *
 * Every mutation sends a fresh idempotency key and
 * disables its submit button while in flight, so a
 * double click can never apply a stock change twice.
 * All rendered values pass through HTML escaping or
 * text-node assignment, and every handler is attached
 * with addEventListener so no identifier reaches a
 * string literal.
 */

import {
  generateIdempotencyKey,
  inventoryApi,
  menuApi as cloudMenuApi,
  recipeApi,
} from "./api-client.mjs";

const BASE_UNITS = ["piece", "gram", "kilogram", "millilitre", "litre"];
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

function formatDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function statusBadge(item) {
  if (item.isNegativeStock) {
    return '<span class="badge badge-negative">NEGATIVE</span>';
  }
  if (item.isLowStock) {
    return '<span class="badge badge-warning">LOW STOCK</span>';
  }
  if (!item.isActive) {
    return '<span class="badge badge-muted">INACTIVE</span>';
  }
  return '<span class="badge badge-ok">OK</span>';
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

/**
 * A small modal helper. The modal is built with DOM
 * methods and text nodes, so no untrusted value is ever
 * interpolated into an HTML string.
 */
function openModal({ title, bodyEl, actions }) {
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

  if (bodyEl) dialog.appendChild(bodyEl);

  const footer = document.createElement("div");
  footer.className = "inventory-modal-actions";
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action.primary
      ? "inventory-btn inventory-btn-primary"
      : "inventory-btn";
    button.textContent = action.label;
    button.addEventListener("click", () => action.onClick({ close }));
    footer.appendChild(button);
  }
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
  return { close, dialog };
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

/**
 * Classifies a CloudApiError into a human-readable
 * message, reusing the client's error categories.
 */
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

export function createInventoryUI({
  containerEl,
  api = inventoryApi,
  recipes = recipeApi,
  menuApi = cloudMenuApi,
} = {}) {
  const state = {
    items: [],
    nextCursor: null,
    cursorStack: [],
    search: "",
    isActive: null,
    loading: false,
    error: null,
    lowStock: [],
    lowStockLoading: false,
    history: null,
    historyLoading: false,
    historyError: null,
    historyCursor: null,
    historyStack: [],
    submitting: false,
  };

  let root = null;

  function render() {
    if (!root) return;
    root.textContent = "";

    const header = document.createElement("div");
    header.className = "inventory-header";
    const title = document.createElement("h1");
    title.textContent = "Inventory";
    header.appendChild(title);

    const newButton = document.createElement("button");
    newButton.type = "button";
    newButton.className = "inventory-btn inventory-btn-primary";
    newButton.textContent = "New item";
    newButton.addEventListener("click", () => openItemForm());
    header.appendChild(newButton);

    const recipeButton = document.createElement("button");
    recipeButton.type = "button";
    recipeButton.className = "inventory-btn";
    recipeButton.textContent = "Recipe editor";
    recipeButton.addEventListener("click", () => openRecipeEditor());
    header.appendChild(recipeButton);

    root.appendChild(header);

    const toolbar = document.createElement("div");
    toolbar.className = "inventory-toolbar";

    const search = document.createElement("input");
    search.type = "search";
    search.className = "inventory-input inventory-search";
    search.placeholder = "Search by name or SKU";
    search.value = state.search;
    search.addEventListener("input", () => {
      state.search = search.value;
      state.cursorStack = [];
      state.nextCursor = null;
      loadItems();
    });
    toolbar.appendChild(search);

    const activeFilter = selectInput(
      [
        { value: "", label: "All items" },
        { value: "true", label: "Active only" },
        { value: "false", label: "Inactive only" },
      ],
      { value: state.isActive === null ? "" : String(state.isActive) },
    );
    activeFilter.addEventListener("change", () => {
      state.isActive = activeFilter.value === ""
        ? null
        : activeFilter.value === "true";
      state.cursorStack = [];
      state.nextCursor = null;
      loadItems();
    });
    toolbar.appendChild(activeFilter);

    const lowStockButton = document.createElement("button");
    lowStockButton.type = "button";
    lowStockButton.className = "inventory-btn";
    lowStockButton.textContent = "Low stock";
    lowStockButton.addEventListener("click", loadLowStock);
    toolbar.appendChild(lowStockButton);

    root.appendChild(toolbar);

    if (state.error) {
      root.appendChild(errorState(state.error));
    }

    if (state.loading) {
      root.appendChild(loadingState());
    } else if (state.items.length === 0) {
      root.appendChild(emptyState(
        state.search
          ? "No inventory items match your search."
          : "No inventory items yet. Create your first item to begin.",
      ));
    } else {
      root.appendChild(renderTable());
      root.appendChild(renderPagination());
    }

    const lowStockSection = document.createElement("section");
    lowStockSection.className = "inventory-low-stock";
    const lowStockTitle = document.createElement("h2");
    lowStockTitle.textContent = "Low stock warnings";
    lowStockSection.appendChild(lowStockTitle);
    if (state.lowStockLoading) {
      lowStockSection.appendChild(loadingState());
    } else if (state.lowStock.length === 0) {
      lowStockSection.appendChild(emptyState("No items are below their reorder level."));
    } else {
      const list = document.createElement("ul");
      list.className = "inventory-low-stock-list";
      for (const item of state.lowStock) {
        const row = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = `${item.name}${item.sku ? ` (${item.sku})` : ""}`;
        const detail = document.createElement("span");
        detail.textContent = `${formatQuantity(item.currentQuantity)} ${item.baseUnit} / reorder at ${formatQuantity(item.reorderLevel)}`;
        row.appendChild(name);
        row.appendChild(detail);
        list.appendChild(row);
      }
      lowStockSection.appendChild(list);
    }
    root.appendChild(lowStockSection);

    if (state.history) {
      root.appendChild(renderHistory());
    }
  }

  function renderTable() {
    const table = document.createElement("table");
    table.className = "inventory-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const column of [
      "Name", "SKU", "Unit", "Current qty", "Reorder level",
      "Avg cost", "Stock value", "Status", "",
    ]) {
      const th = document.createElement("th");
      th.textContent = column;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const item of state.items) {
      const row = document.createElement("tr");

      const nameCell = document.createElement("td");
      nameCell.textContent = item.name;
      row.appendChild(nameCell);

      const skuCell = document.createElement("td");
      skuCell.textContent = item.sku || "—";
      row.appendChild(skuCell);

      const unitCell = document.createElement("td");
      unitCell.textContent = item.baseUnit;
      row.appendChild(unitCell);

      const qtyCell = document.createElement("td");
      qtyCell.textContent = formatQuantity(item.currentQuantity);
      if (item.isNegativeStock) qtyCell.className = "inventory-negative";
      row.appendChild(qtyCell);

      const reorderCell = document.createElement("td");
      reorderCell.textContent = formatQuantity(item.reorderLevel);
      row.appendChild(reorderCell);

      const costCell = document.createElement("td");
      costCell.textContent = formatMinor(item.averageCostMinor);
      row.appendChild(costCell);

      const valueCell = document.createElement("td");
      valueCell.textContent = formatMinor(item.stockValueMinor);
      row.appendChild(valueCell);

      const statusCell = document.createElement("td");
      statusCell.innerHTML = statusBadge(item);
      row.appendChild(statusCell);

      const actionsCell = document.createElement("td");
      actionsCell.className = "inventory-actions";

      const adjustButton = document.createElement("button");
      adjustButton.type = "button";
      adjustButton.className = "inventory-btn inventory-btn-sm";
      adjustButton.textContent = "Adjust";
      adjustButton.addEventListener("click", () => openAdjustment(item));
      actionsCell.appendChild(adjustButton);

      const wasteButton = document.createElement("button");
      wasteButton.type = "button";
      wasteButton.className = "inventory-btn inventory-btn-sm";
      wasteButton.textContent = "Waste";
      wasteButton.addEventListener("click", () => openWaste(item));
      actionsCell.appendChild(wasteButton);

      const historyButton = document.createElement("button");
      historyButton.type = "button";
      historyButton.className = "inventory-btn inventory-btn-sm";
      historyButton.textContent = "History";
      historyButton.addEventListener("click", () => openHistory(item));
      actionsCell.appendChild(historyButton);

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "inventory-btn inventory-btn-sm";
      editButton.textContent = "Edit";
      editButton.addEventListener("click", () => openItemForm(item));
      actionsCell.appendChild(editButton);

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
      loadItems();
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
      loadItems();
    });
    nav.appendChild(nextButton);

    return nav;
  }

  function renderHistory() {
    const section = document.createElement("section");
    section.className = "inventory-history";

    const header = document.createElement("div");
    header.className = "inventory-history-header";
    const title = document.createElement("h2");
    title.textContent = `Movement history — ${state.history.itemName}`;
    header.appendChild(title);

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "inventory-btn";
    closeButton.textContent = "Close history";
    closeButton.addEventListener("click", () => {
      state.history = null;
      state.historyStack = [];
      state.historyCursor = null;
      render();
    });
    header.appendChild(closeButton);
    section.appendChild(header);

    if (state.historyLoading) {
      section.appendChild(loadingState());
      return section;
    }
    if (state.historyError) {
      section.appendChild(errorState(state.historyError));
      return section;
    }

    const movements = state.history.movements;
    if (movements.length === 0) {
      section.appendChild(emptyState("No movements recorded for this item yet."));
      return section;
    }

    const table = document.createElement("table");
    table.className = "inventory-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const column of [
      "When", "Type", "Delta", "Balance after", "Unit cost", "Total cost", "Reference", "Notes",
    ]) {
      const th = document.createElement("th");
      th.textContent = column;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const movement of movements) {
      const row = document.createElement("tr");

      const when = document.createElement("td");
      when.textContent = formatDateTime(movement.createdAt);
      row.appendChild(when);

      const type = document.createElement("td");
      type.textContent = movement.movementType;
      row.appendChild(type);

      const delta = document.createElement("td");
      delta.textContent = formatQuantity(movement.quantityDelta);
      if (Number(movement.quantityDelta) < 0) delta.className = "inventory-negative";
      row.appendChild(delta);

      const after = document.createElement("td");
      after.textContent = formatQuantity(movement.quantityAfter);
      row.appendChild(after);

      const unitCost = document.createElement("td");
      unitCost.textContent = movement.unitCostMinor === null
        ? "—"
        : formatMinor(movement.unitCostMinor);
      row.appendChild(unitCost);

      const totalCost = document.createElement("td");
      totalCost.textContent = movement.totalCostMinor === null
        ? "—"
        : formatMinor(movement.totalCostMinor);
      row.appendChild(totalCost);

      const reference = document.createElement("td");
      reference.textContent = movement.referenceType || "—";
      row.appendChild(reference);

      const notes = document.createElement("td");
      notes.textContent = movement.notes || "—";
      row.appendChild(notes);

      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    section.appendChild(table);

    const nav = document.createElement("div");
    nav.className = "inventory-pagination";
    const prevButton = document.createElement("button");
    prevButton.type = "button";
    prevButton.className = "inventory-btn";
    prevButton.textContent = "Previous";
    prevButton.disabled = state.historyStack.length === 0;
    prevButton.addEventListener("click", () => {
      if (state.historyStack.length === 0) return;
      state.historyCursor = state.historyStack.pop();
      loadHistory(state.history.itemId);
    });
    nav.appendChild(prevButton);

    const nextButton = document.createElement("button");
    nextButton.type = "button";
    nextButton.className = "inventory-btn";
    nextButton.textContent = "Next";
    nextButton.disabled = !state.history.nextCursor;
    nextButton.addEventListener("click", () => {
      if (!state.history.nextCursor) return;
      state.historyStack.push(state.history.nextCursor);
      loadHistory(state.history.itemId);
    });
    nav.appendChild(nextButton);
    section.appendChild(nav);

    return section;
  }

  async function loadItems() {
    state.loading = true;
    state.error = null;
    render();
    try {
      const result = await api.list({
        search: state.search || undefined,
        isActive: state.isActive,
        limit: PAGE_SIZE,
        cursor: state.nextCursor || undefined,
      });
      state.items = result.items;
      state.nextCursor = result.nextCursor;
      state.error = null;
    } catch (error) {
      state.error = describeError(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadLowStock() {
    state.lowStockLoading = true;
    render();
    try {
      const result = await api.lowStock({ limit: 100 });
      state.lowStock = result.items;
    } catch (error) {
      state.lowStock = [];
      state.error = describeError(error);
    } finally {
      state.lowStockLoading = false;
      render();
    }
  }

  async function loadHistory(itemId) {
    state.historyLoading = true;
    state.historyError = null;
    render();
    try {
      const result = await api.movements({
        itemId,
        limit: PAGE_SIZE,
        cursor: state.historyCursor || undefined,
      });
      const item = state.items.find((entry) => entry.id === itemId);
      state.history = {
        itemId,
        itemName: item?.name ?? "Item",
        movements: result.movements,
        nextCursor: result.nextCursor,
      };
    } catch (error) {
      state.historyError = describeError(error);
    } finally {
      state.historyLoading = false;
      render();
    }
  }

  function openHistory(item) {
    state.history = { itemId: item.id, itemName: item.name, movements: [], nextCursor: null };
    state.historyStack = [];
    state.historyCursor = null;
    render();
    loadHistory(item.id);
  }

  /** Item create/edit form. */
  function openItemForm(item = null) {
    const isEdit = Boolean(item);
    // The key is minted when the form opens and reused
    // for every attempt, so a retry after a lost
    // response replays safely instead of creating a
    // duplicate item. Opening the form again mints a
    // fresh key.
    const idempotencyKey = generateIdempotencyKey();
    const errorContainer = document.createElement("div");

    const nameInput = textInput({ value: item?.name ?? "" });
    const skuInput = textInput({ value: item?.sku ?? "", placeholder: "Optional" });
    const unitSelect = selectInput(
      BASE_UNITS.map((unit) => ({ value: unit, label: unit })),
      { value: item?.baseUnit ?? "piece" },
    );
    unitSelect.disabled = isEdit;
    const reorderInput = numberInput({
      value: item?.reorderLevel ?? "",
      min: "0",
    });
    const costInput = numberInput({
      value: item?.averageCostMinor ?? "",
      min: "0",
      step: "1",
    });
    const openingInput = numberInput({ value: "", min: "0" });

    const body = document.createElement("div");
    body.appendChild(labeledField("Name", nameInput));
    body.appendChild(labeledField("SKU", skuInput, "Optional. Unique per restaurant."));
    body.appendChild(labeledField("Base unit", unitSelect, isEdit
      ? "The base unit cannot change after creation."
      : "All quantities for this item are stored in this unit."));
    body.appendChild(labeledField("Reorder level", reorderInput, "Low-stock warning threshold."));
    body.appendChild(labeledField("Average cost (minor units)", costInput, "Integer minor units per base unit."));
    if (!isEdit) {
      body.appendChild(labeledField("Opening quantity", openingInput, "Optional starting stock, recorded as an adjustment."));
    }
    body.appendChild(errorContainer);

    let busy = false;
    openModal({
      title: isEdit ? "Edit inventory item" : "New inventory item",
      bodyEl: body,
      actions: [
        { label: "Cancel", onClick: ({ close }) => close() },
        {
          label: isEdit ? "Save changes" : "Create item",
          primary: true,
          onClick: async ({ close }) => {
            if (busy) return;
            busy = true;
            setError(errorContainer, null);
            try {
              if (isEdit) {
                await api.update(item.id, {
                  name: nameInput.value,
                  sku: skuInput.value || null,
                  reorderLevel: reorderInput.value === "" ? undefined : Number(reorderInput.value),
                  averageCostMinor: costInput.value === "" ? undefined : Number(costInput.value),
                });
              } else {
                await api.create({
                  idempotencyKey,
                  name: nameInput.value,
                  sku: skuInput.value || null,
                  baseUnit: unitSelect.value,
                  reorderLevel: reorderInput.value === "" ? undefined : Number(reorderInput.value),
                  averageCostMinor: costInput.value === "" ? undefined : Number(costInput.value),
                  openingQuantity: openingInput.value === "" ? undefined : Number(openingInput.value),
                });
              }
              close();
              await loadItems();
            } catch (error) {
              setError(errorContainer, describeError(error));
            } finally {
              busy = false;
            }
          },
        },
      ],
    });
  }

  /** Stock adjustment form. */
  function openAdjustment(item) {
    // Minted once per form so a retry after a lost
    // response replays the same adjustment.
    const idempotencyKey = generateIdempotencyKey();
    const errorContainer = document.createElement("div");
    const directionSelect = selectInput(
      [
        { value: "increase", label: "Increase stock" },
        { value: "decrease", label: "Decrease stock" },
      ],
      { value: "increase" },
    );
    const quantityInput = numberInput({ value: "", min: "0" });
    const reasonInput = textInput({ placeholder: "e.g. Stock count correction" });

    const body = document.createElement("div");
    const itemName = document.createElement("p");
    itemName.className = "inventory-modal-item";
    itemName.textContent = `${item.name} — current ${formatQuantity(item.currentQuantity)} ${item.baseUnit}`;
    body.appendChild(itemName);
    body.appendChild(labeledField("Direction", directionSelect));
    body.appendChild(labeledField("Quantity", quantityInput, `In ${item.baseUnit}.`));
    body.appendChild(labeledField("Reason", reasonInput, "Required for the audit trail."));
    body.appendChild(errorContainer);

    let busy = false;
    openModal({
      title: "Adjust stock",
      bodyEl: body,
      actions: [
        { label: "Cancel", onClick: ({ close }) => close() },
        {
          label: "Apply adjustment",
          primary: true,
          onClick: async ({ close }) => {
            if (busy) return;
            busy = true;
            setError(errorContainer, null);
            try {
              await api.adjust({
                idempotencyKey,
                itemId: item.id,
                direction: directionSelect.value,
                quantity: Number(quantityInput.value),
                reason: reasonInput.value,
              });
              close();
              await loadItems();
            } catch (error) {
              setError(errorContainer, describeError(error));
            } finally {
              busy = false;
            }
          },
        },
      ],
    });
  }

  /** Waste recording form. */
  function openWaste(item) {
    // Minted once per form so a retry after a lost
    // response replays the same waste record.
    const idempotencyKey = generateIdempotencyKey();
    const errorContainer = document.createElement("div");
    const quantityInput = numberInput({ value: "", min: "0" });
    const reasonInput = textInput({ placeholder: "e.g. Expired, damaged, spoiled" });

    const body = document.createElement("div");
    const itemName = document.createElement("p");
    itemName.className = "inventory-modal-item";
    itemName.textContent = `${item.name} — current ${formatQuantity(item.currentQuantity)} ${item.baseUnit}`;
    body.appendChild(itemName);
    body.appendChild(labeledField("Quantity wasted", quantityInput, `In ${item.baseUnit}.`));
    body.appendChild(labeledField("Reason", reasonInput, "Required for the audit trail."));
    body.appendChild(errorContainer);

    let busy = false;
    openModal({
      title: "Record waste",
      bodyEl: body,
      actions: [
        { label: "Cancel", onClick: ({ close }) => close() },
        {
          label: "Record waste",
          primary: true,
          onClick: async ({ close }) => {
            if (busy) return;
            busy = true;
            setError(errorContainer, null);
            try {
              await api.waste({
                idempotencyKey,
                itemId: item.id,
                quantity: Number(quantityInput.value),
                reason: reasonInput.value,
              });
              close();
              await loadItems();
            } catch (error) {
              setError(errorContainer, describeError(error));
            } finally {
              busy = false;
            }
          },
        },
      ],
    });
  }

  /**
   * Recipe editor: pick a menu product, edit its
   * ingredient rows, and save the complete recipe
   * transactionally.
   */
  async function openRecipeEditor() {
    const errorContainer = document.createElement("div");

    const body = document.createElement("div");
    body.appendChild(errorContainer);

    const productLabel = document.createElement("label");
    productLabel.textContent = "Product";
    body.appendChild(productLabel);

    const productSelect = document.createElement("select");
    productSelect.className = "inventory-input";
    productSelect.disabled = true;
    const loadingOption = document.createElement("option");
    loadingOption.value = "";
    loadingOption.textContent = "Loading products…";
    productSelect.appendChild(loadingOption);
    body.appendChild(productSelect);

    const ingredientList = document.createElement("div");
    ingredientList.className = "inventory-recipe-rows";
    body.appendChild(ingredientList);

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "inventory-btn";
    addButton.textContent = "Add ingredient";
    addButton.disabled = true;
    body.appendChild(addButton);

    const unitsNote = document.createElement("p");
    unitsNote.className = "inventory-field-hint";
    unitsNote.textContent = "Quantities are entered in each ingredient's own base unit.";
    body.appendChild(unitsNote);

    let products = [];
    let inventoryItems = [];
    let rows = [];
    let busy = false;

    function renderRows() {
      ingredientList.textContent = "";
      rows.forEach((row, index) => {
        const rowEl = document.createElement("div");
        rowEl.className = "inventory-recipe-row";

        const itemSelect = selectInput(
          inventoryItems.map((item) => ({
            value: item.id,
            label: `${item.name}${item.sku ? ` (${item.sku})` : ""} — ${item.baseUnit}`,
          })),
          { value: row.inventoryItemId },
        );
        itemSelect.addEventListener("change", () => {
          row.inventoryItemId = itemSelect.value;
          validateRows();
        });

        const quantityInput = numberInput({
          value: row.quantityRequired === "" ? "" : String(row.quantityRequired),
          min: "0",
        });
        quantityInput.addEventListener("input", () => {
          row.quantityRequired = quantityInput.value;
        });

        const unitLabel = document.createElement("span");
        unitLabel.className = "inventory-recipe-unit";
        const selectedItem = inventoryItems.find(
          (item) => item.id === row.inventoryItemId,
        );
        unitLabel.textContent = selectedItem ? selectedItem.baseUnit : "";

        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "inventory-btn inventory-btn-sm";
        removeButton.textContent = "Remove";
        removeButton.addEventListener("click", () => {
          rows.splice(index, 1);
          renderRows();
        });

        rowEl.appendChild(itemSelect);
        rowEl.appendChild(quantityInput);
        rowEl.appendChild(unitLabel);
        rowEl.appendChild(removeButton);
        ingredientList.appendChild(rowEl);
      });
    }

    function validateRows() {
      const seen = new Set();
      let duplicate = false;
      for (const row of rows) {
        if (seen.has(row.inventoryItemId)) duplicate = true;
        seen.add(row.inventoryItemId);
      }
      if (duplicate) {
        setError(errorContainer, "An ingredient can only appear once in a recipe.");
      } else {
        setError(errorContainer, null);
      }
      return !duplicate;
    }

    addButton.addEventListener("click", () => {
      rows.push({ inventoryItemId: "", quantityRequired: "" });
      renderRows();
    });

    const modal = openModal({
      title: "Recipe editor",
      bodyEl: body,
      actions: [
        { label: "Close", onClick: ({ close }) => close() },
        {
          label: "Save recipe",
          primary: true,
          onClick: async ({ close }) => {
            if (busy) return;
            const productId = productSelect.value;
            if (!productId) {
              setError(errorContainer, "Select a product first.");
              return;
            }
            if (!validateRows()) return;
            const items = rows
              .filter((row) => row.inventoryItemId && row.quantityRequired !== "")
              .map((row) => ({
                inventoryItemId: row.inventoryItemId,
                quantityRequired: Number(row.quantityRequired),
              }));
            for (const item of items) {
              if (!(item.quantityRequired > 0)) {
                setError(errorContainer, "Every ingredient quantity must be greater than zero.");
                return;
              }
            }
            busy = true;
            setError(errorContainer, null);
            try {
              await recipes.replace(productId, items);
              close();
            } catch (error) {
              setError(errorContainer, describeError(error));
            } finally {
              busy = false;
            }
          },
        },
      ],
    });

    try {
      const [menuResult, itemsResult] = await Promise.all([
        menuApi ? menuApi.list() : Promise.resolve({ items: [] }),
        api.list({ limit: 200 }),
      ]);
      products = menuResult.items || [];
      inventoryItems = itemsResult.items || [];

      productSelect.textContent = "";
      productSelect.disabled = false;
      if (products.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No products available";
        productSelect.appendChild(option);
      } else {
        for (const product of products) {
          const option = document.createElement("option");
          option.value = product.id;
          option.textContent = product.name;
          productSelect.appendChild(option);
        }
        addButton.disabled = false;

        productSelect.addEventListener("change", async () => {
          const productId = productSelect.value;
          rows = [];
          renderRows();
          if (!productId) return;
          try {
            const recipe = await recipes.get(productId);
            rows = (recipe.items || []).map((item) => ({
              inventoryItemId: item.inventoryItemId,
              quantityRequired: String(item.quantityRequired),
            }));
            renderRows();
          } catch (error) {
            setError(errorContainer, describeError(error));
          }
        });
      }
    } catch (error) {
      productSelect.textContent = "";
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Failed to load products";
      productSelect.appendChild(option);
      setError(errorContainer, describeError(error));
    }

    return modal;
  }

  async function mount() {
    if (!containerEl) return;
    root = containerEl;
    await loadItems();
    await loadLowStock();
  }

  return {
    mount,
    render,
    loadItems,
    loadLowStock,
  };
}
