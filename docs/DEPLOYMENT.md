# Deployment

This document describes how to deploy Billz 2.0 to a Docker-compatible
platform with a managed PostgreSQL database. The model is one
application container plus one managed PostgreSQL 17 database.

> **Pricing:** Any prices mentioned below are illustrative and must be
> confirmed on the deployment date. Do not rely on them for budgeting.

## Architecture

- **Application:** a single Node.js 22 container that runs the Fastify
  API and serves the legacy POS client (HTML + ES modules).
- **Database:** a managed PostgreSQL 17 instance. All business data
  (orders, users, subscriptions, refunds, reports, configuration
  records) lives in PostgreSQL. The application container is
  stateless and stores nothing on its filesystem.
- **Migrations:** applied as a release command, not at application
  startup.
- **First tenant:** created with the bootstrap CLI.

## 1. Create managed PostgreSQL

Create a PostgreSQL 17 database on your provider (Railway, Render,
Supabase, AWS RDS, Google Cloud SQL, etc.). Record:

- the connection string (`DATABASE_URL`)
- whether the provider requires TLS (most managed databases do)
- the CA certificate if the provider uses a private CA

Configure the database to require SSL where the provider supports it.

## 2. Configure environment variables

Set the following on the application service. Use real secrets — the
application refuses placeholder values in production.

| Variable | Required | Notes |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` |
| `HOST` | no | defaults to `0.0.0.0` |
| `PORT` | no | defaults to `3000` |
| `DATABASE_URL` | yes | managed PostgreSQL connection string |
| `DATABASE_SSL_MODE` | recommended | `require` or `verify-full` for managed PostgreSQL |
| `DATABASE_SSL_CA` | conditional | PEM CA certificate when `DATABASE_SSL_MODE=verify-full` |
| `DATABASE_POOL_MAX` | no | connection pool size, default `10` |
| `TRUSTED_ORIGINS` | yes | comma-separated exact HTTPS origins, no wildcards |
| `SESSION_SECRET` | yes | at least 32 random bytes |
| `PASSWORD_PEPPER` | yes | at least 32 random bytes, different from `SESSION_SECRET` |
| `MAIL_PROVIDER` | conditional | transactional mail provider name; when absent in production, self-registration is disabled |
| `PAYMENT_PROVIDER` | yes | `stripe` or `manual` |
| `STRIPE_SECRET_KEY` | conditional | required when `PAYMENT_PROVIDER=stripe` |
| `STRIPE_WEBHOOK_SECRET` | conditional | required when `PAYMENT_PROVIDER=stripe` |
| `STRIPE_PUBLISHABLE_KEY` | no | publishable key for checkout |
| `LOG_LEVEL` | no | `info` recommended for production |
| `TRUST_PROXY` | conditional | `true` only behind a trusted reverse proxy |

Generate secrets with a CSPRNG, for example:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 3. Configure the release / migration command

Migrations are applied as a separate release step so two application
instances never migrate concurrently. Set the release command to:

```sh
node src/server/database/migration-runner.mjs
```

The runner:

- applies migrations in filename order,
- holds a PostgreSQL advisory lock so only one instance migrates at a
  time,
- records each applied migration with a SHA-256 checksum,
- refuses to continue if an already-applied migration's checksum
  changed,
- rolls back a failed migration atomically,
- never drops or resets the database.

On platforms that support a release phase (Railway, Render), configure
this as the release command. On platforms that do not, run it once
manually before scaling the application past one replica.

## 4. Deploy the application container

Deploy the image built from the repository `Dockerfile`. The container:

- runs as a non-root user,
- listens on the configured `PORT`,
- serves the API and the POS client,
- exposes `/health/live` and `/health/ready`.

## 5. Configure health checks

- **Liveness:** `GET /health/live` — confirms the process is alive.
  Does not query the database.
- **Readiness:** `GET /health/ready` — verifies PostgreSQL
  connectivity and that migrations are current. Returns `200` only
  when the application can safely receive traffic, `503` otherwise.

Configure the platform to restart the container on liveness failure and
to stop routing traffic on readiness failure.

## 6. Configure the Stripe webhook URL

When `PAYMENT_PROVIDER=stripe`, configure the Stripe webhook endpoint
to point at:

```
https://<your-domain>/webhook
```

The endpoint verifies the raw request body against
`STRIPE_WEBHOOK_SECRET`. The application never parses and re-serializes
the webhook body, so the signature remains verifiable.

## 6a. Registration and transactional mail

Transactional email is not implemented. In production, self-registration
is therefore **disabled by default** unless a real transactional mail
provider is configured via `MAIL_PROVIDER`. This is deliberate: a
verification mail that is never delivered would lock a restaurant out of
its own account.

- The production server starts with registration disabled when no
  provider is configured.
- A registration attempt while disabled fails with `503`
  `REGISTRATION_DISABLED` and never creates a pending user.
- The production mailer never logs verification tokens or passwords.
- Bootstrap-created owners are written directly by the bootstrap CLI and
  are not self-registrations, so they are unaffected.
- Development keeps the existing logging mailer behavior.

To enable self-registration in production, configure a real transactional
mail provider and set `MAIL_PROVIDER` to its name. Until then, create
owners with the bootstrap CLI (section 9).

## 7. Add a custom domain and configure DNS

Add a custom domain on the platform, then create a `CNAME` (or
`ALIAS`/`ANAME` for apex domains) record pointing to the platform's
domain. Allow time for DNS propagation.

## 8. Verify HTTPS

Confirm the platform provisions a TLS certificate and that
`https://<your-domain>` loads over HTTPS. The application requires
HTTPS trusted origins in production and sets secure cookies.

## 9. Run the first-restaurant bootstrap

Create the first tenant with the bootstrap CLI. Run it once against the
managed database:

```sh
node src/server/bootstrap-first-restaurant.mjs
```

with these environment variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | managed PostgreSQL connection string |
| `PASSWORD_PEPPER` | yes | the same pepper the application uses |
| `RESTAURANT_NAME` | yes | display name |
| `RESTAURANT_SLUG` | yes | lowercase, hyphenated |
| `RESTAURANT_TIMEZONE` | yes | IANA timezone, e.g. `Asia/Karachi` |
| `RESTAURANT_CURRENCY` | yes | ISO 4217 code, e.g. `PKR` |
| `OWNER_EMAIL` | yes | owner sign-in email |
| `OWNER_DISPLAY_NAME` | no | defaults to `Owner` |
| `BOOTSTRAP_OWNER_PASSWORD` | yes* | at least 10 characters; or run interactively |
| `SUBSCRIPTION_STATUS` | no | `trial` (maps to `trialing`) or `active`; default `trial` |

\* The password is read from the environment or an interactive prompt.
It is hashed with the project's argon2id implementation and is never
printed or logged. Re-running with the same identifiers is idempotent
and does not create duplicates.

## 10. Verify login and POS loading

- Sign in as the owner email with the bootstrap password.
- Confirm the POS page loads at `https://<your-domain>/`.
- Confirm the reports and refunds screens load for the owner role.

## 11. Verify Stripe test-mode checkout and webhook

In Stripe test mode:

- start a checkout from the billing screen,
- complete a test payment,
- confirm the webhook is received and the subscription becomes active,
- confirm the POS grants full access for the active subscription.

## Where application data is stored

All application data is stored in the managed PostgreSQL database:

- users, sessions, and password hashes
- restaurants, branches, and memberships
- orders, order items, payments, and refunds
- menu items, stock, and financial accounts
- subscriptions, plans, and billing events
- sales reports (computed from orders)

The application container filesystem holds only the application code and
its dependencies. No business data is written to the container
filesystem, so application data survives application redeployment and
container replacement.

## What survives redeployment

- **Survives:** everything in PostgreSQL — tenants, orders, users,
  subscriptions, refunds, reports, and configuration records.
- **Does not survive:** the container's local filesystem (which holds
  only code). Redeploying the application does not affect business
  data.

Because the database is separate from the application container, you can
redeploy, scale, or roll back the application without touching tenant
data.
