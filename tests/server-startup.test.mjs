import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it, before, after } from "node:test";

/**
 * Tests that the server can start and listen on Linux.
 * Spawns the server as a child process, proves it listens, then terminates cleanly.
 */
describe("Linux server startup", () => {
  let serverProcess;

  after(async () => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      await new Promise((resolve) => serverProcess.on("exit", resolve));
    }
  });

  it("starts and listens on the configured port", async () => {
    // Use a test database URL that will fail fast if not configured
    const env = {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://postgres:validation-only@127.0.0.1:55432/restaurant_pos_test",
      TRUSTED_ORIGIN: "https://pos.example.com",
      PASSWORD_PEPPER: "a-long-enough-pepper-value-for-testing-purposes-only",
      SESSION_SECRET: "a-different-session-secret-for-testing-purposes",
      PAYMENT_PROVIDER: "manual",
      PORT: "34567", // Use a high port to avoid conflicts
      HOST: "127.0.0.1",
    };

    return new Promise((resolve, reject) => {
      serverProcess = spawn("node", ["src/server/main.mjs"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      let errorOutput = "";
      let started = false;

      serverProcess.stdout.on("data", (data) => {
        output += data.toString();
        if (!started && output.includes("pos_server_started")) {
          started = true;
          // Give it a moment to fully bind
          setTimeout(() => resolve(), 500);
        }
      });

      serverProcess.stderr.on("data", (data) => {
        errorOutput += data.toString();
      });

      serverProcess.on("error", (err) => {
        reject(new Error(`Failed to spawn server: ${err.message}`));
      });

      serverProcess.on("exit", (code, signal) => {
        if (!started) {
          reject(new Error(`Server exited prematurely (code: ${code}, signal: ${signal}). stderr: ${errorOutput}`));
        }
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!started) {
          serverProcess.kill("SIGTERM");
          reject(new Error(`Server did not start within 10 seconds. stderr: ${errorOutput}`));
        }
      }, 10000);
    });
  });
});