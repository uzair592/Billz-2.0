import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { createServer } from "../src/server/main.mjs";
import { createStaticFileHandler } from "../src/server/http/static-files.mjs";
import { createEntitlementService } from "../src/server/auth/entitlement-service.mjs";
import { buildHttpApp } from "../src/server/http/app.mjs";
import { createOrderOutbox, OrderSyncError } from "../src/client/order-outbox.mjs";
import { createLegacyCloudAdapter, CLOUD_CONTEXT_KEY } from "../src/client/legacy-cloud-adapter.mjs";
import { mapCloudOrderDetail } from "../src/client/cloud-order-mapper.mjs";
import { readLegacyApp, extractInlineScript, extractDeclaration } from "./helpers/legacy-source.mjs";
import { runMigrations, verifyMigrationsCurrent } from "../src/server/database/migration-runner.mjs";

function memory() { const data = new Map(); return { get: async key => structuredClone(data.get(key)), set: async (key,value) => data.set(key,structuredClone(value)) }; }
const env = { NODE_ENV: "test", DATABASE_URL: "postgresql://unused/test", PASSWORD_PEPPER: "fixture-password-pepper-long", SESSION_SECRET: "fixture-session-secret-long", TRUSTED_ORIGIN: "http://localhost:3000" };
test("actual production composition registers the five previously missing route families", async t => {
  const client = { query: async () => ({ rows: [{ ok: 1 }] }), release() {} };
  const server = await createServer({ env, pool: { connect: async () => client }, migrationsDir: null });
  t.after(() => server.close());
  const id = randomUUID();
  for (const [method,url] of [["GET","/api/pos/orders"],["GET",`/api/pos/orders/${id}`],["POST",`/api/pos/orders/${id}/cancel`],["POST","/api/pos/import/legacy-catalog"],["GET","/api/pos/settings/business"]]) {
    const response = await server.app.inject({ method, url });
    assert.equal(response.statusCode, 401, `${method} ${url} must be registered and guarded`);
  }
});
test("static assets reject decoded traversal and symlink escapes", async t => {
  const root = await mkdtemp(path.join(tmpdir(),"billz-static-"));
  t.after(() => rm(root,{ recursive:true,force:true }));
  await mkdir(path.join(root,"src/client"),{ recursive:true });
  await mkdir(path.join(root,"platform-admin"));
  await writeFile(path.join(root,"package.json"),'private canary');
  await writeFile(path.join(root,"src/client/ok.mjs"),'export {}');
  await symlink(path.join(root,"package.json"),path.join(root,"src/client/leak.mjs"));
  const handler = createStaticFileHandler({ root });
  for (const url of ["/src/client/..%2F..%2Fpackage.json","/platform-admin/..%2Fpackage.json","/src/client/leak.mjs"]) {
    const reply = { status:200, code(value) {this.status=value;return this}, header(){return this}, send(body){return body} };
    await handler({url},reply);
    assert.equal(reply.status,403,url);
  }
});
test("forged forwarded IPs cannot bypass the direct-server login limit", async t => {
  const app = await buildHttpApp({ authService: { login: async () => { throw Object.assign(new Error("Invalid"),{ code:"INVALID_CREDENTIALS" }) } }, trustedOrigin:"http://localhost:3000", serveClient:false });
  t.after(() => app.close());
  for (let n=0;n<11;n++) {
    const res = await app.inject({ method:"POST",url:"/api/auth/login",headers:{"x-forwarded-for":`198.51.100.${n}`},payload:{email:`test${n}@example.com`,password:"long-password"} });
    assert.equal(res.statusCode,n<10?401:429);
  }
});
test("authentication DTO strips credential fields even from a repository-shaped session", async t => {
  const app = await buildHttpApp({ authService:{ authenticate:async()=>({ user:{id:randomUUID(),username:"owner",passwordHash:"private-canary",tokenHash:"private-token"} }) },trustedOrigin:"http://localhost:3000",serveClient:false });
  t.after(() => app.close());
  const res = await app.inject("/api/auth/me");
  assert.equal(res.statusCode,200);
  assert.ok(!res.body.includes("private-canary") && !res.body.includes("passwordHash") && !res.body.includes("tokenHash"));
});
test("entitlement cannot use a source default and expires at the paid boundary", () => {
  assert.throws(()=>createEntitlementService({secret:null}),/private entitlement/);
  const now=new Date("2026-10-10T10:00:00Z");
  const service=createEntitlementService({secret:"fixture-private-signing-material-32-chars",clock:()=>now});
  const issued=service.issueToken({restaurantId:randomUUID(),userId:randomUUID(),deviceId:"one",validUntil:"2026-10-10T10:10:00Z"});
  assert.equal(issued.claims.expiresAt,"2026-10-10T10:10:00.000Z");
  assert.equal(service.verifyToken(issued.token).valid,true);
});
test("authorization recovery preserves the original operation ID and tenant", async () => {
  const storage=memory();let restored=false;let calls=0;
  const outbox=createOrderOutbox({storage,createId:randomUUID,transport:{send:async()=>{calls++;if(!restored)throw new OrderSyncError("Expired",{status:402});return {order:{id:"cloud"}}}}});
  const original=await outbox.enqueue({localOrderId:1,restaurantId:"tenant-a",payload:{items:[{}]}});
  assert.equal((await outbox.flush())[0].status,"blocked");
  restored=true;
  await outbox.resumeAccess("tenant-b");await outbox.flush();assert.equal(calls,1);
  await outbox.resumeAccess("tenant-a");const records=await outbox.flush();
  assert.equal(records[0].status,"synced");assert.equal(records[0].idempotencyKey,original.idempotencyKey);assert.equal(calls,2);
});
test("stale catalog cannot enqueue another tenant's new sale", async () => {
  const storage=memory();let queued=false;
  await storage.set(CLOUD_CONTEXT_KEY,{restaurantId:"a",mappings:{menuItems:{1:randomUUID()}}});
  const adapter=createLegacyCloudAdapter({storage,session:{status:async()=>({user:{id:"b-user"},restaurantId:"b"})},outbox:{enqueue:async()=>{queued=true},flush:async()=>[]}});
  await assert.rejects(adapter.enqueueLegacyOrder({id:1,items:[{id:1,qty:1}],orderType:"Takeaway"}),e=>e.code==="CLOUD_TENANT_MISMATCH");
  assert.equal(queued,false);
});
test("cloud profit uses the whole line cost and retains true zero costs", () => {
  const mapped=mapCloudOrderDetail({order:{totalMinor:30000,costOfGoodsMinor:6000},items:[{quantity:3,unitPriceMinor:10000,unitCostMinor:2000}]});
  assert.equal(mapped.items[0].lineCostAtSale,60);
  assert.equal(mapCloudOrderDetail({order:{costOfGoodsMinor:0},items:[{quantity:3,unitCostMinor:0}]}).costOfGoods,0);
});
test("backup validates malformed late rows and nested items before restore", async () => {
  const source=extractInlineScript(await readLegacyApp());
  const sandbox=vm.createContext({});
  vm.runInContext("const APP_SCHEMA_VERSION=3;"+extractDeclaration(source,"const ValidationEngine =","const BackupService =")+extractDeclaration(source,"const BackupService =","const memoryStorageFallback =")+"globalThis.check=BackupService.validate;",sandbox);
  const good={totalBill:1,items:[{name:"A",qty:1,price:1}]};
  assert.equal(sandbox.check({pos_orders:Array.from({length:1000},()=>good).concat(null)}).valid,false);
  assert.equal(sandbox.check({pos_orders:[{totalBill:1,items:[null]}]}).valid,false);
});
test("migration DDL and history commit together and the session lock is unlocked", async t => {
  const dir=await mkdtemp(path.join(tmpdir(),"billz-migration-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(path.join(dir,"001_probe.sql"),"BEGIN;\nCREATE TABLE probe(id int);\nCOMMIT;\n");
  const queries=[];
  const client={query:async(sql)=>{queries.push(sql);return {rows:sql.includes("pg_try_advisory_lock")?[{acquired:true}]:[]}},release(){queries.push("RELEASE")}};
  await runMigrations({pool:{connect:async()=>client},migrationsDir:dir,logger:{}});
  const ddl=queries.find(q=>q.includes("CREATE TABLE probe"));
  assert.ok(!/\bBEGIN\b|\bCOMMIT\b/.test(ddl));
  assert.ok(queries.findIndex(q=>q.includes("INSERT INTO schema_migrations"))<queries.indexOf("COMMIT"));
  assert.ok(queries.at(-2).includes("pg_advisory_unlock"));
});
test("actual invoice renderer escapes customer, item, offer and attribute canaries", async () => {
  const source=extractInlineScript(await readLegacyApp());
  const content={innerHTML:""};const overlay={classList:{remove(){}}};
  const canary='<img src=x onerror="canary()">';
  const sandbox=vm.createContext({ orders:[{id:1,customerName:canary,orderType:"Takeaway",date:"2026-10-10",totalBill:100,subtotal:100,items:[{name:canary,offerLabel:canary,qty:1,price:100}]}],
    document:{getElementById:id=>id==="invoice-modal-content"?content:overlay},stockItemDefs:{},
    getOrderStatus:()=>"Completed",receiptCustomerPhone:()=>"",receiptRiderName:()=>"",ProfitEngine:{order:()=>({costOfGoods:0,grossProfit:100,isHistoricalEstimate:false})} });
  vm.runInContext(extractDeclaration(source,"function escapeHtmlForExport(str)","function exportOrdersHistoryToExcel()")+
    extractDeclaration(source,"function showOrderInvoiceDetailsView(orderId)","function refreshOrderDependentViews()")+"\nshowOrderInvoiceDetailsView(1);",sandbox);
  assert.ok(!content.innerHTML.includes("<img"));assert.ok(content.innerHTML.includes("&lt;img"), content.innerHTML.slice(0,3000));
  assert.ok(content.innerHTML.includes("&quot;canary()&quot;"));
});

test("runtime migration readiness never requests schema creation privileges", async t => {
  const dir=await mkdtemp(path.join(tmpdir(),"billz-readiness-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const queries=[];
  const client={query:async sql=>{queries.push(sql);return {rows:[]}},release(){}};
  assert.equal((await verifyMigrationsCurrent({pool:{connect:async()=>client},migrationsDir:dir})).current,true);
  assert.equal(queries.length,1);assert.match(queries[0],/^SELECT version/);
  await writeFile(path.join(dir,"001_probe.sql"),"SELECT 1;");
  const missing={query:async sql=>{assert.match(sql,/^SELECT version/);throw Object.assign(new Error("missing history"),{code:"42P01"})},release(){}};
  const pending=await verifyMigrationsCurrent({pool:{connect:async()=>missing},migrationsDir:dir});
  assert.equal(pending.current,false);assert.equal(pending.pending,"001_probe.sql");
});

test("managed sign-in hides the initial legacy PIN overlay before requesting a session", async () => {
  const source=extractInlineScript(await readLegacyApp());const hidden=new Set(["cloud-account-modal-overlay"]);let message;
  const sandbox=vm.createContext({window:{BILLZ_MANAGED:true},fetch:async()=>({ok:false,status:401}),hideBootSplash(){},cloudSetStatus:text=>{message=text},
    document:{getElementById:id=>({classList:{add:()=>hidden.add(id),remove:()=>hidden.delete(id)}})}});
  await vm.runInContext(extractDeclaration(source,"async function runBootSequence()", "\n      bootBiteTechApp();")+"\nrunBootSequence();",sandbox);
  assert.equal(hidden.has("pin-lock-overlay"),true);
  assert.equal(hidden.has("cloud-account-modal-overlay"),false);
  assert.equal(message,"Sign in to open your restaurant.");
});
