import { createCloudSessionClient } from "./cloud-session.mjs";
import {
  createBrowserIndexedDbStorage,
  createBrowserOutbox,
  createLegacyCloudAdapter,
} from "./legacy-cloud-adapter.mjs";
import { createOrderHistoryUI } from "./order-history-ui.mjs";
import { createOrderDetailUI } from "./order-detail-ui.mjs";
import { createOrderCancellationUI } from "./order-cancellation-ui.mjs";
import { createBillingUI } from "./billing-ui.mjs";
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
  billingUI,
};
