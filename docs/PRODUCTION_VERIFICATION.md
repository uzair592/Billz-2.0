# Production verification

Complete [DEPLOY_FROM_ZERO.md](DEPLOY_FROM_ZERO.md) first. Keep payment providers manual. These checks complement provider backups and monitoring; CI timings do not predict your chosen host's capacity.

## Production security and database checks

With PostgreSQL client tools matching the server major version, run `npm test`, `npm run test:postgres`, `npm run test:fullstack`, `npm run test:integration`, and `npm run test:browser:saas-core`. Use a disposable test database with `TEST_DATABASE_ADMIN_URL`, `TEST_DATABASE_URL` (NOBYPASSRLS role) and `TEST_CONTROL_DATABASE_URL` (non-superuser BYPASSRLS role). The tests recreate the test schema; do not point test variables at production.

`production-verification-postgres.test.mjs` starts the real production composition with HTTPS origins, distinct random secrets and explicit trusted proxy CIDRs. It checks Secure/HttpOnly/SameSite cookies for owners and administrators, HSTS, admin CSP, readiness, rejection of localhost/insecure origins, placeholder secrets, missing proxy CIDRs and unsafe database roles. It then runs the load script over an actual HTTP listener and verifies a full dump/restore. Existing deployment tests cover migration-aware readiness and bootstrapping.

## Daily backup verification

Set these variables in the scheduled job's secret environment (never commit their values):

| Variable | Purpose |
| --- | --- |
| `BACKUP_DATABASE_URL` | Source database account with SELECT on every dumped table and permission to bypass forced tenant RLS. A migration/backup account is appropriate; the POS runtime account cannot make a complete cross-tenant backup. |
| `BACKUP_SCRATCH_ADMIN_URL` | Separate verification cluster's maintenance database URL. Account needs CREATEDB, restore/object privileges and BYPASSRLS (or superuser on this isolated verification cluster) to count all restored tenant rows. The app/control runtime roles must not receive these privileges. |
| `BACKUP_DIR` | Private durable dump directory, e.g. `/var/lib/billz/backups`. |

Run `npm run backup:verify`. Install `pg_dump` and `pg_restore` matching the source PostgreSQL major version; restore on the same or a newer compatible server version with required extensions installed. For hosted databases without CREATEDB, use a separate verification PostgreSQL instance. URLs preserve libpq TLS options such as `sslmode=verify-full`; passwords go into child-process environment, never arguments or logs.

The tool opens a read-only repeatable-read transaction, exports its snapshot, counts all main tables, and uses that same snapshot for `pg_dump`. Concurrent writes cannot create a false count mismatch. It creates a uniquely named `billz_verify_*` database, restores there, compares all counts, and drops only the database it created, including on failure. It never restores into an operator-supplied existing database. Dumps use mode 0600; newly created directories use 0700. A failed dump is retained for diagnosis and must not be uploaded as a verified backup. Exit 0 prints `backup_verified`, file size/path and per-table counts; exit 1 reports failure without driver/tool output or credentials.

On a VPS, configure the job's environment via your secret manager, then schedule a wrapper daily, for example `15 2 * * * /opt/billz/ops/verify-and-upload-backup`. The wrapper should `cd /opt/billz`, run `npm run backup:verify`, and only on exit 0 upload the resulting dump plus sanitized count manifest to encrypted object storage in a different account/region. Use least-privilege bucket credentials, encryption at rest, private access, versioning and retention (for example 30 daily and 12 monthly verified dumps). Rotate/expire local dumps only after off-server upload succeeds. Managed hosts can schedule the same release-image command in a cron job with injected secrets and durable scratch storage. Alert on any nonzero exit or missing daily upload. This document does not configure a scheduler or storage account.

Counts prove successful logical restoration, not complete disaster recovery. Keep provider point-in-time backups, periodically rehearse application login/reporting from a restored backup, and preserve the separate `SESSION_SECRET` and `PASSWORD_PEPPER` in your secret manager. Encrypted administrator TOTP data requires its original session secret. Dumps contain private customer/account information and password hashes: protect them accordingly.

## Load test

Use ten **disposable staging** restaurants, each with an active/trial plan permitting at least five simultaneous devices, valid owner credentials and a published in-stock menu item. The script writes 200 real cash orders into the first restaurant; this affects sales, inventory and account balances. Do not run it against live customer restaurants.

Supply credentials in memory from your secret manager over stdin, as a JSON array of exactly ten distinct restaurant objects:

```json
[{"restaurantCode":"staging-01","username":"owner","password":"<injected by your secret manager>"}]
```

The example shows one object; the real array must have ten. Do not save plaintext owner passwords in fixture files, shell history or arguments. Set `LOAD_CONFIRM_STAGING=true` and `LOAD_BASE_URL=https://staging.your-domain.com`, then pipe your secret manager's JSON output into `npm run test:load`. Remote hosts require HTTPS; HTTP is allowed only for a local loopback listener used by tests. Let the command finish (about one minute after login); it logs out the successful sessions afterward.

The workload launches 50 concurrent logins spread evenly over ten restaurants, schedules 200 distinct idempotent order requests at 300ms intervals for the first restaurant, and generates 12 sales reports during that minute. Login timing measures the login HTTP request; authenticated membership lookup is separate. Order timing covers response parsing; the scheduler's deliberate pacing is excluded. HTTP failures and network timeouts count as errors and are not retried into hidden successes. Reports use the current UTC date; fixtures should avoid midnight/timezone boundaries when comparing report totals. All requests use one source IP, as shared restaurant internet access does.

The checkout route has its own 600/minute/IP budget; the former general 120/minute API budget could not admit this requested 200/minute workload. Authentication/tenant checks remain required. Login remains 100/15 minutes with account throttling, so repeated benchmark runs from the same IP require waiting for that window. Other API requests retain the general budget. In multi-replica hosting these in-memory IP budgets apply per instance; persistent per-account guessing throttles and PostgreSQL device/session limits still apply across instances.

Output is one JSON result with `workload`, `results.login/order/report`, `requests`, `errors`, `errorRate` (0–1), `p50Ms`, `p95Ms`, `p99Ms`, `slow`, `skipped`, and `flagged`. Any p95 above 500ms, any error, or a skipped workload sets `flagged=true` and CLI exit 2; configuration failure exits 1. No credentials, cookies, request/response bodies or restaurant names are printed. Store sanitized JSON with host size, region, commit, PostgreSQL version and date. Investigate slow/error flags before accepting a host: inspect CPU/Argon2 contention, database connection waits, query plans, locks and network latency. CI checks correctness and prints the same result; it deliberately does not turn machine-dependent latency into a flaky test assertion.

Record a fresh result on the actual chosen hosting tier with representative menu/stock and reporting history before launch. A one-minute check does not measure sustained growth, very large reports or failover.
