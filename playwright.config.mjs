import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 0,
  workers: 1,
  webServer: {
    command: "node tests/browser/static-server.mjs",
    port: 8899,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: "http://127.0.0.1:8899",
    launchOptions: {
      args: ["--no-sandbox"],
    },
  },
});
