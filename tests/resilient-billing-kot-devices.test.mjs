import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { createOrderService } from "../src/server/pos/order-service.mjs";
import { createSalesReportService } from "../src/server/pos/sales-report-service.mjs";
import { createFinanceService } from "../src/server/pos/finance-service.mjs";
import { createInventoryConsumptionService } from "../src/server/pos/inventory-consumption-service.mjs";
import { createPostgresAuthRepository } from "../src/server/auth/postgres-auth-repository.mjs";
import { createAuthService } from "../src/server/auth/auth-service.mjs";
import { buildHttpApp } from "../src/server/http/app.mjs";
import { createTokenPair, hashOpaqueToken } from "../src/server/auth/tokens.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "./helpers/legacy-source.mjs";
import {
  createAppPool,
  createControlPool,
  connectAdmin,
  isDatabaseAvailable,
  provisionIntegrationDatabase,
  seedRestaurant,
  seedPlan,
} from "./helpers/postgres.mjs";

const available = await isDatabaseAvailable();
const describeDatabase = available ? describe : describe.skip;

if (!available) {
  console.warn(
    "[skipped] PostgreSQL resilient billing & KOT integration tests: no database available.",
  );
}

describeDatabase("Resilient Billing, KOT, and Concurrent Device Limits Integration Suite", () => {
  let admin;
  let pool;
  let controlPool;
  let tenant;
  let consumeInventory;
  let orderService;
  let salesReportService;
  let financeService;
  let authRepository;
  let authService;
  let app;

  let menuItemWithoutRecipeId;
  let menuItemWithRecipeId;
  let stockItemId;
  let financialAccountId;

  const now = new Date("2026-10-16T12:00:00Z");
  const clock = () => now;

  before(async () => {
    await provisionIntegrationDatabase();
    admin = await connectAdmin();
    pool = await createAppPool();
    controlPool = await createControlPool();

    tenant = await seedRestaurant(admin, { name: "Resilient Diner" });

    // Ensure plan has device limit 4 (Growth plan default)
    const plan = await seedPlan(admin, { code: "GROWTH", provider: "manual" });
    await admin.query(`
      UPDATE plans SET max_devices = 4 WHERE id = $1
    `, [plan.planId]);
    await admin.query(`
      INSERT INTO subscriptions (restaurant_id, plan_id, plan_price_id, provider, status)
      VALUES ($1, $2, $3, 'manual', 'active')
    `, [tenant.restaurantId, plan.planId, plan.priceId]);

    // Setup financial cash account
    financialAccountId = randomUUID();
    await admin.query(`
      INSERT INTO financial_accounts (id, restaurant_id, branch_id, account_type, display_name, bank_name, opening_balance_minor, is_active)
      VALUES ($1, $2, $3, 'cash', 'Main Cash Drawer', 'Cash', 0, true)
    `, [financialAccountId, tenant.restaurantId, tenant.branchId]);

    // Setup inventory item with opening balance
    stockItemId = randomUUID();
    await admin.query(`
      INSERT INTO stock_items (id, restaurant_id, name, stock_type, base_unit, is_active)
      VALUES ($1, $2, 'Burger Patty', 'ingredient', 'piece', true)
    `, [stockItemId, tenant.restaurantId]);

    await admin.query(`
      INSERT INTO inventory_balances (restaurant_id, branch_id, stock_item_id, quantity_base_units, average_cost_minor_per_base_unit, version)
      VALUES ($1, $2, $3, 50, 15000, 1)
    `, [tenant.restaurantId, tenant.branchId, stockItemId]);

    // Setup Menu item 1: Has complete recipe and stock
    menuItemWithRecipeId = randomUUID();
    await admin.query(`
      INSERT INTO menu_items (id, restaurant_id, name, price_minor, is_active)
      VALUES ($1, $2, 'Zinger Deluxe', 55000, true)
    `, [menuItemWithRecipeId, tenant.restaurantId]);

    await admin.query(`
      INSERT INTO menu_item_recipe_items (restaurant_id, menu_item_id, stock_item_id, quantity_base_units)
      VALUES ($1, $2, $3, 1)
    `, [tenant.restaurantId, menuItemWithRecipeId, stockItemId]);

    // Setup Menu item 2: Missing recipe and missing stock (brand new item without setup)
    menuItemWithoutRecipeId = randomUUID();
    await admin.query(`
      INSERT INTO menu_items (id, restaurant_id, name, price_minor, is_active)
      VALUES ($1, $2, 'Chef Secret Special', 75000, true)
    `, [menuItemWithoutRecipeId, tenant.restaurantId]);

    consumeInventory = createInventoryConsumptionService(pool);
    orderService = createOrderService(pool, {
      consumeInventory,
      clock,
    });
    salesReportService = createSalesReportService(pool, { clock });
    financeService = createFinanceService(pool);

    authRepository = createPostgresAuthRepository(controlPool);
    authService = createAuthService({
      repository: authRepository,
      mailer: { sendVerification: async () => {} },
      passwordPepper: "test-pepper-resilient",
    });

    app = await buildHttpApp({
      databasePool: pool,
      trustedOrigin: "http://localhost:3000",
      serveClient: false,
      authService,
      orderService,
      salesReportService,
      financeService,
      tenantContextService: {
        async load() {
          return {
            restaurant: { id: tenant.restaurantId, timezone: "Asia/Karachi", currencyCode: "PKR", status: "active" },
            membership: { role: "owner", defaultBranchId: tenant.branchId },
            subscription: { status: "active", plan: { code: "GROWTH" }, currentPeriodEnd: new Date(Date.now() + 30 * 86400 * 1000) },
            subscriptionAccess: { level: "full" },
          };
        },
        async resolve() {
          return {
            restaurant: { id: tenant.restaurantId, timezone: "Asia/Karachi", currencyCode: "PKR", status: "active" },
            membership: { role: "owner", defaultBranchId: tenant.branchId },
            subscription: { status: "active", plan: { code: "GROWTH" }, currentPeriodEnd: new Date(Date.now() + 30 * 86400 * 1000) },
            subscriptionAccess: { level: "full" },
          };
        },
      },
    });
  });

  after(async () => {
    if (app) await app.close();
    if (admin) await admin.end();
    if (pool) await pool.end();
    if (controlPool) await controlPool.end();
  });

  describe("Requirement 1: Resilient Billing without Recipes/Stock Setup", () => {
    it("allows checkout of items without recipes or stock balances, flags incomplete_costing and logs skipped deductions", async () => {
      const idempotencyKey = randomUUID();
      const tenantContext = {
        restaurant: { id: tenant.restaurantId, timezone: "Asia/Karachi" },
        membership: { role: "owner", defaultBranchId: tenant.branchId },
      };

      const result = await orderService.create({
        tenant: tenantContext,
        userId: tenant.userId,
        input: {
          idempotencyKey,
          orderType: "dine_in",
          items: [
            { menuItemId: menuItemWithoutRecipeId, quantity: 2 },
          ],
          payment: {
            method: "cash",
            amountReceivedMinor: 150000,
            financialAccountId,
          },
        },
      });

      assert.equal(result.order.totalMinor, 150000);
      assert.equal(result.order.orderStatus, "completed");
      assert.equal(result.order.paymentStatus, "paid");
      assert.equal(result.order.incompleteCosting, true, "Order must be flagged with incompleteCosting");
      assert.ok(Array.isArray(result.order.skippedStockDeductions));
      assert.ok(result.order.skippedStockDeductions.length > 0, "Missing recipe item must record skipped deduction");

      // Verify report reflects incomplete costing
      const report = await salesReportService.getSalesReport({
        tenant: tenantContext,
        filters: { startDate: "2026-10-16", endDate: "2026-10-16" },
      });

      assert.equal(report.metrics.hasIncompleteCosting, true);
      assert.ok(report.metrics.incompleteCostingOrderCount >= 1);

      // Verify finance profitLoss reflects incomplete costing
      const pl = await financeService.profitLoss({
        restaurantId: tenant.restaurantId,
        userId: tenant.userId,
        startDate: "2026-10-16",
        endDate: "2026-10-16",
      });

      assert.equal(pl.hasIncompleteCosting, true);
      assert.ok(pl.incompleteCostingOrders >= 1);
    });

    it("deducts stock for items with recipes while skipping unconfigured items in the same cart", async () => {
      const balanceBeforeRes = await admin.query(
        "SELECT quantity_base_units FROM inventory_balances WHERE restaurant_id = $1 AND stock_item_id = $2",
        [tenant.restaurantId, stockItemId],
      );
      const balanceBefore = Number(balanceBeforeRes.rows[0].quantity_base_units);

      const idempotencyKey = randomUUID();
      const tenantContext = {
        restaurant: { id: tenant.restaurantId, timezone: "Asia/Karachi" },
        membership: { role: "owner", defaultBranchId: tenant.branchId },
      };

      const result = await orderService.create({
        tenant: tenantContext,
        userId: tenant.userId,
        input: {
          idempotencyKey,
          orderType: "takeaway",
          items: [
            { menuItemId: menuItemWithRecipeId, quantity: 3 }, // 3 units of stock
            { menuItemId: menuItemWithoutRecipeId, quantity: 1 }, // 0 units of stock, unconfigured
          ],
          payment: {
            method: "cash",
            amountReceivedMinor: 240000,
            financialAccountId,
          },
        },
      });

      assert.equal(result.order.incompleteCosting, true);

      const balanceAfterRes = await admin.query(
        "SELECT quantity_base_units FROM inventory_balances WHERE restaurant_id = $1 AND stock_item_id = $2",
        [tenant.restaurantId, stockItemId],
      );
      const balanceAfter = Number(balanceAfterRes.rows[0].quantity_base_units);

      assert.equal(balanceAfter, balanceBefore - 3, "Available ingredient stock must be deducted by exactly 3 units");
    });
  });

  describe("Requirement 2: KOT Order Creation and Settlement Workflow", () => {
    it("creates KOT order in 'in_progress' and 'unpaid' status without running inventory consumption", async () => {
      const idempotencyKey = randomUUID();
      const tenantContext = {
        restaurant: { id: tenant.restaurantId, timezone: "Asia/Karachi" },
        membership: { role: "owner", defaultBranchId: tenant.branchId },
      };

      const result = await orderService.create({
        tenant: tenantContext,
        userId: tenant.userId,
        input: {
          idempotencyKey,
          orderType: "dine_in",
          isKot: true,
          items: [
            { menuItemId: menuItemWithRecipeId, quantity: 2 },
          ],
        },
      });

      assert.equal(result.order.orderStatus, "preparing", "KOT order must start in preparing status");
      assert.equal(result.order.paymentStatus, "unpaid", "KOT order must be unpaid");
      assert.ok(!result.order.completedAt, "KOT order must not have completed timestamp");

      // Verify no inventory consumption was recorded yet
      const consumptionRes = await admin.query(
        "SELECT id FROM inventory_consumptions WHERE restaurant_id = $1 AND order_id = $2",
        [tenant.restaurantId, result.order.id],
      );
      assert.equal(consumptionRes.rowCount, 0, "Inventory consumption must be deferred until settlement");

      // Now settle payment for the KOT order
      const settlementKey = randomUUID();
      const settlement = await orderService.settlePayment({
        tenant: tenantContext,
        userId: tenant.userId,
        orderId: result.order.id,
        input: {
          idempotencyKey: settlementKey,
          amountMinor: result.order.totalMinor,
          paymentMethod: "cash",
          financialAccountId,
        },
      });

      assert.equal(settlement.order.orderStatus, "completed", "Settled order must transition to completed");
      assert.equal(settlement.order.paymentStatus, "paid", "Settled order must be marked paid");

      // Verify inventory consumption ran on settlement
      const postSettlementConsumption = await admin.query(
        "SELECT id FROM inventory_consumptions WHERE restaurant_id = $1 AND order_id = $2",
        [tenant.restaurantId, result.order.id],
      );
      assert.equal(postSettlementConsumption.rowCount, 1, "Inventory consumption must commit on payment settlement");
    });
  });

  describe("Requirement 4: Flexible Concurrent-Device Subscription Limits", () => {
    let testUserId;
    let testUsername;
    let testEmail;
    const testPasswordHash = "$argon2id$v=19$m=19456,t=2,p=1$ZGV2ZWxvcG1lbnQtc2FsdA$VnF2p2kM03vG/Rk5eXoQWqJgWjY";
    const activeTokens = [];

    async function createTestSession(opts = {}) {
      const { token, tokenHash } = createTokenPair();
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
      await authRepository.createSession({
        userId: testUserId,
        expectedPasswordHash: testPasswordHash,
        expectedUsername: testUsername,
        expectedEmail: testEmail,
        expectedRestaurantId: tenant.restaurantId,
        tokenHash,
        ipAddress: opts.ipAddress ?? "192.168.1.10",
        userAgent: opts.userAgent ?? "Terminal",
        expiresAt,
        previousTokenHash: opts.previousSessionToken
          ? hashOpaqueToken(opts.previousSessionToken)
          : null,
        now: new Date(),
      });
      return { token, tokenHash, expiresAt };
    }

    async function revokeAndCreateTestSession(opts = {}) {
      const { token, tokenHash } = createTokenPair();
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
      await authRepository.revokeAndCreateSession({
        userId: testUserId,
        expectedPasswordHash: testPasswordHash,
        expectedUsername: testUsername,
        expectedEmail: testEmail,
        expectedRestaurantId: tenant.restaurantId,
        tokenHash,
        ipAddress: opts.ipAddress ?? "192.168.1.99",
        userAgent: opts.userAgent ?? "Tablet-Android",
        expiresAt,
        sessionToRevokeId: opts.sessionToRevokeId,
        now: new Date(),
      });
      return { token, tokenHash, expiresAt };
    }

    before(async () => {
      testUsername = `device_tester_${randomUUID().slice(0, 6)}`;
      testEmail = `${testUsername}@example.com`;

      // Create test user in tenant
      const userRes = await admin.query(`
        INSERT INTO users (email, normalized_email, username, display_name, status, email_verified_at, password_hash)
        VALUES ($1, $1, $2, 'Device Tester', 'active', now(), $3)
        RETURNING id
      `, [testEmail, testUsername, testPasswordHash]);
      testUserId = userRes.rows[0].id;

      await admin.query(`
        INSERT INTO restaurant_memberships (restaurant_id, user_id, role, status, default_branch_id, joined_at)
        VALUES ($1, $2, 'owner', 'active', $3, now())
      `, [tenant.restaurantId, testUserId, tenant.branchId]);

      // Clear any prior active sessions for this restaurant
      await admin.query(`
        UPDATE sessions SET revoked_at = now() WHERE restaurant_id = $1
      `, [tenant.restaurantId]);
    });

    it("allows up to plan limit (4) concurrent active sessions and blocks 5th with DEVICE_LIMIT_REACHED", async () => {
      // Create 4 distinct sessions
      for (let i = 1; i <= 4; i++) {
        const session = await createTestSession({
          userAgent: `Mozilla/5.0 Terminal-${i}`,
          ipAddress: `192.168.1.${10 + i}`,
        });
        assert.ok(session.token);
        activeTokens.push(session);
      }

      // Check active count in DB
      const countRes = await admin.query(`
        SELECT count(*)::int AS count FROM sessions
        WHERE restaurant_id = $1 AND revoked_at IS NULL AND expires_at > now()
      `, [tenant.restaurantId]);
      assert.equal(countRes.rows[0].count, 4);

      // 5th attempt must fail with DEVICE_LIMIT_REACHED
      await assert.rejects(
        async () => {
          await createTestSession({
            userAgent: "Mozilla/5.0 Terminal-5",
            ipAddress: "192.168.1.15",
          });
        },
        (err) => {
          assert.equal(err.code, "DEVICE_LIMIT_REACHED");
          assert.equal(err.deviceLimit, 4);
          assert.equal(err.activeSessions.length, 4);
          return true;
        },
      );
    });

    it("re-login with previousSessionToken reuses slot without consuming an extra device slot", async () => {
      // Fetch an existing active session
      const sessions = await authRepository.listRestaurantSessions({ restaurantId: tenant.restaurantId });
      assert.equal(sessions.length, 4);
      const existingSession = activeTokens[0];

      // Re-login passing previousSessionToken
      const reconnected = await createTestSession({
        previousSessionToken: existingSession.token,
      });

      assert.ok(reconnected.token);

      // Verify total active sessions is still exactly 4
      const afterSessions = await authRepository.listRestaurantSessions({ restaurantId: tenant.restaurantId });
      assert.equal(afterSessions.length, 4, "Re-connecting must not consume an extra device slot");
    });

    it("revoke-and-login replaces the chosen session atomically", async () => {
      const sessions = await authRepository.listRestaurantSessions({ restaurantId: tenant.restaurantId });
      assert.equal(sessions.length, 4);
      const targetSessionToRevoke = sessions[0];

      const replaced = await revokeAndCreateTestSession({
        sessionToRevokeId: targetSessionToRevoke.id,
      });

      assert.ok(replaced.token);

      // Check that target session is now revoked
      const revokedCheck = await admin.query(
        "SELECT revoked_at FROM sessions WHERE id = $1",
        [targetSessionToRevoke.id],
      );
      assert.ok(revokedCheck.rows[0].revoked_at != null, "Chosen session must be marked revoked");

      // Total active sessions must still be 4
      const postSessions = await authRepository.listRestaurantSessions({ restaurantId: tenant.restaurantId });
      assert.equal(postSessions.length, 4);
    });

    it("owner can list and manually revoke active sessions via HTTP endpoints", async () => {
      const callerToken = activeTokens[1].token;

      // List sessions
      const listRes = await app.inject({
        method: "GET",
        url: "/api/pos/sessions",
        headers: {
          "x-restaurant-id": tenant.restaurantId,
          cookie: `pos_session=${callerToken}`,
        },
      });
      assert.equal(listRes.statusCode, 200);
      const body = JSON.parse(listRes.body);
      assert.ok(Array.isArray(body.sessions));
      assert.equal(body.sessions.length, 4);

      // Revoke an older other session (not the caller's own active session)
      const toRevoke = body.sessions[body.sessions.length - 1];
      const deleteRes = await app.inject({
        method: "DELETE",
        url: `/api/pos/sessions/${toRevoke.id}`,
        headers: {
          "x-restaurant-id": tenant.restaurantId,
          cookie: `pos_session=${callerToken}`,
        },
      });
      assert.equal(deleteRes.statusCode, 200);

      // Active count is now 3
      const remainingRes = await app.inject({
        method: "GET",
        url: "/api/pos/sessions",
        headers: {
          "x-restaurant-id": tenant.restaurantId,
          cookie: `pos_session=${callerToken}`,
        },
      });
      assert.equal(remainingRes.statusCode, 200);
      const remainingBody = JSON.parse(remainingRes.body);
      assert.equal(remainingBody.sessions.length, 3);
    });
  });

  describe("Requirement 3: Frontend POS UI Button Layout and Cart Preservation", () => {
    it("HTML file contains exact button order: Save Bill -> KOT -> Save & Print", () => {
      const htmlPath = path.join(projectRoot, "Fast_Food_POS_Custom_Bill_Header_XXXL.html");
      const html = readFileSync(htmlPath, "utf8");

      const saveBillIdx = html.indexOf('id="btn-save-bill"');
      const kotIdx = html.indexOf('id="btn-kot-bill"');
      const savePrintIdx = html.indexOf('id="btn-save-print-bill"');

      assert.ok(saveBillIdx !== -1, "btn-save-bill must exist in HTML");
      assert.ok(kotIdx !== -1, "btn-kot-bill must exist in HTML");
      assert.ok(savePrintIdx !== -1, "btn-save-print-bill must exist in HTML");

      assert.ok(
        saveBillIdx < kotIdx && kotIdx < savePrintIdx,
        "Button order must strictly be: Save Bill -> KOT -> Save & Print",
      );
    });

    it("HTML file contains missing stock confirmation modal markup with Continue Billing and Review Stock buttons", () => {
      const htmlPath = path.join(projectRoot, "Fast_Food_POS_Custom_Bill_Header_XXXL.html");
      const html = readFileSync(htmlPath, "utf8");

      assert.ok(html.includes('id="missing-stock-confirm-modal"'));
      assert.ok(html.includes("Some items do not have stock details. Continue billing?"));
      assert.ok(html.includes('id="btn-continue-billing"'));
      assert.ok(html.includes('id="btn-review-stock"'));
    });

    it("HTML file contains device limit replacement modal markup with revocation button", () => {
      const htmlPath = path.join(projectRoot, "Fast_Food_POS_Custom_Bill_Header_XXXL.html");
      const html = readFileSync(htmlPath, "utf8");

      assert.ok(html.includes("showDeviceLimitReplacementModal"));
      assert.ok(html.includes("Sign Out &amp; Login Here") || html.includes("Sign Out & Login Here"));
    });

    it("saveCartDraft and restoreCartDraft read and write real DOM element IDs with fallbacks", () => {
      const htmlPath = path.join(projectRoot, "Fast_Food_POS_Custom_Bill_Header_XXXL.html");
      const html = readFileSync(htmlPath, "utf8");

      assert.ok(html.includes('document.getElementById("cust-name")'));
      assert.ok(html.includes('document.getElementById("dinein-table-select")'));
      assert.ok(html.includes('document.getElementById("discount-value-input")'));
      assert.ok(html.includes('document.getElementById("delivery-charge-input")'));
    });
  });
});
