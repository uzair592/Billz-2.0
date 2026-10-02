# POS SaaS implementation status

## Current milestone

Milestone 8: order history, cancellation, and refund compensation.

The authenticated menu, business-settings, transactional order, and legacy
catalog import boundaries are implemented, together with tenant-scoped order
history and a compensating order cancellation. The original standalone POS HTML
queues every locally committed order into the durable cloud outbox without
changing its local behavior.

## Completed

- Added a dependency-free Node test harness.
- Added pricing and money-rounding characterization tests.
- Added order-status and revenue-inclusion characterization tests.
- Added checks for the primary screens and migration-critical IndexedDB keys.
- Added an inline JavaScript syntax check.
- Added a guard for the order, payment-ledger, stock, and persistence save sequence.
- Extracted the money engine and order-status rules into reusable ES modules.
- Added parity tests that compare the extracted modules with the live legacy code.
- Added the first PostgreSQL migration for users, restaurants, branches, memberships, sessions, configurable plans, restaurant subscriptions, billing records, idempotent webhooks, and audit logs.
- Added row-level tenant-isolation policies to every tenant-owned foundation table.
- Added a secrets-safe environment template.
- Added normalized, tenant-owned POS tables for menu, recipes, tables, orders, payments, stock, purchases, expenses, cash/bank accounts, transfers, and ledger entries.
- Added composite tenant foreign keys and forced row-level security across the operational schema.
- Added a temporary PostgreSQL validation environment using `compose.validation.yaml`; it stores its database in memory and contains validation-only credentials.
- Added the backend tenant transaction boundary that sets trusted PostgreSQL RLS context before repository work and always commits, rolls back, and releases safely.
- Added server-side subscription entitlement decisions for active, trial, grace-period, cancellation, expiry, and suspension states.
- Added the initial owner, manager, cashier, waiter, and kitchen permission matrix.
- Added Argon2id password hashing with a mandatory server-side pepper.
- Added opaque email-verification and session tokens that are stored only as SHA-256 hashes.
- Added rate-limited registration, verification, login, and logout HTTP routes with secure cookies and cross-site request rejection.
- Added the main project guide in `README.md`.
- Added the PostgreSQL authentication repository for atomic owner/restaurant onboarding, verification, server sessions, and revocation.
- Registration responses no longer disclose whether an email address already exists.
- Added authenticated session restoration and tenant-context loading under PostgreSQL RLS.
- Added reusable request guards enforcing session, restaurant membership, subscription, and role permission in the required order.
- Added the first server-backed POS APIs for active menu data and owner-managed business settings.
- Added `POST /api/pos/orders` behind session, restaurant membership,
  subscription, and `ORDER_CREATE` permission checks.
- Added server-authoritative order pricing; request payloads cannot supply item
  prices or costs.
- Added tenant-scoped idempotent order retries and atomic per-branch order
  numbering.
- Added transactional stock locking and deduction, recipe/cost snapshots,
  customer-payment records, and financial ledger credits.
- Added a default cash account during restaurant onboarding and validation for
  explicitly selected cash or bank accounts.
- Added order service, HTTP contract, migration, replay, and rollback tests.
- Added recursive deal-component expansion with cycle and unavailable-component
  rejection, aggregated stock usage, nested cost calculation, and immutable
  component snapshots.
- Added a durable browser order outbox and HTTP transport. Each locally saved
  order keeps one idempotency key through network/server retries; validation
  failures are held for review rather than retried forever.
- Serialized outbox mutations so a new checkout cannot be lost while an older
  order is being synchronized, and coalesced concurrent flush requests.
- Added tenant-isolated item and category offer tables, including schedule and
  unit-consistency constraints.
- Added authoritative item-first/category-second offer evaluation to order
  creation and froze the applied offer in the order-item snapshot.
- Exposed legacy item IDs, cloud UUIDs, and offer schedules through the menu API
  as the mapping contract for the upcoming importer/browser adapter.
- Added the manager/owner `POST /api/pos/import/legacy-catalog` boundary for the
  existing backup's category, subcategory, menu, deal-component, item-offer,
  and category-offer collections.
- Added pre-transaction validation for duplicate legacy IDs/item numbers,
  unknown category/subcategory/component references, invalid offer rules, and
  direct or indirect deal cycles.
- Made catalog imports atomic, idempotent by legacy menu ID, merge-based, and
  able to return the cloud UUID mapping required by the browser adapter.
- Extended that transaction to kitchen stock definitions and balances, dynamic
  menu recipes, dining areas, numbered tables, and bank accounts.
- Added tenant-unique legacy bank-account reconciliation keys and stored only a
  masked last-four account reference from the old browser data.
- Added soft-drink SKU unit balances and ice-cream SKU gram balances to the
  atomic importer, including their average costs and low-stock thresholds.
- Linked drink menu items at one unit per sale and ice-cream menu items at their
  legacy grams-per-serving value through authoritative recipe records.
- Added preflight rejection for missing SKU references and stock-key collisions.
- Added a browser cloud adapter that translates a committed legacy order into the
  server order contract using only stored legacy-to-cloud UUID mappings; browser
  prices and costs are never transmitted.
- Adapter payloads refuse any order that references an unmapped menu item,
  table, or bank account instead of guessing identifiers.
- Cloud ordering stays inactive until a successful authenticated catalog import
  has persisted the restaurant ID and its mappings, so an unconfigured device
  behaves exactly as before.
- Persisted those mappings in the existing `BiteTechPOS_DB`/`posData` IndexedDB
  store, reusing the legacy connection parameters.
- Attached the outbox to checkout through a guarded hook that runs only after the
  durable local transaction succeeds, is never awaited, and cannot fail the sale.
- Serialized outbox mutation across tabs and same-origin windows through the
  browser Web Locks API, and scoped idempotency records per restaurant.
- Added integrity tests that keep the bootstrap module reference, the
  post-commit ordering of the cloud hook, and the never-await rule in place.
- Added tenant-scoped order history with a keyset cursor, status and customer
  search, and a same-range revenue summary that excludes cancelled orders and
  counts only captured payments.
- Added a single-order detail response returning the frozen lines, charges,
  payments, and edit events exactly as they were sold.
- Added the compensating cancellation flow: locked order row, one durable
  cancellation record per order, stock returned to the branch balance as
  `sale_reversal` movements, captured payments refunded into the same financial
  account, matching ledger debits, and an order edit event recording the reason
  and exactly what was restocked.
- Made cancellation replay-safe at every layer: the stored record is returned
  for a repeated request, a partial unique index allows only one stock reversal
  per order and stock item, and ledger debits are keyed per payment.
- Added a partial unique index that makes a duplicated reversal a no-op even if
  a retry reaches the database after the transaction boundary.
- Added `ORDER_VIEW` history access for every operational role and
  `ORDER_CANCEL` restricted to owners and managers.

## Migration guardrails

- Do not remove or rename an IndexedDB key until the legacy importer supports it.
- Do not change pricing, discount, charge, payment, or rounding behavior without updating an explicit test and migration note.
- Keep `Fast_Food_POS_Custom_Bill_Header_XXXL.html` operational until the server-backed replacement passes the equivalent POS workflow tests.
- Treat PostgreSQL as authoritative only after a restaurant's migration has been reconciled and accepted.
- Keep SaaS subscription payments separate from customer order payments.

## Next milestone

Add browser sign-in, restaurant selection, and the catalog-import trigger to the
legacy interface, then drive the history and cancellation APIs from it. Report
APIs, the payment adapter, and the platform admin area follow that work.

All six migrations still need validation against a real PostgreSQL instance.
Docker Desktop is installed but its Linux engine could not start in the current
non-interactive session, so the migrations are contract-tested but have not yet
been executed by PostgreSQL.

When Docker is available, run:

```powershell
docker compose -f compose.validation.yaml up --abort-on-container-exit --exit-code-from migrations
docker compose -f compose.validation.yaml down
```

## Running the tests

```powershell
npm test
```

The current suite has 138 tests and runs without external services.
