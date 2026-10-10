import { createServer } from "../src/server/main.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createAppPool, createControlPool, provisionIntegrationDatabase, seedPlan } from "./helpers/postgres.mjs";

import { buildHttpApp } from "../src/server/http/app.mjs";
import { createPostgresAuthRepository } from "../src/server/auth/postgres-auth-repository.mjs";
import { createAuthService } from "../src/server/auth/auth-service.mjs";
import { createPlatformAdminRepository } from "../src/server/auth/platform-admin-repository.mjs";
import { createPlatformAdminService } from "../src/server/auth/platform-admin-service.mjs";
import { createPlatformAdminPortalService } from "../src/server/subscriptions/platform-admin-portal-service.mjs";
import { createEntitlementService } from "../src/server/auth/entitlement-service.mjs";
import { createStorageService } from "../src/server/storage/storage-service.mjs";
import { createTenantContextService } from "../src/server/tenancy/tenant-context-service.mjs";

const pepper = "test-pepper-for-development-only";

async function setupTestApp() {
  await provisionIntegrationDatabase();
  const appPool = await createAppPool();
  const pool = await createControlPool();
  await seedPlan(pool, { code: "GROWTH", provider: "manual" });
  const server = await createServer({ pool: appPool, controlPool: pool, env: {
    NODE_ENV: "test", DATABASE_URL: "postgresql://unused/test", PASSWORD_PEPPER: pepper,
    SESSION_SECRET: "test-session-secret-at-least-32-chars", TRUSTED_ORIGIN: "http://127.0.0.1:3000",
    OFFLINE_ENTITLEMENT_SECRET: "fixture-entitlement-signing-key-32-chars", PAYMENT_PROVIDER: "manual",
  } });
  const authRepo = createPostgresAuthRepository(pool);
  const platformAdminService = createPlatformAdminService({ repository: createPlatformAdminRepository(pool), passwordPepper: pepper });
  const platformAdminPortalService = createPlatformAdminPortalService({ pool, passwordPepper: pepper });
  const entitlementService = createEntitlementService({ secret: "fixture-entitlement-signing-key-32-chars" });
  const storageService = createStorageService({ pool: appPool });
  return { app: server.app, pool, appPool, authRepo, platformAdminService, platformAdminPortalService, entitlementService, storageService };

}

test("SaaS Core Fullstack Suite", async (t) => {
  const { app, pool, appPool, authRepo, platformAdminService, platformAdminPortalService, entitlementService, storageService } = await setupTestApp();

  t.after(async () => { await app.close(); await pool.end(); await appPool.end(); });

  // Bootstrap platform administrator
  const adminResult = await platformAdminService.bootstrapAdmin({
    username: "superadmin",
    password: "SuperAdminPassword123!",
    displayName: "Lead Super Admin",
  });
  const adminId = adminResult.admin.id;

  // Create Restaurant A & Restaurant B with same cashier username
  const restA = await platformAdminPortalService.createRestaurant({
    adminId,
    name: "Burger Haven",
    code: "burger-haven",
    ownerUsername: "owner_a",
    ownerPassword: "Password123!",
  });

  const restB = await platformAdminPortalService.createRestaurant({
    adminId,
    name: "Pizza Palace",
    code: "pizza-palace",
    ownerUsername: "owner_b",
    ownerPassword: "Password123!",
  });

  // Create cashier user in both restaurants with identical username 'cashier'
  await authRepo.createTenantUser({
    restaurantId: restA.id,
    username: "cashier",
    passwordHash: await platformAdminService.bootstrapAdmin({ username: "dummy1", password: "Password123!" }).then(() => import("../src/server/auth/passwords.mjs")).then(m => m.hashPassword("CashierPassA!", pepper)),
    displayName: "Cashier Alice",
    role: "cashier",
  });

  await authRepo.createTenantUser({
    restaurantId: restB.id,
    username: "cashier",
    passwordHash: await platformAdminService.bootstrapAdmin({ username: "dummy2", password: "Password123!" }).then(() => import("../src/server/auth/passwords.mjs")).then(m => m.hashPassword("CashierPassB!", pepper)),
    displayName: "Cashier Bob",
    role: "cashier",
  });

  await t.test("PHASE 2 — Username Authentication", async () => {
    // 1. Same username in two restaurants succeeds for correct restaurant code
    const resA = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { restaurantCode: "BURGER-HAVEN", username: "CASHIER", password: "CashierPassA!" },
    });
    assert.equal(resA.statusCode, 200);

    const resB = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { restaurantCode: "pizza-palace", username: "cashier", password: "CashierPassB!" },
    });
    assert.equal(resB.statusCode, 200);

    // 2. Wrong restaurant code returns 401 generic error
    const resWrongCode = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { restaurantCode: "invalid-code", username: "cashier", password: "CashierPassA!" },
    });
    assert.equal(resWrongCode.statusCode, 401);
    assert.equal(resWrongCode.json().code, "INVALID_CREDENTIALS");

    // 3. Wrong password returns 401 generic error
    const resWrongPass = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { restaurantCode: "burger-haven", username: "cashier", password: "WrongPassword!" },
    });
    assert.equal(resWrongPass.statusCode, 401);
    assert.equal(resWrongPass.json().code, "INVALID_CREDENTIALS");
  });

  await t.test("PHASE 3 & 4 — Platform Admin & Manual Subscriptions", async () => {
    // 1. Login as Platform Admin
    const adminLoginRes = await app.inject({
      method: "POST",
      url: "/platform-admin/api/auth/login",
      payload: { username: "superadmin", password: "SuperAdminPassword123!" },
    });
    assert.equal(adminLoginRes.statusCode, 200);
    const adminCookie = adminLoginRes.headers["set-cookie"];

    // 2. Normal restaurant user gets 403 on platform admin routes
    const userRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { restaurantCode: "burger-haven", username: "cashier", password: "CashierPassA!" },
    });
    const userCookie = userRes.headers["set-cookie"];

    const unauthorizedRes = await app.inject({
      method: "GET",
      url: "/platform-admin/api/dashboard",
      headers: { cookie: userCookie },
    });
    assert.equal(unauthorizedRes.statusCode, 401);

    // 3. Record and approve manual payment
    const now = new Date();
    const coveredFrom = now.toISOString();
    const coveredUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const paymentRes = await app.inject({
      method: "POST",
      url: `/platform-admin/api/restaurants/${restA.id}/payments`,
      headers: { cookie: adminCookie },
      payload: {
        planCode: "GROWTH",
        amountMinor: 500000, // 5000 PKR
        currencyCode: "PKR",
        paymentDate: now.toISOString(),
        coveredFrom,
        coveredUntil,
        externalReference: "TRX-987654321",
        whatsappReferenceText: "Paid via Easypaisa",
      },
    });
    assert.equal(paymentRes.statusCode, 201);
    const paymentId = paymentRes.json().paymentId;

    // Approve payment
    const approveRes = await app.inject({
      method: "POST",
      url: `/platform-admin/api/payments/${paymentId}/approve`,
      headers: { cookie: adminCookie },
    });
    assert.equal(approveRes.statusCode, 200);
    assert.equal(approveRes.json().approved, true);

    // Duplicate approval is idempotent
    const approveDupRes = await app.inject({
      method: "POST",
      url: `/platform-admin/api/payments/${paymentId}/approve`,
      headers: { cookie: adminCookie },
    });
    assert.equal(approveDupRes.statusCode, 200);
    assert.equal(approveDupRes.json().replayed, true);

    // 4. Suspend restaurant
    const suspendRes = await app.inject({
      method: "POST",
      url: `/platform-admin/api/restaurants/${restA.id}/suspend`,
      headers: { cookie: adminCookie },
      payload: { reason: "Non-payment of dues" },
    });
    assert.equal(suspendRes.statusCode, 200);

    // Attempt login to suspended restaurant receives suspended error
    const loginSuspendedRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { restaurantCode: "burger-haven", username: "cashier", password: "CashierPassA!" },
    });
    assert.equal(loginSuspendedRes.statusCode, 403);
    assert.equal(loginSuspendedRes.json().code, "RESTAURANT_SUSPENDED");

    // Restore restaurant
    const restoreRes = await app.inject({
      method: "POST",
      url: `/platform-admin/api/restaurants/${restA.id}/restore`,
      headers: { cookie: adminCookie },
    });
    assert.equal(restoreRes.statusCode, 200);

    // Login succeeds again after restore
    const loginRestoredRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { restaurantCode: "burger-haven", username: "cashier", password: "CashierPassA!" },
    });
    assert.equal(loginRestoredRes.statusCode, 200);
  });

  await t.test("PHASE 5 — Server-Signed Offline Entitlement", async () => {
    // 1. Issue valid entitlement
    const tokenObj = entitlementService.issueToken({
      restaurantId: restA.id,
      userId: "user-123",
      deviceId: "till-01",
      permissions: ["ORDER_CREATE"],
      subscriptionState: "active",
      ttlMs: 24 * 60 * 60 * 1000,
      validUntil: new Date(Date.now() + 86400000).toISOString(),
    });
    assert.ok(tokenObj.token);

    // 2. Verify valid entitlement
    const validVerify = entitlementService.verifyToken(tokenObj.token, {
      currentDeviceId: "till-01",
      currentRestaurantId: restA.id,
    });
    assert.equal(validVerify.valid, true);

    // 3. Tampered entitlement signature rejected
    const tamperedToken = tokenObj.token.slice(0, -4) + "XXXX";
    const tamperedVerify = entitlementService.verifyToken(tamperedToken, {
      currentDeviceId: "till-01",
      currentRestaurantId: restA.id,
    });
    assert.equal(tamperedVerify.valid, false);
    assert.equal(tamperedVerify.reason, "tampered_signature");

    // 4. Device mismatch rejected
    const devMismatch = entitlementService.verifyToken(tokenObj.token, {
      currentDeviceId: "till-99",
      currentRestaurantId: restA.id,
    });
    assert.equal(devMismatch.valid, false);
    assert.equal(devMismatch.reason, "device_mismatch");
  });

  await t.test("PHASE 6 — Storage Plan Quota Metering", async () => {
    // 1. Check initial usage
    const initialUsage = await storageService.getStorageUsage(restA.id);
    assert.equal(initialUsage.maxStorageBytes, 5368709120);

    // 2. Upload asset within quota
    const sampleBuffer = Buffer.from("Hello World Sample Asset Bytes");
    const uploadRes = await storageService.reserveAndStoreAsset({
      restaurantId: restA.id,
      fileName: "logo.png",
      mimeType: "image/png",
      buffer: sampleBuffer,
    });
    assert.equal(uploadRes.byteSize, sampleBuffer.length);

    // 3. Over-limit upload rejected
    const customStorage = createStorageService({ pool: appPool });
    await pool.query(
      `INSERT INTO tenant_storage_allowances (restaurant_id, max_storage_bytes, used_storage_bytes)
       VALUES ($1, 100, 90)
       ON CONFLICT (restaurant_id) DO UPDATE SET max_storage_bytes = 100, used_storage_bytes = 90`,
      [restB.id],
    );

    await assert.rejects(
      async () => {
        await customStorage.reserveAndStoreAsset({
          restaurantId: restB.id,
          fileName: "large.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.alloc(50),
        });
      },
      (err) => err.code === "STORAGE_QUOTA_EXCEEDED" && err.statusCode === 413,
    );
  });

});
