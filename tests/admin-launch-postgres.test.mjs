import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  provisionIntegrationDatabase,
  createAppPool,
  createControlPool,
  connectAdmin,
} from "./helpers/postgres.mjs";
import { createLoginThrottle } from "../src/server/auth/login-throttle.mjs";
import { createServer } from "../src/server/main.mjs";
import { createPlatformAdminService } from "../src/server/auth/platform-admin-service.mjs";
import { createPlatformAdminRepository } from "../src/server/auth/platform-admin-repository.mjs";
import { createPostgresAuthRepository } from "../src/server/auth/postgres-auth-repository.mjs";
import { createTokenPair } from "../src/server/auth/tokens.mjs";
import { seedPlan } from "./helpers/postgres.mjs";

test("shared-IP restaurant and admin logins allow startup and isolate failed accounts", async t => {
  await provisionIntegrationDatabase();
  const pool = await createAppPool();
  const control = await createControlPool();
  const pepper = "shared-ip-login-test-pepper-32bytes";
  await seedPlan(control, { code: "GROWTH", provider: "manual" });
  await createPlatformAdminService({ repository: createPlatformAdminRepository(control), passwordPepper: pepper })
    .bootstrapAdmin({ username: "startupadmin", password: "AdminPassword123!" });
  let now = new Date();
  const savedOverride = process.env.DISABLE_RATE_LIMIT;
  delete process.env.DISABLE_RATE_LIMIT;
  const server = await createServer({ pool, controlPool: control,
    loginThrottle: createLoginThrottle(control, { clock: () => now }),
    env: { NODE_ENV: "test", DATABASE_URL: "postgresql://unused/test", PASSWORD_PEPPER: pepper,
      SESSION_SECRET: "shared-ip-test-session-secret-32bytes", TRUSTED_ORIGIN: "http://localhost:3000", PAYMENT_PROVIDER: "manual" },
  });
  t.after(async () => {
    await server.close(); await pool.end(); await control.end();
    if (savedOverride === undefined) delete process.env.DISABLE_RATE_LIMIT;
    else process.env.DISABLE_RATE_LIMIT = savedOverride;
  });
  const send = (url, payload, cookie) => server.app.inject({ method: "POST", url, payload,
    remoteAddress: "198.51.100.90", headers: cookie ? { cookie } : {} });
  let adminCookie;
  for (let n = 0; n < 15; n++) {
    const result = await send("/platform-admin/api/auth/login", { username: "startupadmin", password: "AdminPassword123!" });
    assert.equal(result.statusCode, 200, result.body);
    adminCookie = result.headers["set-cookie"].split(";")[0];
  }
  for (const code of ["startup-a", "startup-b"]) {
    const result = await send("/platform-admin/api/restaurants", { name: code, code,
      ownerUsername: "owner", ownerPassword: "OwnerPassword123!", planCode: "GROWTH" }, adminCookie);
    assert.equal(result.statusCode, 201, result.body);
  }
  const account = { restaurantCode: "startup-a", username: "owner", password: "OwnerPassword123!" };
  for (let n = 0; n < 15; n++) {
    const result = await send("/api/auth/login", account);
    assert.equal(result.statusCode, 200, result.body);
  }
  for (let n = 0; n < 5; n++) {
    now = new Date(now.getTime() + 10000);
    assert.equal((await send("/api/auth/login", { ...account, password: "WrongPassword123!" })).statusCode, 401);
    const delayed = await send("/api/auth/login", { ...account, password: "WrongPassword123!" });
    assert.equal(delayed.statusCode, 429, delayed.body);
    assert.ok(Number(delayed.headers["retry-after"]) > 0);
    const other = await send("/api/auth/login", { ...account, restaurantCode: "startup-b" });
    assert.equal(other.statusCode, 200, other.body);
  }
});

test("test provisioning repairs stale role credentials and security flags", async (t) => {
  await provisionIntegrationDatabase();
  const admin = await connectAdmin();
  t.after(() => admin.end());
  await admin.query(
    "ALTER ROLE pos_integration_app PASSWORD 'stale-fixture-password' BYPASSRLS",
  );
  await assert.rejects(createAppPool(), (error) => error.code === "28P01");
  await provisionIntegrationDatabase();
  const app = await createAppPool();
  t.after(() => app.end());
  const row = (
    await app.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  assert.equal(row.rolsuper, false);
  assert.equal(row.rolbypassrls, false);
});

test("durable login throttling with real control and tenant roles", async (t) => {
  await provisionIntegrationDatabase();
  const control = await createControlPool();
  const app = await createAppPool();
  t.after(async () => {
    await control.end();
    await app.end();
  });
  let now = new Date();
  const clock = () => now;
  const input = {
    scope: "restaurant",
    restaurantCode: "Cafe",
    username: "Owner",
    ipAddress: "198.51.100.1",
  };
  let throttle = createLoginThrottle(control, { clock });
  await throttle.failed(input);
  // Recreation simulates another worker/restart; no local state is involved.
  throttle = createLoginThrottle(control, { clock });
  await assert.rejects(
    throttle.check(input),
    (error) => error.statusCode === 429 && error.retryAfter === 1,
  );
  await throttle.check({ ...input, ipAddress: "198.51.100.2" });
  await throttle.check({ ...input, restaurantCode: "another" });
  await throttle.check({ ...input, scope: "platform_admin" });
  assert.equal(
    (await app.query("SELECT * FROM login_attempts")).rows.length,
    0,
  );
  await assert.rejects(
    app.query(
      `INSERT INTO login_attempts VALUES('restaurant',decode(repeat('aa',32),'hex'),'198.51.100.3',1,now(),now())`,
    ),
    (error) => error.code === "42501",
  );
  now = new Date(now.getTime() + 250);
  await throttle.check(input);
  await throttle.succeeded({
    ...input,
    restaurantCode: "CAFE",
    username: "OWNER",
  });
  assert.equal(
    (await control.query("SELECT * FROM login_attempts")).rows.length,
    0,
  );
  await Promise.all(Array.from({ length: 10 }, () => throttle.failed(input)));
  const row = (await control.query("SELECT * FROM login_attempts")).rows[0];
  assert.equal(row.failures, 10);
  assert.equal(new Date(row.next_attempt_at) - now, 5000);
  now = new Date(now.getTime() + 5000);
  await throttle.check(input);
  await throttle.succeeded(input);
  assert.equal(
    (await control.query("SELECT * FROM login_attempts")).rows.length,
    0,
  );
});

test("password management through actual HTTP composition and PostgreSQL", async (t) => {
  await provisionIntegrationDatabase();
  const fixtureAdmin = await connectAdmin();
  t.after(() => fixtureAdmin.end());
  const control = await createControlPool();
  const appPool = await createAppPool();
  await seedPlan(control, { code: "GROWTH", provider: "manual" });
  const pepper = "password-management-test-pepper";
  const adminService = createPlatformAdminService({
    repository: createPlatformAdminRepository(control),
    passwordPepper: pepper,
  });
  const admin = await adminService.bootstrapAdmin({
    username: "securityadmin",
    password: "AdminPassword123!",
  });
  let now = new Date();
  const throttle = createLoginThrottle(control, { clock: () => now });
  const server = await createServer({
    pool: appPool,
    controlPool: control,
    loginThrottle: throttle,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://unused/test",
      PASSWORD_PEPPER: pepper,
      SESSION_SECRET: "password-management-session-secret",
      TRUSTED_ORIGIN: "http://localhost:3000",
      PAYMENT_PROVIDER: "manual",
    },
  });
  t.after(async () => {
    await server.close();
    await control.end();
    await appPool.end();
  });
  const app = server.app;
  let requestNumber = 0;
  const send = async (method, url, payload, cookie) => {
    now = new Date(now.getTime() + 10000);
    return app.inject({
      method,
      url,
      payload,
      headers: cookie ? { cookie } : {},
      remoteAddress: `198.51.100.${++requestNumber}`,
    });
  };
  const cookie = (response) => response.headers["set-cookie"].split(";")[0];
  const adminLogin = await send("POST", "/platform-admin/api/auth/login", {
    username: "securityadmin",
    password: "AdminPassword123!",
  });
  const adminCookie = cookie(adminLogin);
  const create = async (code) => {
    const response = await send(
      "POST",
      "/platform-admin/api/restaurants",
      {
        code,
        name: code,
        ownerUsername: code === "password-cafe" ? "owner" : "other_password_owner",
        ownerPassword: "OriginalPassword123!",
      },
      adminCookie,
    );
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  const restaurant = await create("password-cafe");
  const other = await create("password-other");
  const path = `/platform-admin/api/restaurants/${restaurant.id}/users/${restaurant.owner.id}/reset-password`;
  const login = (password) =>
    send("POST", "/api/auth/login", {
      restaurantCode: "password-cafe",
      username: "owner",
      password,
    });
  const first = await login("OriginalPassword123!");
  const second = await login("OriginalPassword123!");
  const oldCookie = cookie(first);
  const secondCookie = cookie(second);
  assert.equal(
    (await send("POST", path, { newPassword: "ResetPassword123!" })).statusCode,
    403,
  );
  for (const payload of [
    { newPassword: "123456789" },
    { newPassword: "a".repeat(201) },
    { newPassword: "ResetPassword123!", generateTemporary: true },
  ])
    assert.equal(
      (await send("POST", path, payload, adminCookie)).statusCode,
      400,
    );
  for (const unknown of [
    path.replace(restaurant.id, randomUUID()),
    path.replace(restaurant.owner.id, randomUUID()),
    path.replace(restaurant.owner.id, other.owner.id),
  ])
    assert.equal(
      (
        await send(
          "POST",
          unknown,
          { newPassword: "ResetPassword123!" },
          adminCookie,
        )
      ).statusCode,
      404,
    );
  // If audit persistence fails, credentials and revocation must roll back too.
  await fixtureAdmin.query(`CREATE FUNCTION fail_password_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action IN ('user.password_reset','user.password_changed') THEN RAISE EXCEPTION 'injected password audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_password_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_password_audit();`);
  try {
    assert.equal(
      (
        await send(
          "POST",
          path,
          { newPassword: "ResetPassword123!" },
          adminCookie,
        )
      ).statusCode,
      500,
    );
    assert.equal(
      (await send("GET", "/api/auth/me", undefined, oldCookie)).statusCode,
      200,
    );
    assert.equal((await login("OriginalPassword123!")).statusCode, 200);
  } finally {
    await fixtureAdmin.query(
      "DROP TRIGGER fail_password_audit ON audit_logs; DROP FUNCTION fail_password_audit();",
    );
  }
  const reset = await send(
    "POST",
    path,
    { newPassword: "ResetPassword123!" },
    adminCookie,
  );
  assert.deepEqual(reset.json(), { reset: true, userId: restaurant.owner.id });
  assert.equal(
    (await send("GET", "/api/auth/me", undefined, oldCookie)).statusCode,
    401,
  );
  assert.equal(
    (await send("GET", "/api/auth/me", undefined, secondCookie)).statusCode,
    401,
  );
  assert.equal((await login("OriginalPassword123!")).statusCode, 401);
  const fresh = await login("ResetPassword123!");
  assert.equal(fresh.statusCode, 200, fresh.body);
  const currentCookie = cookie(fresh);
  const another = await login("ResetPassword123!");
  assert.equal(
    (
      await send("POST", "/api/auth/change-password", {
        currentPassword: "ResetPassword123!",
        newPassword: "ChangedPassword123!",
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await send(
        "POST",
        "/api/auth/change-password",
        { currentPassword: "ResetPassword123!", newPassword: "short" },
        currentCookie,
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await send(
        "POST",
        "/api/auth/change-password",
        {
          currentPassword: "IncorrectPassword123!",
          newPassword: "ChangedPassword123!",
        },
        currentCookie,
      )
    ).statusCode,
    400,
  );
  const changed = await send(
    "POST",
    "/api/auth/change-password",
    {
      currentPassword: "ResetPassword123!",
      newPassword: "ChangedPassword123!",
    },
    currentCookie,
  );
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(
    (await send("GET", "/api/auth/me", undefined, currentCookie)).statusCode,
    200,
  );
  assert.equal(
    (await send("GET", "/api/auth/me", undefined, cookie(another))).statusCode,
    401,
  );
  assert.equal((await login("ResetPassword123!")).statusCode, 401);
  assert.equal((await login("ChangedPassword123!")).statusCode, 200);
  const beforeHash = (
    await control.query("SELECT password_hash FROM users WHERE id=$1", [
      restaurant.owner.id,
    ])
  ).rows[0].password_hash;
  const generated = await send(
    "POST",
    path,
    { generateTemporary: true },
    adminCookie,
  );
  assert.equal(generated.statusCode, 200, generated.body);
  const temporary = generated.json().temporaryPassword;
  assert.match(temporary, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await login(temporary)).statusCode, 200);
  assert.equal(
    (await send("GET", "/api/auth/me", undefined, currentCookie)).statusCode,
    401,
  );
  const detail = await send(
    "GET",
    `/platform-admin/api/restaurants/${restaurant.id}`,
    undefined,
    adminCookie,
  );
  assert.ok(
    !detail.body.includes(temporary) &&
      !detail.body.includes("passwordHash") &&
      !detail.body.includes("password_hash"),
  );
  const audits = (
    await control.query(
      "SELECT * FROM audit_logs WHERE resource_id=$1 AND action IN ('user.password_reset','user.password_changed')",
      [restaurant.owner.id],
    )
  ).rows;
  assert.equal(audits.length, 3);
  assert.ok(
    audits
      .filter((row) => row.action === "user.password_reset")
      .every(
        (row) =>
          row.actor_admin_id === admin.admin.id &&
          row.restaurant_id === restaurant.id,
      ),
  );
  assert.equal(
    audits.find((row) => row.action === "user.password_changed").actor_user_id,
    restaurant.owner.id,
  );
  const serialized = JSON.stringify(audits);
  assert.ok(
    !serialized.includes(temporary) &&
      !serialized.includes("Password123") &&
      !serialized.includes("$argon2"),
  );

  const restPath = `/platform-admin/api/restaurants/${restaurant.id}`;
  assert.equal(
    (await send("PATCH", restPath, { name: "Updated cafe" })).statusCode,
    401,
  );
  for (const body of [
    {},
    { name: "" },
    { contactEmail: "invalid" },
    { code: "a" },
  ])
    assert.equal(
      (await send("PATCH", restPath, body, adminCookie)).statusCode,
      400,
    );
  assert.equal(
    (
      await send(
        "PATCH",
        restPath.replace(restaurant.id, randomUUID()),
        { name: "Cafe" },
        adminCookie,
      )
    ).statusCode,
    404,
  );
  const edited = await send(
    "PATCH",
    restPath,
    {
      name: "Updated <img src=x onerror=alert(1)>",
      phone: "03001234567",
      contactEmail: "support@example.com",
      address: "Peshawar",
    },
    adminCookie,
  );
  assert.equal(edited.statusCode, 200, edited.body);
  const information = (
    await send("GET", restPath, undefined, adminCookie)
  ).json().restaurant;
  assert.equal(information.contactEmail, "support@example.com");
  assert.equal(information.phone, "03001234567");
  assert.equal(information.address, "Peshawar");
  const activeLogin = await login(temporary);
  assert.equal(activeLogin.statusCode, 200);
  const statusPath = `${restPath}/users/${restaurant.owner.id}/status`;
  assert.equal(
    (await send("POST", statusPath, { status: "disabled" })).statusCode,
    401,
  );
  assert.equal(
    (await send("POST", statusPath, { status: "deleted" }, adminCookie))
      .statusCode,
    400,
  );
  for (const missing of [
    statusPath.replace(restaurant.id, randomUUID()),
    statusPath.replace(restaurant.owner.id, other.owner.id),
  ])
    assert.equal(
      (await send("POST", missing, { status: "disabled" }, adminCookie))
        .statusCode,
      404,
    );
  assert.equal(
    (await send("POST", statusPath, { status: "disabled" }, adminCookie))
      .statusCode,
    200,
  );
  assert.equal(
    (await send("GET", "/api/auth/me", undefined, cookie(activeLogin)))
      .statusCode,
    401,
  );
  assert.equal((await login(temporary)).statusCode, 403);
  await control.query(
    "UPDATE restaurant_memberships SET status='invited',joined_at=NULL WHERE user_id=$1 AND restaurant_id=$2",
    [restaurant.owner.id, restaurant.id],
  );
  assert.equal(
    (await send("POST", statusPath, { status: "active" }, adminCookie))
      .statusCode,
    200,
  );
  assert.equal(
    (await send("GET", "/api/auth/me", undefined, cookie(activeLogin)))
      .statusCode,
    401,
  );
  assert.equal((await login(temporary)).statusCode, 200);
  const actions = (
    await control.query(
      "SELECT action, actor_admin_id FROM audit_logs WHERE restaurant_id=$1",
      [restaurant.id],
    )
  ).rows;
  for (const action of ["restaurant.updated", "user.disabled", "user.enabled"])
    assert.ok(
      actions.some(
        (row) => row.action === action && row.actor_admin_id === admin.admin.id,
      ),
    );
  assert.equal(
    (await send("GET", "/platform-admin/api/audit-logs")).statusCode,
    401,
  );
  for (const query of ["page=0", "limit=101", "restaurantId=invalid"])
    assert.equal(
      (
        await send(
          "GET",
          `/platform-admin/api/audit-logs?${query}`,
          undefined,
          adminCookie,
        )
      ).statusCode,
      400,
    );
  const auditPage = (
    await send(
      "GET",
      `/platform-admin/api/audit-logs?restaurantId=${restaurant.id}&limit=1`,
      undefined,
      adminCookie,
    )
  ).json();
  assert.equal(auditPage.audits.length, 1);
  assert.ok(auditPage.totalCount >= 6);
  assert.ok(
    auditPage.audits.every((row) => row.restaurantId === restaurant.id),
  );
  const nextPage = (
    await send(
      "GET",
      `/platform-admin/api/audit-logs?restaurantId=${restaurant.id}&limit=1&page=2`,
      undefined,
      adminCookie,
    )
  ).json();
  assert.notEqual(auditPage.audits[0].id, nextPage.audits[0].id);
  assert.equal(
    (await send("POST", "/platform-admin/api/audit-logs", {}, adminCookie))
      .statusCode,
    404,
  );
  const list = (
    await send(
      "GET",
      "/platform-admin/api/restaurants?includeTotal=true&limit=1",
      undefined,
      adminCookie,
    )
  ).json();
  assert.equal(list.restaurants.length, 1);
  assert.equal(list.totalCount, 2);
  // A login that verified the old hash before a reset cannot mint a new session afterward.
  await assert.rejects(
    createPostgresAuthRepository(control).createSession({
      userId: restaurant.owner.id,
      expectedPasswordHash: beforeHash,
      tokenHash: createTokenPair().tokenHash,
      ipAddress: "198.51.100.100",
      userAgent: "test",
      expiresAt: new Date(Date.now() + 60000),
    }),
    (error) => error.code === "INVALID_CREDENTIALS",
  );
});

test("username-only identity migration preserves legacy accounts, rejects ambiguity and atomically reserves new identifiers", async t => {
  const { readFile } = await import("node:fs/promises");
  const { createPlatformAdminPortalService } = await import("../src/server/subscriptions/platform-admin-portal-service.mjs");
  await provisionIntegrationDatabase();
  const pool = await createAppPool(), control = await createControlPool(), administrator = await connectAdmin();
  const pepper = "global-login-regression-pepper-long";
  await seedPlan(control, { code: "GROWTH", provider: "manual" });
  const admin = await createPlatformAdminService({ repository: createPlatformAdminRepository(control), passwordPepper: pepper })
    .bootstrapAdmin({ username: "identityadmin", password: "AdminPassword123!" });
  const portal = createPlatformAdminPortalService({ pool: control, passwordPepper: pepper });
  // Simulate the pre-migration database, where tenant-scoped duplicates were legal.
  await administrator.query("DROP TRIGGER users_claim_login_identifiers ON users; DROP FUNCTION claim_user_login_identifiers(); DROP TABLE user_login_identifiers;");
  const create = (code, ownerUsername = "owner", ownerEmail = `${code}@example.com`) => portal.createRestaurant({
    adminId: admin.admin.id, code, name: code, ownerUsername, ownerEmail, ownerPassword: "OwnerPassword123!", planCode: "GROWTH",
  });
  const first = await create("identity-first"), second = await create("identity-second");
  const collision = await create("identity-collision", "identity-first@example.com");
  await administrator.query(await readFile(new URL("../database/migrations/024_global_login_identifiers.sql", import.meta.url), "utf8"));
  assert.equal((await control.query("SELECT username FROM users WHERE id=$1", [first.owner.id])).rows[0].username, "owner");
  assert.equal((await administrator.query("SELECT user_id FROM user_login_identifiers WHERE identifier='owner'")).rows[0].user_id, null);
  const server = await createServer({ pool, controlPool: control, env: { NODE_ENV: "test", DATABASE_URL: "postgresql://unused/test",
    PASSWORD_PEPPER: pepper, SESSION_SECRET: "identity-session-secret-long", TRUSTED_ORIGIN: "http://localhost:3000", PAYMENT_PROVIDER: "manual" } });
  t.after(async () => { await server.close(); await pool.end(); await control.end(); await administrator.end(); });
  const send = (username,password = "OwnerPassword123!") => server.app.inject({ method: "POST", url: "/api/auth/login", payload: { username,password } });
  assert.equal((await send("owner")).statusCode, 401);
  assert.equal((await send("identity-first@example.com")).statusCode, 401);
  // Renaming a legacy collision must not attempt to re-claim its unchanged,
  // reserved email. No existing credentials are silently overwritten.
  await portal.editUser({ adminId: admin.admin.id, restaurantId: first.id, userId: first.owner.id, username: "identity_first_owner" });
  await portal.editUser({ adminId: admin.admin.id, restaurantId: collision.id, userId: collision.owner.id, username: "identity_collision_owner" });
  const emailLogin = await send("identity-first@example.com"); assert.equal(emailLogin.statusCode, 200, emailLogin.body);
  await assert.rejects(create("identity-third"), error => error.code === "USERNAME_EXISTS" && error.statusCode === 409);
  assert.equal(Number((await control.query("SELECT count(*) FROM restaurants WHERE code='identity-third'")).rows[0].count), 0);
  await portal.editUser({ adminId: admin.admin.id, restaurantId: first.id, userId: first.owner.id, username: "identity_first_owner" });
  assert.equal((await send("identity_first_owner")).statusCode, 200);
  assert.equal((await send("owner")).json().user.id, second.owner.id);
  const firstLogin = await send("identity_first_owner"), otherLogin = await send("identity_first_owner");
  const cookie = result => result.headers["set-cookie"].split(";")[0];
  const change = (session, newUsername) => server.app.inject({ method: "POST", url: "/api/auth/change-password", headers: { cookie: cookie(session) },
    payload: { currentPassword: "OwnerPassword123!", newPassword: "ChangedPassword123!", newUsername } });
  assert.equal((await change(firstLogin, "owner")).statusCode, 409);
  assert.equal((await send("identity_first_owner")).statusCode, 200);
  const renamed = await change(firstLogin, "identity_renamed_owner"); assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal((await server.app.inject({ url: "/api/auth/me", headers: { cookie: cookie(firstLogin) } })).statusCode, 200);
  assert.equal((await server.app.inject({ url: "/api/auth/me", headers: { cookie: cookie(otherLogin) } })).statusCode, 401);
  assert.equal((await send("identity_renamed_owner", "ChangedPassword123!")).statusCode, 200);
  const concurrent = await Promise.all([create("identity-race-a", "unique_race_owner"), create("identity-race-b", "unique_race_owner")].map(operation => operation.then(() => 201, error => error.statusCode)));
  assert.deepEqual(concurrent.sort(), [201,409]);
  // The registry is maintained by a scoped definer trigger, never writable by
  // the production runtime role directly (test helpers grant broader fixtures).
  const audit = (await control.query("SELECT metadata FROM audit_logs WHERE actor_user_id=$1 AND action='user.password_changed'", [first.owner.id])).rows;
  assert.equal(audit[0].metadata.usernameChanged, true);
});
