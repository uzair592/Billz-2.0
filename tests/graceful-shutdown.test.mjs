import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { runServer, startServer, createServer } from "../src/server/main.mjs";

const databaseUrl = process.env.TEST_DATABASE_ADMIN_URL
  ?? "postgresql://postgres:validation-only@127.0.0.1:55432/restaurant_pos_test";

const serverEnv = {
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  TRUSTED_ORIGINS: "https://pos.example.com",
  PASSWORD_PEPPER: "a-long-enough-pepper-value",
  SESSION_SECRET: "a-different-session-secret",
  PAYMENT_PROVIDER: "manual",
  HOST: "127.0.0.1",
};

const isWindows = process.platform === "win32";

function spawnServer({ port, env = {} }) {
  const child = spawn("node", ["src/server/main.mjs"], {
    env: { ...process.env, ...serverEnv, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

function waitForOutput(child, marker, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for "${marker}". stderr: ${errorOutput}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        clearTimeout(timer);
        resolve(output);
      }
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before "${marker}" (code=${code}, signal=${signal}). stderr: ${errorOutput}`));
    });
  });
}

function waitForExit(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Server did not exit within the grace period."));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe("graceful startup and shutdown", () => {
  it("starts and serves liveness", async () => {
    const port = 34_800 + Math.floor(Math.random() * 300);
    const server = await startServer({
      env: { ...serverEnv, PORT: String(port) },
      logger: { info() {}, warn() {}, error() {} },
    });
    try {
      const live = await fetch(`http://127.0.0.1:${port}/health/live`);
      assert.equal(live.status, 200);
      const body = await live.json();
      assert.equal(body.status, "ok");
    } finally {
      await server.close();
    }
  });

  it("closes the HTTP server and the PostgreSQL pool cleanly", async () => {
    const port = 34_800 + Math.floor(Math.random() * 300);
    const server = await startServer({
      env: { ...serverEnv, PORT: String(port) },
      logger: { info() {}, warn() {}, error() {} },
    });
    try {
      const live = await fetch(`http://127.0.0.1:${port}/health/live`);
      assert.equal(live.status, 200);
    } finally {
      // close() must resolve, proving Fastify and the pool shut down.
      await server.close();
    }
    // After close, the pool is ended; a new query must fail.
    await assert.rejects(
      () => server.pool.query("SELECT 1"),
      /Cannot use a pool after calling end/,
    );
  });

  it("exits non-zero on an invalid configuration", async () => {
    const port = 34_800 + Math.floor(Math.random() * 300);
    const child = spawnServer({ port, env: { TRUSTED_ORIGINS: "" } });
    try {
      const { code } = await waitForExit(child);
      assert.notEqual(code, 0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it("exits non-zero when the database is unavailable at startup", async () => {
    const port = 34_800 + Math.floor(Math.random() * 300);
    const child = spawn("node", ["src/server/main.mjs"], {
      env: {
        ...process.env,
        ...serverEnv,
        DATABASE_URL: "postgresql://postgres:validation-only@127.0.0.1:59999/nonexistent",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const { code } = await waitForExit(child);
      assert.notEqual(code, 0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  // Signal-based graceful shutdown is exercised on POSIX platforms. On
  // Windows, SIGTERM/SIGINT are not delivered as real signals, so the
  // in-process close() tests above cover the same shutdown path.
  if (!isWindows) {
    it("shuts down cleanly on SIGTERM", async () => {
      const port = 34_800 + Math.floor(Math.random() * 300);
      const child = spawnServer({ port });
      try {
        await waitForOutput(child, "pos_server_started");
        const live = await fetch(`http://127.0.0.1:${port}/health/live`);
        assert.equal(live.status, 200);
        child.kill("SIGTERM");
        const { code, signal } = await waitForExit(child);
        assert.equal(signal, null);
        assert.equal(code, 0);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    });

    it("shuts down cleanly on SIGINT", async () => {
      const port = 34_800 + Math.floor(Math.random() * 300);
      const child = spawnServer({ port });
      try {
        await waitForOutput(child, "pos_server_started");
        child.kill("SIGINT");
        const { code, signal } = await waitForExit(child);
        assert.equal(signal, null);
        assert.equal(code, 0);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    });
  }
});
