import test from "node:test";
import assert from "node:assert/strict";
import { buildHttpApp } from "../src/server/http/app.mjs";

test("shared-IP successes do not exhaust authentication failure budgets", async t => {
  const session = { user: { id: "owner" }, token: "session", expiresAt: new Date(Date.now() + 60000) };
  const app = await buildHttpApp({
    authService: {
      login: async () => session,
      verifyEmail: async () => session,
      authenticate: async () => session,
      changePassword: async () => ({ changed: true }),
    },
    platformAdminService: { login: async () => ({ ...session, admin: { id: "admin" } }) },
    platformAdminPortalService: {},
    trustedOrigin: "http://localhost:3000", serveClient: false,
  });
  t.after(() => app.close());
  for (const [url, payload] of [
    ["/api/auth/login", { restaurantCode: "cafe", username: "owner", password: "Password123!" }],
    ["/api/auth/change-password", { currentPassword: "Password123!", newPassword: "NewPassword123!" }],
    ["/api/auth/verify-email", { token: "a".repeat(32) }],
    ["/platform-admin/api/auth/login", { username: "admin", password: "Password123!" }],
  ]) {
    for (let n = 0; n < 15; n++) {
      const response = await app.inject({ method: "POST", url, payload, remoteAddress: "198.51.100.1" });
      assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    }
  }
});

test("administrator failure budget stays tight and sends Retry-After", async t => {
  const app = await buildHttpApp({
    authService: {},
    platformAdminService: { login: async () => { throw Object.assign(new Error("Invalid credentials."), { code: "INVALID_ADMIN_CREDENTIALS", statusCode: 401 }); } },
    platformAdminPortalService: {}, trustedOrigin: "http://localhost:3000", serveClient: false,
  });
  t.after(() => app.close());
  for (let n = 0; n < 11; n++) {
    const response = await app.inject({ method: "POST", url: "/platform-admin/api/auth/login",
      payload: { username: `admin${n}`, password: "WrongPassword123!" }, remoteAddress: "198.51.100.2" });
    assert.equal(response.statusCode, n < 10 ? 401 : 429, response.body);
    if (n === 10) assert.ok(Number(response.headers["retry-after"]) > 0);
  }
});

test("password and email verification failures retain their separate IP caps", async t => {
  const app = await buildHttpApp({ authService: {
    authenticate: async () => ({ user: { id: "owner" } }),
    changePassword: async () => { throw Object.assign(new Error("Wrong password."), { statusCode: 401 }); },
    verifyEmail: async () => { throw Object.assign(new Error("Invalid token."), { statusCode: 400 }); },
  }, trustedOrigin: "http://localhost:3000", serveClient: false });
  t.after(() => app.close());
  for (const [url, payload, max, status] of [
    ["/api/auth/change-password", { currentPassword: "WrongPassword123!", newPassword: "NewPassword123!" }, 5, 401],
    ["/api/auth/verify-email", { token: "a".repeat(32) }, 10, 400],
  ]) for (let n = 0; n <= max; n++) {
    const response = await app.inject({ method: "POST", url, payload, remoteAddress: "198.51.100.3" });
    assert.equal(response.statusCode, n < max ? status : 429, response.body);
    if (n === max) assert.ok(Number(response.headers["retry-after"]) > 0);
  }
});
