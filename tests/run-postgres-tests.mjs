import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { projectRoot } from "./helpers/legacy-source.mjs";
import { isDatabaseAvailable } from "./helpers/postgres.mjs";

/**
 * Runner for the PostgreSQL-dependent Milestone 13 suites.
 *
 * These tests need a live PostgreSQL instance and the correct
 * TEST_DATABASE_ADMIN_URL. They are deliberately separated from the
 * pure unit suites so the unit step never tries to connect before the
 * database is reachable, and so a connection failure is reported as a
 * database problem rather than as a misleading test failure.
 *
 * The runner refuses to start unless the admin database is reachable,
 * so a missing or misconfigured database produces a clear, non-zero
 * failure instead of an incomplete "successful" report.
 */
const POSTGRES_TESTS = [
  "migration-runner.test.mjs",
  "health-endpoints.test.mjs",
  "bootstrap-first-restaurant.test.mjs",
  "graceful-shutdown.test.mjs",
  "backup-restore.test.mjs",
];

if (!isDatabaseAvailable()) {
  console.error(
    "PostgreSQL is not reachable at TEST_DATABASE_ADMIN_URL. "
    + "The PostgreSQL-dependent tests require a live database.",
  );
  process.exit(1);
}

const testsDir = path.join(projectRoot, "tests");
const files = POSTGRES_TESTS
  .filter((file) => {
    // Only run files that actually exist so a renamed suite does not
    // silently disappear from the report.
    return true;
  })
  .sort()
  .map((file) => path.join(testsDir, file));

// Confirm every expected suite is present. A missing file means the
// report would be incomplete, so fail loudly rather than pass quietly.
const present = new Set((await readdir(testsDir)).filter((f) => f.endsWith(".test.mjs")));
const missing = POSTGRES_TESTS.filter((file) => !present.has(file));
if (missing.length > 0) {
  console.error(`Expected PostgreSQL test files are missing: ${missing.join(", ")}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--test", ...files],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
