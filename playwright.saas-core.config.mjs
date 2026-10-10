import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "saas-core-acceptance.spec.mjs",
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
      DATABASE_URL: process.env.TEST_DATABASE_URL || "postgresql://pos_integration_app:integration-only@127.0.0.1:55432/restaurant_pos_test",
      CONTROL_DATABASE_URL: process.env.TEST_CONTROL_DATABASE_URL || "postgresql://pos_control_test:control-test-only@127.0.0.1:55432/restaurant_pos_test",
      PASSWORD_PEPPER: "test-pepper-for-development-only-32bytes",
      SESSION_SECRET: "test-session-secret-development-32bytes",
      TRUSTED_ORIGIN: "http://127.0.0.1:3000",
      DISABLE_RATE_LIMIT: "true",
      NODE_ENV: "development",
    },
  },
  use: {
    baseURL: "http://127.0.0.1:3000",
    launchOptions: {
      args: ["--no-sandbox"],
    },
  },
});
