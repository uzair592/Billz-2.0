# First-Restaurant Bootstrap & Repair CLI

The bootstrap CLI is the administrative bridge for provisioning the first
tenant in a controlled pilot, and for performing safe repair of historical
restaurants that lack an active cash register.

## What bootstrap creates

Running the CLI idempotently creates, in a single atomic transaction:

- a **restaurant** (name, slug, timezone, currency)
- an **initial default branch**
- an **owner user** (password hashed with the project's argon2id
  implementation and configured pepper)
- an **owner membership** associated with the default branch
- default **owner permissions** (the `owner` role maps to all POS permissions)
- default **business settings** and **tenant storage allowance** (5 GB)
- a default active **cash financial account** (`Cash` or `Default Cash`) scoped to the restaurant and default branch
- an optional **trial/active manual subscription** state appropriate for a controlled pilot

## Usage

### Provisioning the first restaurant

```sh
node src/server/bootstrap-first-restaurant.mjs
```

### Idempotent repair of missing cash accounts

For historical restaurants bootstrapped prior to default cash account provisioning:

```sh
node src/server/bootstrap-first-restaurant.mjs --repair-cash-accounts
```

The repair command:
- Identifies restaurants that have NO cash account in `financial_accounts`.
- Discovers each restaurant's default branch.
- Inserts an active cash account (`account_type = 'cash'`).
- Handles display-name collisions cleanly (naming the account `Cash - <Branch>` or `Default Cash` if `Cash` is already in use by another account type).
- Uses transaction-level advisory locks (`pg_advisory_xact_lock(839217421)`) to guarantee concurrent repair executions are serialized safely without race conditions.
- Reports only accounts that were actually created.
- Never reactivates deliberately disabled accounts (`is_active = false`), resets account balances, resets user passwords, or overwrites existing settings.

---

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `CONTROL_DATABASE_URL` | **Yes (in prod)** | PostgreSQL connection string for the provisioning control role. Must have `BYPASSRLS` or superuser privileges. |
| `DATABASE_URL` | Dev fallback | Fallback connection string for local development only. Normal restricted POS roles are rejected. |
| `PASSWORD_PEPPER` | Yes | Server password pepper string (minimum 16 characters). |
| `RESTAURANT_NAME` | Yes | Restaurant display name (e.g. `Pilot Restaurant`). |
| `RESTAURANT_SLUG` | Yes | Unique URL slug (lowercase alphanumeric and hyphens). |
| `RESTAURANT_TIMEZONE` | Yes | IANA timezone string (e.g. `Asia/Karachi`). |
| `RESTAURANT_CURRENCY` | Yes | ISO 4217 3-letter currency code (e.g. `PKR`). |
| `OWNER_EMAIL` | Yes | Owner sign-in email. |
| `OWNER_USERNAME` | No | Owner username (defaults to `OWNER_EMAIL`). |
| `OWNER_DISPLAY_NAME` | No | Owner display name (defaults to `Owner`). |
| `BOOTSTRAP_OWNER_PASSWORD` | Yes* | Owner password (minimum 10 characters). Prompted interactively if omitted. |
| `BRANCH_NAME` | No | Initial branch name (defaults to `Main`). |
| `BRANCH_CODE` | No | Initial branch code (defaults to `main`). |
| `SUBSCRIPTION_PLAN` | No | Plan code (defaults to `STANDARD`). |
| `SUBSCRIPTION_STATUS` | No | `trial` (maps to `trialing`) or `active`; default is `trial`. |
| `DATABASE_SSL_MODE` | No | SSL mode: `disable`, `require`, or `verify-full`. |
| `DATABASE_SSL_CA` | No | File path or certificate content for custom CA. |

\* If `BOOTSTRAP_OWNER_PASSWORD` is omitted and standard input is an interactive TTY, the CLI prompts securely without echoing. The password is never echoed, printed, or written to logs.

---

## Production Example

```sh
export CONTROL_DATABASE_URL="postgresql://pos_smoke_control:smoke-control-only@db.example.com:5432/restaurant_pos"
export PASSWORD_PEPPER="your-secure-production-pepper-32-bytes"
export RESTAURANT_NAME="Pilot Restaurant"
export RESTAURANT_SLUG="pilot-restaurant"
export RESTAURANT_TIMEZONE="Asia/Karachi"
export RESTAURANT_CURRENCY="PKR"
export OWNER_EMAIL="owner@pilot.example"
export BOOTSTRAP_OWNER_PASSWORD="SecureOwnerPassword123!"

node src/server/bootstrap-first-restaurant.mjs
```

---

## Security Guarantees

1. **Role Enforcement**: Normal POS application roles (`pos_app` with `NOBYPASSRLS`) fail closed with `UNSUITABLE_PROVISIONING_ROLE`. Provisioning requires `CONTROL_DATABASE_URL` pointing to a designated non-superuser control role with `BYPASSRLS`.
2. **Credential Secrecy**: Passwords and password hashes are never logged, echoed, or included in conflict error messages.
3. **Tenant Isolation**: Row-Level Security (RLS) on all domain tables is never bypassed by normal application requests.
4. **Idempotency & Replay Safety**: Re-running bootstrap with the same identifiers:
   - Does not overwrite existing business settings.
   - Does not reset existing owner passwords or sessions.
   - Does not create duplicate cash accounts or reset balances.
   - Does not overwrite or shorten active subscription periods.
5. **Conflict Protection**: If a slug or normalized email already belongs to a different entity, the command fails with `BOOTSTRAP_CONFLICT` without modifying existing records.

---

## Automated Tests

Integration tests in `tests/bootstrap-first-restaurant.test.mjs` and `tests/migration-runner.test.mjs` verify:
- Initial provisioning and atomic cash register creation.
- Scoped branch cash account verification and account name conflict resolution.
- Repeat runs without duplicate accounts, password resets, or balance mutations.
- Concurrent execution safety using advisory transaction locks.
- Role checks: rejection of normal POS roles and unprivileged connections.
- Migration checksum normalization (CRLF/LF compatibility) while strictly rejecting actual SQL syntax modifications.
