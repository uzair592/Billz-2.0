import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { buildHttpApp } from "../src/server/http/app.mjs";
import { paymentMinor, remainingPayment } from "../src/client/order-actions-ui.mjs";

const restaurantId="11111111-1111-4111-8111-111111111111", userId="22222222-2222-4222-8222-222222222222", orderId="33333333-3333-4333-8333-333333333333";
const apps=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
async function setup(role="owner",status="active") {
  const calls=[];
  const app=await buildHttpApp({serveClient:false,trustedOrigin:"https://pos.example.com",secureCookies:true,
    authService:{async authenticate(token){return token?{user:{id:userId}}:null;}},
    tenantContextService:{async load(){return {restaurant:{id:restaurantId,status:"active"},membership:{userId,role,status:"active",defaultBranchId:orderId},subscription:{status,currentPeriodEnd:"2999-01-01T00:00:00Z"}};}},
    orderService:{async paymentAccounts(input){calls.push(input);return {accounts:[{id:orderId,accountType:"bank",displayName:"Bank"}]};},
      async settlePayment(input){calls.push(input);return {replayed:false};}},
    orderAmendmentService:{async amend(input){calls.push(input);return {replayed:false};}},
  });apps.push(app);
  return {app,calls,headers:{cookie:`pos_session=${"s".repeat(43)}`,"x-restaurant-id":restaurantId,origin:"https://pos.example.com"}};
}
const edit={idempotencyKey:orderId,expectedVersion:1,items:[{orderItemId:orderId,quantity:2}]};
test("cashiers can select payment accounts without access to finance balances",async()=>{
  const {app,calls,headers}=await setup("cashier");
  const result=await app.inject({method:"GET",url:"/api/pos/payment-accounts",headers});
  assert.equal(result.statusCode,200);assert.equal(result.json().accounts[0].displayName,"Bank");
  assert.equal(result.json().accounts[0].balanceMinor,undefined);assert.equal(calls[0].tenant.restaurant.id,restaurantId);
});
test("waiters can edit unpaid bills but cannot take payment; cashiers cannot bypass edit permissions",async()=>{
  const waiter=await setup("waiter"),cashier=await setup("cashier");
  assert.equal((await waiter.app.inject({method:"PATCH",url:`/api/pos/orders/${orderId}`,headers:waiter.headers,payload:edit})).statusCode,200);
  assert.equal((await waiter.app.inject({method:"GET",url:"/api/pos/payment-accounts",headers:waiter.headers})).statusCode,403);
  assert.equal((await cashier.app.inject({method:"PATCH",url:`/api/pos/orders/${orderId}`,headers:cashier.headers,payload:edit})).statusCode,403);
});
test("amendments require a version, valid lines and active authenticated subscription",async()=>{
  const {app,calls,headers}=await setup();
  for(const payload of [{...edit,expectedVersion:0},{...edit,items:[]},{...edit,items:[{quantity:1}]},{...edit,items:[{orderItemId:orderId,menuItemId:orderId,quantity:1}]},{...edit,payment:{amountMinor:100}}]) {
    assert.equal((await app.inject({method:"PATCH",url:`/api/pos/orders/${orderId}`,headers,payload})).statusCode,400);
  }
  assert.equal(calls.length,0);
  assert.equal((await app.inject({method:"PATCH",url:`/api/pos/orders/${orderId}`,payload:edit})).statusCode,401);
  const expired=await setup("owner","expired");
  assert.equal((await expired.app.inject({method:"PATCH",url:`/api/pos/orders/${orderId}`,headers:expired.headers,payload:edit})).statusCode,402);
});
test("payment inputs use exact minor units and partial payments leave only the outstanding balance",()=>{
  assert.equal(paymentMinor("12.50"),1250);
  for(const value of ["", "-1", "0", "1e3", "12.555", "Infinity"])assert.throws(()=>paymentMinor(value));
  assert.equal(remainingPayment({order:{totalMinor:10000},payments:[{status:"captured",amountMinor:2500},{status:"refunded",amountMinor:1000}]}),7500);
});
