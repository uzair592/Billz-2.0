# Production Pilot Deployment Guide

## Architecture Overview

- **Application Web Service**: Managed Docker-based Fastify web application.
- **Database**: Managed PostgreSQL 17 with Row-Level Security (RLS) enabled.
- **Security & HTTPS**: Automatic TLS certificate managed by provider.
- **Billing**: Stripe Integration (Test Mode during Pilot).
- **Offline Capability**: Local IndexedDB fallback preserved for cashier terminals.

---

## Deployment Steps

1. **Database Provisioning**:
   - Provision PostgreSQL 17 database instance (e.g., Render Postgres / AWS RDS / Railway).
   - Configure SSL connection mode (`DATABASE_SSL_MODE=require`).

2. **Secret & Environment Configuration**:
   - Set all required production environment variables (see `docs/environment-variables.md`).
   - Secure secrets (`PASSWORD_PEPPER`, `SESSION_SECRET`, `STRIPE_SECRET_KEY`) using platform secret store.

3. **Database Migration**:
   - Execute all 12 database migrations via Docker or CLI:
     ```bash
     docker compose -f compose.validation.yaml up --abort-on-container-exit
     ```

4. **First Restaurant & Owner Bootstrap**:
   - Run initial bootstrap script:
     ```bash
     node database/bootstrap.mjs --restaurant="Bite Tech Pilot" --email="owner@pilot.example"
     ```

5. **Start Web Service**:
   - Deploy Docker container using `Dockerfile`.
   - Production start command: `npm start`.

6. **Health Check & Verification**:
   - Verify liveness endpoint: `GET /health/live` -> HTTP 200 `{"status":"live"}`.
   - Verify readiness endpoint: `GET /health/ready` -> HTTP 200 `{"status":"ready"}`.

7. **Stripe Webhook Configuration**:
   - Register endpoint: `POST https://<your-domain>/api/billing/webhook`.
   - Set `STRIPE_WEBHOOK_SECRET` in environment variables.

---

## Post-Deployment Pilot Smoke Testing

- Perform authenticated owner login.
- Test POS order placement and inventory deduction.
- Verify sales report generation.
- Perform test backup (see `docs/backup-restore-runbook.md`).
