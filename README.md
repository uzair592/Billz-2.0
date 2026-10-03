# Bite Tech Café & Restaurant POS SaaS

This project is converting an existing offline café and restaurant POS into a secure, multi-tenant, subscription-based cloud application while preserving its established POS behavior.

The original application remains available in:

```text
Fast_Food_POS_Custom_Bill_Header_XXXL.html
```

It is deliberately being kept operational while domain rules are characterized, extracted, and moved behind a server API.

## Current implementation status

Implemented foundations:

- Characterization tests for the existing POS.
- Reusable money and order-status domain modules with legacy parity tests.
- PostgreSQL platform schema for users, restaurants, branches, memberships, sessions, devices, plans, subscriptions, billing, webhooks, and audits.
- Tenant-owned POS schema for menus, recipes, orders, payments, stock, purchases, expenses, cash/bank accounts, transfers, and ledgers.
- PostgreSQL row-level security on every restaurant-owned table.
- Composite tenant foreign keys preventing records from being linked across restaurants.
- Tenant-aware backend transaction boundary.
- Restaurant subscription access policy.
- Owner, manager, cashier, waiter, and kitchen permission matrix.
- Argon2id password hashing with a server-side pepper.
- Random opaque session and email-verification tokens; only their SHA-256 hashes are stored.
- Rate-limited registration, email-verification, login, and logout HTTP routes.
- PostgreSQL authentication repository with atomic restaurant-owner onboarding.
- Authenticated tenant-context resolution and membership, subscription, and permission request guards.
- Tenant-protected menu and business-settings HTTP APIs.
- Tenant-protected transactional order API for standard items and deals, with
  server-authoritative pricing, idempotent retries, stock reservation,
  recursive component/recipe snapshots, cost snapshots, payment validation,
  and ledger writes.
- Durable browser order outbox with stable idempotency keys, exponential retry
  backoff, permanent-failure holding, and in-process concurrency protection.
- Tenant-owned item and category offer rules, evaluated by the order service in
  integer minor units and frozen into order snapshots.
- Menu responses expose legacy numeric item IDs alongside cloud UUIDs to support
  a reconciled migration instead of trusting browser-supplied identifiers.
- Manager/owner legacy catalog import endpoint with atomic upserts, deal-graph
  validation, offer migration, and returned cloud ID mappings.
- The same atomic import reconciles kitchen stock definitions/balances, menu
  recipes, halls, numbered tables, and masked bank accounts against the default
  branch.
- Soft-drink unit inventory and ice-cream gram inventory are imported as typed
  stock SKUs and linked to their menu items through server-side recipes.
- Legacy-to-cloud ID mappings persisted in the browser after an accepted catalog
  import, with cloud ordering inactive until that import succeeds.
- Guarded checkout hook that queues each locally committed order into the
  durable outbox without ever blocking or failing the local POS save.
- Cross-tab outbox serialization through the browser Web Locks API.
- Tenant-scoped order history with a keyset cursor, status and customer search,
  and a revenue summary that excludes cancelled orders.
- A compensating order cancellation that returns consumed stock, refunds captured
  payments into the same account, reverses the ledger, and records an auditable
  cancellation event. Replays never double-compensate.
- An authenticated-user boundary and read-only policies that let a device list
  only its own restaurant memberships before any tenant is selected.
- `GET /api/auth/me` returns the account's own restaurant memberships alongside
  the user, so a till can send the trusted restaurant header.
- A browser cloud session client that reads and writes only the selected
  restaurant, since the session itself stays in an HttpOnly cookie.
- A catalog snapshot builder that converts this device's IndexedDB collections
  into the exact import contract and refuses rather than dropping records.
- A dashboard cloud panel for sign-in, restaurant selection, catalog copy, and
  sign-out that stays hidden and fully optional for an offline till.
- A payment-provider seam with a Stripe adapter and a development adapter that
  cannot start a checkout and refuses every webhook.
- A signed billing webhook that verifies the raw bytes, claims each provider
  event once, and is the only path that can ever move a subscription to paid.
  Access is only granted by a verified event that also carries a paid period, so
  a completed checkout alone leaves the subscription unpaid.
- Owner-only billing routes for plans, checkout, plan changes, cancellation,
  resume, and payment history. They stay reachable without paid subscription
  access so a restaurant that has lost POS access can still pay.
- Secure HttpOnly session cookies and cross-site request rejection.
- In-memory Docker Compose environment for executing database migrations.

Not yet complete:

- Transactional email provider connection.
- Legacy IndexedDB order/expense/stock history import.
- Partial refunds and sales-report APIs.
- Driving order history and cancellation from the POS interface.
- A billing page in the POS interface.
- Platform-admin interface.
- Production deployment.

The current implementation checklist is also maintained in [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

## Architecture

```text
Desktop / Tablet / Mobile Browser
                |
              HTTPS
                |
       Fastify modular backend
       /         |          \
 Authentication POS API   Billing adapter
       |         |              |
       |    Tenant transaction  Payment provider
       |         |              |
       +---------+--------------+
                 |
            PostgreSQL
                 |
          Object file storage

Platform administration uses separately authorized routes and never inherits
restaurant permissions from the normal POS interface.
```

The initial deployment remains a modular monolith. Microservices and Kubernetes are intentionally excluded until there is a demonstrated need.

## Tenant security model

Every business record ultimately belongs to a restaurant.

The backend request sequence is:

```text
Session authentication
  → active restaurant membership
  → restaurant status
  → subscription entitlement
  → role permission
  → PostgreSQL tenant transaction
  → POS operation
```

The trusted restaurant ID comes from the authenticated membership selected by the server. Resource bodies and URL IDs are never trusted to establish tenant ownership.

Before a restaurant has been chosen, a request runs under an authenticated-user
context that sets `app.user_id` and leaves `app.restaurant_id` empty. Row-level
security then hides every tenant table, so that boundary can only read the
caller's own active memberships and nothing else.

At the beginning of every tenant transaction, the backend sets:

```sql
SELECT set_config('app.restaurant_id', $1, true);
```

PostgreSQL row-level-security policies then restrict all reads and writes to that restaurant. Composite foreign keys provide a second database-level defense against cross-restaurant relationships.

## Restaurant roles

The initial roles are:

| Role | Intended access |
|---|---|
| Owner | All restaurant operations, employees, settings, reports, and billing |
| Manager | Orders, payments, tables, kitchen, menu, inventory, expenses, finance, and reports |
| Cashier | Create/view orders, collect payments, print receipts, and view tables |
| Waiter | Create/view/edit orders and view tables |
| Kitchen | View orders and update kitchen status |

The subscription belongs to the restaurant. Employees do not purchase individual subscriptions.

## Subscription behavior

Supported states:

```text
pending_checkout
trialing
active
past_due
cancel_at_period_end
cancelled
expired
suspended
```

Rules currently encoded by the server policy:

- Active subscriptions receive full access until the current period ends.
- Trials receive full access until the trial ends.
- Past-due subscriptions retain full access only during the configured grace period.
- Cancellation at period end preserves access through the already-paid period.
- Cancelled, expired, and suspended restaurants retain billing-level access but cannot perform protected POS mutations.
- Platform suspension overrides an otherwise active subscription.
- Expiration never automatically deletes restaurant data.

`pending_checkout` exists because a subscription record has to be written when a
checkout starts, before any money moves. It grants nothing: only a verified
provider event that also carries a paid period can move a restaurant to `active`.

Billing endpoints are intentionally reachable without paid subscription access.
A restaurant that has lost POS access must still be able to read its bill and
pay, or it would be permanently stuck.

## Existing POS behavior being preserved

The legacy application includes:

- Dine-in, takeaway, and delivery orders.
- Halls and numbered tables.
- Discounts, delivery charges, and additional charges.
- Paid, unpaid, and partial-payment orders.
- Cash and bank-account ledgers.
- Order editing, cancellation, stock restoration, and receipt reprinting.
- Menu categories, subcategories, deals, recipes, and extras.
- Kitchen ingredient, juice, soft-drink, and ice-cream stock.
- Purchases, expenses, receipt photographs, and business reports.
- Customer and kitchen receipt printing.
- Browser and desktop ESC/POS printer support.
- JSON backup and restore.
- Offline IndexedDB storage.

Customer names and phone numbers currently exist only as order snapshots. A separate customer-management module has not been invented during migration.

## Project structure

```text
.
├── Fast_Food_POS_Custom_Bill_Header_XXXL.html  Existing operational POS
├── database/
│   └── migrations/
│       ├── 001_platform_foundation.sql
│       ├── 002_tenant_pos.sql
│       ├── 003_order_idempotency.sql
│       ├── 004_menu_offers.sql
│       ├── 005_legacy_operational_keys.sql
│       ├── 006_order_cancellations.sql
│       └── 007_session_tenant_selection.sql
├── docs/
│   └── IMPLEMENTATION_STATUS.md
├── src/
│   ├── client/
│   │   ├── cloud-session.mjs
│   │   ├── legacy-catalog-snapshot.mjs
│   │   ├── legacy-cloud-adapter.mjs
│   │   ├── legacy-cloud-bootstrap.mjs
│   │   └── order-outbox.mjs
│   ├── domain/
│   │   ├── money-engine.mjs
│   │   └── order-status.mjs
│   └── server/
│       ├── auth/
│       ├── authorization/
│       ├── database/
│       ├── http/
│       ├── pos/
│       ├── subscriptions/
│       └── tenancy/
├── tests/
├── compose.validation.yaml
├── .env.example
└── package.json
```

## Requirements

- Node.js 22 or newer
- npm
- Docker Desktop with the Linux engine, or PostgreSQL 17, for database validation

## Local setup

Install dependencies:

```powershell
npm install
```

Create a local environment file:

```powershell
Copy-Item .env.example .env
```

Replace every placeholder secret. Do not commit `.env`.

Generate secrets with a cryptographically secure tool. `SESSION_SECRET` and `PASSWORD_PEPPER` must be different values.

## Running tests

Run the complete suite:

```powershell
npm test
```

Run only legacy behavior checks:

```powershell
npm run test:legacy
```

The catalog migration boundary is `POST /api/pos/import/legacy-catalog`. It
accepts the existing backup collections `pos_categories`, `pos_subcategories`,
`pos_category_offers`, `pos_menu`, `pos_stock_item_defs`,
`pos_ingredient_stock`, `pos_softdrink_stock`, `pos_icecream_stock`,
`pos_halls_list`, `pos_total_tables`, and `pos_bank_accounts`. The response maps
imported legacy menu, stock, table, and financial-account identifiers to
authoritative cloud UUIDs. This endpoint is merge-based and does not delete
cloud records omitted from a snapshot.

The order history boundary is `GET /api/pos/orders`, which accepts an optional
`businessDate` or `from`/`to` range, `orderStatus`, `paymentStatus`, `search`,
`limit`, and an opaque `cursor`. It returns the page, a same-range summary, and
the next cursor. `GET /api/pos/orders/:orderId` returns one order with its
frozen lines, charges, payments, and edit events.

`POST /api/pos/orders/:orderId/cancel` is the compensating transaction for a
sale. It requires an `idempotencyKey` and optional `reason`, returns consumed
stock to the branch as `sale_reversal` movements, marks captured payments as
refunded, writes the matching ledger debits into the same financial accounts,
and records an `order_edit_events` entry with the reason and the exact restocked
quantities. Replaying the same request returns the stored cancellation instead
of compensating twice. Partial refunds are not yet implemented.

The billing boundaries are `GET /api/billing`, `POST /api/billing/checkout`,
`POST /api/billing/change-plan`, `POST /api/billing/cancel`,
`POST /api/billing/resume`, and `GET /api/billing/payments`. They require an
owner session and the trusted restaurant header, and they do not require paid
subscription access.

`POST /webhook` is the payment-provider endpoint. It carries no session and no
tenant header: the request body is kept as raw bytes so the signature can be
verified exactly as sent, and a failed verification is recorded and refused with
no database effect. Configure the provider to deliver
`checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.paid`, and `invoice.payment_failed`.

Validate the Docker Compose file:

```powershell
npm run validate:compose
```

## Validating database migrations

The validation environment uses a temporary in-memory PostgreSQL database. Its credentials are validation-only and it does not expose a host port.

With Docker Desktop running:

```powershell
npm run validate:database
docker compose -f compose.validation.yaml down
```

The validator applies every SQL file in `database/migrations` in filename order and stops on the first PostgreSQL error.

## Environment variables

The current template defines:

| Variable | Purpose |
|---|---|
| `NODE_ENV` | Runtime environment |
| `TRUSTED_ORIGIN` | Only trusted browser origin |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Session-related server secret |
| `PASSWORD_PEPPER` | Secret appended before Argon2id hashing |
| `PAYMENT_PROVIDER` | Selected billing adapter |
| `STRIPE_SECRET_KEY` | Server-only Stripe credential |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature secret |
| `STRIPE_PUBLISHABLE_KEY` | Browser-safe Stripe key |
| `OBJECT_STORAGE_*` | Tenant file-storage configuration |

Payment keys and object-storage credentials must never be exposed to browser JavaScript.

## Authentication security

- Passwords are hashed with Argon2id.
- A separate server-side pepper is required.
- Registration does not create a logged-in session until email verification succeeds.
- Verification and session tokens contain 256 bits of randomness.
- Only SHA-256 token hashes are persisted.
- Login responses use secure HttpOnly SameSite cookies.
- Authentication routes are rate limited.
- State-changing cross-site requests are rejected.
- Error responses do not return password hashes, token hashes, or internal stack traces.

The old shared PIN is not considered cloud authentication. It may later remain only as a rate-limited, per-employee till-unlock convenience.

## Database conventions

- UUID internal identifiers.
- Restaurant and branch ownership is explicit.
- Money uses integer minor units.
- Historical order lines retain product, price, cost, and recipe snapshots.
- Operational writes use idempotency keys where retries are possible.
- Stock changes are represented by an append-only movement ledger.
- Subscription billing payments remain separate from customer order payments.
- Timestamps are stored with timezone; business dates are stored separately.
- Reports are derived from transactions rather than stored as mutable totals.

## Legacy migration approach

The existing JSON backup format will become the initial import format.

Migration will:

1. Create or select the target restaurant and default branch.
2. Validate the backup schema and retain the original file.
3. Import business and receipt settings.
4. Import menu categories, items, recipes, and images.
5. Import inventory definitions, balances, and purchase history.
6. Import orders with original price and cost snapshots.
7. Import expenses, cash/bank accounts, and ledger history.
8. Reconcile counts, sales totals, stock values, and account balances.
9. Produce an import report before the server becomes authoritative.

The local IndexedDB data must not be deleted automatically after migration.

## Offline roadmap

PostgreSQL will remain the source of truth. IndexedDB will become a cache and transactional outbox.

Offline-capable operations will use:

- Client-generated UUIDs.
- Idempotency keys.
- Device identity.
- Append-only order and stock events where practical.
- Server versions for conflict detection.
- Explicit conflict handling rather than silent overwrites.
- A short-lived signed subscription entitlement.

Billing, employee administration, permission changes, and destructive operations will remain online-only.

## Payment roadmap

The final provider will be selected according to merchant jurisdiction, settlement currency, recurring-payment availability, taxation, and webhook reliability.

The provider integration will use an adapter with operations such as:

```text
createCustomer
createCheckoutSession
changeSubscription
cancelSubscription
openCustomerPortal
verifyWebhook
normalizeEvent
```

The frontend will never activate a subscription. Only verified, idempotently processed server webhooks may update paid access.

## Production checklist

Before commercial deployment:

- Execute all migrations against PostgreSQL in CI.
- Add migration rollback/recovery documentation.
- Connect transactional email and payment providers.
- Add tenant-isolation integration tests using two restaurants.
- Add partial-refund and report API tests.
- Configure object storage and signed access.
- Add CSP after frontend extraction removes incompatible inline handlers.
- Configure HTTPS, HSTS, monitoring, structured logs, and alerts.
- Enable automated backups and perform restoration drills.
- Complete responsive browser and receipt-printer testing.
- Complete a security review before accepting real customer or payment data.

## Development rule

Do not remove or rewrite the original POS behavior merely to fit a new framework. New server-backed behavior must first match the characterization tests or include a documented, intentionally approved behavior change.
