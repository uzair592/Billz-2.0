# Pilot Launch Checklist

Go-live checklist for the first production restaurant pilot.

## Pre-deployment

- [ ] Managed PostgreSQL 17 instance created and reachable
- [ ] PostgreSQL requires SSL (or is confirmed private-network only)
- [ ] `DATABASE_URL` recorded securely
- [ ] `SESSION_SECRET` generated (32+ random bytes)
- [ ] `PASSWORD_PEPPER` generated (32+ random bytes, differs from session secret)
- [ ] `TRUSTED_ORIGINS` set to the production HTTPS origin(s)
- [ ] `MAIL_PROVIDER` configured if self-registration is required (otherwise registration is disabled in production)
- [ ] `PAYMENT_PROVIDER` set to `stripe` (or `manual` for a no-payment pilot)
- [ ] Stripe keys configured and test-mode verified (if Stripe)
- [ ] Provider-managed automated backups enabled (point-in-time recovery)
- [ ] Custom domain DNS configured and HTTPS certificate issued

## Release

- [ ] Production image builds successfully
- [ ] Migration release command ran without error
- [ ] All 11 migrations applied exactly once
- [ ] Application container deployed as non-root
- [ ] `/health/live` returns `200`
- [ ] `/health/ready` returns `200`

## First tenant

- [ ] Bootstrap CLI run with test-then-real owner credentials
- [ ] Owner email verified and sign-in confirmed
- [ ] POS page loads at the production origin
- [ ] Owner role has full permissions
- [ ] Trial/active subscription state confirmed

## Smoke verification

- [ ] Create a test order and complete checkout
- [ ] Partial refund flow works end to end
- [ ] Sales report loads with correct figures
- [ ] CSV export downloads the current filter range
- [ ] Billing page loads (even for a lapsed subscription)
- [ ] Stripe test-mode checkout and webhook verified (if Stripe)

## Operational readiness

- [ ] Liveness/readiness alerts configured
- [ ] Log destination configured and searchable
- [ ] Manual backup taken and restore verified into a scratch database
- [ ] Rollback image tag identified
- [ ] Runbook reviewed by the on-call owner

## Go / No-go

- [ ] All boxes above checked
- [ ] No open `P0` incidents
- [ ] On-call owner confirmed available

**Decision:** [ ] GO  [ ] NO-GO
