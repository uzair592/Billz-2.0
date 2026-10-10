# Launch recheck — 10 October 2026

**Verdict: the original report is partly superseded, but not every launch requirement is resolved. Do not treat green CI or PR #8 as approval for the complete paid/offline product.**

The tester reviewed main `7bcd9911e365415b3c18ed064208e0177cf4043a` and PR #7 `9f8624b050aa2e9f01ad0989bee7c97ad8669f55`. This recheck starts from main `0dd1fa7e71fdf8f57cdbb52ad75ac05ccb5188d7`, the merge of PR #8. GitHub reports PR #8 merged at `2026-10-10T13:09:42Z`; the follow-up changes therefore belong in a new PR. This review did not merge or deploy anything.

“Fixed” below means the specific reported defect has a code repair and regression evidence. It does not mean that every related workflow has passed production acceptance. “Contained” means managed checkout avoids the failing offline path by requiring server acceptance before issuing a paid receipt. It does not complete offline support.

## Finding-by-finding disposition

| ID | Recheck result | Evidence and remaining work |
|---|---|---|
| L01 Login/subscriptions | Partial | Production-served HTML uses restaurant code, username and password. Boot verifies membership and POS subscription access; managed demo PIN activation is excluded. Real-server CI exercises visible owner login, payment approval, suspension and recovery. Browser offline access leases and a full cashier permissions journey remain incomplete. |
| L02 Production 404s | Fixed reported defect | `src/server/main.mjs` composes history, detail, cancellation, catalog import and business settings services. `tests/launch-regressions.test.mjs` probes the actual entrypoint: all five route families return guarded 401, not missing-route 404. Real browser CI imports a catalog and creates a paid sale. |
| L03 Fail-open RLS | Fixed reported defect | Additive migration 014 repairs the policies without rewriting previously applied migrations. POS uses a non-superuser NOBYPASSRLS role; account discovery/admin uses a separate control role. PostgreSQL CI verifies missing-context reads/writes and cross-tenant denial. Hosting grants and migration application still require deployment verification. |
| L04 Static-file disclosure | Fixed reported defect | The static handler checks decoded paths and canonical realpaths inside allowed public roots. Regression probes reject encoded traversal and escaping symlinks. |
| L05 HTML injection | **Additional defects found and repaired in this follow-up; audit remains open** | PR #8's invoice fixes were insufficient. Actual management descriptions/deal names, stock filter labels/icons and keys, and expense option labels/attributes failed new canary tests on merged main. The follow-up escapes these and related stock/history/restock fields, serializes inline JS arguments correctly, and adds real-DOM canaries to the production-server browser journey. This is not an exhaustive sink/print audit or restrictive CSP implementation. |
| L06 Forwarded IP spoofing | Fixed reported defect | Proxy trust defaults false; account throttling supplements IP throttling. A production-app injection test varies forged forwarded addresses and still hits the login limit. A deployment using a proxy must configure its trusted boundary. |
| L07 Tenant context/local data | Fixed reported defect with acceptance gate | Managed IndexedDB/preferences use tenant keys; enqueue rejects mismatched session/catalog tenants; logout quarantines pending data and account switches reload. This follow-up also fixes preference removal to use the same tenant key as reads/writes. Full two-account/two-restaurant browser switching remains a release acceptance gate. |
| L08 Sale/outbox atomicity | Contained, offline requirement open | Managed checkout is server-first and journals a stable attempt ID. A failed server request cannot become a locally paid receipt. The legacy standalone offline path does not have a completed atomic sale-plus-outbox contract. |
| L09 Authorization recovery | Fixed reported defect | Failed authentication/subscription operations become blocked, then resume only after validated same-tenant access. A timed drain retains the original operation ID. Unit tests prove another tenant cannot resume the blocked sale and recovery does not change its ID. |
| L10 Price/options mismatch | Contained, feature incomplete | Server rejects a changed expected total before order/payment persistence. Managed extras are explicitly rejected rather than silently omitted. Signed/versioned offline prices and supported paid extras/options still need implementation and acceptance. |
| L11 Partial refund quantity | Fixed reported defect | Regression fixtures now use the real per-unit checkout snapshot. Refunding one unit of a two-unit sale restores 200 ingredient units. Real PostgreSQL checkout/refund/cancellation tests verify balances and repeat-request idempotency. |
| L12 Inventory/COGS ledgers | Fixed new-sale defect; historical gate | New recipes/costs are frozen at checkout, migrated products avoid legacy double consumption, refunds use snapshots, and cancellation reverses remaining consumption after refunds. The follow-up adds a mixed legacy/migrated deal PostgreSQL test covering both ledgers, costs, post-sale recipe edits and repeated refund/cancel requests. Pre-fix historical orders need migration/reconciliation review; their missing snapshots cannot be reconstructed by assertion. |
| L13 Quantity profit | Fixed reported defect | The mapper preserves total line cost or multiplies unit cost by quantity, including true zero costs. A three-unit Rs 300 sale with Rs 20 unit cost has Rs 60 COGS and Rs 240 gross profit. |
| L14 File storage | Fixed byte-retention defect; integration incomplete | Files and SHA-256 persist in PostgreSQL with atomic managed-file quota accounting. PostgreSQL CI recreates the service and verifies identical bytes, cross-tenant denial and deletion. Local menu photos/receipt attachments are not automatically uploaded, and quota does not measure all database data. |
| L15 Offline entitlement | Partial | Public default signing secret removed; configured server tokens require a private secret and expire at the paid boundary. A browser-verifiable lease integrated with offline checkout is still absent. |
| L16 Bootstrap/admin Docker | Fixed reported defects | Owner username/code bootstrap and private admin environment configuration work; admin assets are copied into Docker. CI runs the actual admin UI plus application/container startup. Hosting bootstrap and backup/restore still require staging execution. |
| L17 CI/acceptance evidence | Improved, incomplete release acceptance | PR #8 exact-head CI had all four jobs green. The real PostgreSQL/browser lifecycle replaces the previous weak assertions, and visible checkout must return 201 with paid status and the exact persisted amount. Fixtures still seed the initial local catalog, and the suite covers owners at three sizes rather than every cashier/tenant/offline/printing workflow. |
| L18 Backup validation | Fixed reported validation defect; recovery gate | Validation examines every order and nested item, including malformed row 1001; collections/images are staged for one IndexedDB transaction. Real backup recovery with current customer data and device/settings state remains a release gate. |
| L19 Migration atomicity | Fixed reported defect | Runner unwraps source transaction wrappers without changing source checksums; DDL and history share one transaction; session lock is released. Unit and PostgreSQL failure-injection checks cover rollback. Rehearse on a current-data copy before deployment. |
| L20 Password hash DTO | Fixed reported defect | Public DTOs allowlist fields; regression checks assert password/token hash fields and canary values are absent from `/api/auth/me`. |

## New defects reproduced on merged main

`tests/launch-recheck.test.mjs` executes the actual legacy function declarations, not replacement renderers. Before repair, all five new cases failed with assertions (not fixture/reference errors):

1. Management description and linked item name became raw `<img>` markup.
2. Stock labels/icons became markup, and HTML escaping alone did not safely serialize a key inside a quoted inline JavaScript argument.
3. Expense category labels and option values could break out into markup.
4. `safeStorageRemove` deleted an unscoped key while get/set used a tenant prefix, leaving the tenant preference in both persistent and fallback storage.
5. A two-unit “Fish & Chips” deal summary became the plain-input string `Fish &amp; Chips`, causing visible double escaping.

All five pass after repair. Related stock warnings, purchase histories, restock attributes and threshold handler arguments are also hardened. The SaaS browser test now checks inert management/stock/expense canaries against the production server on mobile, tablet and desktop; it dispatches the stock filter event and verifies the hostile key arrives unchanged.

## Verification record

- Baseline merged main: `npm test` — **612 passed, 0 failed, 0 skipped**.
- Follow-up: `npm test` — **617 passed, 0 failed, 0 skipped**. JavaScript syntax checks and `git diff --check` passed.
- Baseline PR #8 CI: [run 38050694817](https://github.com/uzair592/Billz-2.0/actions/runs/38050694817), head `aacbe16718b243041bb2043ace1b69f374523bec`: `validate`, `browser`, `production-smoke`, `saas-acceptance` all successful. Retrieved job logs confirm the real RLS/storage/checkout/refund/price/manual-payment PostgreSQL regressions passed, and all three SaaS viewport journeys passed.
- New browser and mixed-ledger PostgreSQL cases require the follow-up CI result before accepting this patch. Local PostgreSQL/Chromium execution was unavailable in this workspace; no local pass is claimed for those suites.

## Remaining paid-launch gates

Complete the browser XSS/print sink audit and cashier/tenant-switch acceptance. Rehearse migrations, role grants and backup recovery on a copy of current production data, including historical refund snapshots. Validate manual renewals and suspension boundaries on the deployed HTTPS server. These are release gates even for an online-only product.

Before advertising dependable offline checkout, extras/options, shared cross-device catalog/settings/inventory or cloud attachment upload, finish and test those features. The current managed implementation requires connectivity for checkout and intentionally does not issue paid offline receipts. Green tests prove the covered behavior; they do not turn these missing features into resolved findings.
