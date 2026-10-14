# Super admin control center

## Creation defect and correction

The restaurant form accepted arbitrary trimmed codes, but provisioning reused the code as `restaurants.slug`. The slug database CHECK only accepts lowercase ASCII words separated by single hyphens. Codes such as `Cafe_01 With Spaces` passed HTTP validation and then failed with SQLSTATE 23514, returning 500. Provisioning now derives a separate valid slug with a full UUID suffix; the login code remains the chosen normalized value. All tenant, owner, branch, membership, settings, financial account, trial and storage inserts remain in the same transaction with the audit. Unknown plans, duplicate codes/emails, invalid passwords, missing migrations and missing control-role grants have controlled errors.

Changing a restaurant code previously left its old slug accepted by the login lookup. Username/email sign-in now resolves the current code only. Owner email changes recheck the verified email as well as password/username during session insertion, preventing a stale verification from creating a session after a change.

This is a reproduced code defect, not proof of the cause of an unseen deployed server log. Existing failures due to deployment configuration still require the matching server logs and migrations.

## Plans and access controls

- Plan CRUD uses guarded `/platform-admin/api/plans` endpoints. Create/edit publishes a manual price; previous price rows remain available to billing history. The plan builder offers monthly, quarterly, yearly and custom trial periods, currency/price, trial days and maximum sessions.
- Archive/activate toggles availability for new assignments; existing subscribers retain access until their recorded boundary. A referenced plan cannot be deleted; archive it instead.
- Administrative assignment/renewal is an audited access adjustment, not proof of payment. Payment recording/review remains separate. Provider-managed subscriptions cannot be overridden through the manual control.
- Manual payment forms use the selected plan's price/currency; the server rejects mismatched currencies. Amounts can be adjusted for negotiated coverage. Both direct assignment and payment approval reject provider-managed subscriptions without altering payment or access state.
- Renewal adds calendar months with month-end clamping, starting at the later of now or existing expiry. Trial duration uses plan-configured days. Expiry overrides in the UI use UTC end-of-day. Assignment does not clear an administrative suspension.
- Owner credentials permit changing a login email and choosing or securely generating a password. Passwords use the existing policy/pepper. All owner sessions are revoked in the same transaction as the credential update and audit. Generated passwords are returned once and cleared when the modal closes.
- Session viewer exposes user, client, IP and timestamps, never session tokens or password hashes. Force logout invalidates every restaurant session and records an audit.

## Concurrent device policy

Each unexpired, unrevoked authenticated session is one device slot across **all restaurant users**. Multiple browser tabs sharing one cookie are one session; this is not a physical hardware fingerprint. Reauthentication with that user's existing cookie replaces its slot transactionally. The default allowance for existing plans is 20, preserving prior workflows; set desired limits through the builder.

Session insertion obtains a shared plan advisory lock and then the restaurant row lock before counting/inserting. Competing logins cannot both take the last slot. A concurrent plan reassignment returns a retryable conflict instead of using an unverified limit. Plan edits obtain the exclusive plan lock and restaurant locks in stable order. Lowering a limit keeps the most recently used sessions and revokes the excess. The authentication query also rejects sessions beyond the current plan limit, covering other billing transitions.

Sessions are tenant-bound. A cookie cannot be presented as a slot for another tenant. Expired/revoked sessions, disabled users and inactive memberships do not consume seats. Online entitlement issuance revalidates the current session; force logout prevents further issuance. Previously signed offline tokens have their existing expiry and cannot be remotely invalidated without an online check; managed offline checkout remains disabled and is outside this work.

## Migration and operation

Apply additive migration **021_admin_plans_and_session_limits.sql** before restarting the application. It adds plan device/trial settings, quarterly/trial prices and historical-price support; binds existing sessions to memberships; and indexes active restaurant sessions. No old migrations are edited. Existing runtime/control grants cover the new columns. The bootstrap and database test helper use the new partial current-price index.

Plans are manual billing controls for the current launch. Creating a manual plan does not create Stripe products/prices. A Stripe deployment still needs provider-linked prices through its existing billing integration.

## Verification

647 local Node 22 unit tests passed before CI, with zero skips, including slug, calendar interval, guarded route, session-limit rollback and online entitlement checks. PostgreSQL is unavailable locally; required PostgreSQL/full-stack commands fail explicitly instead of skipping. CI supplies real PostgreSQL 17 and Chromium.

Added HTTP/PostgreSQL acceptance covers plan CRUD/history/audits, formerly failing restaurant codes, complete atomic provisioning, concurrent last-slot competition across users, replacement sessions, downgrades, owner email/generated password reset, session revocation, suspension-preserving renewal, code reuse, currency validation, provider-managed billing safeguards and rollback on audit failure. Browser acceptance exercises the visible plan builder, currency-aware payments, provisioning, three till contexts, device refusal, owner recovery, renewal, suspension/restore, audit filtering and phone/desktop screens.

The final commit SHA, CI result and screenshot review are recorded in the PR. No merge or deployment is performed by this change. Broader POS launch gates in READINESS_AUDIT.md still apply.
