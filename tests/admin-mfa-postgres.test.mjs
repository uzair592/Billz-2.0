import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import {
  provisionIntegrationDatabase,
  createControlPool,
} from "./helpers/postgres.mjs";
import { createPlatformAdminRepository } from "../src/server/auth/platform-admin-repository.mjs";
import { createPlatformAdminService } from "../src/server/auth/platform-admin-service.mjs";
import { createPlatformAdminMfaService } from "../src/server/auth/platform-admin-mfa-service.mjs";
import { totp } from "../src/server/auth/totp.mjs";
import { buildHttpApp } from "../src/server/http/app.mjs";

test("administrator 2FA enrollment, recovery, replay protection and log secrecy over real PostgreSQL/HTTP", async (t) => {
  await provisionIntegrationDatabase();
  const pool = await createControlPool();
  let now = new Date(),
    log = "";
  const clock = () => now,
    pepper = "mfa-test-password-pepper-32-chars";
  const repository = createPlatformAdminRepository(pool);
  const mfa = createPlatformAdminMfaService({
    pool,
    passwordPepper: pepper,
    sessionSecret: "mfa-test-session-secret-32-chars",
    clock,
  });
  const service = createPlatformAdminService({
    repository,
    passwordPepper: pepper,
    mfaService: mfa,
    clock,
  });
  const admin = await service.bootstrapAdmin({
    username: "mfaadmin",
    password: "AdminPassword123!",
  });
  const app = await buildHttpApp({
    authService: {},
    platformAdminService: service,
    platformAdminMfaService: mfa,
    platformAdminPortalService: {},
    trustedOrigin: "http://localhost:3000",
    serveClient: false,
    nodeEnv: "test",
    logger: {
      level: "info",
      stream: new Writable({
        write(chunk, _encoding, next) {
          log += chunk.toString();
          next();
        },
      }),
    },
  });
  t.after(async () => {
    await app.close();
    await pool.end();
  });
  let n = 0;
  const send = (path, payload, cookie, headers = {}) =>
    app.inject({
      method: payload === undefined ? "GET" : "POST",
      url: path,
      payload,
      remoteAddress: `198.51.100.${++n}`,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
    });
  const signIn = (code) =>
    send("/platform-admin/api/auth/login", {
      username: "mfaadmin",
      password: "AdminPassword123!",
      ...(code ? { code } : {}),
    });
  const cookie = (response) => response.headers["set-cookie"].split(";")[0];
  const first = await signIn();
  assert.equal(first.statusCode, 200, first.body);
  const original = cookie(first);
  const second = cookie(await signIn());
  const path = "/platform-admin/api/security/2fa";
  assert.equal(
    (await send(`${path}/start`, { currentPassword: "AdminPassword123!" }))
      .statusCode,
    401,
  );
  assert.equal(
    (await send(`${path}/start`, { currentPassword: "wrong" }, original))
      .statusCode,
    401,
  );
  const start = await send(
    `${path}/start`,
    { currentPassword: "AdminPassword123!" },
    original,
  );
  assert.equal(start.statusCode, 200, start.body);
  assert.equal(start.headers["cache-control"], "no-store");
  const enrollment = start.json(),
    secret = new URL(enrollment.otpauthUri).searchParams.get("secret");
  assert.equal(enrollment.recoveryCodes.length, 10);
  assert.equal((await send(path, undefined, original)).json().enabled, false);
  const row = (
    await pool.query("SELECT * FROM platform_administrators WHERE id=$1", [
      admin.admin.id,
    ])
  ).rows[0];
  assert.equal(JSON.stringify(row).includes(secret), false);
  for (const code of enrollment.recoveryCodes)
    assert.equal(JSON.stringify(row).includes(code), false);
  const current = () => totp(secret, Math.floor(now.getTime() / 30000));
  assert.equal(
    (
      await send(
        `${path}/verify`,
        {
          enrollmentId: enrollment.enrollmentId,
          code: current() === "000000" ? "000001" : "000000",
        },
        original,
      )
    ).statusCode,
    401,
  );
  const verified = await send(
    `${path}/verify`,
    { enrollmentId: enrollment.enrollmentId, code: current() },
    original,
  );
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(verified.headers["cache-control"], "no-store");
  assert.equal(
    (
      await send(
        `${path}/start`,
        { currentPassword: "AdminPassword123!" },
        original,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (await send("/platform-admin/api/auth/me", undefined, second)).statusCode,
    401,
  );
  assert.equal((await signIn()).statusCode, 401);
  assert.equal((await signIn(current())).statusCode, 401); // Enrollment already consumed this time step.
  now = new Date(now.getTime() + 60000);
  const login = await signIn(current());
  assert.equal(login.statusCode, 200, login.body);
  const active = cookie(login);
  const recovered = await signIn(enrollment.recoveryCodes[0]);
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal((await signIn(enrollment.recoveryCodes[0])).statusCode, 401);
  const oldCode = enrollment.recoveryCodes[1];
  const races = await Promise.all([signIn(oldCode), signIn(oldCode)]);
  assert.deepEqual(races.map((r) => r.statusCode).sort(), [200, 401]);
  now = new Date(now.getTime() + 60000);
  assert.equal(
    (
      await send(
        `${path}/recovery-codes`,
        { currentPassword: "wrong", code: current() },
        active,
      )
    ).statusCode,
    401,
  );
  const regenerated = await send(
    `${path}/recovery-codes`,
    { currentPassword: "AdminPassword123!", code: current() },
    active,
  );
  assert.equal(regenerated.statusCode, 200, regenerated.body);
  assert.equal(regenerated.headers["cache-control"], "no-store");
  const newCodes = regenerated.json().recoveryCodes;
  assert.equal((await signIn(enrollment.recoveryCodes[2])).statusCode, 401);
  assert.equal((await signIn(newCodes[0])).statusCode, 200);
  const status = await send(path, undefined, active, {
    "x-request-id": secret,
    "x-debug": newCodes[1],
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.includes("otpauth"), false);
  now = new Date(now.getTime() + 60000);
  const disabled = await send(
    `${path}/disable`,
    { currentPassword: "AdminPassword123!", code: current() },
    active,
  );
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal((await signIn()).statusCode, 200);
  const audits = (
    await pool.query(
      "SELECT action,metadata FROM audit_logs WHERE actor_admin_id=$1 ORDER BY created_at",
      [admin.admin.id],
    )
  ).rows;
  assert.deepEqual(
    audits
      .filter((r) => r.action.startsWith("platform_admin.2fa."))
      .map((r) => r.action),
    [
      "platform_admin.2fa.enrollment_started",
      "platform_admin.2fa.enabled",
      "platform_admin.2fa.disabled",
    ],
  );
  const persisted = (
    await pool.query("SELECT * FROM platform_administrators WHERE id=$1", [
      admin.admin.id,
    ])
  ).rows[0];
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(log.includes("incoming request"), "HTTP log capture must be active");
  for (const value of [
    secret,
    enrollment.otpauthUri,
    ...enrollment.recoveryCodes,
    ...newCodes,
  ]) {
    assert.equal(log.includes(value), false, "secret leaked into HTTP logs");
    assert.equal(
      JSON.stringify(audits).includes(value),
      false,
      "secret leaked into audit rows",
    );
    assert.equal(
      JSON.stringify(persisted).includes(value),
      false,
      "plaintext persisted",
    );
  }
});
