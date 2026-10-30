import { defineConfig } from "@playwright/test";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL || "postgresql://postgres:postgres@127.0.0.1:5432/restaurant_pos_test";
function deriveUrl(role, pass) {
  try {
    const u = new URL(adminUrl);
    u.username = role;
    u.password = pass;
    return u.toString();
  } catch {
    return `postgresql://${role}:${pass}@127.0.0.1:5432/restaurant_pos_test`;
  }
}

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: ["saas-core-acceptance.spec.mjs", "launch-readiness-acceptance.spec.mjs", "admin-control-acceptance.spec.mjs", "admin-mfa-acceptance.spec.mjs", "pos-xss-acceptance.spec.mjs"],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  webServer: {
    command: "node tests/browser/setup-saas.mjs && node src/server/main.mjs",
    url: "http://127.0.0.1:3000/health/ready",
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL || deriveUrl("pos_integration_app", "integration-only"),
      CONTROL_DATABASE_URL: process.env.TEST_CONTROL_DATABASE_URL || deriveUrl("pos_control_test", "control-test-only"),
      PASSWORD_PEPPER: "test-pepper-for-development-only-32bytes",
      SESSION_SECRET: "test-session-secret-development-32bytes",
      TRUSTED_ORIGIN: "http://127.0.0.1:3000",
      DISABLE_RATE_LIMIT: "true",
      NODE_ENV: "test",
    },
  },
  use: {
    baseURL: "http://127.0.0.1:3000",
    launchOptions: {
      args: ["--no-sandbox"],
    },
  },
});
