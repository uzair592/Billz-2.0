# Deploy Billz from zero

This is the canonical deployment checklist for Node 22, PostgreSQL 17 and **manual billing**. The older deployment guides point here. Run it on staging before admitting real customers. Never run the test database provisioning helper against a customer database: it drops the schema.

## 1. Choose hosting and a compatible database

- Create a Docker web service and a separate PostgreSQL 17 database in the same region. Use the repository Dockerfile; attach no business-data disk to the application. On Render, use a paid service supporting pre-deploy commands and the supplied `render.yaml`.
- Confirm your DBA/provider can supply two dedicated, non-owner runtime roles: a non-superuser **NOBYPASSRLS** POS role and a non-superuser **BYPASSRLS** control role. The migration account must own the application schema and be allowed to manage these roles. `CREATEROLE` alone cannot grant BYPASSRLS. Render does not provide superuser access; get provider assistance/pre-created roles if its default credentials cannot perform this operation, or choose a compatible PostgreSQL host. Do not substitute the database owner or a superuser as the control connection.
- Keep PostgreSQL off the public internet where possible. Otherwise allow only the application and operator IPs. Keep migration credentials in the release/operator secret store, not in browser code.
- Set a backup schedule and test restoration before launch; see [backup-restore-runbook.md](backup-restore-runbook.md). A successful migration is not a backup.

## 2. Domain, DNS and HTTPS

1. Register your domain, for example `pos.yourdomain.com`.
2. Add that custom hostname to the web service. Copy the provider's exact DNS target into the domain's DNS settings: normally a CNAME for a subdomain, or the provider's ALIAS/ANAME/A record for an apex. Do not invent an IP address.
3. Wait for DNS verification and issuance of the host's TLS certificate. Redirect HTTP to HTTPS at the edge. With your own VPS, use Nginx/Caddy and an automatically renewed certificate; keep the Node port reachable only by that proxy.
4. Set `TRUSTED_ORIGINS=https://pos.yourdomain.com`. Add another origin only if you actually serve the app there. Include no path, wildcard, localhost, or HTTP origin. Login cookies are Secure, HttpOnly and SameSite=Lax.

## 3. Configure secrets and environment

Use the hosting secret manager. Generate independent 32-byte random values for the pepper/session secret and runtime database passwords using a password manager or `crypto.randomBytes(32)`. Do not paste them into git, tickets, command arguments or logs. Keep a secure copy of `PASSWORD_PEPPER`; changing it makes existing password hashes unusable.

| Variable | Set to |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` on managed hosting; `127.0.0.1` behind a local VPS proxy |
| `PORT` | Provider's assigned port, Render `10000`, VPS e.g. `3000` |
| `MIGRATION_DATABASE_URL` | Privileged schema-owner connection, same database as both runtime URLs |
| `DATABASE_URL` | Dedicated POS role connection; never the owner connection |
| `CONTROL_DATABASE_URL` | Dedicated control role connection; never a superuser connection |
| `APP_DATABASE_ROLE` | Optional role name, default `billz_pos` |
| `CONTROL_DATABASE_ROLE` | Optional role name, default `billz_control` |
| `APP_DATABASE_PASSWORD` | POS role password, 32–200 printable ASCII characters without spaces; use random hex |
| `CONTROL_DATABASE_PASSWORD` | Separate control role password, same boundaries |
| `DATABASE_SSL_MODE` | Prefer `verify-full` with the host's verified certificate. `require` encrypts without certificate verification; use only with a separately secured database network. `disable` is for local testing only |
| `DATABASE_SSL_CA` | Optional trusted **PEM contents**, not a filename, when the provider uses a private CA |
| `DATABASE_POOL_MAX` | Optional, default `10`; budget both pools across every replica against database connection limits |
| `PASSWORD_PEPPER` | Independent random secret, at least 32 characters in production |
| `SESSION_SECRET` | Different random secret, at least 32 characters in production |
| `TRUSTED_ORIGINS` | Exact HTTPS origin(s) from step 2 |
| `TRUST_PROXY` | `true` only with the verified ingress allowlist below; otherwise `false` |
| `TRUSTED_PROXY_CIDRS` | Exact verified ingress proxy IPs/CIDRs; never all networks |
| `PAYMENT_PROVIDER` | `manual`; leave Stripe credentials unset |
| `SUPPORT_CONTACT` | Actual support phone/email or instructions visible to customers |
| `LOG_LEVEL` | `info` |

Build each runtime URL using the migration connection's host/database and the matching runtime role/password. Percent-encode URL credentials; random hex passwords avoid encoding ambiguity. Do this in the secret manager, not a logged shell command. The passwords in the URLs must match the corresponding password variables. Variables do not create database roles until the release script runs.

Transactional mail delivery is not implemented in this repository. Leave `MAIL_PROVIDER` unset: production self-registration is disabled. Provision restaurants through the administrator panel. Do not set undocumented `REGISTRATION_MODE` or assume that a provider name installs email delivery.

## 4. Configure the reverse proxy correctly

| Host arrangement | Exact configuration |
| --- | --- |
| Nginx/Caddy on the same VPS, proxy connects over loopback | Bind Node to `127.0.0.1`; set `TRUST_PROXY=true`, `TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128`. The firewall must block direct public access to the Node port |
| Docker proxy on a dedicated network | Allow only that proxy's fixed IP/CIDR, obtained from your network configuration. Do not trust every Docker/private subnet |
| Render or another managed ingress | Obtain the actual ingress chain ranges from the provider and verify them on staging. Provider **outbound/egress** IP lists are not ingress proxy allowlists. There is no universal numeric value this repository can safely supply |
| No verified proxy allowlist | Set `TRUST_PROXY=false`; forwarded headers are ignored. Do not enable client-IP-dependent production controls until your ingress chain is verified |

Never set `0.0.0.0/0`, `::/0`, or unrestricted proxy trust. Startup rejects those ranges and rejects `TRUST_PROXY=true` without `TRUSTED_PROXY_CIDRS`. Check request IPs in staging logs from two different external networks; a forged `X-Forwarded-For` prefix must not change the identified client. Block direct ingress bypasses. Until that works, shared proxy addresses may cause unrelated restaurants to share an IP rate-limit budget.

## 5. Run the repeatable release step

From the checkout or the same Docker image as the deployment, with secret variables already injected:

```sh
node src/server/database/migration-runner.mjs
node database/ops/create-runtime-roles.mjs
```

Run sequentially; stop if either exits nonzero. `render.yaml` wires both commands into `preDeployCommand`, with `&&` ensuring roles are refreshed only after migrations succeed. Do not run migrations in each web process or in the image build. On another host, configure the equivalent release job before routing traffic to the new build.

The runner prefers `MIGRATION_DATABASE_URL`, honors database TLS settings, records checksums and uses the existing advisory lock. A concurrent release fails `MIGRATION_LOCK_BUSY`; retry after the first completes. Already-applied migrations are not rerun. Never edit an applied migration. The legacy `DATABASE_URL` fallback remains for existing development/CI commands; production releases must supply `MIGRATION_DATABASE_URL` explicitly.

The role script is idempotent and transactional. It creates missing dedicated roles or refreshes safe pre-created roles, sets SCRAM password verifiers (plaintext passwords never enter its SQL/log output), and reapplies existing-object grants after each release. Runtime roles may not own objects or be members of other roles. Granting permissions does not grant schema creation, migration DDL, TRUNCATE, role administration, database creation, or superuser access. The POS gets tenant-table DML under RLS, catalog/migration-history reads and opaque checkout-reference publishing; authentication/admin tables belong to the control boundary. Control access is restricted to tables used by authentication, administration, provisioning and billing. New global tables need an explicit grant-list review. No blanket default privilege grants are installed.

If role creation fails with permission error `42501`, ask the provider/DBA to create/manage these roles with the required attributes and grant the migration operator appropriate administration permissions. Rerun the script; do not remove the production role guard to make startup pass. The safe POS/control split is a prerequisite for this repository's architecture.

## 6. Deploy and bootstrap the first super administrator

Start the image after the release succeeds. It runs as a non-root OS user. Production refuses unsafe database-role flags and logs which connection needs fixing. Readiness stays `503` while migration history is missing, pending or drifted; liveness remains a separate process check.

In the host's web-service shell/one-off job, use its injected `CONTROL_DATABASE_URL` and **the same** `PASSWORD_PEPPER` as the running service. Temporarily inject these additional secret variables:

| Variable | Value |
| --- | --- |
| `BOOTSTRAP_ADMIN_USERNAME` | Chosen administrator username |
| `BOOTSTRAP_ADMIN_PASSWORD` | Strong unique password, 10–200 characters |
| `BOOTSTRAP_ADMIN_DISPLAY_NAME` | Optional display name |

```sh
node src/server/bootstrap-platform-admin.mjs
```

On Render use the service Shell after its release/start succeeds; on a VPS use an ephemeral container from the deployed image with the secret environment file/manager mounted. Supply secrets as environment input, never `--password` arguments. Repeating the bootstrap reports the existing account and does not reset it. Remove the bootstrap password variable afterwards. Never use the first-restaurant bootstrap as a replacement for creating a platform administrator.

## 7. First restaurant and owner login

1. Open `https://pos.yourdomain.com/platform-admin/` and sign in with the bootstrap administrator.
2. In **Plans**, create an active manual plan: code/name, interval, price/currency, trial days and concurrent device allowance. A clean database has no default catalog until you create one here. Archive retired plans instead of deleting billing history.
3. In **Restaurants**, create the restaurant using that plan and a unique code, owner username/email and strong owner password. Creation provisions the tenant, membership, settings and trial transactionally. Deliver the owner's credentials through your secure customer handoff process.
4. Open `/` in another browser context; sign in with the restaurant code and owner username/email. Confirm menu setup and a small staging sale, reporting, suspend/restore and credential recovery. Verify the configured device cap using independent browser contexts.
5. Manual plan assignment/renewal adjusts access; record and review actual payments separately. Generated recovery passwords are displayed only once. No Stripe checkout/product configuration is needed or enabled for this launch.

## 8. Smoke checks before accepting customers

Use the public HTTPS hostname, not the internal plain HTTP address:

```sh
curl --fail --silent --show-error https://pos.yourdomain.com/health/ready
curl --fail --silent --show-error https://pos.yourdomain.com/health/live
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' https://pos.yourdomain.com/api/auth/me
curl --silent --show-error --head https://pos.yourdomain.com/
```

Expect readiness `200` with `{"status":"ready"}`, liveness `200` with `{"status":"ok"}`, unauthenticated `/api/auth/me` `401`, and HTTPS/security headers on the POS response. Check secure cookie flags in the browser after login. Monitor logs without logging request bodies, passwords, cookies or database URLs. Configure alerts for readiness failure, database errors and unusual login failures.

CI verifies clean PostgreSQL migrations, restricted-role isolation, authentication, actual browser journeys and production container startup/shutdown. Your real DNS, proxy, database permissions, restore process and physical receipt printer still require staging acceptance. See [audit/READINESS_AUDIT.md](audit/READINESS_AUDIT.md) for remaining product limits; plan device enforcement is now implemented by the admin control-center changes. Managed paid offline checkout remains disabled.

## 9. Rollback and recovery

- Record the deployed commit/image digest and take a database backup before each release. Retain encrypted backups off the application host; test a restore on an isolated database.
- If the release/migration fails, do not route traffic to the new build. A failed individual migration rolls back its transaction; earlier migrations in the same release may already have committed. Inspect the migration history and error before retrying.
- Roll back the **image** only when its code is compatible with the database schema. Readiness verifies the bundled migrations but does not certify semantic backward compatibility. Prefer additive migrations and a tested rollback image.
- Never delete migration history, edit old SQL or run the schema-dropping test helper to repair a live database. Schema/data reversal needs a reviewed forward repair migration or restoration to a new database, with downtime and recovery-point loss explicitly planned.
- Restore into a separate database, reapply runtime grants and validate counts, logins and reports before switching connection secrets/traffic. Preserve the pepper/session secrets required by the restored data. Do not blindly rotate them during rollback.

Reference: [Render deploy lifecycle](https://render.com/docs/deploys), [Blueprint pre-deploy command](https://render.com/docs/blueprint-spec), [Render database credentials](https://render.com/docs/postgresql-credentials), [PostgreSQL 17 role attributes](https://www.postgresql.org/docs/17/role-attributes.html).
