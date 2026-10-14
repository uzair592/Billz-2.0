import test from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import {
  base32,
  totp,
  verifyTotp,
  createTotpCrypto,
} from "../src/server/auth/totp.mjs";
import { createIpAllowlist } from "../src/server/auth/ip-allowlist.mjs";
import { verifyPassword, hashPassword } from "../src/server/auth/passwords.mjs";
import { buildHttpApp } from "../src/server/http/app.mjs";

test("TOTP matches RFC 6238 SHA1 vectors and rejects stale/replayed codes", () => {
  const secret = base32(Buffer.from("12345678901234567890"));
  for (const [time, expected] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ]) {
    assert.equal(totp(secret, Math.floor(time / 30), { digits: 8 }), expected);
  }
  const now = new Date(1234567890000),
    counter = Math.floor(now.getTime() / 30000),
    code = totp(secret, counter);
  assert.equal(verifyTotp(secret, code, now), counter);
  assert.equal(verifyTotp(secret, code, now, counter), null);
  assert.equal(verifyTotp(secret, code, new Date(now.getTime() + 90000)), null);
});
test("encrypted TOTP secrets are bound to administrator and encryption key", () => {
  const crypto = createTotpCrypto("session-secret-at-least-32-characters");
  const value = crypto.encrypt("ABCDEFGHIJKLMNOP", "admin-a");
  assert.equal(value.includes("ABCDEFGHIJKLMNOP"), false);
  assert.equal(crypto.decrypt(value, "admin-a"), "ABCDEFGHIJKLMNOP");
  assert.throws(() => crypto.decrypt(value, "admin-b"), /cannot be read/);
  assert.throws(
    () =>
      createTotpCrypto("different-secret-at-least-32-chars").decrypt(
        value,
        "admin-a",
      ),
    /cannot be read/,
  );
  assert.notEqual(
    crypto.recoveryHash("ABCDEF-GHIJKL", "admin-a"),
    crypto.recoveryHash("ABCDEF-GHIJKL", "admin-b"),
  );
});
test("legacy password verification accepts shorter hashes while new password policy stays 10", async (t) => {
  const pepper = "legacy-password-test-pepper-32chars";
  const hash = await argon2.hash(`short\u0000${pepper}`, {
    type: argon2.argon2id,
  });
  assert.equal(await verifyPassword(hash, "short", pepper), true);
  assert.equal(await verifyPassword(hash, "wrong", pepper), false);
  assert.equal(await verifyPassword(null, "wrong", pepper), false);
  await assert.rejects(hashPassword("short", pepper), /at least 10/);
  const app = await buildHttpApp({
    authService: {
      login: async (input) => {
        assert.equal(input.password, "short");
        return {
          user: { id: "user" },
          token: "session",
          expiresAt: new Date(Date.now() + 60000),
        };
      },
    },
    trustedOrigin: "http://localhost:3000",
    serveClient: false,
  });
  t.after(() => app.close());
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          restaurantCode: "cafe",
          username: "owner",
          password: "short",
        },
      })
    ).statusCode,
    200,
  );
});
test("administrator IP gate covers HTML, assets, encoded paths and API before authentication", async (t) => {
  const allow = createIpAllowlist("192.0.2.0/24,2001:db8::/32");
  assert.ok(allow("::ffff:192.0.2.5"));
  assert.ok(allow("2001:db8::5"));
  assert.equal(allow("198.51.100.1"), false);
  const app = await buildHttpApp({
    authService: {},
    trustedOrigin: "http://localhost:3000",
    platformAdminAllowedIps: "192.0.2.0/24",
    trustProxy: ["10.0.0.2/32"],
  });
  t.after(() => app.close());
  for (const url of [
    "/platform-admin",
    "/platform-admin/",
    "/platform-admin/app.js",
    "/%70latform-admin/",
    "/platform-admin/api/auth/login",
  ]) {
    const result = await app.inject({
      url,
      remoteAddress: "198.51.100.1",
      headers: { "x-forwarded-for": "192.0.2.1" },
    });
    assert.equal(result.statusCode, 404, url);
  }
  assert.equal(
    (
      await app.inject({
        url: "/platform-admin/",
        remoteAddress: "10.0.0.2",
        headers: { "x-forwarded-for": "192.0.2.5" },
      })
    ).statusCode,
    200,
  );
});
