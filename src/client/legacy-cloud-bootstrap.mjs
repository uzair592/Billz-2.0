import { createCloudSessionClient } from "./cloud-session.mjs";
import {
  createBrowserIndexedDbStorage,
  createBrowserOutbox,
  createLegacyCloudAdapter,
} from "./legacy-cloud-adapter.mjs";
import { createOrderHistoryUI } from "./order-history-ui.mjs";
import { createOrderDetailUI } from "./order-detail-ui.mjs";
import { createOrderCancellationUI } from "./order-cancellation-ui.mjs";
import { createOrderRefundUI } from "./order-refund-ui.mjs";
import { createSalesReportUI } from "./sales-report-ui.mjs";
import { createBillingUI } from "./billing-ui.mjs";
import { createInventoryUI } from "./inventory-ui.mjs";
import { createPurchasesUI } from "./purchases-ui.mjs";
import { createCloudStatus } from "./cloud-status.mjs";

const storage = createBrowserIndexedDbStorage();
const session = createCloudSessionClient({ storage });
const outbox = createBrowserOutbox({ storage });
const adapter = createLegacyCloudAdapter({ storage, outbox, session });

globalThis.BiteTechCloudSession = session;
globalThis.BiteTechCloudSync = adapter;

// The status indicator is independent of the order flow —
// it only reads state this device already owns.
const cloudStatus = createCloudStatus({ storage });

// Order detail & reprint wrap the legacy modal and receipt
// printer so cloud orders render through them.
const orderDetail = createOrderDetailUI({ storage });

// Cancellation wraps the legacy cancel flow for cloud orders.
const orderCancellation = createOrderCancellationUI({
  storage,
  onCancelled: () => {
    window.renderOrdersHistory();
  },
});

// Partial refunds for cloud orders. The refund modal is
// reachable from the order detail invoice; a successful
// refund refreshes the order history and the open invoice.
const orderRefund = createOrderRefundUI({
  storage,
  onRefunded: () => {
    window.renderOrdersHistory?.();
  },
});
window.openRefundModal = orderRefund.openRefundModal;
globalThis.BiteTechRefund = orderRefund;

// History wraps the legacy local renderer: cloud-first with
// server-side filtering, local fallback when the cloud is
// unreachable or was never configured.
const orderHistory = createOrderHistoryUI({
  storage,
  legacyRender: window.renderOrdersHistory.bind(window),
});
window.renderOrdersHistory = orderHistory.renderOrdersHistory;

// Billing screen — reachable for every signed-in account,
// with or without a paid subscription.
const billingUI = createBillingUI();
globalThis.BiteTechBilling = billingUI;

// Server-authoritative sales reporting. The dashboard mounts
// into the reports screen's cloud container and is shown only
// when the operator switches to the "Cloud Sales Report" tab —
// local IndexedDB totals are never presented as cloud figures.
const salesReportContainer = document.getElementById(
  "cloud-sales-report-container",
);
const salesReportUI = createSalesReportUI({
  containerEl: salesReportContainer ?? undefined,
});
globalThis.BiteTechSalesReport = salesReportUI;

function showCloudSalesReport() {
  const localView = document.getElementById("local-reports-view");
  const cloudView = document.getElementById("cloud-sales-report-view");
  const localTab = document.getElementById("reports-tab-local");
  const cloudTab = document.getElementById("reports-tab-cloud");
  if (localView) localView.classList.add("hidden");
  if (cloudView) cloudView.classList.remove("hidden");
  if (localTab) localTab.classList.remove("active-switch");
  if (cloudTab) cloudTab.classList.add("active-switch");
  salesReportUI.mount();
}

function showLocalReports() {
  const localView = document.getElementById("local-reports-view");
  const cloudView = document.getElementById("cloud-sales-report-view");
  const localTab = document.getElementById("reports-tab-local");
  const cloudTab = document.getElementById("reports-tab-cloud");
  if (cloudView) cloudView.classList.add("hidden");
  if (localView) localView.classList.remove("hidden");
  if (cloudTab) cloudTab.classList.remove("active-switch");
  if (localTab) localTab.classList.add("active-switch");
  if (typeof calculateAndRenderBusinessReports === "function") {
    calculateAndRenderBusinessReports();
  }
}

window.showCloudSalesReport = showCloudSalesReport;
window.showLocalReports = showLocalReports;

// Inventory screen — stock items with weighted-average
// costing, the immutable movement ledger, adjustments,
// waste, low-stock warnings, and product recipes.
const inventoryContainer = document.getElementById(
  "inventory-screen-container",
);
const inventoryUI = createInventoryUI({
  containerEl: inventoryContainer ?? undefined,
});
globalThis.BiteTechInventory = inventoryUI;

// Purchases screen — suppliers, draft purchasing
// documents, and receiving with stock receipt.
const purchasesContainer = document.getElementById(
  "purchases-screen-container",
);
const purchasesUI = createPurchasesUI({
  containerEl: purchasesContainer ?? undefined,
});
globalThis.BiteTechPurchases = purchasesUI;

globalThis.addEventListener("online", () => {
  adapter.flush().catch((error) => console.warn("Cloud order retry failed:", error));
  cloudStatus.refresh();
});
adapter.flush().catch((error) => console.warn("Cloud order startup retry failed:", error));

export {
  cloudStatus,
  orderDetail,
  orderCancellation,
  orderHistory,
  orderRefund,
  billingUI,
  salesReportUI,
  inventoryUI,
  purchasesUI,
};
