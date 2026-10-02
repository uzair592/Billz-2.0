# POS SaaS implementation status

## Current milestone

Milestone 7: server-backed POS APIs.

The authenticated menu, business-settings, and transactional order boundaries
are implemented. The original standalone POS HTML remains operational while the
browser UI is incrementally connected to these APIs.

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

## Migration guardrails

- Do not remove or rename an IndexedDB key until the legacy importer supports it.
- Do not change pricing, discount, charge, payment, or rounding behavior without updating an explicit test and migration note.
- Keep `Fast_Food_POS_Custom_Bill_Header_XXXL.html` operational until the server-backed replacement passes the equivalent POS workflow tests.
- Treat PostgreSQL as authoritative only after a restaurant's migration has been reconciled and accepted.
- Keep SaaS subscription payments separate from customer order payments.

## Next milestone

Implement the validated legacy catalog importer and reconcile numeric menu,
table, stock, and financial-account IDs to cloud UUIDs. Then the tested outbox
can be attached to the legacy checkout without trusting browser identifiers or
prices. Cancellation/refund compensation and order history APIs follow that
work.

All four migrations still need validation against a real PostgreSQL instance.
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

The current suite has 98 tests and runs without external services.
