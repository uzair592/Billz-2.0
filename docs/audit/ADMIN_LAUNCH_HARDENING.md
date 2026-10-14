# Admin launch hardening — 12 October 2026

This release implements the four requested groups on `fix/admin-launch-hardening`, reviewed in PR #10. It does not deploy or merge the application.

## Changes

1. Launch config: manual payments on Render, separate POS/control/migration connections, explicit proxy allowlist, external admin script and scoped CSP, PostgreSQL failed-login counters, shared 10–200 character password policy. Validation errors are registered before any routes/plugins so production composition returns 400 consistently.
2. Password management: audited admin resets (chosen or generated), tenant ownership checks, atomic revocation of all sessions, support contact in a safe public endpoint and login help, authenticated password changes revoking other sessions. Login locks/rechecks the verified hash before minting a session to prevent a reset/login race. Unused reset-token table removed.
3. Admin portal: responsive local assets, dashboard/storage totals, searchable/status-filtered paginated restaurants, subscription/payment/storage/user details, actual storage allowances, contact edits, user enable/disable, confirmation dialogs, error toasts and paginated read-only audits. Generated passwords are shown once and cleared on close/logout; credential fields are removed from audit DTOs.
4. Acceptance and isolation: independent shutdown-suite provisioning, sequential PostgreSQL suite execution, repair of stale test-role passwords/flags, failed-pool cleanup, real HTTP tests for mutations/authorization/validation/audits/session revocation, audit-failure rollback and stale-login checks, and real-browser password reset/old-password/old-session checks. Production ignores `DISABLE_RATE_LIMIT`; only the explicit test harness can bypass per-IP limits, while durable account throttling remains active.

## Verification

Node **22.23.3** was installed for local checks. Unit totals after groups 1–4: **623, 626, 629, 630**, with zero failures or skips after each group's local fixes. Exact-head CI results and any subsequent acceptance fixes are recorded in PR #10. Existing migrations 001–014 are unchanged; new migrations are 015–017.

A final UI regression prevents editing a previously loaded restaurant while another restaurant's details are loading. It brings the unit total to **631**.

The requested `npm run test:postgres` and `npm run test:fullstack` commands were attempted locally after every group. They failed explicitly because PostgreSQL is unavailable. The workspace denies OS user/permission operations required by package installation and has no Docker. No local database pass is claimed. Local Playwright execution was attempted; Chromium downloads were truncated, and the SaaS web server also requires PostgreSQL. GitHub CI supplies real PostgreSQL 17, Node 22 and Chromium for these checks. Browser failure artifacts must not retain generated passwords; the reset test clears the generated field before assertions/artifact capture.

The shutdown defect is fixture setup, not a production password-authentication bypass: the standalone runner did not provision application/control roles, the shutdown suite imported but never called provisioning, and an existing role's stale password was left untouched. Provisioning now repairs those fixed test roles, and a real PostgreSQL regression deliberately starts with stale credentials and verifies repair. Runtime security checks still reject incorrect production roles.

## Operator configuration still required

Set verified `TRUSTED_PROXY_CIDRS` for the actual Render proxy chain. Unrestricted Fastify `true` would trust forged forwarded prefixes; the blueprint's `TRUST_PROXY=true` instead enables only this allowlist. Proxy addresses cannot be inferred from the repository. Verify two real clients and spoofed headers on staging. This runtime/hosting boundary is not claimed verified by injected requests.

Set `DATABASE_URL` to the restricted NOBYPASSRLS role, `CONTROL_DATABASE_URL` to the separate non-superuser BYPASSRLS role, and use the owner connection only for migrations. Apply migrations before updating the app. Grant the control role SELECT/INSERT/UPDATE/DELETE on the new `login_attempts` table; it intentionally has forced RLS without tenant policies. Set `SUPPORT_CONTACT` to public support text. These changes do not alter the previously documented offline-product and broader launch acceptance gates.
