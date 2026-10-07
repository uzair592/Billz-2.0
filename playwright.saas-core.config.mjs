import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "saas-core-acceptance.spec.mjs",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  webServer: {
    command: "node src/server/main.mjs",
    url: "http://127.0.0.1:3000/health/ready",
    reuseExistingServer: true,
    timeout: 30_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_ADMIN_URL || "postgresql://postgres:validation-only@127.0.0.1:55432/restaurant_pos_test",
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
