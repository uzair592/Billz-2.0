# Billz 2.0 — production readiness audit, 13 October 2026

## Scope and baseline

Main remains `d894795c41528f329be10503180886d81972e557`. PR #10 was still unmerged at the start of this review; its prior head was `de6336b180131cbc2e324db3a3938972a44d66ae`. This review extends that PR so security/password/admin fixes are included in one reviewable release. No production data, database, hosting configuration or main branch is changed by this audit.

The baseline unit suite on the pending PR passes 631 tests. Static inventory identifies **229 buttons** and **215 distinct inline handler function references** in the POS HTML. All handler references resolve to declarations or the two report handlers exported by the cloud bootstrap module. This checks wiring, not proof that every button has been clicked with every possible dataset.

## Findings repaired in this release

| Finding | Repair and acceptance evidence |
|---|---|
| Publishing a menu resets stock that has already been sold | Imports initialize new stock balances once; later publications preserve authoritative quantities and costs. HTTP/PostgreSQL test checks stock after two simultaneous invoices and after publication. |
| Two devices can overwrite each other's catalog edits | Tenant catalog revisions serialize publication. A stale or missing revision on an existing catalog returns 409; the second operator must refresh/reconcile their draft. The losing publication rolls back. |
| A new device cannot use a published menu without a local catalog/import | Authenticated boot downloads the shared menu and UUID mappings atomically. Refresh preserves unpublished local drafts by default; an explicit replacement requires confirmation. Separate-browser-context acceptance starts with no seeded IndexedDB. |
| Fresh tills use default/local receipt business details | Boot loads an allowlisted receipt-business DTO; administrative edits update business settings too. Owner-only settings APIs retain their original permissions. |
| Waiters can submit paid orders without payment permission | Paid checkout now also requires `payment:process`. Unpaid order creation retains its existing role contract. |
| Partial refund followed by cancellation can distort another bill's net sales | Net revenue subtracts completed-order refunds only. Cancelled bills cannot subtract their partial refunds again from other sales. |
| Cancellation resurrects stock marked not to be restocked on an earlier refund | Frozen per-unit recipes exclude those lost quantities from both inventory ledgers' cancellation reversals. P&L retains the lost item costs. Old snapshots without version 2 still require historical reconciliation. |
| Expenses and P&L are local-device figures | New tenant-guarded cloud expense and account APIs persist expenses, ledger debits and audits in one transaction. Durable retry references prevent duplicate expenses. Cloud P&L uses quantity-adjusted checkout costs, discounts, refunds/restocking and operating expenses; purchases are inventory assets until consumed. |
| Unknown plan silently assigns a different plan | Creation requires an active known plan, otherwise 404 and rollback. Admin forms select actual active plans from the server. |
| Suspension/restore loses trial/cancellation state | New migration records the previous subscription status and restores it without extending expiry. Previously suspended rows with unknown history require operator review. |
| Admin can reset passwords but cannot create staff or change login identifiers | Audited, validated, rate-limited staff creation and username/display-name edits. Username and restaurant-code changes revoke sessions; session creation rechecks the verified identifiers to prevent stale login races. Duplicate identifiers return 409, foreign users/unknown restaurants return 404. |
| Pending payments lack a global workflow | New paginated status-filtered payment queue, restaurant links and confirmed approve/reject controls. Searchable restaurants, actual storage allowances, user table, password reset, contact edits, suspension/restore and audit viewer remain available from the earlier PR changes. |
| Several admin mutations accept malformed UUIDs/reasons and surface database failures | Route validation now covers identifiers and suspension reasons before SQL. Unknown suspend/restore/payment targets return a controlled 404. |

## What the suites exercise

- **Unit tests:** monetary calculation/rounding, recipes and cost snapshots, cancellation/refund idempotency, reports/exports, request guards, authentication/password/tenant logic, durable outbox retries, static traversal, import/backup validation, stored text escaping, admin rendering, mobile state and cloud client error handling. New regressions cover shared menu hydration, draft preservation, tenant switching during refresh, blocked access, unknown plans, staff endpoints and cloud finance authorization/validation.
- **PostgreSQL/HTTP:** actual production composition with restricted POS and separate control roles; tenant isolation, stored bytes, manual billing, authentication/session revocation, new staff/credential endpoints, shared catalog/conflicting publication, two invoices completing concurrently, invoice retry, inventory quantities/costs, expense/ledger/audit atomicity, P&L, partial refunds/cancellation and restore semantics. Every required suite fails when PostgreSQL is absent rather than claiming a skipped pass.
- **Existing browser suites:** 55 static-server/mocked UI cases for history/details/reprints, refunds, sales exports, inventory items/adjustments/waste/recipes, suppliers/purchases/receiving and phone/tablet navigation. These check UI behavior; they are not standalone evidence of database persistence.
- **Real-server browser journeys:** existing admin/owner/manual billing/password-reset/suspension journeys, plus actual visible category/item creation, menu publication, a clean second till, simultaneous visible checkout, offline refusal, cloud expense recording, inert XSS text and exact P&L at phone (390), tablet (768) and laptop (1366) widths. Screenshots are captured for review. No mocks or direct browser collection seeds in the new menu setup journey.
- **Container checks:** real production image, packaged assets, non-root execution, migrations/bootstrap, auth, webhook verification and SIGTERM shutdown.

## Invoice ordering and conflicts

Different invoices use different UUID retry references and a database sequence row locked per restaurant/branch. Both invoices are retained. The first transaction to obtain the sequence lock receives the smaller invoice number; there is no promise that the first click or the fastest device wins. An invoice transaction atomically writes the bill, payment and inventory movements. A retry with the same reference returns that invoice rather than saving another or consuming stock twice. Failed/rolled-back transactions do not produce a paid local receipt in managed mode.

Catalog edits use a separate revision check: one publication wins; a competing stale publication returns 409. Other devices receive the shared menu on login/reload or explicit refresh, not a live stream of every unsaved edit. A bill already open is protected by server price validation. Operators must publish menu edits before expecting another device to see them.

## Financial definition

Cloud P&L is accrual-based: completed unpaid sales count as revenue; revenue includes recorded bill charges and deducts discounts/refunds. Cost of goods uses frozen checkout unit cost multiplied by quantity. Restocked items reverse their cost; non-restocked items retain their cost, including cancellation after a partial refund. Net profit is gross profit less the period's recorded cloud operating expenses. Purchasing does not itself become an operating expense and must not be entered a second time as one. This is operational P&L, not a statutory tax return; taxes, payroll accruals, depreciation and supplier settlement accounting are not implemented by this release.

Previously local expenses must be reconciled before entering cloud expenses; this release does not silently bulk-import them. Costs missing from historical snapshots cannot be recovered by a test assertion.

## Remaining release gates — do not advertise these as tested features

1. **Hosting/staging:** trusted proxy CIDRs, restricted/control-role grants (including new tables), TLS, migrations 015–020, public support contact, real HTTPS client IPs, external load limits, alerts and staging backup recovery. No hosting account or deployed URL has been supplied.
2. **Offline:** managed checkout requires internet and refuses paid offline receipts. Browser-verifiable offline leases, dependable cold-start offline access and signed offline pricing are unfinished.
3. **Complete cloud product parity:** legacy kitchen/table live ordering, cash/bank transfers, purchasing settlements, local attachments/photos/receipt templates and all local settings do not yet have full multi-device synchronization. Shared publication covers menu/catalog setup; cloud inventory/purchasing/expenses/reports/history have separate authoritative APIs. Local stock/restocking screens remain local; use the Cloud Inventory/Purchases screens for shared operations.
4. **Roles/limits:** roles are predefined; configurable owner permissions, plan device-limit enforcement and all role-specific visible journeys are not complete. Server permissions remain authoritative.
5. **Printing and security:** real 58/80 mm printer drivers/cutting/paper layout need physical-hardware acceptance. Canary/escaping/static/RLS tests do not constitute an exhaustive penetration test. Parameter-bound SQL and Fastify guards/rate limits reduce application risk; volumetric DDoS requires hosting/network protection.
6. **Operational recovery:** rehearse historical stock/cost reconciliation, migration rollback/recovery and a complete restoration of real customer data on an isolated staging copy.

## Verification record

Final exact-head results and acceptance fixes are recorded in PR #10. Local Node 22 unit checks run in this workspace. PostgreSQL is not installed and the workspace cannot perform the OS permission operations needed to install/run it; required local PostgreSQL commands fail explicitly. Chromium/headless-shell downloads are truncated; local browser execution is attempted but not claimed to pass. CI provides real PostgreSQL 17, Node 22 and Chromium and is the database/browser acceptance gate. No blanket “all functions pass” or paid-launch approval is implied by green CI.
