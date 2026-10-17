import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { provisionIntegrationDatabase, connectAdmin, createAppPool, seedRestaurant } from "./helpers/postgres.mjs";
import { createLegacyOrderRestoreService } from "../src/server/pos/legacy-order-restore-service.mjs";
import { createOrderHistoryService } from "../src/server/pos/order-history-service.mjs";
import { createSalesReportService } from "../src/server/pos/sales-report-service.mjs";
import { createOrderCancellationService } from "../src/server/pos/order-cancellation-service.mjs";
import { createOrderRefundService } from "../src/server/pos/order-refund-service.mjs";
import { createOrderService } from "../src/server/pos/order-service.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/santex-cafe-reproduction-backup.json", import.meta.url), "utf8"));
test("three historical backup orders restore into shared history exactly once under real RLS", async t => {
  await provisionIntegrationDatabase();
  const admin = await connectAdmin(), pool = await createAppPool();
  t.after(async () => { await pool.end(); await admin.end(); });
  const a = await seedRestaurant(admin, { name: "Restore Cafe" }), b = await seedRestaurant(admin, { name: "Other Cafe" });
  const context = seed => ({ restaurant: { id: seed.restaurantId, timezone: "Asia/Karachi", currencyCode: "PKR", name: "Restore Cafe" }, membership: { userId: seed.userId, role: "owner", defaultBranchId: seed.branchId } });
  const tenant = context(a), otherTenant = context(b), service = createLegacyOrderRestoreService(pool);
  const restore = records => service.restore({ tenant, userId: a.userId, orders: records });
  let restoredId;
  await t.test("concurrent replay imports the fixture once without stock, kitchen or account mutations", async () => {
    const results = await Promise.all([restore(fixture.pos_orders), restore(fixture.pos_orders)]);
    assert.equal(results.reduce((sum, result) => sum + result.imported, 0), 3);
    assert.equal(results.reduce((sum, result) => sum + result.skipped, 0), 3);
    const history = await createOrderHistoryService(pool).list({ tenant });
    assert.equal(history.orders.length, 3);
    assert.deepEqual(history.orders.map(order => order.orderNumber).sort(), [1,2,3]);
    assert.ok(history.orders.every(order => order.restored && order.financialReconciliationRequired));
    restoredId = history.orders[0].id;
    const detail = await createOrderHistoryService(pool).get({ tenant, orderId: restoredId });
    assert.equal(detail.items.length, 1);
    assert.ok(detail.order.originalOrderNumber);
    for (const table of ["stock_movements", "inventory_consumptions", "kitchen_tickets", "ledger_entries"]) {
      assert.equal((await admin.query(`SELECT count(*) FROM ${table}`)).rows[0].count, "0");
    }
    const report = await createSalesReportService(pool).getSalesReport({ tenant, filters: { startDate: "2026-10-02", endDate: "2026-10-02" } });
    assert.equal(report.metrics.netSalesMinor, 304700);
    assert.equal(report.metrics.completedOrderCount, 3);
    assert.equal(report.metrics.incompleteCostingOrderCount, 3);
    assert.equal(report.paymentBreakdown[0].capturedMinor, 304700);
  });
  await t.test("a changed duplicate rolls back the entire batch and leaves existing records intact", async () => {
    const extra = { ...fixture.pos_orders[0], id: 4 };
    const conflict = { ...fixture.pos_orders[0], customerName: "Changed" };
    await assert.rejects(restore([extra, conflict]), error => error.code === "RESTORE_ORDER_CONFLICT");
    assert.equal((await admin.query("SELECT count(*) FROM orders")).rows[0].count, "3");
    assert.equal((await restore(fixture.pos_orders)).imported, 0);
  });
  await t.test("a second restaurant cannot read or financially mutate restored bills", async () => {
    const history = await createOrderHistoryService(pool).list({ tenant: otherTenant });
    assert.equal(history.orders.length, 0);
    await assert.rejects(createOrderHistoryService(pool).get({ tenant: otherTenant, orderId: restoredId }), error => error.code === "ORDER_NOT_FOUND");
    for (const operation of [
      () => createOrderCancellationService(pool).cancel({ tenant, userId: a.userId, orderId: restoredId, reason: "test", idempotencyKey: randomUUID() }),
      () => createOrderRefundService(pool).createRefund({ tenant, userId: a.userId, orderId: restoredId, input: { reason: "test", amountMinor: 100, idempotencyKey: randomUUID() } }),
      () => createOrderService(pool).settlePayment({ tenant, userId: a.userId, orderId: restoredId, input: { amountMinor: 100, paymentMethod: "cash", idempotencyKey: randomUUID() } }),
    ]) await assert.rejects(operation(), error => error.code === "HISTORICAL_ORDER_READ_ONLY");
    assert.equal((await admin.query("SELECT count(*) FROM ledger_entries")).rows[0].count, "0");
  });
});
