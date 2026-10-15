# POS review regression fixes

Apply numbered migrations through `node src/server/database/migration-runner.mjs` before deploying this change. Migration 024 introduces a global username/email login namespace. It does not change passwords or silently rename existing users.

New usernames and username changes must be unique across restaurants and must not collide with another account's email. Existing ambiguous usernames fail with the normal invalid-credentials response. Those users can sign in with their unique email, or the platform administrator can assign a unique username through the restaurant's user editor. Changing a password alone continues to work for existing accounts. Keep the same password minimums and Argon2 settings.

The `user_login_identifiers` registry is maintained by a database trigger, with unique-key concurrency protection. Existing ambiguous identifiers are reserved. The POS and control runtime roles do not need direct registry privileges. Re-run the standard role provisioner after migrations; do not grant runtime users permission to write this registry or alter its trigger. Include it in backups.

Managed Stock opens the shared inventory screen; Purchases & Suppliers is a Stock subtab. Local Kitchen Stock purchasing is unavailable in managed mode. Use purchase creation and receiving or authorized stock adjustments so movements, weighted costs and shared quantities remain on the backend.

Managed Reports displays shared sales and profit/loss figures using ordinary report labels. Local device reports are retained for explicit development/demo mode and are not substituted for managed figures when the server is unavailable.

Menu item save publishes the current local menu draft using the existing expected-revision check. Publication failures preserve the draft and form for retry. Missing checkout mappings are recovered by reading the published catalog; cashier checkout never writes a catalog. An unpublished menu requires an owner to save menu items first. This retains pricing, permission, tenant and idempotency checks.

Regression coverage includes username-only login, global identifier conflicts, legacy ambiguity, concurrent claims, credential rollback/session revocation, read-only mapping recovery, tenant switching, shared Reports/Stock routing and visible browser journeys. Browser acceptance must include 1366×768 and phone/tablet viewports.
