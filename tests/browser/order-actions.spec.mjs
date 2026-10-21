import { test, expect } from "@playwright/test";
const restaurantId="11111111-1111-4111-8111-111111111111",orderId="22222222-2222-4222-8222-222222222222",itemId="33333333-3333-4333-8333-333333333333",lineId="44444444-4444-4444-8444-444444444444",bankId="55555555-5555-4555-8555-555555555555";
async function setup(page,{dropPayment=false,staleEdit=false}={}) {
  const state={order:{id:orderId,orderNumber:17,version:3,orderType:"takeaway",orderStatus:"served",paymentStatus:"unpaid",customerName:"Table 7",businessDate:"2026-10-21",orderedAt:"2026-10-21T12:00:00Z",subtotalMinor:20000,discountMinor:0,discountType:"flat",discountValue:0,deliveryMinor:0,totalMinor:20000,costOfGoodsMinor:4000},
    items:[{id:lineId,menuItemId:itemId,name:"Burger",quantity:2,unitPriceMinor:10000,unitCostMinor:2000,recipe:{}}],payments:[],charges:[],events:[],cancellation:null};
  const writes=[],saved=new Map();let dropped=false;
  function detail(){return {...state,actions:{canPay:state.order.paymentStatus!=="paid"&&state.order.orderStatus!=="cancelled",canEdit:state.order.paymentStatus==="unpaid"&&state.order.orderStatus!=="cancelled",canCancel:state.order.orderStatus!=="cancelled"}};}
  await page.addInitScript(()=>sessionStorage.setItem("biteTechUnlocked","true"));
  await page.route("**/api/**",async route=>{
    const url=new URL(route.request().url()),path=url.pathname,method=route.request().method();
    if(path===`/api/pos/orders/${orderId}`&&method==="GET")return route.fulfill({json:detail()});
    if(path==="/api/pos/orders")return route.fulfill({json:{orders:[{...state.order,receivedMinor:state.payments.reduce((sum,row)=>sum+row.amountMinor,0)}],summary:{orderCount:1,salesMinor:state.order.totalMinor,paidMinor:0,dueMinor:0},nextCursor:null}});
    if(path==="/api/pos/payment-accounts")return route.fulfill({json:{accounts:[{id:bankId,displayName:"Restaurant bank",accountType:"bank"}]}});
    if(path==="/api/pos/menu")return route.fulfill({json:{items:[{id:itemId,name:"Burger",priceMinor:10000}]}});
    if(path===`/api/pos/orders/${orderId}/payments`&&method==="POST") {
      const payload=route.request().postDataJSON();writes.push({path,payload});
      if(!saved.has(payload.idempotencyKey)) {
        state.payments.push({id:crypto.randomUUID(),status:"captured",amountMinor:payload.amountMinor,method:payload.paymentMethod});
        const paid=state.payments.reduce((sum,row)=>sum+row.amountMinor,0);
        state.order.paymentStatus=paid>=state.order.totalMinor?"paid":"partially_paid";
        if(state.order.paymentStatus==="paid")state.order.orderStatus="completed";
        state.order.version++;saved.set(payload.idempotencyKey,true);
        if(dropPayment&&!dropped){dropped=true;return route.abort();}
      }
      return route.fulfill({json:{replayed:true,order:state.order}});
    }
    if(path===`/api/pos/orders/${orderId}`&&method==="PATCH") {
      const payload=route.request().postDataJSON();writes.push({path,payload});
      if(staleEdit)return route.fulfill({status:409,json:{code:"ORDER_VERSION_CONFLICT",error:"changed"}});
      state.order.customerName=payload.customerName;state.order.version++;
      state.items=payload.items.map((row,index)=>({id:row.orderItemId||`${index}`,menuItemId:itemId,name:"Burger",quantity:row.quantity,unitPriceMinor:10000}));
      state.order.totalMinor=state.items.reduce((sum,row)=>sum+row.quantity*10000,0);return route.fulfill({json:{replayed:false,order:state.order}});
    }
    if(path===`/api/pos/orders/${orderId}/cancel`&&method==="POST"){
      const payload=route.request().postDataJSON();writes.push({path,payload});state.order.orderStatus="cancelled";
      return route.fulfill({json:{replayed:false}});
    }
    return route.fulfill({json:{plans:[],subscription:null,tickets:[],accounts:[],user:{id:lineId},restaurants:[{restaurantId}]}});
  });
  await page.goto("/");await page.waitForFunction(()=>window.BillzOrderActions&&typeof bootFinished!=="undefined"&&bootFinished);
  await page.evaluate(async({restaurantId})=>Storage.setMany({pos_setup_done:true,pos_pin_code:"8429",pos_business_name:"KOT Cafe",pos_business_name_provided:true,
    pos_cloud_context_v1:{restaurantId,mappings:{menuItems:{1:"33333333-3333-4333-8333-333333333333"},tables:{},financialAccounts:{}}},
    pos_cloud_session_v1:{user:{id:"staff"},restaurantId}}),{restaurantId});
  await page.reload();await expect(page.locator(".app-container")).toBeVisible();
  await page.evaluate(()=>switchScreen("view-orders"));
  await expect(page.locator("#history-orders-rows")).toContainText("Table 7");
  await page.locator("#history-orders-rows tr").first().click();
  await expect(page.locator('[data-order-action="payment"]')).toBeVisible();
  return {state,writes};
}
for(const width of [1366,390])test(`served KOT takes payment and edits are usable at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:768});const {state,writes}=await setup(page);
  const before=await page.evaluate(()=>JSON.stringify(orders));
  await page.locator('[data-order-action="edit"]').click();
  await page.getByLabel("Quantity for Burger").fill("3");
  await page.getByLabel("Customer name",{exact:true}).fill('<img src=x onerror="window.__xss=1">');
  await page.getByRole("button",{name:"Save Changes",exact:true}).click();
  await expect(page.locator(".order-action-overlay")).toHaveCount(0);
  expect(state.order.totalMinor).toBe(30000);expect(state.payments).toHaveLength(0);
  await expect(page.locator("#invoice-modal-content img")).toHaveCount(0);
  await page.locator('[data-order-action="payment"]').click();
  await page.getByRole("dialog").getByLabel("Payment method",{exact:true}).selectOption("bank_account");
  await page.getByLabel("Amount received (Rs.)",{exact:true}).fill("50");
  await page.getByRole("button",{name:"Record Payment",exact:true}).click();
  await expect(page.locator(".order-action-overlay")).toHaveCount(0);
  await expect(page.locator("#history-orders-rows")).toContainText("Rs. 250");
  expect(writes.at(-1).payload).toMatchObject({amountMinor:5000,paymentMethod:"bank_account",financialAccountId:bankId});
  await page.locator('[data-order-action="payment"]').click();
  await expect(page.getByLabel("Amount received (Rs.)",{exact:true})).toHaveValue("250.00");
  await page.getByRole("button",{name:"Record Payment",exact:true}).click();
  await expect(page.locator('[data-order-action="payment"]')).toHaveCount(0);
  expect(state.order.paymentStatus).toBe("paid");expect(state.payments).toHaveLength(2);
  expect(await page.evaluate(()=>JSON.stringify(orders))).toBe(before);
  expect(await page.evaluate(()=>window.__xss)).toBeUndefined();
});
test("lost payment response survives reload and retries the same charge once",async({page})=>{
  const {state,writes}=await setup(page,{dropPayment:true});
  await page.locator('[data-order-action="payment"]').click();await page.getByRole("button",{name:"Record Payment",exact:true}).click();
  await expect(page.locator(".order-action-dialog [data-message]")).toContainText("may already be saved");
  expect(state.payments).toHaveLength(1);
  await page.reload();await page.evaluate(()=>switchScreen("view-orders"));await page.locator("#history-orders-rows tr").first().click();
  await page.getByRole("button",{name:"Check previous payment",exact:true}).click();
  await page.getByRole("button",{name:"Retry safely",exact:true}).click();
  await expect(page.locator(".order-action-overlay")).toHaveCount(0);
  expect(state.payments).toHaveLength(1);expect(writes[0].payload.idempotencyKey).toBe(writes[1].payload.idempotencyKey);
});
test("stale edits show a useful error and never change the local or shared bill",async({page})=>{
  const {state}=await setup(page,{staleEdit:true});
  await page.locator('[data-order-action="edit"]').click();await page.getByLabel("Quantity for Burger").fill("4");
  await page.getByRole("button",{name:"Save Changes",exact:true}).click();
  await expect(page.locator(".order-action-dialog [data-message]")).toContainText("Another device");
  expect(state.items[0].quantity).toBe(2);await expect(page.getByRole("button",{name:"Save Changes",exact:true})).toBeEnabled();
});
test("Delete opens recorded cancellation and an empty optional reason works",async({page})=>{
  const {state,writes}=await setup(page);page.on("dialog",dialog=>dialog.accept());
  await page.evaluate(id=>{void deleteBill(id);},orderId);await expect(page.locator("#cloud-cancel-dialog-overlay")).toBeVisible();
  await page.locator("#cloud-cancel-confirm").click();await expect(page.locator("#invoice-modal-overlay")).toBeHidden();
  expect(state.order.orderStatus).toBe("cancelled");expect(writes.at(-1).payload.reason).toBe("");
});
