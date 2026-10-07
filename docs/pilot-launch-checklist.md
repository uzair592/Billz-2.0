# Pilot Launch Checklist

Pre-flight verification checklist before initiating live pilot operations.

## Security & Secrets
- [ ] No hardcoded credentials or API tokens in tracked files.
- [ ] OAuth authorizations rotated / revoked as required.
- [ ] `NODE_ENV=production` configured.
- [ ] Strong random string generated for `SESSION_SECRET` (>= 32 chars).
- [ ] Strong random string generated for `PASSWORD_PEPPER` (>= 32 chars).
- [ ] `TRUSTED_ORIGINS` configured to HTTPS domain.

## Database & Infrastructure
- [ ] Managed PostgreSQL 17 online with SSL enforced.
- [ ] All 12 migrations successfully applied (`001` through `012`).
- [ ] RLS policies active and enforced across all tenant tables.
- [ ] Database backup schedule configured.

## Application & Services
- [ ] `/health/live` returns 200 OK.
- [ ] `/health/ready` returns 200 OK.
- [ ] First restaurant & owner user bootstrapped.
- [ ] Stripe Test mode keys configured (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`).
- [ ] Webhook handler verified with test event.

## Mobile & Terminal Usability
- [ ] Off-canvas navigation drawer opens and closes cleanly on phones.
- [ ] No horizontal page overflow on viewports 390px, 412px, 768px, 1024px, 1366px.
- [ ] Desktop thermal printing from cashier laptop verified.
