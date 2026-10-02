import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildHttpApp } from "../src/server/http/app.mjs";

const apps = [];

async function appWith(overrides = {}) {
  const calls = [];
  const authService = {
    async register(input) {
      calls.push(["register", input]);
      return { verificationRequired: true };
    },
    async verifyEmail(input) {
      calls.push(["verify", input]);
      return {
        token: "v".repeat(43),
        expiresAt: new Date("2026-10-03T00:00:00Z"),
        user: { id: "user-1", email: "owner@example.com" },
      };
    },
    async login(input) {
      calls.push(["login", input]);
      return {
        token: "s".repeat(43),
        expiresAt: new Date("2026-10-03T00:00:00Z"),
        user: { id: "user-1", email: "owner@example.com" },
      };
    },
    async logout(token) {
      calls.push(["logout", token]);
    },
    async authenticate(token) {
      calls.push(["authenticate", token]);
      if (!token) return null;
      return {
        user: { id: "user-1", email: "owner@example.com" },
        expiresAt: new Date("2026-10-03T00:00:00Z"),
      };
    },
    ...overrides,
  };
  const app = await buildHttpApp({
    authService,
    trustedOrigin: "https://pos.example.com",
    secureCookies: true,
  });
  apps.push(app);
  return { app, calls };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("authentication HTTP boundary", () => {
  it("registers a restaurant owner without returning a session before verification", async () => {
    const { app, calls } = await appWith();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { origin: "https://pos.example.com" },
      payload: {
        email: "owner@example.com",
        password: "correct horse battery staple",
        displayName: "Owner",
        restaurantName: "Example Cafe",
      },
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.json().verificationRequired, true);
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(calls[0][0], "register");
  });

  it("sets an HttpOnly secure session cookie after login", async () => {
    const { app } = await appWith();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "https://pos.example.com" },
      payload: { email: "owner@example.com", password: "password" },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["set-cookie"], /pos_session=/);
    assert.match(response.headers["set-cookie"], /HttpOnly/i);
    assert.match(response.headers["set-cookie"], /Secure/i);
    assert.match(response.headers["set-cookie"], /SameSite=Lax/i);
  });

  it("rejects malformed registration data", async () => {
    const { app, calls } = await appWith();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { origin: "https://pos.example.com" },
      payload: { email: "bad", password: "short" },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  it("rejects cross-site state-changing requests", async () => {
    const { app, calls } = await appWith();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
      payload: { email: "owner@example.com", password: "password" },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(calls.length, 0);
  });

  it("revokes the server session and clears the cookie on logout", async () => {
    const { app, calls } = await appWith();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        origin: "https://pos.example.com",
        cookie: `pos_session=${"s".repeat(43)}`,
      },
    });

    assert.equal(response.statusCode, 204);
    assert.deepEqual(calls[0], ["logout", "s".repeat(43)]);
    assert.match(response.headers["set-cookie"], /pos_session=;/);
  });

  it("restores the account from a persistent session cookie", async () => {
    const { app } = await appWith();
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `pos_session=${"s".repeat(43)}` },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().user.email, "owner@example.com");
  });

  it("rejects account restoration without a session", async () => {
    const { app } = await appWith();
    const response = await app.inject({ method: "GET", url: "/api/auth/me" });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, "UNAUTHENTICATED");
  });
});
