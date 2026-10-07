# Billz 2.0 POS — Gemini Audit Findings Verification Matrix

## Overview
This matrix independently evaluates every claim made in previous reports against the actual codebase (`7bcd9911e365415b3c18ed064208e0177cf4043a`), Fastify server, PostgreSQL migrations, and Playwright specifications.

---

## Verification Matrix

| Gemini Claim | Classification | Evidence & File Location | Actual Severity | Root Cause / Next Action |
| :--- | :---: | :--- | :---: | :--- |
| **Mobile sidebar overflow** | `CONFIRMED` | [`Fast_Food_POS_Custom_Bill_Header_XXXL.html`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/Fast_Food_POS_Custom_Bill_Header_XXXL.html#L2100) | Medium | Touch padding adjustment required for viewports $\le 390\text{px}$. |
| **Inventory 404 alert display** | `CONFIRMED` | [`src/client/inventory-ui.mjs`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/src/client/inventory-ui.mjs#L205) + [`Fast_Food_POS_Custom_Bill_Header_XXXL.html`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/Fast_Food_POS_Custom_Bill_Header_XXXL.html#L7309) | Blocker | Unclosed modal wrapper + raw status code rendering in client catch block. |
| **Missing change calculator** | `FEATURE REQUEST, NOT BUG` | [`Fast_Food_POS_Custom_Bill_Header_XXXL.html`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/Fast_Food_POS_Custom_Bill_Header_XXXL.html#L6130) | High | Omitted from legacy checkout modal template. Add tendered field. |
| **Unpersisted privacy toggle** | `CONFIRMED` | [`Fast_Food_POS_Custom_Bill_Header_XXXL.html`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/Fast_Food_POS_Custom_Bill_Header_XXXL.html#L15860) | Medium | Missing `localStorage` persistence hook in toggle function. |
| **Cashier financial visibility** | `CONFIRMED` | [`Fast_Food_POS_Custom_Bill_Header_XXXL.html`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/Fast_Food_POS_Custom_Bill_Header_XXXL.html#L5930) | High | Sidebar exposes financial ledger routes to cashiers. Enforce RBAC in UI. |
| **Completed order editing without PIN** | `CONFIRMED` | [`src/client/order-cancellation-ui.mjs`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/src/client/order-cancellation-ui.mjs#L40) | Critical | Missing supervisor PIN verification gate in order mutation handler. |
| **Missing COGS & Gross Profit** | `FEATURE REQUEST, NOT BUG` | [`src/client/sales-report-ui.mjs`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/src/client/sales-report-ui.mjs#L120) | Critical | Report service calculates gross/net sales but omits COGS margin. |
| **Hypothetical `/api/v1/*` routes** | `FALSE` | [`src/server/http/app.mjs`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/src/server/http/app.mjs#L460-L1250) | N/A | Invented path strings; real endpoints use `/api/pos/*` and `/api/auth/*`. |
| **Port 8899 was Fastify server** | `FALSE` | `tests/browser/static-server.mjs` | N/A | Port 8899 was the Playwright static file server, not the Fastify server. |
| **Stripe online payment wired** | `CONFIRMED` | [`src/server/billing/stripe-provider.mjs`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/src/server/billing/stripe-provider.mjs) | Blocker | Stripe is currently wired; must transition to manual WhatsApp payment proof model. |
| **Super-admin panel exists** | `FALSE` | [`src/server/http/app.mjs`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/src/server/http/app.mjs) | Blocker | No `/platform-admin` route namespace or super-admin controller exists in codebase. |
