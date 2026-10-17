import assert from "node:assert/strict";
import test from "node:test";
import { createAppPool, createControlPool, provisionIntegrationDatabase, seedPlan } from "./helpers/postgres.mjs";
import { createServer } from "../src/server/main.mjs";
import { createPostgresAuthRepository } from "../src/server/auth/postgres-auth-repository.mjs";
import { createPlatformAdminRepository } from "../src/server/auth/platform-admin-repository.mjs";
import { createPlatformAdminService } from "../src/server/auth/platform-admin-service.mjs";
import { createPlatformAdminPortalService } from "../src/server/subscriptions/platform-admin-portal-service.mjs";
import { createEntitlementService } from "../src/server/auth/entitlement-service.mjs";
import { createLoginThrottle } from "../src/server/auth/login-throttle.mjs";

const pepper = "test-pepper-for-development-only";

async function setupTestApp() {
  await provisionIntegrationDatabase();
  const appPool = await createAppPool();
  const pool = await createControlPool();
  await seedPlan(pool, { code: "GROWTH", provider: "manual" });
  await pool.query("UPDATE plans SET max_devices = 2 WHERE code = 'GROWTH'");
  await seedPlan(pool, { code: "STARTER", provider: "manual" });
  await pool.query("UPDATE plans SET max_devices = 1 WHERE code = 'STARTER'");

  let throttleTime = Date.now();
  const loginThrottle = createLoginThrottle(pool, { clock: () => new Date(throttleTime += 10000) });
  const server = await createServer({
    pool: appPool,
    controlPool: pool,
    loginThrottle,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://unused/test",
      PASSWORD_PEPPER: pepper,
      SESSION_SECRET: "test-session-secret-at-least-32-chars",
      TRUSTED_ORIGIN: "http://127.0.0.1:3000",
      OFFLINE_ENTITLEMENT_SECRET: "fixture-entitlement-signing-key-32-chars",
      PAYMENT_PROVIDER: "manual",
    },
  });

  const authRepo = createPostgresAuthRepository(pool);
  const platformAdminService = createPlatformAdminService({
    repository: createPlatformAdminRepository(pool),
    passwordPepper: pepper,
  });
  const platformAdminPortalService = createPlatformAdminPortalService({
    pool,
    passwordPepper: pepper,
  });
  const entitlementService = createEntitlementService({
    secret: "fixture-entitlement-signing-key-32-chars",
  });

  return {
    app: server.app,
    pool,
    appPool,
    authRepo,
    platformAdminService,
    platformAdminPortalService,
    entitlementService,
  };
}

test("Dedicated Device Management Module Suite", async (t) => {
  const {
    app,
    pool,
    appPool,
    authRepo,
    platformAdminService,
    platformAdminPortalService,
    entitlementService,
  } = await setupTestApp();

  t.after(async () => {
    await app.close();
    await pool.end();
    await appPool.end();
  });

  // 1. Bootstrap super admin
  const adminResult = await platformAdminService.bootstrapAdmin({
    username: "superadmin_dev",
    password: "SuperAdmin123!",
    displayName: "Platform Admin",
  });
  const adminId = adminResult.admin.id;

  // Log in as platform admin to obtain cookie
  const loginRes = await app.inject({
    method: "POST",
    url: "/platform-admin/api/auth/login",
    payload: {
      username: "superadmin_dev",
      password: "SuperAdmin123!",
    },
  });
  assert.equal(loginRes.statusCode, 200);
  const adminCookie = loginRes.headers["set-cookie"];

  // 2. Create Restaurant A (on GROWTH plan, max 2 devices)
  const restA = await platformAdminPortalService.createRestaurant({
    adminId,
    name: "Terminal Cafe",
    code: "terminal-cafe",
    ownerUsername: "owner_term",
    ownerPassword: "Password123!",
    planCode: "GROWTH",
  });

  // Create Restaurant B (on STARTER plan, max 1 device)
  const restB = await platformAdminPortalService.createRestaurant({
    adminId,
    name: "Single POS Diner",
    code: "single-pos",
    ownerUsername: "owner_single",
    ownerPassword: "Password123!",
    planCode: "STARTER",
  });

  await t.test("1. Status derivation logic with configurable thresholds", () => {
    const now = Date.now();
    // Revoked status always returns revoked
    assert.equal(
      platformAdminPortalService.calculateDeviceStatus("revoked", new Date(now)),
      "revoked"
    );

    // Active status: online within 5 minutes (300,000 ms)
    assert.equal(
      platformAdminPortalService.calculateDeviceStatus("active", new Date(now - 60_000)),
      "online"
    );

    // Active status: offline between 5 minutes and 24 hours
    assert.equal(
      platformAdminPortalService.calculateDeviceStatus("active", new Date(now - 600_000)),
      "offline"
    );

    // Active status: stale if older than 24 hours (86,400,000 ms)
    assert.equal(
      platformAdminPortalService.calculateDeviceStatus("active", new Date(now - 90_000_000)),
      "stale"
    );

    // Active status: stale if never seen (null)
    assert.equal(
      platformAdminPortalService.calculateDeviceStatus("active", null),
      "stale"
    );
  });

  let deviceA1;
  let deviceA2;
  let deviceB1;

  await t.test("2. Device registration via Super Admin API", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/platform-admin/api/devices",
      headers: { cookie: adminCookie },
      payload: {
        restaurantId: restA.id,
        name: "Main Register 1",
        deviceUid: "TERM-CAFE-01",
        deviceType: "desktop",
        platform: "Windows",
        os: "Windows 11 Pro",
        appVersion: "1.2.0",
      },
    });

    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.payload);
    assert.equal(body.device.name, "Main Register 1");
    assert.equal(body.device.deviceUid, "TERM-CAFE-01");
    assert.equal(body.device.deviceType, "desktop");
    assert.equal(body.device.status, "active");
    assert.equal(body.device.calculatedStatus, "stale"); // because lastSeenAt is null
    deviceA1 = body.device;

    // Verify database record
    const dbCheck = await pool.query(`SELECT * FROM devices WHERE id = $1`, [deviceA1.id]);
    assert.equal(dbCheck.rows.length, 1);
    assert.equal(dbCheck.rows[0].device_type, "desktop");
    assert.equal(dbCheck.rows[0].os, "Windows 11 Pro");
    assert.equal(dbCheck.rows[0].app_version, "1.2.0");
  });

  await t.test("3. Duplicate device UID rejection per restaurant", async () => {
    // Attempting to register the same deviceUid under restA must fail
    const dupRes = await app.inject({
      method: "POST",
      url: "/platform-admin/api/devices",
      headers: { cookie: adminCookie },
      payload: {
        restaurantId: restA.id,
        name: "Duplicate Register",
        deviceUid: "TERM-CAFE-01",
        deviceType: "desktop",
      },
    });
    assert.equal(dupRes.statusCode, 409);
    assert.match(JSON.parse(dupRes.payload).error, /already registered/i);

    // Registering same UID under a different restaurant (restB) should succeed (tenant scoped UID)
    const restBRes = await app.inject({
      method: "POST",
      url: "/platform-admin/api/devices",
      headers: { cookie: adminCookie },
      payload: {
        restaurantId: restB.id,
        name: "Single Diner Till",
        deviceUid: "TERM-CAFE-01", // same UID, different tenant
        deviceType: "tablet",
        platform: "Android",
        os: "Android 14",
      },
    });
    assert.equal(restBRes.statusCode, 201);
    deviceB1 = JSON.parse(restBRes.payload).device;
  });

  await t.test("4. Subscription plan device limit enforcement", async () => {
    // restB is on STARTER (maxDevices = 1). deviceB1 is already active.
    // Registering a second device for restB must be rejected
    const limitRes = await app.inject({
      method: "POST",
      url: "/platform-admin/api/devices",
      headers: { cookie: adminCookie },
      payload: {
        restaurantId: restB.id,
        name: "Second Till Beyond Limit",
        deviceUid: "SINGLE-TILL-02",
        deviceType: "mobile",
      },
    });
    assert.equal(limitRes.statusCode, 409);
    assert.match(JSON.parse(limitRes.payload).error, /device limit/i);

    // restA is on GROWTH (maxDevices = 2), currently has 1 device.
    // Registering 2nd device for restA must succeed
    const restA2Res = await app.inject({
      method: "POST",
      url: "/platform-admin/api/devices",
      headers: { cookie: adminCookie },
      payload: {
        restaurantId: restA.id,
        name: "Patio Terminal",
        deviceUid: "TERM-CAFE-02",
        deviceType: "tablet",
        platform: "iOS",
        os: "iPadOS 17.5",
      },
    });
    assert.equal(restA2Res.statusCode, 201);
    deviceA2 = JSON.parse(restA2Res.payload).device;

    // Registering a 3rd device for restA must now exceed limit
    const restA3Res = await app.inject({
      method: "POST",
      url: "/platform-admin/api/devices",
      headers: { cookie: adminCookie },
      payload: {
        restaurantId: restA.id,
        name: "Excess Terminal",
        deviceUid: "TERM-CAFE-03",
        deviceType: "mobile",
      },
    });
    assert.equal(restA3Res.statusCode, 409);
  });

  await t.test("5. Heartbeat recording and live status calculation", async () => {
    // Send authenticated POS heartbeat for deviceA1
    const hbRes = await app.inject({
      method: "POST",
      url: "/api/pos/devices/heartbeat",
      payload: {
        deviceId: deviceA1.id,
        appVersion: "1.2.1",
        syncStatus: { pendingOrders: 0, failedSyncs: 0 },
      },
    });
    assert.equal(hbRes.statusCode, 200);
    const hbBody = JSON.parse(hbRes.payload);
    assert.equal(hbBody.ok, true);
    assert.equal(hbBody.device.calculatedStatus, "online");
    assert.equal(hbBody.device.appVersion, "1.2.1");

    // Check device detail endpoint reflects online status
    const detailRes = await app.inject({
      method: "GET",
      url: `/platform-admin/api/devices/${deviceA1.id}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(detailRes.statusCode, 200);
    const detailBody = JSON.parse(detailRes.payload);
    assert.equal(detailBody.device.calculatedStatus, "online");
    assert.equal(detailBody.device.appVersion, "1.2.1");
    assert.ok(detailBody.device.lastSeenAt);
  });

  await t.test("6. Device listing, searching, and filtering", async () => {
    // List all devices
    const listAllRes = await app.inject({
      method: "GET",
      url: "/platform-admin/api/devices",
      headers: { cookie: adminCookie },
    });
    assert.equal(listAllRes.statusCode, 200);
    const listAll = JSON.parse(listAllRes.payload);
    assert.equal(listAll.devices.length, 3);
    assert.equal(listAll.summary.totalDevices, 3);
    assert.equal(listAll.summary.onlineDevices, 1); // deviceA1 is online

    // Filter by restaurantId (restB)
    const listBRes = await app.inject({
      method: "GET",
      url: `/platform-admin/api/devices?restaurantId=${restB.id}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(listBRes.statusCode, 200);
    const listB = JSON.parse(listBRes.payload);
    assert.equal(listB.devices.length, 1);
    assert.equal(listB.devices[0].id, deviceB1.id);

    // Search query for "Patio"
    const searchRes = await app.inject({
      method: "GET",
      url: "/platform-admin/api/devices?search=Patio",
      headers: { cookie: adminCookie },
    });
    assert.equal(searchRes.statusCode, 200);
    const searchList = JSON.parse(searchRes.payload);
    assert.equal(searchList.devices.length, 1);
    assert.equal(searchList.devices[0].name, "Patio Terminal");

    // Filter by status "online"
    const onlineRes = await app.inject({
      method: "GET",
      url: "/platform-admin/api/devices?status=online",
      headers: { cookie: adminCookie },
    });
    assert.equal(onlineRes.statusCode, 200);
    const onlineList = JSON.parse(onlineRes.payload);
    assert.equal(onlineList.devices.length, 1);
    assert.equal(onlineList.devices[0].id, deviceA1.id);
  });

  await t.test("7. Update device metadata", async () => {
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/platform-admin/api/devices/${deviceA1.id}`,
      headers: { cookie: adminCookie },
      payload: {
        name: "Counter 1 - Renamed",
        deviceType: "laptop",
        os: "Windows 11 Enterprise",
      },
    });
    assert.equal(patchRes.statusCode, 200);
    const patched = JSON.parse(patchRes.payload).device;
    assert.equal(patched.name, "Counter 1 - Renamed");
    assert.equal(patched.deviceType, "laptop");
    assert.equal(patched.os, "Windows 11 Enterprise");
  });

  await t.test("8. Revoke device, invalidate sessions, and audit logging", async () => {
    // First, associate a fake active session to deviceA1
    const sessionId = "a1b2c3d4-e5f6-4a5b-8c9d-0123456789ab";
    const userRow = (await pool.query(`SELECT id FROM users WHERE restaurant_id = $1 LIMIT 1`, [restA.id])).rows[0];
    await pool.query(
      `INSERT INTO sessions (id, restaurant_id, user_id, token_hash, user_agent, ip_address, expires_at, device_id)
       VALUES ($1, $2, $3, 'dummy_token_hash', 'POS Electron/1.0', '192.168.1.50', NOW() + INTERVAL '1 day', $4)`,
      [sessionId, restA.id, userRow.id, deviceA1.id]
    );

    // Verify session exists
    const sessCheck = await pool.query(`SELECT * FROM sessions WHERE id = $1`, [sessionId]);
    assert.equal(sessCheck.rows.length, 1);

    // Revoke deviceA1 with revokeSessions = true
    const revokeRes = await app.inject({
      method: "POST",
      url: `/platform-admin/api/devices/${deviceA1.id}/revoke`,
      headers: { cookie: adminCookie },
      payload: {
        reason: "Hardware reported lost or stolen",
        revokeSessions: true,
      },
    });
    assert.equal(revokeRes.statusCode, 200);
    const revokedDev = JSON.parse(revokeRes.payload).device;
    assert.equal(revokedDev.status, "revoked");
    assert.equal(revokedDev.calculatedStatus, "revoked");
    assert.equal(revokedDev.revocationReason, "Hardware reported lost or stolen");
    assert.ok(revokedDev.revokedAt);

    // Verify linked session was revoked (revoked_at is set)
    const postSessCheck = await pool.query(`SELECT * FROM sessions WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
    assert.equal(postSessCheck.rows.length, 0);

    // Verify audit log entry was created
    const auditCheck = await pool.query(
      `SELECT * FROM audit_logs WHERE restaurant_id = $1 AND action = 'device.revocation' ORDER BY created_at DESC LIMIT 1`,
      [restA.id]
    );
    assert.equal(auditCheck.rows.length, 1);
    assert.equal(auditCheck.rows[0].resource_id, deviceA1.id);

    // Subsequent heartbeat must be rejected
    const badHbRes = await app.inject({
      method: "POST",
      url: "/api/pos/devices/heartbeat",
      payload: {
        deviceId: deviceA1.id,
      },
    });
    assert.equal(badHbRes.statusCode, 403);
    assert.match(JSON.parse(badHbRes.payload).error, /revoked/i);

    // Log in as POS owner user to test authenticated entitlement issuance
    const posLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        restaurantCode: "terminal-cafe",
        username: "owner_term",
        password: "Password123!",
      },
    });
    assert.equal(posLogin.statusCode, 200);
    const posCookie = Array.isArray(posLogin.headers["set-cookie"])
      ? posLogin.headers["set-cookie"][0].split(";")[0]
      : posLogin.headers["set-cookie"].split(";")[0];

    // Entitlement generation check: GET /api/pos/entitlement must be rejected with 403 DEVICE_REVOKED
    const entRes = await app.inject({
      method: "GET",
      url: `/api/pos/entitlement?deviceId=${deviceA1.id}`,
      headers: {
        cookie: posCookie,
        "x-restaurant-id": restA.id,
      },
    });
    assert.equal(entRes.statusCode, 403);
    assert.equal(JSON.parse(entRes.payload).code, "DEVICE_REVOKED");
  });

  await t.test("9. Device reactivation workflow and audit trail", async () => {
    const reactivateRes = await app.inject({
      method: "POST",
      url: `/platform-admin/api/devices/${deviceA1.id}/reactivate`,
      headers: { cookie: adminCookie },
      payload: {
        reason: "Terminal recovered, inspected, and cleared for operational use",
      },
    });
    assert.equal(reactivateRes.statusCode, 200);
    const reactivatedDev = JSON.parse(reactivateRes.payload).device;
    assert.equal(reactivatedDev.status, "active");
    assert.equal(reactivatedDev.reactivationReason, "Terminal recovered, inspected, and cleared for operational use");
    assert.ok(reactivatedDev.reactivatedAt);

    // Verify audit log entry was created
    const auditCheck = await pool.query(
      `SELECT * FROM audit_logs WHERE restaurant_id = $1 AND action = 'device.reactivation' ORDER BY created_at DESC LIMIT 1`,
      [restA.id]
    );
    assert.equal(auditCheck.rows.length, 1);
    assert.equal(auditCheck.rows[0].resource_id, deviceA1.id);
  });

  await t.test("10. Remote session revocation endpoint", async () => {
    // Create a new session linked to deviceA2
    const sess2Id = "b2c3d4e5-f6a7-4b5c-9d0e-123456789abc";
    const userRow = (await pool.query(`SELECT id FROM users WHERE restaurant_id = $1 LIMIT 1`, [restA.id])).rows[0];
    await pool.query(
      `INSERT INTO sessions (id, restaurant_id, user_id, token_hash, user_agent, ip_address, expires_at, device_id)
       VALUES ($1, $2, $3, 'dummy_token_hash_2', 'POS Electron/1.0', '192.168.1.51', NOW() + INTERVAL '1 day', $4)`,
      [sess2Id, restA.id, userRow.id, deviceA2.id]
    );

    // Call revoke-sessions endpoint
    const revSessRes = await app.inject({
      method: "POST",
      url: `/platform-admin/api/devices/${deviceA2.id}/revoke-sessions`,
      headers: { cookie: adminCookie },
      payload: { reason: "Remote logout requested" },
    });
    assert.equal(revSessRes.statusCode, 200);
    const revSessBody = JSON.parse(revSessRes.payload);
    assert.equal(revSessBody.revokedCount, 1);

    // Verify session was revoked
    const checkSess2 = await pool.query(`SELECT * FROM sessions WHERE id = $1 AND revoked_at IS NULL`, [sess2Id]);
    assert.equal(checkSess2.rows.length, 0);
  });
});
