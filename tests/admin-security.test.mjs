import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { buildHttpApp } from "../src/server/http/app.mjs";
import { loadServerConfiguration } from "../src/server/config/environment.mjs";
import { hashPassword } from "../src/server/auth/passwords.mjs";
import { passwordSchema } from "../src/server/auth/password-policy.mjs";

const base = { NODE_ENV: "test", DATABASE_URL: "postgresql://unused/test", PASSWORD_PEPPER: "test-long-password-pepper", SESSION_SECRET: "different-long-session-secret", TRUSTED_ORIGIN: "http://localhost:3000" };

test("proxy trust fails closed without a valid explicit platform allowlist", () => {
  assert.throws(() => loadServerConfiguration({ ...base, TRUST_PROXY: "true" }), /TRUSTED_PROXY_CIDRS/);
  assert.throws(() => loadServerConfiguration({ ...base, TRUST_PROXY: "true", TRUSTED_PROXY_CIDRS: "0.0.0.0/999" }), /valid IP/);
  assert.deepEqual(loadServerConfiguration({ ...base, TRUST_PROXY: "true", TRUSTED_PROXY_CIDRS: "10.22.0.0/24" }).trustProxy, ["10.22.0.0/24"]);
});

test("verified proxy chains distinguish clients and ignore forged forwarded prefixes", async t => {
  const ips = [];
  const app = await buildHttpApp({ authService: { login: async input => { ips.push(input.ipAddress); return { user: { id: "one" }, token: "session", expiresAt: new Date(Date.now()+60000) }; } },
    trustedOrigin: base.TRUSTED_ORIGIN, serveClient: false, trustProxy: ["10.22.0.0/24"] });
  t.after(() => app.close());
  const login = (remoteAddress, forwarded) => app.inject({ method: "POST", url: "/api/auth/login", remoteAddress,
    headers: { "x-forwarded-for": forwarded }, payload: { restaurantCode: "cafe", username: "owner", password: "OwnerPassword123!" } });
  for (const [peer,header] of [["10.22.0.4","198.51.100.1"],["10.22.0.4","198.51.100.2"],["10.22.0.4","192.0.2.50, 198.51.100.1"],["203.0.113.5","192.0.2.51"]]) assert.equal((await login(peer,header)).statusCode,200);
  assert.deepEqual(ips,["198.51.100.1","198.51.100.2","198.51.100.1","203.0.113.5"]);
});

test("admin CSP blocks inline scripts without changing legacy POS CSP", async t => {
  const app = await buildHttpApp({ authService: {}, trustedOrigin: base.TRUSTED_ORIGIN });
  t.after(() => app.close());
  const admin = await app.inject("/platform-admin/");
  assert.equal(admin.statusCode,200);
  assert.match(admin.headers["content-security-policy"], /script-src 'self';/);
  assert.ok(!/<script(?![^>]*src=)[^>]*>/i.test(admin.body));
  assert.equal((await app.inject("/")).headers["content-security-policy"],undefined);
});

test("actual admin restaurant renderer treats stored markup as text", async () => {
  const source = await readFile(new URL("../platform-admin/app.js",import.meta.url),"utf8");
  const canary='<img src=x onerror=alert(1)>';
  const context=vm.createContext({record:{code:canary,name:canary,status:canary,subscriptionStatus:canary,id:canary,planName:canary,usedStorageBytes:0,maxStorageBytes:100}});
  const helper=source.slice(0,source.indexOf("async function apiCall"));
  const row=vm.runInContext(helper+"\nrenderRestaurantRow(record);",context);
  assert.ok(!row.includes("<img"));assert.ok(row.includes("&lt;img"));
  assert.ok(row.includes("0 B / 100 B"));
});

test("all password schemas share boundaries and password-layer errors have HTTP status", async t => {
  for(const length of [8,9,201]) {
    assert.equal(passwordSchema.safeParse("a".repeat(length)).success,false);
    await assert.rejects(hashPassword("a".repeat(length),base.PASSWORD_PEPPER),error=>error instanceof TypeError && error.statusCode===400);
  }
  for(const length of [10,200]) assert.equal(passwordSchema.safeParse("a".repeat(length)).success,true);
  const app=await buildHttpApp({authService:{},platformAdminService:{authenticate:async()=>({admin:{id:"admin"}})},
    platformAdminPortalService:{createRestaurant(){throw new Error("must not hash invalid passwords")}},trustedOrigin:base.TRUSTED_ORIGIN,serveClient:false});
  t.after(()=>app.close());
  const response=await app.inject({method:"POST",url:"/platform-admin/api/restaurants",payload:{name:"Cafe",code:"cafe",ownerUsername:"owner",ownerPassword:"123456789"}});
  assert.equal(response.statusCode,400);assert.match(response.json().error,/at least 10/);
});

test("restaurant and admin counters record only bad credentials and reset after success", async t => {
  const calls=[];let fail=true;
  const loginThrottle={check:async input=>calls.push(["check",input]),failed:async input=>calls.push(["failed",input]),succeeded:async input=>calls.push(["succeeded",input])};
  const session={user:{id:"one"},admin:{id:"admin"},token:"token",expiresAt:new Date(Date.now()+60000)};
  const login=code=>async()=>{if(fail)throw Object.assign(new Error("Invalid"),{code,statusCode:401});return session};
  const app=await buildHttpApp({authService:{login:login("INVALID_CREDENTIALS")},platformAdminService:{login:login("INVALID_ADMIN_CREDENTIALS")},
    platformAdminPortalService:{},loginThrottle,trustedOrigin:base.TRUSTED_ORIGIN,serveClient:false});
  t.after(()=>app.close());
  for(const url of ["/api/auth/login","/platform-admin/api/auth/login"]) {
    fail=true;const payload={restaurantCode:"cafe",username:"owner",password:"OwnerPassword123!"};
    assert.equal((await app.inject({method:"POST",url,payload})).statusCode,401);
    fail=false;assert.equal((await app.inject({method:"POST",url,payload})).statusCode,200);
  }
  assert.deepEqual(calls.map(c=>c[0]),["check","failed","check","succeeded","check","failed","check","succeeded"]);
  assert.ok(calls.every(c=>c[1].ipAddress && !c[1].password));
  assert.deepEqual([...new Set(calls.map(c=>c[1].scope))],["restaurant","platform_admin"]);
});
