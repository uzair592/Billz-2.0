# POS SaaS implementation status

## Current milestone

Milestone 10: subscription checkout, verified billing webhooks, and the billing
surface an owner uses to pay.

A restaurant owner can now see plans, start a provider checkout, change plan,
cancel, resume, and read payment history, and a verified provider webhook is the
only thing that can ever move a subscription to paid. Tenant-scoped order
history, compensating order cancellation, browser sign-in, restaurant selection,
and catalog import are implemented. The standalone POS HTML keeps its offline
behavior at every step.

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
- Added an authenticated-user transaction boundary that sets `app.user_id`
  without any tenant context, so a device can discover its restaurants while
  every tenant table stays invisible.
- Added read-only row-level security policies that expose a caller its own
  active memberships and nothing else; no write access was widened.
- Extended `GET /api/auth/me` with the account's own restaurant memberships so a
  device can send the trusted restaurant header the POS API requires.
- Added a browser cloud session client that can neither read nor forge the
  server-set HttpOnly session, auto-selects the only restaurant when there is
  exactly one, never guesses between several, and forgets a restaurant the
  account can no longer use.
- Added a legacy catalog snapshot builder that reads this device's own IndexedDB
  collections and emits the exact import contract, verified against the server
  schema, and refuses rather than silently dropping an unusable record.
- Wired the import to read the signed-in restaurant automatically, so cloud
  ordering still cannot activate without an accepted import.
- Added a cloud account panel to the POS dashboard for sign-in, restaurant
  selection, catalog copy, and sign-out, hidden until it is opened and fully
  optional for the offline till.
- Added the single payment-provider seam: one adapter contract, a Stripe adapter,
  and a development adapter that cannot start a checkout and refuses every
  webhook, so a local environment can never accidentally grant paid access.
- Added Stripe webhook verification over the exact received bytes: HMAC-SHA256
  compared in constant time, with a timestamp tolerance so a captured request
  cannot be replayed.
- Added the billing webhook service with the security order fixed in code:
  verify the signature, claim the event under a unique provider key so a retry
  cannot apply twice, and only then resolve the restaurant and update the
  subscription inside a normal tenant transaction. An unverified payload is
  recorded as refused and never applied.
- Made webhook application fail closed. Access is only extended by a verified
  event that also carries a paid period, so a completed checkout on its own
  leaves the subscription unpaid; a settled invoice is what activates it. An
  already active subscription is never demoted because a later event happened
  to carry less information, and an event with no period never revokes access.
- Recorded the provider subscription identifier and routed later events by
  subscription, customer, or checkout session, so an event is always
  attributable to exactly one restaurant.
- Added a `past_due` grace window rather than an immediate cut-off, and recorded
  each provider payment exactly once, keyed by the provider payment identifier.
- Added a `pending_checkout` subscription state so a restaurant record can exist
  before any money moves, and included it in the one-current-subscription
  partial index so a second checkout cannot be started by accident.
- Added owner-only billing routes, deliberately reachable without paid
  subscription access: a restaurant that has lost POS access can still see the
  bill and pay to get the access back.
- Registered the webhook in its own Fastify context with a raw body parser,
  because a signature computed over a re-serialized payload is unverifiable.
- Added webhook, Stripe adapter, migration contract, and billing HTTP tests.

## Migration guardrails

- Do not remove or rename an IndexedDB key until the legacy importer supports it.
- Do not change pricing, discount, charge, payment, or rounding behavior without updating an explicit test and migration note.
- Keep `Fast_Food_POS_Custom_Bill_Header_XXXL.html` operational until the server-backed replacement passes the equivalent POS workflow tests.
- Treat PostgreSQL as authoritative only after a restaurant's migration has been reconciled and accepted.
- Keep SaaS subscription payments separate from customer order payments.

## Next milestone

Drive order history and cancellation from the POS interface, then add partial
refunds and sales reports. The platform admin area follows that work.

The repository contains ten forward-only migrations. Apply all of them to a
clean PostgreSQL 17 instance with `compose.validation.yaml` after any schema
change:

```powershell
npm run validate:database
docker compose -f compose.validation.yaml down
```

## Running the tests

```powershell
npm test
```

The current external-service-free run has 278 passing tests. PostgreSQL
integration tests run separately with `npm run test:integration`.
