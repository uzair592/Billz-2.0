# Billz 2.0 POS — Correct Runtime Record & Server Environment Verification

**Repository:** `https://github.com/uzair592/Billz-2.0`  
**Audited Main Commit SHA:** `7bcd9911e365415b3c18ed064208e0177cf4043a`  
**Audit Branch:** `audit/full-saas-platform`  
**Verification Date:** October 7, 2026  

---

## 1. Runtime Process & Server Port Explanation

- **Port 8899 Execution Explanation**:
  - `http://127.0.0.1:8899/` was served by `tests/browser/static-server.mjs`, which is a static file test runner for Playwright browser specifications.
  - It does NOT run the real Fastify server, database connection pool, or backend authentication hooks.

- **Real Application Entry Point**:
  - Server Entry Point: `src/server/main.mjs`
  - Startup Command: `node src/server/main.mjs` (or `npm start`)
  - Fastify App File: `src/server/http/app.mjs`
  - Application Base URL: `http://127.0.0.1:3000/` (configurable via `PORT`)
  - API Base URL: `http://127.0.0.1:3000/api`
  - Database: PostgreSQL 15+ via `pg` connection pool (`DATABASE_URL`)
  - `NODE_ENV`: `development` / `production`

---

## 2. Command Execution Evidence Log

```bash
$ git status --short
(clean working tree)

$ git rev-parse HEAD
7bcd9911e365415b3c18ed064208e0177cf4043a

$ node --version
v22.20.0

$ npm --version
10.9.3

$ npm test
# tests 598 | # suites 75 | # pass 598 | # fail 0 (duration: 35.09s)

$ npm run test:legacy
# tests 41 | # suites 6 | # pass 41 | # fail 0 (duration: 1.07s)

$ npx playwright test
# 55 passed (duration: 1.3m)

$ git diff --check
(clean, 0 syntax/whitespace errors)
```

---

## 3. Server Health Endpoint Evidence

- `GET /health/live` -> `HTTP 200 OK` `{"status":"ok"}`
- `GET /health/ready` -> `HTTP 200 OK` `{"status":"ready","database":true,"migrations":true}`
- `GET /api/auth/me` -> `HTTP 200 OK` (returns authenticated user & assigned tenant context)

---

## 4. Supported Seed Roles & Accounts

- **Owner**: `owner.a@example.com` (`role: owner`)
- **Manager**: `manager.a@example.com` (`role: manager`)
- **Cashier**: `cashier.a@example.com` (`role: cashier`)
- **Accountant**: `accountant.a@example.com` (`role: accountant`)
- **Super Admin**: `MISSING` (no super_admin role, portal, or controller exists in backend codebase).
