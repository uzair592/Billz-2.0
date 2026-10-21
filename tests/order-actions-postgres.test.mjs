import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { provisionIntegrationDatabase, createAppPool, connectAdmin, seedRestaurant } from "./helpers/postgres.mjs";
import { createOrderService } from "../src/server/pos/order-service.mjs";
import { createOrderAmendmentService } from "../src/server/pos/order-amendment-service.mjs";
import { createOrderHistoryService } from "../src/server/pos/order-history-service.mjs";
import { createOrderCancellationService } from "../src/server/pos/order-cancellation-service.mjs";
import { createKitchenService } from "../src/server/pos/kitchen-service.mjs";

// Required real PostgreSQL tests: tenant RLS, locks and ledgers cannot be mocked here.
test("KOT order lifecycle remains consistent across devices", async t => {
  await provisionIntegrationDatabase();
  const admin = await connectAdmin(), pool = await createAppPool();
  t.after(async () => { await pool.end(); await admin.end(); });
  const a = await seedRestaurant(admin), b = await seedRestaurant(admin);
  const tenant = { restaurant:{id:a.restaurantId,timezone:"Asia/Karachi"},membership:{userId:a.userId,defaultBranchId:a.branchId,role:"owner"} };
  const foreign = { restaurant:{id:b.restaurantId,timezone:"Asia/Karachi"},membership:{userId:b.userId,defaultBranchId:b.branchId,role:"owner"} };
  const cash = (await admin.query(`INSERT INTO financial_accounts(restaurant_id,branch_id,account_type,display_name)
    VALUES($1,$2,'cash','Counter') RETURNING id`,[a.restaurantId,a.branchId])).rows[0].id;
  const bank = (await admin.query(`INSERT INTO financial_accounts(restaurant_id,branch_id,account_type,display_name)
    VALUES($1,$2,'bank','Restaurant bank') RETURNING id`,[a.restaurantId,a.branchId])).rows[0].id;
  const legacyStock = (await admin.query(`INSERT INTO stock_items(restaurant_id,name,stock_type,base_unit)
    VALUES($1,'Dough','ingredient','gram') RETURNING id`,[a.restaurantId])).rows[0].id;
  await admin.query(`INSERT INTO inventory_balances(restaurant_id,branch_id,stock_item_id,quantity_base_units,average_cost_minor_per_base_unit)
    VALUES($1,$2,$3,1000,10)`,[a.restaurantId,a.branchId,legacyStock]);
  const migratedStock = (await admin.query(`INSERT INTO inventory_items(restaurant_id,name,base_unit,current_quantity,average_cost_minor,idempotency_key)
    VALUES($1,'Cheese','gram',1000,5,$2) RETURNING id`,[a.restaurantId,randomUUID()])).rows[0].id;
  const [legacyItem,migratedItem] = (await admin.query(`INSERT INTO menu_items(restaurant_id,name,price_minor)
    VALUES($1,'Pizza',10000),($1,'Cheese topping',2000) RETURNING id`,[a.restaurantId])).rows.map(row=>row.id);
  await admin.query(`INSERT INTO menu_item_recipe_items(restaurant_id,menu_item_id,stock_item_id,quantity_base_units) VALUES($1,$2,$3,100)`,[a.restaurantId,legacyItem,legacyStock]);
  await admin.query(`INSERT INTO product_recipes(restaurant_id,product_id,inventory_item_id,quantity_required) VALUES($1,$2,$3,20)`,[a.restaurantId,migratedItem,migratedStock]);
  const kitchen = createKitchenService(pool), orders = createOrderService(pool,{kitchenService:kitchen});
  const amendments = createOrderAmendmentService(pool,{kitchenService:kitchen}), history = createOrderHistoryService(pool), cancellations = createOrderCancellationService(pool);
  const context = {tenant,userId:a.userId};
  const create = (items=[{menuItemId:legacyItem,quantity:1},{menuItemId:migratedItem,quantity:1}]) => orders.create({...context,input:{idempotencyKey:randomUUID(),orderType:"takeaway",isKot:true,items}});
  const details = id => history.get({tenant,orderId:id});
  const balances = async () => [(await admin.query(`SELECT quantity_base_units FROM inventory_balances WHERE restaurant_id=$1 AND stock_item_id=$2`,[a.restaurantId,legacyStock])).rows[0].quantity_base_units,
    (await admin.query(`SELECT current_quantity FROM inventory_items WHERE id=$1`,[migratedStock])).rows[0].current_quantity].map(Number);
  const pay = (id,amountMinor,options={}) => orders.settlePayment({...context,orderId:id,input:{amountMinor,paymentMethod:"cash",financialAccountId:cash,idempotencyKey:randomUUID(),...options}});
  await t.test("served KOT takes partial then bank payment and consumes both stock systems once",async()=>{
    const before = await balances(), sale = await create(), id = sale.order.id;
    assert.deepEqual(await balances(),before);
    for (const status of ["preparing","ready","served"]) await kitchen.updateStatus({restaurantId:a.restaurantId,userId:a.userId,ticketId:sale.kitchenTicket.id,status});
    assert.equal((await details(id)).actions.canPay,true);
    await pay(id,2000);
    assert.deepEqual(await balances(),before);
    const listed = await history.list({tenant});
    assert.equal(listed.orders.find(row=>row.id===id).receivedMinor,2000);
    const input = {amountMinor:10000,paymentMethod:"bank_account",financialAccountId:bank,idempotencyKey:randomUUID()};
    const settled = await orders.settlePayment({...context,orderId:id,input});
    assert.equal(settled.order.orderStatus,"completed"); assert.equal(settled.order.paymentStatus,"paid");
    assert.deepEqual(await balances(),[before[0]-100,before[1]-20]);
    const replay = await orders.settlePayment({...context,orderId:id,input}); assert.equal(replay.replayed,true);
    assert.deepEqual(await balances(),[before[0]-100,before[1]-20]);
    assert.equal((await admin.query(`SELECT sum(amount_minor)::int AS paid FROM order_payments WHERE order_id=$1`,[id])).rows[0].paid,12000);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM order_edit_events WHERE order_id=$1 AND event_type='payment'`,[id])).rows[0].count,2);
    await cancellations.cancel({...context,orderId:id,reason:"Customer returned the bill",idempotencyKey:randomUUID()});
    assert.deepEqual(await balances(),before);
    assert.equal((await admin.query(`SELECT sum(CASE WHEN l.entry_type='credit' THEN l.amount_minor ELSE -l.amount_minor END)::int AS net
      FROM ledger_entries l JOIN order_payments p ON p.id=l.order_payment_id WHERE p.order_id=$1`,[id])).rows[0].net,0);
    const accounts = await orders.paymentAccounts(context);
    assert.equal(accounts.accounts.some(row=>row.id===bank),true); assert.equal(accounts.accounts.some(row=>"balanceMinor" in row),false);
  });
  await t.test("two tills cannot charge the same balance twice; retry keys bind to their order and payload",async()=>{
    const sale = await create([{menuItemId:legacyItem,quantity:1}]), id = sale.order.id, key=randomUUID();
    const attempts=await Promise.allSettled([pay(id,10000,{idempotencyKey:key}),pay(id,10000)]);
    assert.equal(attempts.filter(row=>row.status==="fulfilled").length,1);
    assert.equal(attempts.find(row=>row.status==="rejected").reason.code,"ORDER_ALREADY_PAID");
    const paid=(await details(id)).payments;assert.equal(paid.length,1);
    const other=await create();
    const actualKey=(await admin.query(`SELECT idempotency_key FROM order_payments WHERE order_id=$1`,[id])).rows[0].idempotency_key;
    await assert.rejects(pay(other.order.id,10000,{idempotencyKey:actualKey}),error=>error.code==="IDEMPOTENCY_CONFLICT");
    await assert.rejects(pay(id,9999,{idempotencyKey:actualKey}),error=>error.code==="IDEMPOTENCY_CONFLICT");
    await assert.rejects(orders.settlePayment({tenant:foreign,userId:b.userId,orderId:id,input:{amountMinor:1,paymentMethod:"cash",idempotencyKey:randomUUID()}}),error=>error.code==="ORDER_NOT_FOUND");
  });
  await t.test("edits preserve snapshot prices, quantities and audit history; repeated or stale edits do not duplicate kitchen changes",async()=>{
    const sale=await create(), id=sale.order.id, before=await balances(), original=await details(id);
    await admin.query(`UPDATE menu_items SET price_minor=99999 WHERE id=$1`,[legacyItem]);
    await admin.query(`UPDATE menu_item_recipe_items SET quantity_base_units=900 WHERE menu_item_id=$1`,[legacyItem]);
    const pizza=original.items.find(row=>row.menuItemId===legacyItem);
    const input={idempotencyKey:randomUUID(),expectedVersion:original.order.version,customerName:"Family table",customerPhone:"03015929230",
      items:[{orderItemId:pizza.id,quantity:2}],discount:{type:"percent",value:10},deliveryMinor:0};
    await amendments.amend({...context,orderId:id,input});
    const updated=await details(id);assert.equal(updated.order.totalMinor,18000);assert.equal(updated.items[0].unitPriceMinor,10000);
    assert.equal(updated.items[0].recipe.items[0].quantityBaseUnits,100);assert.equal(updated.order.customerName,"Family table");
    assert.deepEqual(await balances(),before);
    const tickets=(await admin.query(`SELECT items FROM kitchen_tickets WHERE order_id=$1 ORDER BY ticket_number`,[id])).rows;
    assert.equal(tickets.length,2); assert.deepEqual(tickets[1].items.map(row=>row.adjustment).sort(),["add","remove"]);
    assert.equal((await amendments.amend({...context,orderId:id,input})).replayed,true);
    assert.equal((await admin.query(`SELECT id FROM kitchen_tickets WHERE order_id=$1`,[id])).rowCount,2);
    await assert.rejects(amendments.amend({...context,orderId:id,input:{...input,idempotencyKey:randomUUID()}}),error=>error.code==="ORDER_VERSION_CONFLICT");
    await assert.rejects(amendments.amend({...context,orderId:id,input:{...input,customerName:"Changed retry"}}),error=>error.code==="IDEMPOTENCY_CONFLICT");
    await pay(id,18000); assert.deepEqual(await balances(),[before[0]-200,before[1]]);
    await assert.rejects(amendments.amend({...context,orderId:id,input:{...input,idempotencyKey:randomUUID(),expectedVersion:(await details(id)).order.version}}),error=>error.code==="ORDER_NOT_EDITABLE");
  });
  await t.test("new lines use server prices, belong to this tenant and cannot overwrite another till",async()=>{
    const sale=await create([{menuItemId:migratedItem,quantity:1}]), id=sale.order.id, original=await details(id);
    const input={idempotencyKey:randomUUID(),expectedVersion:original.order.version,items:[{orderItemId:original.items[0].id,quantity:1},{menuItemId:legacyItem,quantity:1}]};
    await amendments.amend({...context,orderId:id,input});
    assert.equal((await details(id)).order.totalMinor,101999);
    await assert.rejects(amendments.amend({tenant:foreign,userId:b.userId,orderId:id,input:{...input,idempotencyKey:randomUUID()}}),error=>error.code==="ORDER_NOT_FOUND");
    const inaccessible=(await admin.query(`INSERT INTO menu_items(restaurant_id,name,price_minor) VALUES($1,'Foreign item',100) RETURNING id`,[b.restaurantId])).rows[0].id;
    await assert.rejects(amendments.amend({...context,orderId:id,input:{idempotencyKey:randomUUID(),expectedVersion:(await details(id)).order.version,items:[{menuItemId:inaccessible,quantity:1}]}}),error=>error.code==="MENU_CHANGED");
    assert.equal((await details(id)).items.length,2);
  });
  await t.test("cancelling an unpaid KOT never adds stock and clears its active kitchen queue",async()=>{
    const before=await balances(), sale=await create(), id=sale.order.id;
    const table=(await admin.query(`INSERT INTO restaurant_tables(restaurant_id,branch_id,table_number)
      VALUES($1,$2,'Family 4') RETURNING id`,[a.restaurantId,a.branchId])).rows[0].id;
    await admin.query(`UPDATE orders SET table_id=$2 WHERE id=$1`,[id,table]);
    const visible=await kitchen.listTickets({restaurantId:a.restaurantId,userId:a.userId,branchId:a.branchId});
    assert.equal(visible.tickets.find(row=>row.orderId===id).tableName,"Family 4");
    assert.equal((await kitchen.listTickets({restaurantId:b.restaurantId,userId:b.userId,branchId:b.branchId})).tickets.length,0);
    const input={...context,orderId:id,reason:"",idempotencyKey:randomUUID()};
    const result=await cancellations.cancel(input); assert.equal(result.cancellation.refundedMinor,0);
    assert.deepEqual(await balances(),before);
    assert.equal((await kitchen.listTickets({restaurantId:a.restaurantId,userId:a.userId,branchId:a.branchId})).tickets.some(row=>row.orderId===id),false);
    assert.equal((await cancellations.cancel(input)).replayed,true);
    assert.equal((await details(id)).order.orderStatus,"cancelled");
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM order_edit_events WHERE order_id=$1 AND event_type='cancelled'`,[id])).rows[0].count,1);
  });
});
