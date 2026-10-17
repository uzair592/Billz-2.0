// Device-local layout preference only; no restaurant data is kept here.
export function billWidthBounds(workspaceWidth) {
  return { min: 320, max: Math.max(320, Math.min(workspaceWidth * 0.68, workspaceWidth - 280)) };
}
export function clampBillWidth(width, workspaceWidth) {
  const { min, max } = billWidthBounds(workspaceWidth);
  return Math.round(Math.max(min, Math.min(max, width)));
}
export function initializeWorkspaceLayout() {
  for (const screen of document.querySelectorAll("section.screen-view")) {
    const heading = screen.querySelector("h1");
    if (!heading) continue;
    const header = [...screen.children].find(node => node.contains(heading));
    if (header === heading) {
      // Standalone titles (Billing and Item Ledger) need the same treatment.
      const wrapper = document.createElement("header");
      heading.before(wrapper);
      wrapper.append(heading);
      wrapper.classList.add("workspace-header");
      const note = wrapper.nextElementSibling;
      if (note?.tagName === "P") {
        note.classList.add("workspace-intro");
        if (screen.id === "screen-ledger") {
          const help = document.createElement("details");
          help.className = "workspace-help";
          const summary = document.createElement("summary");
          summary.textContent = "How this report is calculated";
          note.before(help);
          help.append(summary, note);
        }
      }
    } else {
      header?.classList.add("workspace-header");
      const actionGroup = header?.lastElementChild;
      if (actionGroup?.querySelector("button") && !actionGroup.contains(heading) && !actionGroup.querySelector("h2, h3")) {
        actionGroup.classList.add("workspace-actions");
      }
    }
  }
  const search = document.getElementById("history-search");
  const actions = document.querySelector("#history-results-count > span:last-child");
  if (search && actions && !document.getElementById("history-toolbar")) {
    const wrapper = search.parentElement;
    const toolbar = document.createElement("div");
    toolbar.id = "history-toolbar";
    wrapper.before(toolbar);
    const filters = document.createElement("div");
    filters.className = "history-status-filters";
    for (const id of ["history-payment-filter", "history-status-filter"]) {
      const filter = document.getElementById(id);
      if (filter) {
        filter.setAttribute("aria-label", id === "history-payment-filter" ? "Payment method" : "Order status");
        filters.append(filter);
      }
    }
    toolbar.append(search, filters, actions);
    wrapper.remove();
    search.placeholder = "Search customer or phone…";
    search.setAttribute("aria-label", "Search orders by customer or phone");
  }
  const layout = document.querySelector("#screen-new-order .pos-layout");
  const cart = layout?.querySelector(".cart-box");
  if (!cart || document.getElementById("bill-width-divider")) return;
  const divider = document.createElement("div");
  divider.id = "bill-width-divider";
  divider.tabIndex = 0;
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "vertical");
  divider.setAttribute("aria-label", "Resize current bill");
  divider.title = "Drag to resize bill. Arrow keys adjust; Home or double-click resets.";
  cart.before(divider);
  const key = "billz-current-bill-width";
  let preferred = 0;
  try { preferred = Number(localStorage.getItem(key)) || 0; } catch {}
  function apply(width, persist = true) {
    const available = layout.getBoundingClientRect().width;
    if (available < 650) return;
    const value = clampBillWidth(width, available);
    preferred = value;
    layout.style.setProperty("--bill-width", `${value}px`);
    divider.setAttribute("aria-valuemin", "320");
    divider.setAttribute("aria-valuemax", String(Math.round(billWidthBounds(available).max)));
    divider.setAttribute("aria-valuenow", String(value));
    if (persist) { try { localStorage.setItem(key, String(value)); } catch {} }
  }
  function reset() {
    preferred = 0;
    layout.style.removeProperty("--bill-width");
    divider.setAttribute("aria-valuenow", String(Math.round(cart.getBoundingClientRect().width)));
    try { localStorage.removeItem(key); } catch {}
  }
  let dragging = false;
  divider.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    dragging = true;
    divider.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  divider.addEventListener("pointermove", event => {
    if (dragging) apply(layout.getBoundingClientRect().right - event.clientX);
  });
  const endDrag = () => { dragging = false; };
  divider.addEventListener("pointerup", endDrag);
  divider.addEventListener("pointercancel", endDrag);
  divider.addEventListener("lostpointercapture", endDrag);
  divider.addEventListener("dblclick", reset);
  divider.addEventListener("keydown", event => {
    if (event.key === "Home") { event.preventDefault(); reset(); }
    if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      apply(cart.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 24 : -24));
    }
  });
  const observer = new ResizeObserver(() => {
    if (preferred) apply(preferred, false);
    else divider.setAttribute("aria-valuenow", String(Math.round(cart.getBoundingClientRect().width)));
  });
  observer.observe(layout);
}
