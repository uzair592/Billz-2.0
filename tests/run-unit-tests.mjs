import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { projectRoot } from "./helpers/legacy-source.mjs";

/**
 * Cross-platform unit test runner.
 *
 * Mirrors the CI unit-test step: every `*.test.mjs` directly under
 * `tests/` runs except the PostgreSQL integration suites, the
 * Linux-only startup test, and the PostgreSQL-dependent Milestone 13
 * suites, which need a live database and are executed by
 * `npm run test:postgres` after the database is provisioned.
 * Running the PostgreSQL suites here would make them provision the
 * same schema concurrently and clobber each other, and they would
 * try to connect before the database is reachable.
 */
const EXCLUDED = new Set([
  "billing-postgres.test.mjs",
  "refund-sales-report-postgres.test.mjs",
  "server-startup.test.mjs",
  // PostgreSQL-dependent Milestone 13 suites. They require a live
  // database and the correct TEST_DATABASE_ADMIN_URL, so they run in
  // the dedicated postgres step, never in the pure unit step.
  "migration-runner.test.mjs",
  "health-endpoints.test.mjs",
  "bootstrap-first-restaurant.test.mjs",
  "graceful-shutdown.test.mjs",
  "backup-restore.test.mjs",
]);

const testsDir = path.join(projectRoot, "tests");
const files = (await readdir(testsDir))
  .filter((file) => file.endsWith(".test.mjs") && !EXCLUDED.has(file))
  .sort()
  .map((file) => path.join(testsDir, file));

if (files.length === 0) {
  console.error("No unit test files found.");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--test", ...files],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
