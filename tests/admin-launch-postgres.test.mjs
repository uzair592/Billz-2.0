import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { provisionIntegrationDatabase, createAppPool, createControlPool } from "./helpers/postgres.mjs";
import { createLoginThrottle } from "../src/server/auth/login-throttle.mjs";
import { createServer } from "../src/server/main.mjs";
import { createPlatformAdminService } from "../src/server/auth/platform-admin-service.mjs";
import { createPlatformAdminRepository } from "../src/server/auth/platform-admin-repository.mjs";
import { createPostgresAuthRepository } from "../src/server/auth/postgres-auth-repository.mjs";
import { hashOpaqueToken } from "../src/server/auth/tokens.mjs";
import { seedPlan } from "./helpers/postgres.mjs";

test("durable login throttling with real control and tenant roles", async t => {
  await provisionIntegrationDatabase();
  const control=await createControlPool();const app=await createAppPool();
  t.after(async()=>{await control.end();await app.end()});
  let now=new Date();const clock=()=>now;
  const input={scope:"restaurant",restaurantCode:"Cafe",username:"Owner",ipAddress:"198.51.100.1"};
  let throttle=createLoginThrottle(control,{clock});
  await throttle.failed(input);
  // Recreation simulates another worker/restart; no local state is involved.
  throttle=createLoginThrottle(control,{clock});
  await assert.rejects(throttle.check(input),error=>error.statusCode===429 && error.retryAfter===1);
  await throttle.check({...input,ipAddress:"198.51.100.2"});
  await throttle.check({...input,restaurantCode:"another"});
  await throttle.check({...input,scope:"platform_admin"});
  assert.equal((await app.query("SELECT * FROM login_attempts")).rows.length,0);
  await assert.rejects(app.query(`INSERT INTO login_attempts VALUES('restaurant',decode(repeat('aa',32),'hex'),'198.51.100.3',1,now(),now())`),error=>error.code==="42501");
  now=new Date(now.getTime()+250);await throttle.check(input);
  await throttle.succeeded({...input,restaurantCode:"CAFE",username:"OWNER"});
  assert.equal((await control.query("SELECT * FROM login_attempts")).rows.length,0);
  await Promise.all(Array.from({length:10},()=>throttle.failed(input)));
  const row=(await control.query("SELECT * FROM login_attempts")).rows[0];
  assert.equal(row.failures,10);assert.equal(new Date(row.next_attempt_at)-now,5000);
  now=new Date(now.getTime()+5000);await throttle.check(input);
  await throttle.succeeded(input);
  assert.equal((await control.query("SELECT * FROM login_attempts")).rows.length,0);
});

test("password management through actual HTTP composition and PostgreSQL",async t=>{
  await provisionIntegrationDatabase();
  const control=await createControlPool();const appPool=await createAppPool();
  await seedPlan(control,{code:"GROWTH",provider:"manual"});
  const pepper="password-management-test-pepper";
  const adminService=createPlatformAdminService({repository:createPlatformAdminRepository(control),passwordPepper:pepper});
  const admin=await adminService.bootstrapAdmin({username:"securityadmin",password:"AdminPassword123!"});
  let now=new Date();const throttle=createLoginThrottle(control,{clock:()=>now});
  const server=await createServer({pool:appPool,controlPool:control,loginThrottle:throttle,env:{NODE_ENV:"test",DATABASE_URL:"postgresql://unused/test",
    PASSWORD_PEPPER:pepper,SESSION_SECRET:"password-management-session-secret",TRUSTED_ORIGIN:"http://localhost:3000",PAYMENT_PROVIDER:"manual"}});
  t.after(async()=>{await server.close();await control.end();await appPool.end()});
  const app=server.app;let requestNumber=0;
  const send=async(method,url,payload,cookie)=>{
    now=new Date(now.getTime()+10000);
    return app.inject({method,url,payload,headers:cookie?{cookie}:{},remoteAddress:`198.51.100.${++requestNumber}`});
  };
  const cookie=response=>response.headers["set-cookie"].split(";")[0];
  const adminLogin=await send("POST","/platform-admin/api/auth/login",{username:"securityadmin",password:"AdminPassword123!"});
  const adminCookie=cookie(adminLogin);
  const create=async(code)=>{
    const response=await send("POST","/platform-admin/api/restaurants",{code,name:code,ownerUsername:"owner",ownerPassword:"OriginalPassword123!"},adminCookie);
    assert.equal(response.statusCode,201,response.body);return response.json();
  };
  const restaurant=await create("password-cafe");const other=await create("password-other");
  const path=`/platform-admin/api/restaurants/${restaurant.id}/users/${restaurant.owner.id}/reset-password`;
  const login=password=>send("POST","/api/auth/login",{restaurantCode:"password-cafe",username:"owner",password});
  const first=await login("OriginalPassword123!");const second=await login("OriginalPassword123!");
  const oldCookie=cookie(first);const secondCookie=cookie(second);
  assert.equal((await send("POST",path,{newPassword:"ResetPassword123!"})).statusCode,403);
  for(const payload of [{newPassword:"123456789"},{newPassword:"a".repeat(201)},{newPassword:"ResetPassword123!",generateTemporary:true}])
    assert.equal((await send("POST",path,payload,adminCookie)).statusCode,400);
  for(const unknown of [path.replace(restaurant.id,randomUUID()),path.replace(restaurant.owner.id,randomUUID()),path.replace(restaurant.owner.id,other.owner.id)])
    assert.equal((await send("POST",unknown,{newPassword:"ResetPassword123!"},adminCookie)).statusCode,404);
  const reset=await send("POST",path,{newPassword:"ResetPassword123!"},adminCookie);
  assert.deepEqual(reset.json(),{reset:true,userId:restaurant.owner.id});
  assert.equal((await send("GET","/api/auth/me",undefined,oldCookie)).statusCode,401);
  assert.equal((await send("GET","/api/auth/me",undefined,secondCookie)).statusCode,401);
  assert.equal((await login("OriginalPassword123!")).statusCode,401);
  const fresh=await login("ResetPassword123!");assert.equal(fresh.statusCode,200,fresh.body);
  const currentCookie=cookie(fresh);const another=await login("ResetPassword123!");
  assert.equal((await send("POST","/api/auth/change-password",{currentPassword:"ResetPassword123!",newPassword:"ChangedPassword123!"})).statusCode,401);
  assert.equal((await send("POST","/api/auth/change-password",{currentPassword:"ResetPassword123!",newPassword:"short"},currentCookie)).statusCode,400);
  assert.equal((await send("POST","/api/auth/change-password",{currentPassword:"IncorrectPassword123!",newPassword:"ChangedPassword123!"},currentCookie)).statusCode,400);
  const changed=await send("POST","/api/auth/change-password",{currentPassword:"ResetPassword123!",newPassword:"ChangedPassword123!"},currentCookie);
  assert.equal(changed.statusCode,200,changed.body);
  assert.equal((await send("GET","/api/auth/me",undefined,currentCookie)).statusCode,200);
  assert.equal((await send("GET","/api/auth/me",undefined,cookie(another))).statusCode,401);
  assert.equal((await login("ResetPassword123!")).statusCode,401);
  assert.equal((await login("ChangedPassword123!")).statusCode,200);
  const beforeHash=(await control.query("SELECT password_hash FROM users WHERE id=$1",[restaurant.owner.id])).rows[0].password_hash;
  const generated=await send("POST",path,{generateTemporary:true},adminCookie);
  assert.equal(generated.statusCode,200,generated.body);
  const temporary=generated.json().temporaryPassword;
  assert.match(temporary,/^[A-Za-z0-9_-]{32}$/);
  assert.equal((await login(temporary)).statusCode,200);
  assert.equal((await send("GET","/api/auth/me",undefined,currentCookie)).statusCode,401);
  const detail=await send("GET",`/platform-admin/api/restaurants/${restaurant.id}`,undefined,adminCookie);
  assert.ok(!detail.body.includes(temporary) && !detail.body.includes("passwordHash") && !detail.body.includes("password_hash"));
  const audits=(await control.query("SELECT * FROM audit_logs WHERE resource_id=$1 AND action IN ('user.password_reset','user.password_changed')",[restaurant.owner.id])).rows;
  assert.equal(audits.length,3);
  assert.ok(audits.filter(row=>row.action==="user.password_reset").every(row=>row.actor_admin_id===admin.admin.id && row.restaurant_id===restaurant.id));
  assert.equal(audits.find(row=>row.action==="user.password_changed").actor_user_id,restaurant.owner.id);
  const serialized=JSON.stringify(audits);assert.ok(!serialized.includes(temporary) && !serialized.includes("Password123") && !serialized.includes("$argon2"));

  const restPath=`/platform-admin/api/restaurants/${restaurant.id}`;
  assert.equal((await send("PATCH",restPath,{name:"Updated cafe"})).statusCode,401);
  for(const body of [{},{name:""},{contactEmail:"invalid"},{code:"forbidden"}])
    assert.equal((await send("PATCH",restPath,body,adminCookie)).statusCode,400);
  assert.equal((await send("PATCH",restPath.replace(restaurant.id,randomUUID()),{name:"Cafe"},adminCookie)).statusCode,404);
  const edited=await send("PATCH",restPath,{name:'Updated <img src=x onerror=alert(1)>',phone:"03001234567",contactEmail:"support@example.com",address:"Peshawar"},adminCookie);
  assert.equal(edited.statusCode,200,edited.body);
  const information=(await send("GET",restPath,undefined,adminCookie)).json().restaurant;
  assert.equal(information.contactEmail,"support@example.com");assert.equal(information.phone,"03001234567");assert.equal(information.address,"Peshawar");
  const activeLogin=await login(temporary);assert.equal(activeLogin.statusCode,200);
  const statusPath=`${restPath}/users/${restaurant.owner.id}/status`;
  assert.equal((await send("POST",statusPath,{status:"disabled"})).statusCode,401);
  assert.equal((await send("POST",statusPath,{status:"deleted"},adminCookie)).statusCode,400);
  for(const missing of [statusPath.replace(restaurant.id,randomUUID()),statusPath.replace(restaurant.owner.id,other.owner.id)])
    assert.equal((await send("POST",missing,{status:"disabled"},adminCookie)).statusCode,404);
  assert.equal((await send("POST",statusPath,{status:"disabled"},adminCookie)).statusCode,200);
  assert.equal((await send("GET","/api/auth/me",undefined,cookie(activeLogin))).statusCode,401);
  assert.equal((await login(temporary)).statusCode,403);
  assert.equal((await send("POST",statusPath,{status:"active"},adminCookie)).statusCode,200);
  assert.equal((await send("GET","/api/auth/me",undefined,cookie(activeLogin))).statusCode,401);
  assert.equal((await login(temporary)).statusCode,200);
  const actions=(await control.query("SELECT action, actor_admin_id FROM audit_logs WHERE restaurant_id=$1",[restaurant.id])).rows;
  for(const action of ["restaurant.updated","user.disabled","user.enabled"]) assert.ok(actions.some(row=>row.action===action && row.actor_admin_id===admin.admin.id));
  assert.equal((await send("GET","/platform-admin/api/audit-logs")).statusCode,401);
  for(const query of ["page=0","limit=101","restaurantId=invalid"])
    assert.equal((await send("GET",`/platform-admin/api/audit-logs?${query}`,undefined,adminCookie)).statusCode,400);
  const auditPage=(await send("GET",`/platform-admin/api/audit-logs?restaurantId=${restaurant.id}&limit=1`,undefined,adminCookie)).json();
  assert.equal(auditPage.audits.length,1);assert.ok(auditPage.totalCount>=6);
  assert.ok(auditPage.audits.every(row=>row.restaurantId===restaurant.id));
  const nextPage=(await send("GET",`/platform-admin/api/audit-logs?restaurantId=${restaurant.id}&limit=1&page=2`,undefined,adminCookie)).json();
  assert.notEqual(auditPage.audits[0].id,nextPage.audits[0].id);
  assert.equal((await send("POST","/platform-admin/api/audit-logs",{},adminCookie)).statusCode,404);
  const list=(await send("GET","/platform-admin/api/restaurants?includeTotal=true&limit=1",undefined,adminCookie)).json();
  assert.equal(list.restaurants.length,1);assert.equal(list.totalCount,2);
  // A login that verified the old hash before a reset cannot mint a new session afterward.
  await assert.rejects(createPostgresAuthRepository(control).createSession({userId:restaurant.owner.id,expectedPasswordHash:beforeHash,
    tokenHash:hashOpaqueToken("stale-login-operation"),ipAddress:"198.51.100.100",userAgent:"test",expiresAt:new Date(Date.now()+60000)}),error=>error.code==="INVALID_CREDENTIALS");
});
