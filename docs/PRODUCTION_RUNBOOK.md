# Production Runbook

Operational procedures for the Billz 2.0 production deployment.

## Deployment

1. Build the production image: `docker build -t bite-tech-pos:<sha> .`
2. Run the migration release command against the managed database:
   `node src/server/database/migration-runner.mjs`
3. Deploy the new image to the application service.
4. Wait for `/health/ready` to return `200`.
5. Verify the POS loads and a smoke order can be created.

## Rollback

1. Redeploy the previous image tag.
2. If the previous image expects an older schema, restore the database
   from a backup taken before the migration (see Restore). Migrations
   are forward-only; do not attempt to reverse them by hand.
3. Wait for `/health/ready` to return `200`.

## Migration failure

The migration runner is atomic per migration and refuses to continue on
failure.

1. Check the structured logs for `migration_run_failed` and the
   `failedFile`.
2. The failed migration was rolled back; the database is in the state
   it was in before the run.
3. Fix the migration or the database state, then re-run the release
   command. Already-applied migrations are skipped.
4. If a checksum mismatch is reported, an applied migration was edited.
   Restore the original migration content or create a new migration;
   never edit an applied migration.

## Database outage

1. `/health/ready` returns `503`; `/health/live` still returns `200`.
   The platform should stop routing traffic but not restart the
   process.
2. Check the managed PostgreSQL provider status.
3. Do not restart the application to "fix" a database outage — the
   application fails closed at startup when the database is
   unavailable.
4. When the database recovers, `/health/ready` returns `200` and
   traffic resumes.

## Stripe webhook failure

1. Check logs for webhook processing errors.
2. A `400` response means the signature was invalid or the event is
   unmodelled — Stripe will not retry. Verify `STRIPE_WEBHOOK_SECRET`
   matches the endpoint's signing secret.
3. A `503` response means the event was retryable — Stripe will retry.
   Check the database and resolve the underlying error.
4. Webhook events are recorded in `webhook_events` with a lease, so a
   crash during processing does not lose the event.

## Backup

Run a manual backup with the backup tool:

```sh
node src/server/database/backup-restore.mjs backup
```

with `DATABASE_URL` and optionally `BACKUP_DIR` (default `./backups`).

- Backups use `pg_dump` custom format (`-Fc`), compressed.
- Filenames are timestamped: `backup-<timestamp>.dump`.
- Credentials are never printed.
- **Also enable provider-managed automated backups** (point-in-time
  recovery) on the managed PostgreSQL instance. This tool is a
  complement, not a replacement.

Retention recommendation: keep at least 7 daily backups and 4 weekly
backups; align with the provider's point-in-time recovery window.

## Restore

Restore into a separately specified target database:

```sh
node src/server/database/backup-restore.mjs restore
```

with `DATABASE_URL` (the backup source), `TARGET_DATABASE_URL`
(a full `postgresql://` connection string for the restore
destination), and `BACKUP_PATH`.

- The target must be a full connection string, not a bare
  database name; the tool refuses an ambiguous or missing target.
- The source and target are parsed and validated, and restoring a
  database onto itself (same host, port, and database) is refused.
- The tool restores with `--clean --if-exists` so a re-restore is
  deterministic.
- Verification queries run against the **target** after
  restoration and report the table count; a target with no
  application tables fails the restore.
- Credentials are redacted from every log, error, and JSON result.
- Never restore over the live production database directly; restore
  into a new database, verify, then repoint the application.

## Secret rotation

1. **`SESSION_SECRET`:** rotate by setting a new value and redeploying.
   Existing sessions are invalidated; users sign in again.
2. **`PASSWORD_PEPPER`:** rotating invalidates all password hashes
   (hashes are pepper-bound). Plan a password reset for all users, or
   rotate during a maintenance window.
3. **`STRIPE_WEBHOOK_SECRET`:** rotate in the Stripe dashboard, then
   update the environment and redeploy.
4. **`DATABASE_URL`:** rotate the database password at the provider,
   update `DATABASE_URL`, and redeploy.

## Subscription-access incident

A restaurant reports the POS is locked (`402 SUBSCRIPTION_REQUIRED`):

1. Check the `subscriptions` table for the restaurant's subscription
   status and `current_period_end`.
2. If the subscription is past due or expired, the billing screen still
   works (billing routes do not require an active subscription) so the
   restaurant can pay.
3. If a webhook was missed, check `webhook_events` for unprocessed
   events and replay them.
4. For a controlled pilot, the bootstrap CLI can set a `trial` or
   `active` subscription state.

## Health-check failure

- **Liveness failing:** the process or event loop is stuck. The
  platform should restart the container. Check logs for
  `unhandled_rejection` or resource exhaustion.
- **Readiness failing:** the database is unreachable or migrations are
  pending. See Database outage and Migration failure.

## Log inspection

Logs are structured JSON. Key events:

- `pos_server_started` / `pos_server_start_failed`
- `shutdown_initiated` / `shutdown_complete` / `shutdown_forced`
- `migration_applied` / `migration_already_applied` /
  `migrations_complete` / `migration_run_failed`
- `database_pool_error`
- `bootstrap_complete` / `bootstrap_failed`
- `backup_complete` / `restore_complete` / `restore_verified`

Logs never contain credentials, full database URLs, passwords, or
password hashes.

## Emergency shutdown

Send `SIGTERM` (or `SIGINT`) to the application process. The server:

1. stops accepting new connections,
2. gives in-flight requests a grace period,
3. closes Fastify and the PostgreSQL pool cleanly,
4. exits with code `0`.

If the process does not exit within the grace period, it
force-exits with a **non-zero** code so the platform records
the abnormal termination. An `unhandledRejection` or
`uncaughtException` triggers an orderly shutdown and exits
with a non-zero code. Do not use `SIGKILL` unless the
process is unresponsive to `SIGTERM`.
