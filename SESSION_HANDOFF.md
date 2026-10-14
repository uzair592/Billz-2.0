# bite-tech-pos-saas - Session Context

![Continuity](https://raw.githubusercontent.com/Thiagoscode/continuity/main/assets/icon.png)

## Cross-LLM Resumption
To resume this session in ANY AI tool:
1. Read this file for project context
2. Read `.continuity/SESSION_NOTES.md` for goals/blockers/next steps
3. Read `.continuity/unfinished-task.json` for structured resume state
4. Call `get_quick_context` if MCP is available

## AI Assistant: Engineering Guardrails

**Honesty:** State facts only if certain. Label suggestions with confidence level. Label speculation explicitly.

**Decision Logging:** Log decisions that change structure, behavior, or long-term direction immediately after the change. If you're unsure whether something qualifies, say so explicitly and follow the project instructions.

**Override auto-memory for project decisions:** Claude Code's built-in auto-memory writes to a private `~/.claude/projects/.../memory/` store invisible to teammates, future sessions on other machines, and other AI tools. For this Continuity-managed project, that auto-memory is NOT the source of truth — `.continuity/decisions.json` is. Route project-scoped decisions (architecture, tradeoffs, "we chose X because Y") through `continuity log` instead of auto-memory. Auto-memory remains appropriate for cross-project context (user preferences, environment quirks) but project decisions belong in Continuity.

**MCP Availability:** Client capabilities differ. If Continuity MCP tools are available, use them first. If not, fall back to the repo instruction files and session notes instead of assuming memory is connected.

**Workspace Self-Test:** Check `.continuity/mcp-health.json` or resource `continuity://mcp-health` for the latest workspace-target probe. This is about the workspace MCP target, not proof that the current chat client has mounted Continuity.

**Search First:** Before proposing architectural changes, call `search_decisions(query: "keyword")` to check for prior decisions.

**Recovery:** If you realize earlier decisions were not logged, pause, summarize, log retroactively, and inform the user.

**Transparency:** Inform the user when you log decisions, recover missed decisions, detect drift, or find conflicts with past decisions.

**When MCP is connected, richer guardrails are available via resource `continuity://session-handoff`.**

---

## 🏗️ Architecture Overview

**Core Systems:**
- **Decision Logging** - Smart clipboard detection, 5 templates, auto-tag extraction
- **Documentation Tracking** - AST parsing with TypeScript compiler API, semantic change detection
- **File Protection** - Prevent AI modification of critical files (.env, credentials)
- **MCP Integration** - Works with Claude Code, Codex, Cursor, Copilot, Gemini, Cline/Roo, and other MCP-capable clients
- **Delta Tracking** - Shows what changed since last sync
- **Auto-Sync** - Hands-free workflow automation

**Technical Depth:**
- TypeScript Compiler API (ts.createSourceFile, ts.SyntaxKind) for AST parsing
- Exports: functions, classes, interfaces, types, constants
- Tracks: signatures, async status, parameters, return types, JSDoc
- Change detection: new/removed exports, signature changes, async conversions
- Markdown parsing: code blocks, inline code, file references
- Gitignore pattern matching with glob-to-regex conversion
- Smart .txt filtering (docs/, notes/, guides/ folders only)

**Storage:**
- `.continuity/decisions.json` - Architectural decisions
- `.continuity/doc-status.json` - Documentation status
- `.continuity/doc-exports.json` - Code exports snapshot
- `.continuity/delta-snapshot.json` - Last sync state
- `.continuity/protected-files.json` - Protected file patterns
- `SESSION_HANDOFF.md` - Full context for AI handoff


## Project Purpose
Characterization tests and migration scaffold for the Bite Tech restaurant POS SaaS conversion.

## Tech Stack
- **Framework:** Node.js server (Fastify)
- @fastify/cookie
- @fastify/helmet
- @fastify/rate-limit
- argon2
- fastify
- pg
- zod
- @playwright/test

## Recent Changes
**Branch:** main

**Modified:**
- .continuity/cli-state.json
- .continuity/decisions.json
- .continuity/decisions.json.backup
- .continuity/decisions.jsonl
- .continuity/delta-snapshot.json
- .continuity/metrics.json
- Fast_Food_POS_Custom_Bill_Header_XXXL.html
- SESSION_HANDOFF.md
- src/server/authorization/permissions.mjs
- src/server/http/app.mjs
- src/server/http/finance-routes.mjs
- src/server/http/request-guards.mjs
- src/server/main.mjs
- src/server/pos/finance-service.mjs
- src/server/pos/order-history-service.mjs
- src/server/pos/order-service.mjs

**Untracked:**
- database/migrations/023_kitchen_tickets_and_settlement.sql
- src/server/pos/kitchen-service.mjs
- tests/audit-fixes.test.mjs


## Recent Commits
- `45e9b0f` feat: streamline POS auth, recipe display, unified stock tabs, redesigned expenses, and responsive modal (Muhammad Uzair)
- `3184feb` Merge pull request #17 from uzair592/production/verification-tools (Muhammad Uzair)
- `da77a47` Merge pull request #16 from uzair592/security/pos-xss-csp (Muhammad Uzair)
- `f41d851` Merge pull request #15 from uzair592/security/remove-legacy-secrets (Muhammad Uzair)
- `3763599` Merge pull request #14 from uzair592/security/admin-mfa (Muhammad Uzair)


## Recent Decisions (most recent first)
These are prior decisions for THIS project. Treat them as binding context — honor them, and flag any conflict before changing course.

- **Q: How was local work preserved before running the repository version at commit 9f8624b?** _(development, git, how, sync)_
  A: Saved all tracked and untracked local work in stash@{0}, then ran git pull --ff-only on feat/saas-core-manual-subscriptions; origin was already up to date at 9f8624b.
- **Q: What local repository revision and runtime were verified on 2026-10-08?** _(git, runtime, verification)_
  A: Branch feat/saas-core-manual-subscriptions was already synchronized with origin at 9f8624b. npm dependencies had zero known vulnerabilities, all 13 PostgreSQL migrations were current, and the POS plus platform-admin pages and both health endpoints passed on 127.0.0.1:3001. Previous workspace edits remain recoverable in stash@{0}.
- **Q: Why: test(saas-core): add fullstack integration and Playwright browser acceptance test suites?** _(auto-draft, needs-review, architectural)_
  A: (Auto-drafted from commit 58fa038 on 2026-10-07.) Please review and expand with actual reasoning.
- **Q: Why: feat(db): add 013_saas_core_remediation.sql migration for multi-tenant usernames, platform admin, manual payments, storage allowances, and RLS?** _(auto-draft, needs-review, architectural)_
  A: (Auto-drafted from commit c5ca1ae on 2026-10-07.) Please review and expand with actual reasoning.
- **Q: Why: fix(test): expect 12 migrations in migration-runner test suite?** _(auto-draft, needs-review, architectural)_
  A: (Auto-drafted from commit 86e2b91 on 2026-10-06.) Please review and expand with actual reasoning.
- **Q: Why: merge: integrate production readiness into inventory milestone?** _(auto-draft, needs-review)_
  A: (Auto-drafted from commit 0843f07 on 2026-10-06.) Please review and expand with actual reasoning.
- **Q: Why: fix(ci): prefer PostgreSQL 17 client binaries?** _(auto-draft, needs-review, architectural)_
  A: (Auto-drafted from commit 51b953a on 2026-10-06.) Please review and expand with actual reasoning.
- **Q: Why: fix(test): use Promise.all to wait for search and item creation request/response in Playwright spec?** _(auto-draft, needs-review, architectural)_
  A: (Auto-drafted from commit 0197281 on 2026-10-06.) Please review and expand with actual reasoning.
- **Q: Why: test(inventory): add PostgreSQL integration, Playwright browser suite, and operational documentation?** _(auto-draft, needs-review, architectural)_
  A: (Auto-drafted from commit e67715d on 2026-10-06.) Please review and expand with actual reasoning.
- **Q: Why: fix(ci): select PostgreSQL 17 backup tools in validation job?** _(auto-draft, needs-review, architectural)_
  A: (Auto-drafted from commit 9c0fcae on 2026-10-05.) Please review and expand with actual reasoning.
- **Q: Why: fix(ci): install PostgreSQL 17 client tools for backup/restore tests?** _(auto-draft, needs-review, architectural)_
  A: (Auto-drafted from commit a4e64a1 on 2026-10-05.) Please review and expand with actual reasoning.
- **Q: Why: fix(ci): run PostgreSQL-dependent tests against real PostgreSQL and smoke in production mode?** _(auto-draft, needs-review, architectural)_
  A: (Auto-drafted from commit b353922 on 2026-10-05.) Please review and expand with actual reasoning.
- **Q: Why: fix: validate billing migrations and resubscription?** _(auto-draft, needs-review, architectural)_
  A: (Auto-drafted from commit 1b06173 on 2026-10-03.) Please review and expand with actual reasoning.
- **Q: Why: Authenticate before using managed tenant storage; retain recipe warnings and dynamic migration assertions?** _(auto-draft, needs-review, architectural)_
  A: (Auto-drafted from commit ea54968 on 2026-10-10.) Please review and expand with actual reasoning.
- **Q: Why: Hide legacy PIN overlay for managed login and report fresh database migrations as pending?** _(auto-draft, needs-review, architectural)_
  A: (Auto-drafted from commit 485210e on 2026-10-10.) Please review and expand with actual reasoning.
- **Q: Docker command not recognized after installation** _(docker, environment)_
  A: Provided troubleshooting steps to ensure Docker is in PATH and Docker Desktop is running
- **Q: How was the updated repository fetched, verified, and loaded on 2026-10-14?** _(git, runtime, verification, sync)_
  A: Saved tracked local state, pulled remote origin/main (fddea35), verified PostgreSQL 16 on 127.0.0.1:5432, ran all 20 migrations and seed plans, created default platform administrator, verified 642/642 tests passing, and loaded the Fastify server on 127.0.0.1:3000.
- **Q: How were login credentials and password reset help updated for cashiers and support?** _(auth, how, login, ui)_
  A: Removed the restaurant code field requirement from the login UI and added support contact number 03015929230 for forgot password help.
- **Q: How were recipe display bugs, stock navigation, expenses UI, reports, security settings, and 14-inch invoice modal scrolling fixed?** _(bugfix, expenses, how, modal, recipes, reports)_
  A: Fixed renderManualRecipeFields HTML escaping, consolidated Inventory and Purchases into Stock sub-tabs, redesigned Expenses into modern cards, removed cloud report clutter, replaced PIN settings with Username/Password updater, auto-imported catalog on checkout, and added max-height 88vh with overflow scrolling to the invoice modal.
- **Q: How was commit 45e9b0f pushed to the Billz-2.0 remote?** _(git, how, release, sync)_
  A: Pushed commit 45e9b0f to origin/main on https://github.com/uzair592/Billz-2.0.git with all fixes and enhancements.
- **Q: How were the October 14 Billz 2.0 pre-deployment audit findings resolved across backend, database, client, and test suites?** _(audit, database, deployment, finance, how, kitchen)_
  A: Applied migration 023 for kitchen tickets and request hash, created kitchen-service.mjs, added kitchen ticket lifecycle management with KDS screen, durable FIFO print queue, local cart draft recovery, order payment settlement endpoint and modal UI, authoritative cloud finance sync and transfers, role navigation guards, idempotency request hash conflict detection, and expanded accountant permissions with 675 passing tests.

Older decisions may exist beyond these 21; use `search_decisions(query)` or grep `.continuity/decisions.json` for the full history.

## Project Structure
.continuity/
AGENTS.md
CLAUDE.md
Dockerfile
Fast_Food_POS_Custom_Bill_Header_XXXL.html
GEMINI.md
README.md
SESSION_HANDOFF.md
backups/
compose.production-smoke.yaml
compose.test-database.yaml
compose.validation.yaml
database/
docs/
package-lock.json
package.json
platform-admin/
playwright.config.mjs
playwright.saas-core.config.mjs
render.yaml
scratch/
scripts/
setup-local-db.ps1
src/
test-results/
tests/

---

## Session Checklist

- [x] Read SESSION_HANDOFF.md
- [ ] Verify whether Continuity MCP tools are available in this client
- [ ] If MCP is unavailable, use repo instruction files, `.continuity/mcp-health.json`, and `.continuity/unfinished-task.json` as fallback context
- [ ] Search past decisions before proposing architectural changes
- [ ] Log architectural decisions (only structural/behavioral/directional changes)
- [ ] Inform user when decisions are logged, recovered, or conflicts detected
- [ ] Recover any missed decisions before session ends

---
Generated: 2026-10-14T19:07:55.084Z
