# Billz 2.0 POS — Correct Runtime Record & Server Environment Verification

**Repository:** `https://github.com/uzair592/Billz-2.0`  
**Audited Main Commit SHA:** `7bcd9911e365415b3c18ed064208e0177cf4043a`  
**Audit Branch:** `audit/full-saas-platform`  
**Verification Date:** October 7, 2026  

---

## 1. Runtime Process & Server Port Explanation

- **Previous Port 8899 Inspection**:
  - Port `8899` was previously spun up by Playwright webServer runner executing `node tests/browser/static-server.mjs`.
  - It was a static node file server for standalone testing of `Fast_Food_POS_Custom_Bill_Header_XXXL.html`, NOT the real multi-tenant Fastify server application.

- **Real Production/Development Entry Point**:
  - Entry Point: `src/server/main.mjs`
  - Startup Command: `npm start` or `node src/server/main.mjs`
  - Application Web URL: `http://127.0.0.1:3000/` (or `PORT` env setting)
  - API Base URL: `http://127.0.0.1:3000/api`
  - Database System: PostgreSQL 15+ (`DATABASE_URL=postgres://...`)
  - `NODE_ENV`: `development` / `production`

---

## 2. Server Startup & Health Endpoint Verification Logs

- `/health/live`: `HTTP 200 OK` `{"status":"ok"}`
- `/health/ready`: `HTTP 200 OK` `{"status":"ready","database":true,"migrations":true}`
- Authenticated Endpoint Test: `GET /api/auth/me` `HTTP 200 OK` (returns authenticated user & assigned tenant context).

---

## 3. Seeded Multi-Tenant Verification Dataset

1. **Restaurant A** (`11111111-1111-4111-8111-111111111111`): Active paid subscription.
   - User `owner.a@example.com` (Owner)
   - User `manager.a@example.com` (Manager)
   - User `cashier.a@example.com` (Cashier)
   - User `accountant.a@example.com` (Accountant)
2. **Restaurant B** (`22222222-2222-4222-8222-222222222222`): Suspended / Expired subscription.
   - User `owner.b@example.com` (Owner)
