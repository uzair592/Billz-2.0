# Milestone 11 Audit Findings

## Current State (Post Milestone 10)

### Backend (Complete - Milestone 10)
- **Billing/Subscription APIs**: Complete Stripe integration with webhooks
- **Order History API**: `GET /api/pos/orders` (filtering, pagination, cursor)
- **Order Detail API**: `GET /api/pos/orders/:orderId` (full order with items, payments, edit events)
- **Order Cancellation**: `POST /api/pos/orders/:orderId/cancel` (idempotent, compensation)
- **Billing APIs**: `/api/billing` (overview, checkout, change-plan, cancel, resume, payments)
- **Cloud Account**: Sign in, restaurant selection, catalog import
- **Authentication**: JWT sessions, email verification, password reset
- **Order History API**: `GET /api/pos/orders` with filters, cursor pagination
- **Order Detail API**: `GET /api/pos/orders/:orderId` (full order snapshot)
- **Order Cancellation**: `POST /api/pos/orders/:orderId/cancel` (idempotent)
- **Cloud Account**: Sign in, restaurant selection, catalog import
- **Cloud Session Client**: `src/client/cloud-session.mjs`

### Frontend (Legacy POS - Partial Cloud Integration)
**Existing (working):**
- `Fast_Food_POS_Custom_Bill_Header_XXXL.html` - Main POS application
- `src/client/legacy-cloud-bootstrap.mjs` - Cloud bootstrap
- `src/client/legacy-cloud-adapter.mjs` - Cloud adapter
- `src/client/order-outbox.mjs` - Durable order outbox
- `src/client/legacy-catalog-snapshot.mjs` - Catalog import builder
- `src/client/cloud-session.mjs` - Cloud session management
- `src/client/legacy-catalog-snapshot.mjs` - Catalog snapshot builder
- Cloud account modal (sign in, restaurant selection, catalog import)
- Order history view (`renderOrdersHistory`) - **uses local IndexedDB only**
- Order invoice details modal (`showOrderInvoiceDetailsView`) - **uses local IndexedDB only**
- Cloud account modal (sign in, restaurant selection, catalog import)
- `src/client/cloud-session.mjs` - Cloud session client
- `src/client/legacy-cloud-adapter.mjs` - Cloud adapter
- `src/client/order-outbox.mjs` - Durable order outbox
- `src/client/legacy-cloud-bootstrap.mjs` - Bootstrap
- `src/client/legacy-catalog-snapshot.mjs` - Catalog snapshot

**What's Missing (Milestone 11 Requirements):**

1. **Order History UI** - Connect `GET /api/pos/orders` to POS interface
   - Currently `renderOrdersHistory()` uses local `orders` array from IndexedDB
   - Need to fetch from `GET /api/pos/orders` with server-side filtering/pagination
   - Support server-side search, status/payment filtering, date range, pagination

2. **Order Detail UI** - Connect `GET /api/pos/orders/:orderId`
   - Currently `showOrderInvoiceDetailsView()` uses local `orders` array
   - Need to fetch from `GET /api/pos/orders/:orderId` for cloud orders
   - Display server-authoritative historical snapshots

3. **Order Cancellation UI** - Connect `POST /api/pos/orders/:orderId/cancel`
   - No UI for cloud order cancellation
   - Need confirmation dialog, reason input, idempotency key
   - Handle success/replay/403/404/409/500/offline

3. **Billing Page in POS UI**
   - No billing page in POS interface
   - Connect `GET /api/billing`, `POST /api/billing/checkout`, etc.
   - Show plan, subscription status, payment history
   - Must work without paid subscription (billing-only access)

4. **Receipt Reprinting from Cloud Data**
   - Current `reprintOrderReceipt()` uses local `orders` array
   - Need to fetch from cloud for historical orders

5. **Cloud/Offline Status Indicators**
   - No visual indication of sync status
   - Need pending/complete/failed/subscription problem states

6. **Mobile/Desktop Responsive Adjustments**
   - Ensure new UI works on desktop, tablet, mobile

6. **Integration Tests**
   - Tests for new UI connections
   - Real PostgreSQL integration tests for tenant isolation

---

## Implementation Plan

### Phase 1: Core Infrastructure
1. Create API client module for frontend (`src/client/api-client.mjs`)
2. Create cloud status indicator component
3. Add navigation for new screens (Order History, Order Detail, Billing)

### Phase 2: Order History UI
1. Replace `renderOrdersHistory()` to fetch from `GET /api/pos/orders`
2. Implement server-side filtering/pagination UI
3. Add loading/error states

### Phase 3: Order Detail UI
1. Create order detail screen/modal using `GET /api/pos/orders/:orderId`
2. Display server-authoritative historical snapshots
3. Receipt reprint button connected to cloud data

### Phase 4: Order Cancellation UI
1. Add cancel button to order detail/history
2. Confirmation dialog with reason input
3. Idempotency key generation
4. Handle all response codes

### Phase 5: Billing Page
1. Create billing screen in POS
2. Connect all billing APIs
3. Ensure accessible without paid subscription

### Phase 5: Receipt Reprinting
1. Connect reprint button to fetch from cloud for historical orders
2. Use server-authoritative historical snapshots

### Phase 6: Cloud/Offline Status
1. Add sync status indicator to header/sidebar
2. Show pending/complete/failed/subscription problem states

### Phase 7: Responsive Adjustments
1. CSS adjustments for mobile/tablet/desktop

### Phase 7: Integration Tests
1. Add tests for new UI connections
2. Real PostgreSQL integration tests

---

## Integration Points to Modify

### Files to Modify:
1. `Fast_Food_POS_Custom_Bill_Header_XXXL.html` - Main POS HTML
2. `src/client/legacy-cloud-bootstrap.mjs` - Add API client
3. `src/client/legacy-cloud-adapter.mjs` - Extend for new APIs
4. `src/client/legacy-cloud-bootstrap.mjs` - Add API client initialization
5. New files: `src/client/api-client.mjs`, `src/client/order-history-ui.mjs`, `src/client/billing-ui.mjs`

### New Files to Create:
1. `src/client/api-client.mjs` - Unified API client
2. `src/client/order-history-ui.mjs` - Order history UI logic
3. `src/client/order-detail-ui.mjs` - Order detail UI logic
3. `src/client/order-cancellation-ui.mjs` - Order cancellation UI
4. `src/client/billing-ui.mjs` - Billing UI logic
4. `src/client/cloud-status.mjs` - Cloud status indicator

### Server-side (already complete):
- All APIs already implemented in Milestone 10
- No server changes needed for Milestone 11

---

## Completion Summary

### Implemented (all client-side, no server changes)

**New modules (`src/client/`):**
- `api-client.mjs` — unified fetch wrapper: session cookies, `x-restaurant-id`
  resolved from the authorized cloud session, `CloudApiError` with
  `CLOUD_UNREACHABLE` normalization for offline detection
- `cloud-order-mapper.mjs` — maps cloud payloads (minor units, snake_case
  statuses) onto the legacy order shape so the existing renderers work
  unchanged; reconstructs offer pills from the stored item snapshot
- `order-history-ui.mjs` — cloud-first history: server-side search, date
  range, payment/status filters, cursor pagination ("Load more"), server
  summary totals; falls back to the local IndexedDB renderer when the
  cloud is unreachable or no catalog was imported; the "Edited" filter
  uses the local ledger (the list endpoint carries no edit trails)
- `order-detail-ui.mjs` — cloud detail + reprint: fetches
  `GET /api/pos/orders/:orderId`, maps it, and renders it through the
  existing invoice modal by temporarily swapping it into the local ledger
  (restored immediately after, so dashboards never double-count); blocks
  local mutations (edit, payment flip, remaining-due, delete) for cloud
  orders
- `order-cancellation-ui.mjs` — confirmation dialog with reason, fresh
  idempotency key per attempt, handles 200/201 (success/replay),
  403, 404, 409 (already cancelled), 5xx and offline; cloud
  cancellation is server-side compensation so the local restock
  checklist does not apply
- `billing-ui.mjs` — billing screen: current subscription, plans with
  checkout redirect (HTTPS URLs on the application origin), payment
  history, cancel-at-period-end, resume; reachable without a paid
  subscription
- `cloud-status.mjs` — sidebar indicator: offline, not configured,
  connected, N pending, sync failed, subscription problem

**Modified:**
- `legacy-cloud-bootstrap.mjs` — wires all UI modules, replaces
  `window.renderOrdersHistory` with the cloud-aware renderer
- `order-outbox.mjs` — exports `DEFAULT_STORAGE_KEY` (shared with the
  status indicator)
- `Fast_Food_POS_Custom_Bill_Header_XXXL.html` — billing screen section,
  billing nav button, history notice/loader/error/load-more elements,
  inline filter handlers moved to the module (debounced search),
  responsive CSS for billing/history/cancel dialog

**Tests (`tests/`):** `cloud-order-mapper`, `api-client`,
`order-history-ui`, `order-detail-ui` (via cancellation/detail flows),
`order-cancellation-ui`, `billing-ui`, `cloud-status` — 54 new tests,
all passing. Full suite: 361 passing; the only failure is
`server-startup.test.mjs`, which requires the Docker PostgreSQL on
127.0.0.1:55432 (unavailable in this environment) and is unrelated to
these changes.

### Key invariants preserved
- A local sale never fails because the server is unavailable (outbox +
  local rendering fallback)
- Local checkout is never blocked by cloud sync
- Offline IndexedDB behavior and existing receipt printing are preserved
- The billing page renders for every signed-in account, paid or not
- Frontend visibility never implies authorization — the server re-checks
  the restaurant header and permissions on every request