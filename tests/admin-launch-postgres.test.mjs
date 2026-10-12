import assert from "node:assert/strict";
import test from "node:test";
import { provisionIntegrationDatabase, createAppPool, createControlPool } from "./helpers/postgres.mjs";
import { createLoginThrottle } from "../src/server/auth/login-throttle.mjs";

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
