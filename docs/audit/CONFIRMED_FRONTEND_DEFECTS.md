# Billz 2.0 POS — Confirmed Frontend Defects & Reproduction Evidence

## Overview
This document logs every confirmed frontend defect verified with Playwright against the real Fastify backend server and PostgreSQL database.

---

## Confirmed Defects List

### 1. DEF-01: Raw 404 Status Display on Unseeded Endpoints
- **Priority:** P1
- **Role:** All roles
- **Viewport:** All viewports (`390×844` to `1920×1080`)
- **Reproduction:** Navigate to Inventory when cloud server returns 404 or table is unseeded.
- **Evidence:** Pink alert banner displayed containing `The resource was not found.`.
- **Root Cause:** Client error catch block in `inventory-ui.mjs` renders `describeError(error)` directly to DOM instead of presenting a clean empty state.
- **Files:** [`src/client/inventory-ui.mjs`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/src/client/inventory-ui.mjs#L630-L645)

---

### 2. DEF-02: Missing Cash Tendered & Change Return Controls
- **Priority:** P1
- **Role:** Cashier
- **Viewport:** All viewports
- **Reproduction:** Add item to cart -> click Checkout -> observe payment modal.
- **Evidence:** Modal allows selecting payment method but lacks Cash Tendered input and Change Return calculation.
- **Root Cause:** Input missing from POS checkout modal layout.
- **Files:** [`Fast_Food_POS_Custom_Bill_Header_XXXL.html`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/Fast_Food_POS_Custom_Bill_Header_XXXL.html#L6130-L6180)

---

### 3. DEF-03: Unpersisted Privacy Amount Toggle
- **Priority:** P2
- **Role:** Owner, Manager
- **Viewport:** All viewports
- **Reproduction:** Click `[👁️ Show Amounts]` to mask amounts -> refresh browser (`F5`).
- **Evidence:** Amounts unmask and show numbers again after reload.
- **Root Cause:** `toggleAmountVisibility()` does not store state in `localStorage`.
- **Files:** [`Fast_Food_POS_Custom_Bill_Header_XXXL.html`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/Fast_Food_POS_Custom_Bill_Header_XXXL.html#L15860-L15890)

---

### 4. DEF-04: Completed Order Edit/Cancel Without PIN Gate
- **Priority:** P1
- **Role:** Cashier
- **Reproduction:** Navigate to View Orders -> click Edit/Cancel on completed order.
- **Evidence:** Mutation dialog opens immediately without requesting supervisor PIN.
- **Root Cause:** Missing supervisor authorization check in handler.
- **Files:** [`src/client/order-cancellation-ui.mjs`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/src/client/order-cancellation-ui.mjs#L40-L80)

---

### 5. DEF-05: Disjointed Multi-Row Inventory & Stock Filter Toolbars
- **Priority:** P2
- **Role:** All roles
- **Reproduction:** Open Inventory or Stock screen.
- **Evidence:** Search input, status dropdown, and low-stock buttons stack vertically across 3 full lines.
- **Root Cause:** Block-level styling on toolbar children in `Fast_Food_POS_Custom_Bill_Header_XXXL.html`.
- **Files:** [`Fast_Food_POS_Custom_Bill_Header_XXXL.html`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/Fast_Food_POS_Custom_Bill_Header_XXXL.html#L4973-L4980)
