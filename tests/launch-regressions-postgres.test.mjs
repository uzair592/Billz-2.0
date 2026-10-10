import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { provisionIntegrationDatabase, createAppPool, createControlPool, connectAdmin, seedRestaurant, seedPlan } from "./helpers/postgres.mjs";
import { createOrderService } from "../src/server/pos/order-service.mjs";
import { createOrderRefundService } from "../src/server/pos/order-refund-service.mjs";
import { createOrderCancellationService } from "../src/server/pos/order-cancellation-service.mjs";
import { createStorageService } from "../src/server/storage/storage-service.mjs";
import { createPlatformAdminPortalService } from "../src/server/subscriptions/platform-admin-portal-service.mjs";
import { createPlatformAdminService } from "../src/server/auth/platform-admin-service.mjs";
import { createPlatformAdminRepository } from "../src/server/auth/platform-admin-repository.mjs";

// This suite intentionally requires real PostgreSQL; an unavailable database fails.
test("launch fixes against non-superuser tenant and control roles", async t => {
  await provisionIntegrationDatabase();
  const admin=await connectAdmin();const app=await createAppPool();const control=await createControlPool();
  t.after(async()=>{await app.end();await control.end();await admin.end()});
  const a=await seedRestaurant(admin,{slug:"regression-a"});
  const b=await seedRestaurant(admin,{slug:"regression-b"});
  const tenant={restaurant:{id:a.restaurantId,timezone:"Asia/Karachi"},membership:{defaultBranchId:a.branchId}};
  await t.test("no-context tenant reads and writes fail closed",async()=>{
    assert.equal((await app.query("SELECT * FROM restaurants")).rows.length,0);
    assert.equal((await app.query("SELECT * FROM restaurant_memberships")).rows.length,0);
    assert.equal((await app.query("UPDATE restaurants SET name = 'forbidden' RETURNING id")).rows.length,0);
    const client=await app.connect();
    try {
      await client.query("BEGIN");await client.query("SELECT set_config('app.restaurant_id',$1,true)",[a.restaurantId]);
      assert.deepEqual((await client.query("SELECT id FROM restaurants")).rows.map(r=>r.id),[a.restaurantId]);
      assert.equal((await client.query("UPDATE restaurants SET name='forbidden' WHERE id=$1 RETURNING id",[b.restaurantId])).rows.length,0);
      await client.query("ROLLBACK");
    } finally {client.release()}
  });
  await t.test("asset contents survive service recreation and quota deletion is atomic",async()=>{
    const content=Buffer.from("durable private asset\n");
    const first=createStorageService({pool:app});
    const stored=await first.reserveAndStoreAsset({restaurantId:a.restaurantId,fileName:"note.txt",mimeType:"text/plain",buffer:content});
    const restarted=createStorageService({pool:app});
    const read=await restarted.readAsset({restaurantId:a.restaurantId,assetId:stored.assetId});
    assert.deepEqual(read.buffer,content);assert.equal(read.sha256,stored.sha256);
    await assert.rejects(restarted.readAsset({restaurantId:b.restaurantId,assetId:stored.assetId}),e=>e.code==="ASSET_NOT_FOUND");
    assert.equal((await restarted.getStorageUsage(a.restaurantId)).usedStorageBytes,content.length);
    await restarted.deleteAsset({restaurantId:a.restaurantId,assetId:stored.assetId});
    await restarted.deleteAsset({restaurantId:a.restaurantId,assetId:stored.assetId});
    assert.equal((await restarted.getStorageUsage(a.restaurantId)).usedStorageBytes,0);
  });
  await t.test("real checkout freezes costs, partial refund and cancellation restore only consumed stock",async()=>{
    const product=(await admin.query(`INSERT INTO menu_items(restaurant_id,name,price_minor) VALUES($1,'Burger',10000) RETURNING id`,[a.restaurantId])).rows[0].id;
    const ingredient=(await admin.query(`INSERT INTO inventory_items(restaurant_id,name,base_unit,current_quantity,average_cost_minor,idempotency_key)
      VALUES($1,'Dough','gram',1000,2,$2) RETURNING id`,[a.restaurantId,randomUUID()])).rows[0].id;
    await admin.query(`INSERT INTO product_recipes(restaurant_id,product_id,inventory_item_id,quantity_required) VALUES($1,$2,$3,200)`,[a.restaurantId,product,ingredient]);
    await admin.query(`INSERT INTO financial_accounts(restaurant_id,branch_id,account_type,display_name) VALUES($1,$2,'cash','Cash')`,[a.restaurantId,a.branchId]);
    const orders=createOrderService(app);
    const input={idempotencyKey:randomUUID(),orderType:"takeaway",expectedTotalMinor:20000,items:[{menuItemId:product,quantity:2}],payment:{method:"cash",amountReceivedMinor:20000}};
    const sale=await orders.create({tenant,userId:a.userId,input});
    const stock=async()=>Number((await admin.query("SELECT current_quantity FROM inventory_items WHERE id=$1",[ingredient])).rows[0].current_quantity);
    assert.equal(await stock(),600);
    const row=(await admin.query("SELECT * FROM order_items WHERE order_id=$1",[sale.order.id])).rows[0];
    assert.equal(Number(row.unit_cost_minor),400);
    assert.equal(row.recipe_snapshot.inventoryItems[0].quantityPerUnit,200);
    // A recipe and cost change after sale must not affect compensation.
    await admin.query("UPDATE product_recipes SET quantity_required=999 WHERE product_id=$1",[product]);
    await admin.query("UPDATE inventory_items SET average_cost_minor=99 WHERE id=$1",[ingredient]);
    const refunds=createOrderRefundService(app);
    const refundInput={idempotencyKey:randomUUID(),reason:"Returned one",items:[{orderItemId:row.id,quantity:1,restock:true}]};
    await refunds.createRefund({tenant,userId:a.userId,orderId:sale.order.id,input:refundInput});
    assert.equal(await stock(),800);
    await refunds.createRefund({tenant,userId:a.userId,orderId:sale.order.id,input:refundInput});
    assert.equal(await stock(),800);
    const cancellation=createOrderCancellationService(app);
    const request={tenant,userId:a.userId,orderId:sale.order.id,reason:"Cancel remainder",idempotencyKey:randomUUID()};
    const cancelled=await cancellation.cancel(request);
    assert.equal(await stock(),1000);assert.equal(cancelled.cancellation.refundedMinor,10000);
    await cancellation.cancel(request);assert.equal(await stock(),1000);
  });
  await t.test("changed prices reject before creating a payment or receipt",async()=>{
    const product=(await admin.query(`INSERT INTO menu_items(restaurant_id,name,price_minor) VALUES($1,'Price probe',12000) RETURNING id`,[a.restaurantId])).rows[0].id;
    const key=randomUUID();
    await assert.rejects(createOrderService(app).create({tenant,userId:a.userId,input:{idempotencyKey:key,orderType:"takeaway",expectedTotalMinor:10000,items:[{menuItemId:product,quantity:1}],payment:{method:"cash",amountReceivedMinor:10000}}}),e=>e.code==="PRICE_CHANGED");
    assert.equal((await admin.query("SELECT id FROM orders WHERE idempotency_key=$1",[key])).rows.length,0);
  });
  await t.test("concurrent approvals extend the current subscription and cannot reject approved payment",async()=>{
    await seedPlan(control,{code:"GROWTH",provider:"manual"});
    const pepper="regression-control-pepper-long";
    const service=createPlatformAdminService({repository:createPlatformAdminRepository(control),passwordPepper:pepper});
    const administrator=(await service.bootstrapAdmin({username:"adminprobe",password:"RegressionPassword123!"})).admin;
    const portal=createPlatformAdminPortalService({pool:control,passwordPepper:pepper});
    const start=new Date(Date.now()+3600000);const end=new Date(start.getTime()+86400000);
    const pay=reference=>portal.recordManualPayment({adminId:administrator.id,restaurantId:a.restaurantId,planCode:"GROWTH",amountMinor:25000,paymentDate:new Date(),coveredFrom:start,coveredUntil:end,externalReference:reference});
    const [first,second]=await Promise.all([pay("unique-a"),pay("unique-b")]);
    await Promise.all([portal.approveManualPayment({adminId:administrator.id,paymentId:first.paymentId}),portal.approveManualPayment({adminId:administrator.id,paymentId:second.paymentId})]);
    const subscription=(await control.query("SELECT current_period_end FROM subscriptions WHERE restaurant_id=$1 AND status='active'",[a.restaurantId])).rows[0];
    assert.equal(new Date(subscription.current_period_end).getTime(),start.getTime()+2*86400000);
    await assert.rejects(portal.rejectManualPayment({adminId:administrator.id,paymentId:first.paymentId}),e=>e.code==="PAYMENT_ALREADY_APPROVED");
    await assert.rejects(pay("unique-a"),e=>e.code==="23505");
  });
});
