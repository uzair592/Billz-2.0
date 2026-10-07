# Billz 2.0 POS — Frontend Defect & UI Usability Inventory

## Overview
This document logs every confirmed UI, UX, responsive layout, modal interaction, and state management defect discovered during the browser walkthrough across viewports: `390×844`, `412×915`, `844×390`, `768×1024`, `1024×768`, `1366×768`, and `1920×1080`.

---

## Defect Inventory

### 1. FE-BUG-01: Disjointed Inventory & Stock Filter Toolbars
- **Severity:** High
- **Affected Screen:** Inventory (`#screen-inventory`), Stock (`#screen-kitchen-stock`)
- **Affected Roles:** Cashier, Manager, Owner
- **Reproduction Steps:**
  1. Open the application and navigate to **Inventory** or **Stock**.
  2. Observe the search box, status dropdown, and low-stock filter buttons.
- **Actual Result:** Filter controls occupy separate full-width rows, consuming excessive vertical screen space.
- **Expected Result:** Controls should be arranged in a unified single horizontal flex toolbar (`display: flex; gap: 8px; align-items: center; flex-wrap: wrap;`).
- **Likely Root Cause:** Unwrapped block-level form element CSS rules in `Fast_Food_POS_Custom_Bill_Header_XXXL.html`.
- **Affected Files:** [`Fast_Food_POS_Custom_Bill_Header_XXXL.html`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/Fast_Food_POS_Custom_Bill_Header_XXXL.html#L4973-L4980)

---

### 2. FE-BUG-02: Missing Cash Tendered & Change Return Calculator
- **Severity:** High
- **Affected Screen:** New Order / POS Checkout (`#screen-new-order`)
- **Affected Roles:** Cashier
- **Reproduction Steps:**
  1. Add items to cart totaling Rs. 750.
  2. Click **Checkout**.
  3. Observe checkout modal controls.
- **Actual Result:** There is no dedicated field to enter cash tendered by the customer (e.g., Rs. 1000) or calculate the change due (Rs. 250).
- **Expected Result:** Checkout modal should provide a Cash Tendered input with automatic change calculation displayed on screen and receipt slips.
- **Likely Root Cause:** Omission of change return inputs in legacy modal template.
- **Affected Files:** [`Fast_Food_POS_Custom_Bill_Header_XXXL.html`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/Fast_Food_POS_Custom_Bill_Header_XXXL.html#L6130-L6180)

---

### 3. FE-BUG-03: Unpersisted Privacy Amount Toggle (`[👁️ Show Amounts]`)
- **Severity:** Medium
- **Affected Screen:** Topbar / Dashboard Header
- **Affected Roles:** Owner, Manager
- **Reproduction Steps:**
  1. Click `[👁️ Show Amounts]` to mask revenue figures with `••••••`.
  2. Refresh the browser page (`F5`).
- **Actual Result:** Amount masking resets to visible on reload.
- **Expected Result:** Masking preference should persist in `localStorage` under `pos_hide_amounts`.
- **Likely Root Cause:** Missing `localStorage` read/write hooks in `toggleAmountVisibility()`.
- **Affected Files:** [`Fast_Food_POS_Custom_Bill_Header_XXXL.html`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/Fast_Food_POS_Custom_Bill_Header_XXXL.html#L15860-L15890)

---

### 4. FE-BUG-04: Unprotected Completed Order Modification
- **Severity:** Critical
- **Affected Screen:** View Orders (`#screen-view-orders`)
- **Affected Roles:** Cashier
- **Reproduction Steps:**
  1. Navigate to **View Orders**.
  2. Click **Edit Order** or **Cancel** on a completed historical order.
- **Actual Result:** Historical orders can be modified without supervisor PIN verification.
- **Expected Result:** Completed transactions must require supervisor/owner PIN code authorization before modification or cancellation.
- **Likely Root Cause:** Missing role/PIN gate in order modification event handlers.
- **Affected Files:** [`src/client/order-cancellation-ui.mjs`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/src/client/order-cancellation-ui.mjs#L40-L80)

---

### 5. FE-BUG-05: Missing Quick Date Presets on Dashboard
- **Severity:** Medium
- **Affected Screen:** Dashboard (`#screen-dashboard`)
- **Affected Roles:** Owner, Manager
- **Reproduction Steps:**
  1. Navigate to **Dashboard**.
  2. Observe date metrics.
- **Actual Result:** Dashboard only displays "Today" metrics without quick period selection filters.
- **Expected Result:** Quick period selector (*Today*, *Yesterday*, *This Week*) should allow immediate KPI re-calculation.
- **Likely Root Cause:** Hardcoded date range filter on dashboard load handler.
- **Affected Files:** [`Fast_Food_POS_Custom_Bill_Header_XXXL.html`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/Fast_Food_POS_Custom_Bill_Header_XXXL.html#L16032-L16060)

---

### 6. FE-BUG-06: Mobile Touch Target Compression on Viewports $\le 390\text{px}$
- **Severity:** Medium
- **Affected Viewports:** `390×844`, `412×915`
- **Affected Roles:** Cashier
- **Reproduction Steps:**
  1. Set viewport to 390px width.
  2. Open the New Order cart action panel.
- **Actual Result:** Action buttons (`Save bill`, `KOT`, `Save & print`) compress below the recommended 44px minimum touch height target.
- **Expected Result:** Action buttons should maintain a minimum height of $44\text{px}$ with touch padding.
- **Likely Root Cause:** Hardcoded $32\text{px}$ button height in mobile CSS media query.
- **Affected Files:** [`Fast_Food_POS_Custom_Bill_Header_XXXL.html`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/Fast_Food_POS_Custom_Bill_Header_XXXL.html#L2100-L2150)
