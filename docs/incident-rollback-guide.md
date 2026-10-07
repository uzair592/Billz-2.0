# Incident & Rollback Guide

Emergency response procedure for deployment failures or operational incidents during pilot.

---

## 1. Fastify Application Rollback

If a newly deployed Docker image exhibits runtime errors or service degradation:

1. **Revert Deployment Container**:
   - In container management dashboard (e.g. Render / Railway / Docker Compose), select the previous green Docker image SHA / release tag.
   - Re-deploy previous image tag immediately.

2. **Verify Liveness and Readiness**:
   ```bash
   curl -i https://<pilot-domain>/health/live
   curl -i https://<pilot-domain>/health/ready
   ```

---

## 2. Database Migration Rollback Rules

- All 12 PostgreSQL migrations are designed to be backward compatible with previous application versions.
- If a database rollback is required, do **not** run destructive schema drops on live production tables.
- Follow the backup-restore runbook (`docs/backup-restore-runbook.md`) to restore to a separate target database and switch connection strings after verification.

---

## 3. Incident Severity Levels & Response SLA

| Level | Description | Target Response Time | Action |
| --- | --- | --- | --- |
| **P1 - Outage** | Application unresponsive or database unreachable | < 15 minutes | Rollback to previous Docker image; check container logs |
| **P2 - Degraded** | Stripe checkout failure or high latency | < 1 hour | Enable offline fallback; inspect API metrics |
| **P3 - Low** | Minor UI or report formatting issue | < 24 hours | Fix on dev branch, submit PR with test suite |
