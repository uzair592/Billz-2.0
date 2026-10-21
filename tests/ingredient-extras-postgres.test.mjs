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

  // Extra stock item: Extra Cheese (tracked in grams, 50g per extra, Rs. 0.50 per gram = 50 minor per gram)
  const cheeseStock = (await admin.query(
    `INSERT INTO stock_items(restaurant_id, name, stock_type, base_unit, sell_unit, base_units_per_sell_unit)
     VALUES ($1, 'Cheese Slice', 'ingredient', 'gram', 'g', 1) RETURNING id`,
    [a.restaurantId],
  )).rows[0].id;
  await admin.query(
    `INSERT INTO inventory_balances(restaurant_id, branch_id, stock_item_id, quantity_base_units, average_cost_minor_per_base_unit)
     VALUES ($1, $2, $3, 5000, 50)`, // 5,000g @ Rs. 0.50/g (cost = Rs. 25 for 50g)
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

  await t.test("1. Direct cash checkout with extras records snapshots, stock deduction, and COGS", async () => {
    const bunBefore = await getBalance(bunStock);
    const cheeseBefore = await getBalance(cheeseStock);

    const input = {
      idempotencyKey: randomUUID(),
      orderType: "takeaway",
      items: [
        {
          menuItemId: burgerItem,
          quantity: 2,
          extras: [
            {
              stockItemId: cheeseStock,
              quantity: 50, // 50g per burger -> 100g total
              unit: "g",
            },
          ],
        },
      ],
      payment: {
        method: "cash",
        amountReceivedMinor: 100000,
        financialAccountId: cash,
      },
    };

    const result = await orders.create({
      tenant,
      userId: a.userId,
      input,
    });

    assert.equal(result.order.orderStatus, "completed");
    assert.equal(result.order.paymentStatus, "paid");
    assert.equal(result.order.totalMinor, 100000); // 2 * 50,000 = Rs. 1000 (extras do not invent extra selling price)

    // Recipe cost = 2 * 2000 = 4000 minor
    // Extras cost = 2 * 50g * 50 minor/g = 5000 minor
    // Total COGS = 9000 minor (Rs. 90)
    assert.equal(result.order.costOfGoodsMinor, 9000);

    // Check inventory deduction
    assert.equal(await getBalance(bunStock), bunBefore - 2);
    assert.equal(await getBalance(cheeseStock), cheeseBefore - 100);

    // Check order_item_extras table
    const extrasRows = (await admin.query(
      `SELECT * FROM order_item_extras WHERE restaurant_id = $1`,
      [a.restaurantId],
    )).rows;
    assert.equal(extrasRows.length, 1);
    assert.equal(extrasRows[0].name_snapshot, "Cheese Slice");
    assert.equal(Number(extrasRows[0].quantity_base_units), 100);
    assert.equal(Number(extrasRows[0].cost_minor), 5000);
    assert.equal(Number(extrasRows[0].price_minor), 0);

    // Check stock movements table
    const movements = (await admin.query(
      `SELECT * FROM stock_movements WHERE restaurant_id = $1 AND stock_item_id = $2`,
      [a.restaurantId, cheeseStock],
    )).rows;
    assert.equal(movements.length, 1);
    assert.equal(movements[0].movement_type, "sale");
    assert.equal(Number(movements[0].quantity_delta), -100);

    // Verify detail retrieval through order-history-service
    const detail = await history.get({ tenant, orderId: result.order.id });
    assert.equal(detail.items[0].extras.length, 1);
    assert.equal(detail.items[0].extras[0].name, "Cheese Slice");
    assert.equal(detail.items[0].extras[0].quantityBaseUnits, 100);
    assert.equal(detail.items[0].extras[0].costMinor, 5000);

    // Verify mapping through mapCloudOrderDetail for invoice rendering
    const legacyDetail = mapCloudOrderDetail(detail);
    assert.equal(legacyDetail.items[0].extras.length, 1);
    assert.equal(legacyDetail.items[0].extras[0].name, "Cheese Slice");
    assert.equal(legacyDetail.items[0].extras[0].qty, 100);
    assert.equal(legacyDetail.costOfGoods, 90);
  });

  await t.test("2. Tenant isolation rejects ordering foreign tenant extras and hides details", async () => {
    const input = {
      idempotencyKey: randomUUID(),
      orderType: "takeaway",
      items: [
        {
          menuItemId: burgerItem,
          quantity: 1,
          extras: [
            {
              stockItemId: foreignStock, // belongs to tenant B
              quantity: 20,
            },
          ],
        },
      ],
    };

    await assert.rejects(
      async () => orders.create({ tenant, userId: a.userId, input }),
      (err) => err.code === "EXTRA_UNAVAILABLE" && (err.statusCode === 409 || err.status === 409),
    );

    // Foreign tenant cannot read tenant A's order details
    const ordersList = (await admin.query(
      `SELECT id FROM orders WHERE restaurant_id = $1 LIMIT 1`,
      [a.restaurantId],
    )).rows;
    if (ordersList.length > 0) {
      await assert.rejects(
        async () => history.get({ tenant: foreignTenant, orderId: ordersList[0].id }),
        (err) => err.code === "ORDER_NOT_FOUND" && (err.statusCode === 404 || err.status === 404),
      );
    }
  });

  await t.test("3. KOT unpaid order defers stock deduction until settlement, and retrying is idempotent", async () => {
    const cheeseBefore = await getBalance(cheeseStock);

    const input = {
      idempotencyKey: randomUUID(),
      orderType: "dine_in",
      isKot: true,
      items: [
        {
          menuItemId: burgerItem,
          quantity: 1,
          extras: [{ stockItemId: cheeseStock, quantity: 50 }],
        },
      ],
    };

    const created = await orders.create({ tenant, userId: a.userId, input });
    assert.equal(created.order.orderStatus, "preparing");
    assert.equal(created.order.paymentStatus, "unpaid");

    // Stock should NOT be deducted on KOT creation
    assert.equal(await getBalance(cheeseStock), cheeseBefore);

    // Kitchen ticket has extras
    const kt = (await admin.query(`SELECT items FROM kitchen_tickets WHERE id = $1`, [created.kitchenTicket.id])).rows[0];
    const ktItems = typeof kt.items === "string" ? JSON.parse(kt.items) : kt.items;
    assert.equal(ktItems[0].extras.length, 1);
    assert.equal(ktItems[0].extras[0].name, "Cheese Slice");

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
    assert.equal(settled.order.paymentStatus, "paid");

    // Stock deduction happened now
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

  await t.test("4. Order amendment updates extras and delta kitchen ticket", async () => {
    const input = {
      idempotencyKey: randomUUID(),
      orderType: "takeaway",
      isKot: true,
      items: [
        {
          menuItemId: burgerItem,
          quantity: 1,
          extras: [{ stockItemId: cheeseStock, quantity: 50 }],
        },
      ],
    };

    const created = await orders.create({ tenant, userId: a.userId, input });
    const orderItemId = (await admin.query(
      `SELECT id FROM order_items WHERE order_id = $1`,
      [created.order.id],
    )).rows[0].id;

    // Amend: change quantity to 2 with updated extras (100g)
    const amendResult = await amendments.amend({
      tenant,
      userId: a.userId,
      orderId: created.order.id,
      input: {
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
        items: [
          {
            orderItemId,
            quantity: 2,
            extras: [{ stockItemId: cheeseStock, quantity: 50 }], // 50g per burger * 2 = 100g
          },
        ],
      },
    });

    // Kitchen delta has addition of 1 item with extras
    assert.ok(amendResult.kitchenTicket);
    const deltaKt = (await admin.query(`SELECT items FROM kitchen_tickets WHERE id = $1`, [amendResult.kitchenTicket.id])).rows[0];
    const deltaItems = typeof deltaKt.items === "string" ? JSON.parse(deltaKt.items) : deltaKt.items;
    assert.equal(deltaItems.length, 1);
    assert.equal(deltaItems[0].quantity, 1);
    assert.equal(deltaItems[0].extras[0].quantity, 100);

    // Check updated order_item_extras
    const extras = (await admin.query(
      `SELECT quantity_base_units FROM order_item_extras WHERE order_item_id = $1`,
      [orderItemId],
    )).rows;
    assert.equal(Number(extras[0].quantity_base_units), 100);
  });

  await t.test("5. Order cancellation restores extras stock via sale_reversal", async () => {
    const cheeseBefore = await getBalance(cheeseStock);

    const input = {
      idempotencyKey: randomUUID(),
      orderType: "takeaway",
      items: [
        {
          menuItemId: burgerItem,
          quantity: 1,
          extras: [{ stockItemId: cheeseStock, quantity: 50 }],
        },
      ],
      payment: {
        method: "cash",
        amountReceivedMinor: 50000,
        financialAccountId: cash,
      },
    };

    const created = await orders.create({ tenant, userId: a.userId, input });
    assert.equal(await getBalance(cheeseStock), cheeseBefore - 50);

    // Cancel order
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

  await t.test("6. Partial refund with restock: true restores proportional extras stock", async () => {
    const cheeseBefore = await getBalance(cheeseStock);

    const input = {
      idempotencyKey: randomUUID(),
      orderType: "takeaway",
      items: [
        {
          menuItemId: burgerItem,
          quantity: 2,
          extras: [{ stockItemId: cheeseStock, quantity: 50 }], // 100g total
        },
      ],
      payment: {
        method: "cash",
        amountReceivedMinor: 100000,
        financialAccountId: cash,
      },
    };

    const created = await orders.create({ tenant, userId: a.userId, input });
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
        items: [
          {
            orderItemId,
            quantity: 1,
            restock: true,
          },
        ],
      },
    });

    // Exactly 50g (half of the 100g) restored
    assert.equal(await getBalance(cheeseStock), cheeseBefore - 50);
  });
});
