import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { provisionIntegrationDatabase, createAppPool, createControlPool, seedPlan } from "./helpers/postgres.mjs";
import { createServer } from "../src/server/main.mjs";
import { createPlatformAdminService } from "../src/server/auth/platform-admin-service.mjs";
import { createPostgresAuthRepository } from "../src/server/auth/postgres-auth-repository.mjs";
import { createTokenPair } from "../src/server/auth/tokens.mjs";
import { createPlatformAdminRepository } from "../src/server/auth/platform-admin-repository.mjs";

// No mocks or database skips: exercise production composition through HTTP with real RLS roles.
test("launch readiness: admin, two devices, catalog conflicts, expenses and exact profit", async t => {
  await provisionIntegrationDatabase();
  const pool = await createAppPool(), control = await createControlPool();
  const pepper = "readiness-test-pepper-at-least-32";
  await seedPlan(control, { code: "GROWTH", provider: "manual" });
  const adminService = createPlatformAdminService({ repository: createPlatformAdminRepository(control), passwordPepper: pepper });
  await adminService.bootstrapAdmin({ username: "auditadmin", password: "AdminPassword123!" });
  const server = await createServer({ pool, controlPool: control, env: { NODE_ENV: "test", DISABLE_RATE_LIMIT: "true", DATABASE_URL: "postgresql://unused/test", PASSWORD_PEPPER: pepper,
    SESSION_SECRET: "readiness-session-secret-at-least-32", TRUSTED_ORIGIN: "http://localhost:3000", PAYMENT_PROVIDER: "manual" } });
  t.after(async () => { await server.close(); await pool.end(); await control.end(); });
  const app = server.app;
  let requestNumber = 0;
  const send = (method, url, payload, cookie, restaurantId) => app.inject({ method, url, payload, remoteAddress: `198.51.100.${++requestNumber}`, headers: { ...(cookie ? { cookie } : {}), ...(restaurantId ? { "x-restaurant-id": restaurantId } : {}) } });
  const cookie = r => r.headers["set-cookie"].split(";")[0];
  const adminCookie = cookie(await send("POST", "/platform-admin/api/auth/login", { username: "auditadmin", password: "AdminPassword123!" }));
  const create = async code => {
    const r = await send("POST", "/platform-admin/api/restaurants", { code, name: code, ownerUsername: code === "readiness-cafe" ? "owner" : "other_readiness_owner", ownerPassword: "OwnerPassword123!" }, adminCookie);
    assert.equal(r.statusCode, 201, r.body); return r.json();
  };
  const restaurant = await create("readiness-cafe"), other = await create("other-readiness");
  const adminBase = `/platform-admin/api/restaurants/${restaurant.id}`;
  const signIn = async (username = "owner", code = restaurant.code) => {
    const r = await send("POST", "/api/auth/login", { restaurantCode: code, username, password: "OwnerPassword123!" });
    assert.equal(r.statusCode, 200, r.body); return cookie(r);
  };
  let first = await signIn(), second = await signIn();
  let cashier;
  await t.test("staff creation/editing, ownership, credential revocation and audits", async () => {
    const input = { username: "cashier", displayName: '<img src=x onerror=alert(1)>', role: "cashier", password: "OwnerPassword123!" };
    assert.equal((await send("POST", `${adminBase}/users`, input)).statusCode, 401);
    assert.equal((await send("POST", `${adminBase}/users`, { ...input, password: "short" }, adminCookie)).statusCode, 400);
    assert.equal((await send("POST", `/platform-admin/api/restaurants/${randomUUID()}/users`, input, adminCookie)).statusCode, 404);
    const result = await send("POST", `${adminBase}/users`, input, adminCookie);
    assert.equal(result.statusCode, 201, result.body); cashier = result.json().user;
    assert.equal(JSON.stringify(cashier).includes("password"), false);
    assert.equal((await send("POST", `${adminBase}/users`, input, adminCookie)).statusCode, 409);
    const staffSession = await signIn("cashier");
    const hash = (await control.query("SELECT password_hash FROM users WHERE id=$1", [cashier.id])).rows[0].password_hash;
    assert.equal((await send("PATCH", `/platform-admin/api/restaurants/${other.id}/users/${cashier.id}`, { username: "new_cashier" }, adminCookie)).statusCode, 404);
    assert.equal((await send("PATCH", `${adminBase}/users/${cashier.id}`, { username: "new_cashier" }, adminCookie)).statusCode, 200);
    assert.equal((await send("GET", "/api/auth/me", undefined, staffSession)).statusCode, 401);
    await assert.rejects(createPostgresAuthRepository(control).createSession({ userId: cashier.id, tokenHash: createTokenPair().tokenHash, expiresAt: new Date(Date.now() + 3600000), expectedPasswordHash: hash, expectedUsername: "cashier" }), error => error.code === "INVALID_CREDENTIALS");
    assert.equal((await send("PATCH", `${adminBase}/users/${cashier.id}`, { username: "owner" }, adminCookie)).statusCode, 409);
    const session = await signIn("new_cashier");
    assert.equal((await send("GET", "/api/auth/me", undefined, session)).statusCode, 200);
    const audits = (await control.query("SELECT action, metadata FROM audit_logs WHERE resource_id=$1 ORDER BY created_at", [cashier.id])).rows;
    assert.deepEqual(audits.map(row => row.action), ["user.created", "user.updated"]);
    assert.equal(JSON.stringify(audits).includes("OwnerPassword"), false);
    assert.equal((await send("GET", "/platform-admin/api/plans", undefined, adminCookie)).json().plans[0].code, "GROWTH");
    assert.equal((await send("GET", "/platform-admin/api/payments?page=0", undefined, adminCookie)).statusCode, 400);
    assert.equal((await send("GET", "/platform-admin/api/payments", undefined, adminCookie)).statusCode, 200);
  });
  let catalog;
  const snapshot = { pos_categories: ["Burgers"], pos_subcategories: {}, pos_category_offers: {}, pos_menu: [{ id: 1, itemNumber: 1, name: "Burger", category: "Burgers", price: 100, recipeDough: 100 }],
    pos_stock_item_defs: { Dough: { label: "Dough", buyUnit: "kg", sellUnit: "kg" } }, pos_ingredient_stock: { Dough: { stockGrams: 1000, avgCostPerGram: 0.2 } },
    pos_softdrink_stock: {}, pos_softdrink_threshold: 0, pos_icecream_stock: {}, pos_icecream_threshold: 0, pos_total_tables: 1, pos_halls_list: ["Main Hall"], pos_bank_accounts: [] };
  await t.test("published catalog can be loaded by a second authenticated device", async () => {
    const r = await send("POST", "/api/pos/import/legacy-catalog", { ...snapshot, expectedRevision: 0 }, first, restaurant.id);
    assert.equal(r.statusCode, 200, r.body); catalog = r.json(); assert.equal(catalog.revision, 1);
    const shared = await send("GET", "/api/pos/catalog", undefined, second, restaurant.id);
    assert.equal(shared.statusCode, 200); assert.equal(shared.json().mappings.menuItems[1], catalog.menuItems[1]);
    const denied = await send("GET", "/api/pos/catalog", undefined, second, other.id); assert.equal(denied.statusCode, 403);
    assert.equal((await pool.query("SELECT * FROM tenant_catalogs")).rows.length, 0);
  });
  let sales;
  const saleInput = key => ({ idempotencyKey: key, orderType: "takeaway", businessDate: "2026-10-13", items: [{ menuItemId: catalog.menuItems[1], quantity: 3 }],
    expectedTotalMinor: 30000, payment: { method: "cash", amountReceivedMinor: 30000 } });
  await t.test("simultaneous invoices both persist with unique sequence numbers; a retry deducts no extra stock", async () => {
    const keys = [randomUUID(), randomUUID()];
    const responses = await Promise.all([send("POST", "/api/pos/orders", saleInput(keys[0]), first, restaurant.id), send("POST", "/api/pos/orders", saleInput(keys[1]), second, restaurant.id)]);
    for (const r of responses) assert.equal(r.statusCode, 201, r.body);
    sales = responses.map(r => r.json().order);
    assert.ok(sales.every(order => order.orderStatus === "completed"));
    assert.equal(new Set(sales.map(order => order.id)).size, 2);
    assert.deepEqual(sales.map(order => order.orderNumber).sort(), [1, 2]);
    for (const sale of sales) assert.equal(sale.costOfGoodsMinor, 6000);
    const replay = await send("POST", "/api/pos/orders", saleInput(keys[0]), first, restaurant.id);
    assert.equal(replay.statusCode, 200); assert.equal(replay.json().order.id, sales[0].id);
    assert.equal((await control.query("SELECT count(*) FROM orders WHERE restaurant_id=$1", [restaurant.id])).rows[0].count, "2");
    assert.equal(Number((await control.query("SELECT quantity_base_units FROM inventory_balances WHERE restaurant_id=$1", [restaurant.id])).rows[0].quantity_base_units), 400);
    const tickets = (await control.query("SELECT id FROM kitchen_tickets WHERE restaurant_id=$1 ORDER BY ticket_number", [restaurant.id])).rows;
    assert.equal(tickets.length, 2);
    for (const status of ["preparing", "ready", "served"]) {
      const ticket = await send("PATCH", `/api/pos/kitchen/tickets/${tickets[0].id}/status`, { status }, first, restaurant.id);
      assert.equal(ticket.statusCode, 200, ticket.body);
    }
    assert.equal((await control.query("SELECT order_status FROM orders WHERE id=$1", [sales[0].id])).rows[0].order_status, "completed");
  });
  await t.test("catalog publication cannot reset sold stock and competing edits return a conflict", async () => {
    const updates = await Promise.all([send("POST", "/api/pos/import/legacy-catalog", { ...snapshot, expectedRevision: 1 }, first, restaurant.id), send("POST", "/api/pos/import/legacy-catalog", { ...snapshot, expectedRevision: 1 }, second, restaurant.id)]);
    assert.deepEqual(updates.map(r => r.statusCode).sort(), [200, 409]);
    assert.equal(Number((await control.query("SELECT quantity_base_units FROM inventory_balances WHERE restaurant_id=$1", [restaurant.id])).rows[0].quantity_base_units), 400);
    const shared = (await send("GET", "/api/pos/catalog", undefined, second, restaurant.id)).json();
    assert.equal(shared.revision, 2); assert.equal(shared.snapshot.pos_ingredient_stock.Dough.stockGrams, 400);
    assert.equal((await send("POST", "/api/pos/import/legacy-catalog", snapshot, first, restaurant.id)).statusCode, 409);
  });
  let accountId;
  await t.test("expenses are durable, tenant-isolated, atomic with ledger/audit, and idempotent across devices", async () => {
    accountId = (await send("GET", "/api/pos/finance/accounts", undefined, first, restaurant.id)).json().accounts[0].id;
    const input = { idempotencyKey: randomUUID(), categoryName: "Rent", amountMinor: 5000, businessDate: "2026-10-13", financialAccountId: accountId, description: '<img src=x onerror=alert(1)>' };
    assert.equal((await send("POST", "/api/pos/expenses", input)).statusCode, 401);
    assert.equal((await send("POST", "/api/pos/expenses", { ...input, amountMinor: 0 }, first, restaurant.id)).statusCode, 400);
    assert.equal((await send("POST", "/api/pos/expenses", { ...input, financialAccountId: randomUUID() }, first, restaurant.id)).statusCode, 404);
    const responses = await Promise.all([send("POST", "/api/pos/expenses", input, first, restaurant.id), send("POST", "/api/pos/expenses", input, second, restaurant.id)]);
    assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 201]);
    const id = responses[0].json().expense.id;
    assert.equal(responses[1].json().expense.id, id);
    assert.equal((await send("POST", "/api/pos/expenses", { ...input, amountMinor: 6000 }, first, restaurant.id)).statusCode, 409);
    assert.equal((await control.query("SELECT count(*) FROM ledger_entries WHERE expense_id=$1", [id])).rows[0].count, "1");
    assert.equal((await control.query("SELECT count(*) FROM audit_logs WHERE action='expense.created' AND resource_id=$1", [id])).rows[0].count, "1");
    const report = await send("GET", "/api/pos/expenses?startDate=2026-10-13&endDate=2026-10-13", undefined, second, restaurant.id);
    assert.equal(report.json().totalMinor, 5000); assert.equal(report.json().expenses[0].description, input.description);
    const foreign = await signIn("other_readiness_owner", other.code);
    assert.equal((await send("GET", "/api/pos/expenses?startDate=2026-10-13&endDate=2026-10-13", undefined, foreign, other.id)).json().totalMinor, 0);
    const cashierCookie = await signIn("new_cashier");
    assert.equal((await send("POST", "/api/pos/expenses", input, cashierCookie, restaurant.id)).statusCode, 403);
    const accounts = (await send("GET", "/api/pos/finance/accounts", undefined, first, restaurant.id)).json().accounts;
    assert.equal(accounts[0].balanceMinor, 55000);
  });
  const profit = async () => (await send("GET", "/api/pos/reports/profit-loss?startDate=2026-10-13&endDate=2026-10-13", undefined, second, restaurant.id)).json();
  await t.test("profit uses quantity times frozen unit cost, expenses and refund restocking policy", async () => {
    assert.equal((await profit()).netSalesMinor, 60000); assert.equal((await profit()).costOfGoodsMinor, 12000); assert.equal((await profit()).netProfitMinor, 43000);
    // Change the recipe cost after checkout; historical profits must remain frozen.
    await control.query("UPDATE inventory_balances SET average_cost_minor_per_base_unit=99 WHERE restaurant_id=$1", [restaurant.id]);
    assert.equal((await profit()).costOfGoodsMinor, 12000);
    const line = (await control.query("SELECT id FROM order_items WHERE order_id=$1", [sales[0].id])).rows[0];
    const refund = await send("POST", `/api/pos/orders/${sales[0].id}/refunds`, { idempotencyKey: randomUUID(), reason: "Damaged item", items: [{ orderItemId: line.id, quantity: 1, restock: false }] }, first, restaurant.id);
    assert.equal(refund.statusCode, 201, refund.body);
    assert.equal((await profit()).costOfGoodsMinor, 12000); assert.equal((await profit()).netProfitMinor, 33000);
    const line2 = (await control.query("SELECT id FROM order_items WHERE order_id=$1", [sales[1].id])).rows[0];
    assert.equal((await send("POST", `/api/pos/orders/${sales[1].id}/refunds`, { idempotencyKey: randomUUID(), reason: "Returned item", items: [{ orderItemId: line2.id, quantity: 1, restock: true }] }, first, restaurant.id)).statusCode, 201);
    assert.equal((await profit()).costOfGoodsMinor, 10000); assert.equal((await profit()).netProfitMinor, 25000);
  });
  await t.test("cancelling a partially refunded sale does not reduce another sale's reported net revenue", async () => {
    const result = await send("POST", `/api/pos/orders/${sales[0].id}/cancel`, { idempotencyKey: randomUUID(), reason: "Cancel remaining bill" }, first, restaurant.id);
    assert.equal(result.statusCode, 201, result.body);
    assert.equal(Number((await control.query("SELECT quantity_base_units FROM inventory_balances WHERE restaurant_id=$1", [restaurant.id])).rows[0].quantity_base_units), 700);
    assert.equal((await profit()).costOfGoodsMinor, 6000);
    assert.equal((await profit()).netProfitMinor, 9000);
    const report = (await send("GET", "/api/pos/reports/sales?startDate=2026-10-13&endDate=2026-10-13", undefined, second, restaurant.id)).json();
    assert.equal(report.metrics.netSalesMinor, 20000);
  });
  await t.test("restoring a trial preserves expiry; changing the restaurant code revokes sessions", async () => {
    assert.equal((await send("POST", `${adminBase}/suspend`, {}, adminCookie)).statusCode, 200);
    assert.equal((await send("POST", `${adminBase}/restore`, {}, adminCookie)).statusCode, 200);
    assert.equal((await control.query("SELECT status FROM subscriptions WHERE restaurant_id=$1", [restaurant.id])).rows[0].status, "trialing");
    assert.equal((await send("PATCH", adminBase, { code: other.code }, adminCookie)).statusCode, 409);
    const hash = (await control.query("SELECT password_hash FROM users WHERE id=$1", [restaurant.owner.id])).rows[0].password_hash;
    assert.equal((await send("PATCH", adminBase, { code: "renamed-readiness" }, adminCookie)).statusCode, 200);
    await assert.rejects(createPostgresAuthRepository(control).createSession({ userId: restaurant.owner.id, tokenHash: createTokenPair().tokenHash, expiresAt: new Date(Date.now() + 3600000), expectedPasswordHash: hash, expectedRestaurantId: restaurant.id, expectedRestaurantCode: restaurant.code }), error => error.code === "INVALID_CREDENTIALS");
    assert.equal((await send("GET", "/api/auth/me", undefined, first)).statusCode, 401);
    assert.equal((await send("GET", "/api/auth/me", undefined, second)).statusCode, 401);
    const renamed = await signIn("owner", "renamed-readiness");
    assert.equal((await send("GET", "/api/auth/me", undefined, renamed)).statusCode, 200);
    assert.equal((await send("POST", `/platform-admin/api/restaurants/${randomUUID()}/suspend`, {}, adminCookie)).statusCode, 404);
    assert.equal((await send("POST", `/platform-admin/api/restaurants/${randomUUID()}/restore`, {}, adminCookie)).statusCode, 404);
  });
});
