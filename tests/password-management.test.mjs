import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { buildHttpApp } from "../src/server/http/app.mjs";
import { readLegacyApp, extractInlineScript, extractDeclaration } from "./helpers/legacy-source.mjs";
import { loadServerConfiguration } from "../src/server/config/environment.mjs";

test("support config exposes only public text and a sensible fallback", async t => {
  const env={NODE_ENV:"test",DATABASE_URL:"postgresql://unused/test",PASSWORD_PEPPER:"private-pepper-value-long",SESSION_SECRET:"private-session-secret-long",TRUSTED_ORIGIN:"http://localhost:3000"};
  const config=loadServerConfiguration({...env,SUPPORT_CONTACT:"  support@example.com  "});
  assert.equal(config.supportContact,"support@example.com");
  assert.match(loadServerConfiguration(env).supportContact,/support/);
  const app=await buildHttpApp({authService:{},trustedOrigin:env.TRUSTED_ORIGIN,supportContact:config.supportContact,serveClient:false});
  t.after(()=>app.close());
  assert.deepEqual((await app.inject("/api/public/config")).json(),{supportContact:"support@example.com"});
});

test("forgot-password renderer treats a configured contact as text",async()=>{
  const source=extractInlineScript(await readLegacyApp());const help={classList:{remove(){}},textContent:""};
  const context=vm.createContext({document:{getElementById:()=>help},fetch:async()=>({ok:true,json:async()=>({supportContact:'<img src=x onerror=alert(1)>'})})});
  await vm.runInContext(extractDeclaration(source,"async function showCloudPasswordHelp()","async function submitCloudPasswordChange()")+"\nshowCloudPasswordHelp();",context);
  assert.match(help.textContent,/Contact customer support/);assert.match(help.textContent,/<img/);assert.equal(help.innerHTML,undefined);
});

test("password reset rejects invalid admin sessions and ambiguous or weak requests",async t=>{
  let authenticated=false;let called=0;
  const app=await buildHttpApp({authService:{authenticate:async()=>null},platformAdminService:{authenticate:async()=>authenticated?{admin:{id:"admin"}}:null},
    platformAdminPortalService:{resetUserPassword:async()=>{called++;return {reset:true}}},trustedOrigin:"http://localhost:3000",serveClient:false});
  t.after(()=>app.close());
  const url="/platform-admin/api/restaurants/11111111-1111-4111-8111-111111111111/users/22222222-2222-4222-8222-222222222222/reset-password";
  assert.equal((await app.inject({method:"POST",url,payload:{generateTemporary:true}})).statusCode,403);
  authenticated=true;
  for(const payload of [{newPassword:"short"},{newPassword:"a".repeat(201)},{generateTemporary:false},{newPassword:"NewPassword123!",generateTemporary:true},{}]) {
    assert.equal((await app.inject({method:"POST",url,payload})).statusCode,400);
  }
  assert.equal(called,0);
  assert.equal((await app.inject({method:"POST",url,payload:{generateTemporary:true}})).statusCode,200);
  assert.equal(called,1);
  assert.equal((await app.inject({method:"POST",url:"/api/auth/change-password",payload:{currentPassword:"OldPassword123!",newPassword:"NewPassword123!"}})).statusCode,401);
});
