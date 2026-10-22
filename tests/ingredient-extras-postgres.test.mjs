import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { provisionIntegrationDatabase, createAppPool, connectAdmin, seedRestaurant } from "./helpers/postgres.mjs";
import { createOrderService } from "../src/server/pos/order-service.mjs";
import { createOrderAmendmentService } from "../src/server/pos/order-amendment-service.mjs";
import { createOrderHistoryService } from "../src/server/pos/order-history-service.mjs";
import { createOrderCancellationService } from "../src/server/pos/order-cancellation-service.mjs";
import { createOrderRefundService } from "../src/server/pos/order-refund-service.mjs";
import { createKitchenService } from "../src/server/pos/kitchen-service.mjs";
import { mapCloudOrderDetail } from "../src/client/cloud-order-mapper.mjs";

test("ingredient extras end-to-end postgres lifecycle", async (t) => {
  await provisionIntegrationDatabase();
  const admin = await connectAdmin();
  const pool = await createAppPool();
  t.after(async () => {
    await pool.end();
    await admin.end();
  });

  const a = await seedRestaurant(admin);
  const b = await seedRestaurant(admin);

  const tenant = {
    restaurant: { id: a.restaurantId, timezone: "Asia/Karachi" },
    membership: { userId: a.userId, defaultBranchId: a.branchId, role: "owner" },
  };
  const foreignTenant = {
    restaurant: { id: b.restaurantId, timezone: "Asia/Karachi" },
    membership: { userId: b.userId, defaultBranchId: b.branchId, role: "owner" },
  };

  const cash = (await admin.query(
    `INSERT INTO financial_accounts(restaurant_id, branch_id, account_type, display_name)
     VALUES ($1, $2, 'cash', 'Till 1') RETURNING id`,
    [a.restaurantId, a.branchId],
  )).rows[0].id;

  // Recipe stock item: Bun (tracked in pieces, 1 piece per burger)
  const bunStock = (await admin.query(
    `INSERT INTO stock_items(restaurant_id, name, stock_type, base_unit, sell_unit, base_units_per_sell_unit)
     VALUES ($1, 'Bun', 'ingredient', 'piece', 'number', 1) RETURNING id`,
    [a.restaurantId],
  )).rows[0].id;
  await admin.query(
    `INSERT INTO inventory_balances(restaurant_id, branch_id, stock_item_id, quantity_base_units, average_cost_minor_per_base_unit)
     VALUES ($1, $2, $3, 100, 2000)`, // 100 buns @ Rs. 20 each
    [a.restaurantId, a.branchId, bunStock],
  );

  // Realistic kg-imported ingredient: Chicken (bought in kg, base_unit = gram, sell_unit = kg, conv = 1000)
  // Entering 50g in UI must become 50 grams, NOT 50,000 grams!
  const chickenStock = (await admin.query(
    `INSERT INTO stock_items(restaurant_id, name, stock_type, base_unit, sell_unit, base_units_per_sell_unit)
     VALUES ($1, 'Chicken Breast', 'ingredient', 'gram', 'kg', 1000) RETURNING id`,
    [a.restaurantId],
  )).rows[0].id;
  await admin.query(
    `INSERT INTO inventory_balances(restaurant_id, branch_id, stock_item_id, quantity_base_units, average_cost_minor_per_base_unit)
     VALUES ($1, $2, $3, 10000, 100)`, // 10,000g @ Rs. 1.00/g = Rs. 1000/kg
    [a.restaurantId, a.branchId, chickenStock],
  );

  // Realistic piece-imported ingredient: Nuggets (bought in kg, sold/used in pieces, base_unit = gram, sell_unit = number, conv = 20g/pc)
  // Entering 2 pcs in UI must become 40 grams (2 * 20g)
  const nuggetStock = (await admin.query(
    `INSERT INTO stock_items(restaurant_id, name, stock_type, base_unit, sell_unit, base_units_per_sell_unit)
     VALUES ($1, 'Chicken Nuggets', 'ingredient', 'gram', 'number', 20) RETURNING id`,
    [a.restaurantId],
  )).rows[0].id;
  await admin.query(
    `INSERT INTO inventory_balances(restaurant_id, branch_id, stock_item_id, quantity_base_units, average_cost_minor_per_base_unit)
     VALUES ($1, $2, $3, 5000, 50)`, // 5,000g @ Rs. 0.50/g (Rs. 10/nugget)
    [a.restaurantId, a.branchId, nuggetStock],
  );

  // Extra stock item: Cheese Slice (base_unit = gram, sell_unit = g, conv = 1)
  const cheeseStock = (await admin.query(
    `INSERT INTO stock_items(restaurant_id, name, stock_type, base_unit, sell_unit, base_units_per_sell_unit)
     VALUES ($1, 'Cheese Slice', 'ingredient', 'gram', 'g', 1) RETURNING id`,
    [a.restaurantId],
  )).rows[0].id;
  await admin.query(
    `INSERT INTO inventory_balances(restaurant_id, branch_id, stock_item_id, quantity_base_units, average_cost_minor_per_base_unit)
     VALUES ($1, $2, $3, 5000, 50)`, // 5,000g @ Rs. 0.50/g
    [a.restaurantId, a.branchId, cheeseStock],
  );

  // Foreign stock item belonging to restaurant B
  const foreignStock = (await admin.query(
    `INSERT INTO stock_items(restaurant_id, name, stock_type, base_unit, sell_unit, base_units_per_sell_unit)
     VALUES ($1, 'Foreign Bacon', 'ingredient', 'gram', 'g', 1) RETURNING id`,
    [b.restaurantId],
  )).rows[0].id;

  // Menu item: Burger (selling price Rs. 500 = 50,000 minor)
  const burgerItem = (await admin.query(
    `INSERT INTO menu_items(restaurant_id, name, price_minor)
     VALUES ($1, 'Cheeseburger', 50000) RETURNING id`,
    [a.restaurantId],
  )).rows[0].id;
  await admin.query(
    `INSERT INTO menu_item_recipe_items(restaurant_id, menu_item_id, stock_item_id, quantity_base_units)
     VALUES ($1, $2, $3, 1)`,
    [a.restaurantId, burgerItem, bunStock],
  );

  const kitchen = createKitchenService(pool);
  const orders = createOrderService(pool, { kitchenService: kitchen });
  const history = createOrderHistoryService(pool);
  const amendments = createOrderAmendmentService(pool, { kitchenService: kitchen });
  const cancellations = createOrderCancellationService(pool);
  const refunds = createOrderRefundService(pool);

  const getBalance = async (stockId) => {
    const res = await admin.query(
      `SELECT quantity_base_units FROM inventory_balances WHERE restaurant_id = $1 AND stock_item_id = $2`,
      [a.restaurantId, stockId],
    );
    return Number(res.rows[0]?.quantity_base_units ?? 0);
  };

  await t.test("1. Unit conversion: kg-purchased ingredient (50g) does NOT become 50,000g and piece ingredient (2 pcs) converts correctly", async () => {
    const chickenBefore = await getBalance(chickenStock);
    const nuggetBefore = await getBalance(nuggetStock);

    // Order with chicken (50g entered without unit) and nuggets (2 pcs entered without unit)
    const input = {
      idempotencyKey: randomUUID(),
      orderType: "takeaway",
      items: [
        {
          menuItemId: burgerItem,
          quantity: 1,
          extras: [
            { stockItemId: chickenStock, quantity: 50 }, // 50g chicken (base_unit=gram, sell_unit=kg, conv=1000)
            { stockItemId: nuggetStock, quantity: 2 },   // 2 nuggets (base_unit=gram, sell_unit=number, conv=20)
          ],
        },
      ],
      payment: {
        method: "cash",
        amountReceivedMinor: 50000,
        financialAccountId: cash,
      },
    };

    const result = await orders.create({ tenant, userId: a.userId, input });
    assert.equal(result.order.orderStatus, "completed");

    // Chicken stock deducted must be exactly 50g, NOT 50,000g!
    assert.equal(await getBalance(chickenStock), chickenBefore - 50);

    // Nugget stock deducted must be exactly 40g (2 pieces * 20g/piece)
    assert.equal(await getBalance(nuggetStock), nuggetBefore - 40);

    // Check order_item_extras records
    const extrasRows = (await admin.query(
      `SELECT * FROM order_item_extras WHERE restaurant_id = $1 AND order_item_id = (SELECT id FROM order_items WHERE order_id = $2) ORDER BY quantity_base_units DESC`,
      [a.restaurantId, result.order.id],
    )).rows;

    assert.equal(extrasRows.length, 2);
    // Chicken: 50g @ Rs. 1/g = 5,000 minor
    const chickenRow = extrasRows.find(r => r.stock_item_id === chickenStock);
    assert.equal(Number(chickenRow.quantity_base_units), 50);
    assert.equal(Number(chickenRow.cost_minor), 5000);

    // Nuggets: 40g @ Rs. 0.50/g = 2,000 minor
    const nuggetRow = extrasRows.find(r => r.stock_item_id === nuggetStock);
    assert.equal(Number(nuggetRow.quantity_base_units), 40);
    assert.equal(Number(nuggetRow.cost_minor), 2000);

    // Total COGS: bun (2000) + chicken (5000) + nuggets (2000) = 9000 minor
    assert.equal(result.order.costOfGoodsMinor, 9000);

    // Gross profit: 50,000 - 9,000 = 41,000 minor
    const grossProfitMinor = result.order.totalMinor - result.order.costOfGoodsMinor;
    assert.equal(grossProfitMinor, 41000);

    // Order detail history format
    const detail = await history.get({ tenant, orderId: result.order.id });
    const nuggetDetailExtra = detail.items[0].extras.find(e => e.stockItemId === nuggetStock);
    assert.equal(nuggetDetailExtra.unit, "pcs");
    assert.equal(nuggetDetailExtra.quantity, 2);
    assert.equal(nuggetDetailExtra.name, "Chicken Nuggets");

    const chickenDetailExtra = detail.items[0].extras.find(e => e.stockItemId === chickenStock);
    assert.equal(chickenDetailExtra.unit, "g");
    assert.equal(chickenDetailExtra.quantity, 50);
    assert.equal(chickenDetailExtra.name, "Chicken Breast");
  });

  await t.test("2. Unit contract rejects unsupported or incompatible units", async () => {
    // Attempt to pass weight unit 'kg' to a piece-only stock item (Bun)
    await assert.rejects(
      async () => orders.create({
        tenant,
        userId: a.userId,
        input: {
          idempotencyKey: randomUUID(),
          orderType: "takeaway",
          items: [{
            menuItemId: burgerItem,
            quantity: 1,
            extras: [{ stockItemId: bunStock, quantity: 2, unit: "kg" }],
          }],
        },
      }),
      (err) => err.code === "INVALID_EXTRA_UNIT" && err.statusCode === 400,
    );

    // Attempt to pass unsupported unit 'gallons'
    await assert.rejects(
      async () => orders.create({
        tenant,
        userId: a.userId,
        input: {
          idempotencyKey: randomUUID(),
          orderType: "takeaway",
          items: [{
            menuItemId: burgerItem,
            quantity: 1,
            extras: [{ stockItemId: chickenStock, quantity: 50, unit: "gallons" }],
          }],
        },
      }),
      (err) => err.code === "INVALID_EXTRA_UNIT" && err.statusCode === 400,
    );
  });

  await t.test("3. Tenant isolation rejects ordering foreign tenant extras", async () => {
    await assert.rejects(
      async () => orders.create({
        tenant,
        userId: a.userId,
        input: {
          idempotencyKey: randomUUID(),
          orderType: "takeaway",
          items: [{
            menuItemId: burgerItem,
            quantity: 1,
            extras: [{ stockItemId: foreignStock, quantity: 20 }],
          }],
        },
      }),
      (err) => err.code === "EXTRA_UNAVAILABLE" && (err.statusCode === 409 || err.status === 409),
    );
  });

  await t.test("4. KOT unpaid order defers stock deduction until settlement, and retrying is idempotent", async () => {
    const cheeseBefore = await getBalance(cheeseStock);

    const created = await orders.create({
      tenant,
      userId: a.userId,
      input: {
        idempotencyKey: randomUUID(),
        orderType: "dine_in",
        isKot: true,
        items: [{
          menuItemId: burgerItem,
          quantity: 1,
          extras: [{ stockItemId: cheeseStock, quantity: 50 }],
        }],
      },
    });
    assert.equal(created.order.orderStatus, "preparing");
    assert.equal(created.order.paymentStatus, "unpaid");

    // Stock should NOT be deducted on KOT creation
    assert.equal(await getBalance(cheeseStock), cheeseBefore);

    // Kitchen ticket has readable name and unit
    const kt = (await admin.query(`SELECT items FROM kitchen_tickets WHERE id = $1`, [created.kitchenTicket.id])).rows[0];
    const ktItems = typeof kt.items === "string" ? JSON.parse(kt.items) : kt.items;
    assert.equal(ktItems[0].extras[0].name, "Cheese Slice");
    assert.equal(ktItems[0].extras[0].quantity, 50);
    assert.equal(ktItems[0].extras[0].unit, "g");

    // Settle payment
    const paymentKey = randomUUID();
    const settleInput = {
      amountMinor: 50000,
      paymentMethod: "cash",
      financialAccountId: cash,
      idempotencyKey: paymentKey,
    };

    const settled = await orders.settlePayment({
      tenant,
      userId: a.userId,
      orderId: created.order.id,
      input: settleInput,
    });
    assert.equal(settled.order.orderStatus, "completed");

    // Exactly 50g deducted once
    assert.equal(await getBalance(cheeseStock), cheeseBefore - 50);

    // Replay same payment idempotently
    const replay = await orders.settlePayment({
      tenant,
      userId: a.userId,
      orderId: created.order.id,
      input: settleInput,
    });
    assert.equal(replay.replayed, true);
    // No duplicate stock deduction
    assert.equal(await getBalance(cheeseStock), cheeseBefore - 50);
  });

  await t.test("5. Order amendment: existing-line costing, frozen cost preservation, and accurate kitchen delta", async () => {
    // Place unpaid KOT order with 1 burger and 50g cheese
    const created = await orders.create({
      tenant,
      userId: a.userId,
      input: {
        idempotencyKey: randomUUID(),
        orderType: "takeaway",
        isKot: true,
        items: [{
          menuItemId: burgerItem,
          quantity: 1,
          extras: [{ stockItemId: cheeseStock, quantity: 50 }],
        }],
      },
    });
    const orderItemId = (await admin.query(
      `SELECT id FROM order_items WHERE order_id = $1`,
      [created.order.id],
    )).rows[0].id;

    // Initial COGS = bun(2000) + cheese 50g @ Rs.0.50(2500) = 4500 minor
    const orderBefore = (await admin.query(`SELECT cost_of_goods_minor FROM orders WHERE id = $1`, [created.order.id])).rows[0];
    assert.equal(Number(orderBefore.cost_of_goods_minor), 4500);

    // Now change inventory balance average cost of cheese to 100 minor/g (Rs. 1.00/g)
    // Frozen cost for existing cheese must NOT change!
    await admin.query(
      `UPDATE inventory_balances SET average_cost_minor_per_base_unit = 100 WHERE restaurant_id = $1 AND stock_item_id = $2`,
      [a.restaurantId, cheeseStock],
    );

    // 5A: Quantity amendment (1 burger -> 2 burgers).
    // The delta must send 1 burger with 50g cheese (the delta), NOT the full 100g!
    const amendQtyResult = await amendments.amend({
      tenant,
      userId: a.userId,
      orderId: created.order.id,
      input: {
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
        items: [{
          orderItemId,
          quantity: 2,
          extras: [{ stockItemId: cheeseStock, quantity: 50 }], // 50g per burger * 2 = 100g total
        }],
      },
    });

    assert.ok(amendQtyResult.kitchenTicket);
    const deltaKt = (await admin.query(`SELECT items FROM kitchen_tickets WHERE id = $1`, [amendQtyResult.kitchenTicket.id])).rows[0];
    const deltaItems = typeof deltaKt.items === "string" ? JSON.parse(deltaKt.items) : deltaKt.items;
    assert.equal(deltaItems.length, 1);
    assert.equal(deltaItems[0].quantity, 1); // 1 additional burger
    // Kitchen instruction delta for extras sends exactly 50g (1 burger's worth), not the full amended 100g!
    assert.equal(deltaItems[0].extras[0].quantity, 50);
    assert.equal(deltaItems[0].extras[0].name, "Cheese Slice");

    // Existing frozen cost preserved: 50 minor/g * 100g = 5000 minor (NOT 100 minor/g * 100g = 10000 minor)
    const amendedExtras = (await admin.query(
      `SELECT cost_minor, quantity_base_units FROM order_item_extras WHERE order_item_id = $1`,
      [orderItemId],
    )).rows[0];
    assert.equal(Number(amendedExtras.cost_minor), 5000);
    assert.equal(Number(amendedExtras.quantity_base_units), 100);

    // Item unit cost updated: base recipe (2000) + extras per unit (2500) = 4500 minor
    const amendedItem = (await admin.query(
      `SELECT unit_cost_minor FROM order_items WHERE id = $1`,
      [orderItemId],
    )).rows[0];
    assert.equal(Number(amendedItem.unit_cost_minor), 4500);

    // Order COGS updated: 2 * 4500 = 9000 minor
    const amendedOrder = (await admin.query(
      `SELECT cost_of_goods_minor, total_minor FROM orders WHERE id = $1`,
      [created.order.id],
    )).rows[0];
    assert.equal(Number(amendedOrder.cost_of_goods_minor), 9000);
    assert.equal(Number(amendedOrder.total_minor), 100000);

    // Gross profit: 100,000 - 9,000 = 91,000 minor
    assert.equal(Number(amendedOrder.total_minor) - Number(amendedOrder.cost_of_goods_minor), 91000);

    // 5B: Extras-only amendment (quantity stays 2, but adding 50g chicken extra per burger)
    const amendExtrasOnlyResult = await amendments.amend({
      tenant,
      userId: a.userId,
      orderId: created.order.id,
      input: {
        idempotencyKey: randomUUID(),
        expectedVersion: 2,
        items: [{
          orderItemId,
          quantity: 2,
          extras: [
            { stockItemId: cheeseStock, quantity: 50 }, // 100g cheese total
            { stockItemId: chickenStock, quantity: 50 }, // newly added: 100g chicken total
          ],
        }],
      },
    });

    assert.ok(amendExtrasOnlyResult.kitchenTicket);
    const extrasOnlyKt = (await admin.query(`SELECT items FROM kitchen_tickets WHERE id = $1`, [amendExtrasOnlyResult.kitchenTicket.id])).rows[0];
    const extrasOnlyItems = typeof extrasOnlyKt.items === "string" ? JSON.parse(extrasOnlyKt.items) : extrasOnlyKt.items;
    assert.equal(extrasOnlyItems.length, 1);
    assert.equal(extrasOnlyItems[0].notes, "ADD extra Chicken Breast");
    assert.equal(extrasOnlyItems[0].extras[0].name, "Chicken Breast");
    assert.equal(extrasOnlyItems[0].extras[0].quantity, 100);

    // Chicken cost: 100g @ Rs. 1.00/g = 10,000 minor
    // Total order COGS: 9,000 + 10,000 = 19,000 minor
    const orderAfterExtrasOnly = (await admin.query(
      `SELECT cost_of_goods_minor, total_minor FROM orders WHERE id = $1`,
      [created.order.id],
    )).rows[0];
    assert.equal(Number(orderAfterExtrasOnly.cost_of_goods_minor), 19000);

    // Revised gross profit: 100,000 - 19,000 = 81,000 minor
    assert.equal(Number(orderAfterExtrasOnly.total_minor) - Number(orderAfterExtrasOnly.cost_of_goods_minor), 81000);
  });

  await t.test("6. Order cancellation restores extras stock via sale_reversal", async () => {
    const cheeseBefore = await getBalance(cheeseStock);

    const created = await orders.create({
      tenant,
      userId: a.userId,
      input: {
        idempotencyKey: randomUUID(),
        orderType: "takeaway",
        items: [{
          menuItemId: burgerItem,
          quantity: 1,
          extras: [{ stockItemId: cheeseStock, quantity: 50 }],
        }],
        payment: {
          method: "cash",
          amountReceivedMinor: 50000,
          financialAccountId: cash,
        },
      },
    });
    assert.equal(await getBalance(cheeseStock), cheeseBefore - 50);

    await cancellations.cancel({
      tenant,
      userId: a.userId,
      orderId: created.order.id,
      reason: "Customer cancelled",
      idempotencyKey: randomUUID(),
    });

    // Stock should be restored
    assert.equal(await getBalance(cheeseStock), cheeseBefore);

    const reversalMovements = (await admin.query(
      `SELECT * FROM stock_movements WHERE restaurant_id = $1 AND order_id = $2 AND movement_type = 'sale_reversal' AND stock_item_id = $3`,
      [a.restaurantId, created.order.id, cheeseStock],
    )).rows;
    assert.equal(reversalMovements.length, 1);
    assert.equal(Number(reversalMovements[0].quantity_delta), 50);
  });

  await t.test("7. Partial refund with restock: true restores proportional extras stock", async () => {
    const cheeseBefore = await getBalance(cheeseStock);

    const created = await orders.create({
      tenant,
      userId: a.userId,
      input: {
        idempotencyKey: randomUUID(),
        orderType: "takeaway",
        items: [{
          menuItemId: burgerItem,
          quantity: 2,
          extras: [{ stockItemId: cheeseStock, quantity: 50 }], // 100g total
        }],
        payment: {
          method: "cash",
          amountReceivedMinor: 100000,
          financialAccountId: cash,
        },
      },
    });
    assert.equal(await getBalance(cheeseStock), cheeseBefore - 100);

    const orderItemId = (await admin.query(
      `SELECT id FROM order_items WHERE order_id = $1`,
      [created.order.id],
    )).rows[0].id;

    // Refund 1 burger with restock = true
    await refunds.createRefund({
      tenant,
      userId: a.userId,
      orderId: created.order.id,
      input: {
        idempotencyKey: randomUUID(),
        reason: "One burger returned untouched",
        items: [{
          orderItemId,
          quantity: 1,
          restock: true,
        }],
      },
    });

    // Exactly 50g (half of the 100g) restored
    assert.equal(await getBalance(cheeseStock), cheeseBefore - 50);
  });
});
