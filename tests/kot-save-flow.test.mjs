import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { readLegacyApp, extractInlineScript, extractDeclaration } from "./helpers/legacy-source.mjs";
import { MoneyEngine } from "../src/domain/money-engine.mjs";
import { createLegacyCloudAdapter, CLOUD_CONTEXT_KEY } from "../src/client/legacy-cloud-adapter.mjs";

const source=extractDeclaration(extractInlineScript(await readLegacyApp()),"async function submitKotOrder()", "function runInternalStockAndProfitAudit()");
const restaurantId="11111111-1111-4111-8111-111111111111",menuId="22222222-2222-4222-8222-222222222222",orderId="33333333-3333-4333-8333-333333333333";
function setup({rejectSave=false,rejectFirstPrint=false}={}) {
  const records=new Map(),events=[],requests=[],alerts=[],prints=[],values=new Map([[CLOUD_CONTEXT_KEY,{restaurantId,mappings:{menuItems:{1:menuId},tables:{},financialAccounts:{}}}]]);
  const storage={async get(key){return structuredClone(values.get(key));},async set(key,value){values.set(key,structuredClone(value));}};
  const adapter=createLegacyCloudAdapter({storage,outbox:{async enqueue(){},async flush(){}},session:{async currentUser(){return {user:{id:orderId},restaurantId};}},
    fetchImpl:async(url,init)=>{
      const body=JSON.parse(init.body);requests.push(body);events.push("save");
      if(rejectSave)return {ok:false,status:409,async json(){return {error:"Menu changed",code:"PRICE_CHANGED"};}};
      records.set(body.idempotencyKey,{id:orderId,orderNumber:101});
      return {ok:true,status:records.size===1?201:200,async json(){return {order:records.get(body.idempotencyKey)};}};
    }});
  const nodes=new Map();
  const value={"cust-name":"Guest","cust-phone":"","delivery-rider-input":"","new-order-date-input":"2026-10-21","discount-type-select":"flat","discount-value-input":"10","delivery-charge-input":"0"};
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:value[id]||"",textContent:"",classList:{add(){},remove(){}},append(){}});return nodes.get(id);};
  const context={console:{warn(){},error(){}},structuredClone,JSON,Date,Map,Number,Math,Array,String,
    BILLZ_MANAGED:true,BILLZ_TENANT_ID:restaurantId,BILLZ_ACCESS_BLOCKED:false,orderSubmitSaving:false,
    cart:[{id:1,name:"Burger",price:100,qty:2}],cartAdditionalCharges:[{name:"Tax",type:"percent",value:5,enabled:true}],orders:[],currentOrderType:"Takeaway",
    document:{getElementById:node,createElement(){return {}; }},
    MoneyEngine,calculateOrderStockUsage:()=>({}),missingPieceWeightKeys:()=>[],validateOrderStockUsage:()=>[],
    getLocalDateString:()=>"2026-10-21",normalizeRiderName:value=>value,normalizeCustomerPhone:value=>value,
    renderAdditionalCharges(){},renderCart(){},clearCartDraft(){events.push("clear");},alert:message=>alerts.push(message),
    async populateReceiptSlipAndPrint(order,targets){events.push("print");prints.push({order,targets});if(rejectFirstPrint&&prints.length===1)throw new Error("Printer unavailable");},
  };
  context.window=context;context.BiteTechCloudSync=adapter;
  vm.createContext(context);vm.runInContext(source,context);
  return {context,records,requests,alerts,prints,values,events};
}
test("failed server KOT save preserves the cart and never queues a print",async()=>{
  const {context,requests,prints,alerts}=setup({rejectSave:true});await context.submitKotOrder();
  assert.equal(requests.length,1);assert.equal(requests[0].expectedTotalMinor,19950);
  assert.equal(prints.length,0);assert.equal(context.cart.length,1);assert.match(alerts[0],/not confirmed/);
  assert.equal(context.orderSubmitSaving,false);
});
test("KOT saves actual totals before kitchen-only print and clears only confirmed drafts",async()=>{
  const {context,requests,prints,events,values}=setup();await context.submitKotOrder();
  assert.equal(requests[0].expectedTotalMinor,19950);assert.equal(requests[0].isKot,true);assert.equal(requests[0].payment,undefined);
  assert.equal(prints[0].order.orderNumber,101);assert.equal(prints[0].order.items[0].price,undefined);
  assert.equal(prints[0].targets[0],"kitchen");assert.deepEqual(events,["save","print","clear"]);
  assert.equal(context.cart.length,0);assert.equal(values.get("pos_checkout_attempt"),null);
});
test("print failure retries the same saved KOT without creating a second order",async()=>{
  const {context,requests,records,values}=setup({rejectFirstPrint:true});
  await context.submitKotOrder();assert.equal(context.cart.length,1);assert.ok(values.get("pos_checkout_attempt"));
  await context.submitKotOrder();assert.equal(context.cart.length,0);assert.equal(records.size,1);
  assert.equal(requests.length,2);assert.equal(requests[0].idempotencyKey,requests[1].idempotencyKey);
});
