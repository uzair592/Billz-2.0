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
- Secure HttpOnly session cookies and cross-site request rejection.
- In-memory Docker Compose environment for executing database migrations.

Not yet complete:

- Transactional email provider connection.
- Legacy menu/table/account data import and ID reconciliation before attaching
  the outbox to the existing checkout screen.
- Legacy IndexedDB backup importer.
- Payment-provider adapter and signed webhook endpoint.
- Billing and platform-admin interfaces.
- Offline outbox synchronization.
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
│       └── 002_tenant_pos.sql
├── docs/
│   └── IMPLEMENTATION_STATUS.md
├── src/
│   ├── domain/
│   │   ├── money-engine.mjs
│   │   └── order-status.mjs
│   └── server/
│       ├── auth/
│       ├── authorization/
│       ├── database/
│       ├── http/
│       └── subscriptions/
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
| `APP_ORIGIN` | Only trusted browser origin |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Session-related server secret |
| `PASSWORD_PEPPER` | Secret appended before Argon2id hashing |
| `PAYMENT_PROVIDER` | Selected billing adapter |
| `PAYMENT_API_KEY` | Server-only payment credential |
| `PAYMENT_WEBHOOK_SECRET` | Webhook signature secret |
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
- Add cancellation, refund, and report API tests.
- Add a cross-tab browser lock around outbox mutation before enabling multiple
  tabs on the same POS device.
- Configure object storage and signed access.
- Add CSP after frontend extraction removes incompatible inline handlers.
- Configure HTTPS, HSTS, monitoring, structured logs, and alerts.
- Enable automated backups and perform restoration drills.
- Complete responsive browser and receipt-printer testing.
- Complete a security review before accepting real customer or payment data.

## Development rule

Do not remove or rewrite the original POS behavior merely to fit a new framework. New server-backed behavior must first match the characterization tests or include a documented, intentionally approved behavior change.
