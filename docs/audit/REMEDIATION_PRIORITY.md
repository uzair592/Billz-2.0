# Billz 2.0 POS — Remediation Priority & Phased Implementation Plan

## Overview
This document prioritizes all verified defects and missing SaaS business requirements into P0 (Blockers), P1 (Critical), P2 (High/Medium), and P3 (Low) remediation buckets.

---

## Priority Buckets

### P0: Critical System Blockers
1. **P0-1: Multi-Tenant `restaurant_code` + `username` Login**:
   - Migrate authentication API from email logins to `restaurant_code` + `username` + `password` (+ 4-digit PIN for quick cashier switching).
2. **P0-2: Isolated Super-Admin Platform Administration (`/platform-admin`)**:
   - Build `/platform-admin` route namespace, authorization middleware, tenant management directory, and manual subscription controls.
3. **P0-3: Manual WhatsApp Payment Approval Workflow**:
   - Replace automated Stripe provider requirement with manual payment recording and WhatsApp reference logger.
4. **P0-4: Offline Subscription Paywall Gate**:
   - Enforce cached `subscription_valid_until` checks in offline cashier authorization handlers to prevent indefinite offline usage after subscription expiry.

### P1: Primary Workflow & Security Defects
1. **P1-1: Upload Size Storage Quota Metering**:
   - Add content-length request metering middleware to enforce 5 GB storage allowance per tenant.
2. **P1-2: Completed Order Mutation PIN Gate**:
   - Require supervisor/owner PIN verification before editing or cancelling completed orders.
3. **P1-3: Cash Tendered & Change Return Calculator**:
   - Add Cash Tendered and Change Return calculation inputs to POS checkout modal and thermal receipt outputs.
4. **P1-4: COGS & Gross Profit Calculations**:
   - Update sales report analytics service to compute Cost of Goods Sold ($\text{COGS} = \text{Total Sales} - \text{Ingredient Cost}$) and Gross Profit margins.

### P2: Layout & Usability Improvements
1. **P2-1: Unpersisted Privacy Amount Toggle**: Store `[👁️ Show Amounts]` setting in `localStorage`.
2. **P2-2: Integrated Single-Row Filter Toolbar**: Refactor search inputs and filter dropdowns into a unified flex toolbar.

### P3: Cosmetic & Minor Polish
1. **P3-1: Sub-tab typography and dark mode contrast polish**.
