# Billz 2.0 POS — Phased Remediation Plan & Dependency Roadmap

## Overview
This document groups all 22 identified defects and architectural gaps into dependency-ordered remediation phases for production SaaS readiness.

---

## Remediation Roadmap & Dependency Order

```
[Phase 1: Multi-Tenant & Auth Core] ---> [Phase 2: Super-Admin & Subscriptions]
                 |                                      |
                 v                                      v
[Phase 3: Storage Quota & Paywall] -----> [Phase 4: Offline Outbox & Hardening]
                 |                                      |
                 +-------------------> [Phase 5: Pilot Acceptance]
```

---

## Phase Breakdown

### Phase 1: Authentication & Multi-Tenant Core
- Implement `restaurant_code` + `username` + `password` (+ 4-digit PIN) authentication API.
- Refactor user tables and JWT session cookies.
- Enforce strict RLS policies across all tenant data tables.

### Phase 2: Super-Admin & Manual Subscription Engine
- Build `/platform-admin` route namespace and authorization middleware.
- Build Super-Admin UI for manual payment approval, subscription extension, and account suspension.
- Replace automated Stripe workflows with manual WhatsApp proof approval.

### Phase 3: Storage Quota & File Metering
- Implement upload size metering middleware (`5 GB` base allowance).
- Build daily storage aggregation worker.
- Add quota warning thresholds (80%, 90%, 100%).

### Phase 4: Offline Outbox & Security Hardening
- Enforce cached `subscription_valid_until` offline paywall locking in IndexedDB.
- Add supervisor PIN requirements for completed order edits and cancellations.
- Sanitize all 404 client error displays.

### Phase 5: Frontend Layout & Reporting Enhancements
- Refactor search/filter toolbars into single inline horizontal flex layouts.
- Add Cash Tendered & Change Calculator to POS checkout.
- Add COGS ($\text{Total Sales} - \text{Ingredient Cost}$) and Gross Profit calculations to reports.

### Phase 6: Pilot Acceptance & Production Release
- Perform end-to-end multi-tenant validation across all viewports and role contexts.
- Execute security penetration audit and backup/restore verification.
