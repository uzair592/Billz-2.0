# Launch review remediation — 10 October 2026

See [the post-merge recheck](LAUNCH_RECHECK.md) for additional renderer defects reproduced after PR #8, the follow-up repairs, and the remaining finding-by-finding release gates.

This branch includes the previously unmerged SaaS core from PR #7 and repairs the production entrypoint, visible tenant login, tenant isolation, refund/cost snapshots, private file retention, and deployment/test lifecycle. It is a review branch, not a production deployment.

## Release behaviour

The HTML served by the application runs in managed mode. It requires an authenticated restaurant membership and current subscription access before loading tenant business data. The default demo PIN/licence is not used. Local IndexedDB and preferences have tenant namespaces; unowned historical device data is kept quarantined. Changing accounts reloads the application to avoid carrying in-memory business state across tenants.

Managed checkout is currently **online only**. The server must persist the sale before the local cache or a paid receipt is issued. A durable request ID survives ambiguous failures, and the server checks the till's expected total against authoritative menu pricing. Changed prices and unsupported ingredient extras require correction before payment. Local edits/payment toggles/deletion of managed sales are blocked; use the cloud refund/cancellation workflow.

This deliberately contains the old offline sale/outbox/pricing failures. It does **not** complete the requested offline product. No browser-verifiable signed pricing/options snapshot, bounded offline access lease, or service-worker cold-start workflow is advertised as finished. Do not launch as a dependable offline POS.

## Review finding disposition

| Finding | Change and remaining gate |
|---|---|
| L01 | Visible restaurant code/username/password login, server authorization before opening till and checkout; demo auto-access excluded from managed entry. Offline lease remains a gate. |
| L02 | Production creates history, cancellation, catalog-import and business-settings services. Entrypoint regression checks registered guarded routes. |
| L03 | Additive migration 014 restores fail-closed tenant policies; control/auth/admin work uses a separate non-superuser BYPASSRLS connection. Runtime verifies both role boundaries in production. |
| L04 | Asset paths confined to the selected public directory after decoding and realpath resolution, including symlink checks. |
| L05 | Confirmed invoice/history/menu/offer/ingredient HTML fields escaped. Existing cloud UIs escape text. Full browser sink audit remains required; legacy inline handlers still prevent a restrictive CSP. |
| L06 | Fastify uses configured proxy trust, default false; tenant/account login throttling supplements IP throttling. |
| L07 | Managed tenant key namespace; stale context cannot enqueue for another account; logout clears context without deleting pending orders. |
| L08 | Managed checkout persists server-first; no local paid receipt before server success. Old standalone offline mode is outside the managed release contract. |
| L09 | Auth/access failures pause the outbox; recovery requires validated session, tenant and POS access; timed drain preserves operation IDs. |
| L10 | Managed checkout checks expected totals before writes; duplicate product lines allowed. Extras are rejected explicitly. Offline versioned pricing/options remains incomplete. |
| L11 | Refund restores frozen per-unit quantity times returned quantity; fixtures corrected to actual checkout format. |
| L12 | Frozen new inventory recipe/cost snapshots determine COGS and reversals; migrated products avoid double consumption in legacy stock. Cancellation restores remaining consumed stock after refunds. Historical pre-fix sales need review before partial restocking. |
| L13 | Mapper uses total line cost (stored value or unit cost times quantity), preserving real zero costs. |
| L14 | Upload stores bytes and SHA-256 in PostgreSQL atomically with quota; tenant-bound download/delete; first-upload quota lock. Metering is explicitly managed-file bytes, not the total restaurant database. |
| L15 | No public default signing secret; optional server entitlement requires explicit private key and paid-period boundary. Managed UI does not claim offline token enforcement. |
| L16 | Tenant code compatibility, owner username bootstrap, working admin pool factory/environment credentials, admin assets in Docker. |
| L17 | Unit/DB separation, dedicated real-server browser lifecycle, dynamic migration count; actual login/catalog/paid-sale assertions replace permissive error-status assertions. |
| L18 | Every order and nested item validated; restore stages collections/images before one local transaction. |
| L19 | Runner unwraps existing file transaction wrappers without changing source checksums; history and DDL share the runner transaction; session lock explicitly released. |
| L20 | Public tenant/admin DTOs allowlist fields instead of returning repository credential objects. |

Manual payment approval locks the tenant/current subscription, ignores cancelled historical subscriptions, rejects duplicate references, cannot reject an already-approved payment, and does not unsuspend a restaurant as a payment side effect. Cancellation refunds only the remaining captured balance after partial refunds.

## Deployment requirements

Apply migrations using a migration/owner connection before updating the application. Existing migrations are unchanged; migration 014 repairs already-applied migration 013. Back up first and retain a rollback plan; this work has not touched customer databases.

Set `DATABASE_URL` to a non-superuser **NOBYPASSRLS** runtime role. Set `CONTROL_DATABASE_URL` to a different non-superuser **BYPASSRLS** role for account discovery, authentication and platform administration. The POS services never receive the control pool. Provision schema usage, required table/sequence privileges, and keep both connection strings server-side. Do not use a PostgreSQL superuser for either application role. Prefer limiting the POS role's privileges on authentication/platform tables in deployment.

Set production HTTPS `TRUSTED_ORIGINS`, strong `PASSWORD_PEPPER` and `SESSION_SECRET`, and `PAYMENT_PROVIDER=manual`. Keep `TRUST_PROXY=false` unless a controlled reverse proxy replaces incoming forwarding headers. If configured, `OFFLINE_ENTITLEMENT_SECRET` must be a separate private secret of at least 32 characters; it is not shipped to the browser.

Bootstrap first owner with `BOOTSTRAP_OWNER_PASSWORD` and optional `OWNER_USERNAME` (default `owner`). Platform admin bootstrap uses `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD` (10+ characters), `PASSWORD_PEPPER`, and `CONTROL_DATABASE_URL`; passwords are not CLI arguments.

Legacy menus can be imported through the visible cloud panel after sign-in. Cloud catalog import is not a completed bidirectional menu/settings/inventory synchronization system. Managed file storage is durable, but local menu photos/receipt attachments are not automatically uploaded by this patch.

## Validation and remaining launch gates

Local unit/regression results are recorded in the PR. Real PostgreSQL, browser and container tests must be green on this exact branch. Local PostgreSQL installation and Chromium download were unavailable in the execution environment; no passing result is claimed for those local runs. CI now supplies the missing service lifecycle.

Before paid/public launch: verify the migration on a copy of current data; exercise visible owner/cashier access and suspension/renewal; test mixed old/new recipes and historical refund snapshots; complete browser XSS/print testing; confirm backup recovery and role grants in the hosting environment. Complete signed offline sales, extras/options, cross-device catalog/settings synchronization and local-attachment cloud upload before marketing those features.
