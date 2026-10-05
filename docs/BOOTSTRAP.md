# First-Restaurant Bootstrap CLI

The bootstrap CLI is the fast-track bridge for creating the first
usable tenant in a controlled pilot. It is a command-line tool for the
platform owner; the full platform-admin web portal is a separate
milestone.

## What it creates

Running the CLI idempotently creates, in a single transaction:

- a **restaurant** (name, slug, timezone, currency)
- an **initial branch**
- an **owner user** (password hashed with the project's argon2id
  implementation and the configured pepper)
- an **owner membership** with the default branch
- default **owner permissions** (the `owner` role maps to every
  permission)
- an optional **trial/active subscription** state appropriate for a
  controlled pilot

## Usage

```sh
node src/server/bootstrap-first-restaurant.mjs
```

### Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `PASSWORD_PEPPER` | yes | the same pepper the application uses (16+ chars) |
| `RESTAURANT_NAME` | yes | display name |
| `RESTAURANT_SLUG` | yes | lowercase letters, numbers, hyphens |
| `RESTAURANT_TIMEZONE` | yes | IANA timezone, e.g. `Asia/Karachi` |
| `RESTAURANT_CURRENCY` | yes | ISO 4217 code, e.g. `PKR` |
| `OWNER_EMAIL` | yes | owner sign-in email |
| `OWNER_DISPLAY_NAME` | no | defaults to `Owner` |
| `BOOTSTRAP_OWNER_PASSWORD` | yes* | 10+ characters, or run interactively |
| `BRANCH_NAME` | no | defaults to `Main` |
| `BRANCH_CODE` | no | defaults to `main` |
| `SUBSCRIPTION_PLAN` | no | defaults to `STANDARD` |
| `SUBSCRIPTION_STATUS` | no | `trial` (maps to `trialing`) or `active`; default `trial` |

\* If `BOOTSTRAP_OWNER_PASSWORD` is not set and stdin is a TTY, the
CLI prompts interactively. The password is never echoed, printed, or
logged.

### Example

```sh
export DATABASE_URL="postgresql://pos_app:...@db.example.com:5432/restaurant_pos"
export PASSWORD_PEPPER="<the application pepper>"
export RESTAURANT_NAME="Pilot Restaurant"
export RESTAURANT_SLUG="pilot-restaurant"
export RESTAURANT_TIMEZONE="Asia/Karachi"
export RESTAURANT_CURRENCY="PKR"
export OWNER_EMAIL="owner@pilot.example"
export BOOTSTRAP_OWNER_PASSWORD="<a strong password>"

node src/server/bootstrap-first-restaurant.mjs
```

## Security

- **No default credentials.** The password is never hardcoded. It is
  read from `BOOTSTRAP_OWNER_PASSWORD` or an interactive prompt.
- **Password hashing.** The password is hashed with the project's
  existing argon2id implementation (`src/server/auth/passwords.mjs`)
  and the configured pepper. The hash is stored, never printed.
- **No secret output.** The CLI logs the restaurant slug, IDs, and
  owner email — never the password or its hash.
- **Idempotent.** Re-running with the same identifiers does not create
  duplicates; the restaurant, branch, owner, and membership are
  matched by their natural keys.
- **Fail on conflict.** Conflicting existing data (for example, a
  different restaurant already using the slug) fails clearly instead of
  overwriting it.

## Idempotency

The CLI matches existing rows by natural key:

- `restaurants.slug`
- `branches.(restaurant_id, code)`
- `users.normalized_email`
- `restaurant_memberships.(restaurant_id, user_id)`

Re-running updates mutable fields (display name, restaurant name) and
leaves the identifiers stable. It never creates a second restaurant,
branch, owner, or membership for the same identifiers.

## Tests

Real-PostgreSQL tests live in
`tests/bootstrap-first-restaurant.test.mjs` and cover creation,
password hashing and verification, idempotency, input validation, and
the guarantee that the password and hash are never printed.
