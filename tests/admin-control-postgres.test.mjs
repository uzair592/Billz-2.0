import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {provisionIntegrationDatabase,createAppPool,createControlPool,connectAdmin} from './helpers/postgres.mjs';
import {createServer} from '../src/server/main.mjs';
import {createPlatformAdminService} from '../src/server/auth/platform-admin-service.mjs';
import {createPlatformAdminRepository} from '../src/server/auth/platform-admin-repository.mjs';

test('enterprise admin HTTP controls and concurrent session limits with PostgreSQL',async t=>{
  await provisionIntegrationDatabase();const pool=await createAppPool(),control=await createControlPool(),ownerDB=await connectAdmin();
  const pepper='admin-enterprise-integration-pepper-32';
  await createPlatformAdminService({repository:createPlatformAdminRepository(control),passwordPepper:pepper}).bootstrapAdmin({username:'enterpriseadmin',password:'AdminPassword123!'});
  const server=await createServer({pool,controlPool:control,env:{NODE_ENV:'test',DISABLE_RATE_LIMIT:'true',DATABASE_URL:'postgresql://unused/test',PASSWORD_PEPPER:pepper,
    SESSION_SECRET:'enterprise-session-secret-at-least-32',TRUSTED_ORIGIN:'http://localhost:3000',PAYMENT_PROVIDER:'manual',OFFLINE_ENTITLEMENT_SECRET:'enterprise-entitlement-secret-32-bytes'}});
  t.after(async()=>{await server.close();await pool.end();await control.end();await ownerDB.end();});
  let n=0;const send=(method,url,payload,cookie,tenant)=>server.app.inject({method,url,payload,remoteAddress:`198.51.${Math.floor(++n/200)}.${n%200+1}`,headers:{...(cookie?{cookie}:{}),...(tenant?{'x-restaurant-id':tenant}:{})}});
  const cookie=r=>r.headers['set-cookie'].split(';')[0];
  const login=await send('POST','/platform-admin/api/auth/login',{username:'enterpriseadmin',password:'AdminPassword123!'});assert.equal(login.statusCode,200,login.body);const admin=cookie(login);
  const planBody={code:'QUARTER',name:'Quarterly',billingInterval:'quarter',amountMinor:150000,currencyCode:'PKR',maxDevices:2,trialDays:9,isActive:true};
  let planId,restaurant;
  const audit=async action=>Number((await control.query('SELECT count(*) AS n FROM audit_logs WHERE action=$1',[action])).rows[0].n);
  await t.test('plan CRUD guards, validation, audit and historical prices',async()=>{
    assert.equal((await send('POST','/platform-admin/api/plans',planBody)).statusCode,401);
    assert.equal((await send('POST','/platform-admin/api/plans',{...planBody,maxDevices:0},admin)).statusCode,400);
    const result=await send('POST','/platform-admin/api/plans',planBody,admin);assert.equal(result.statusCode,201,result.body);planId=result.json().id;
    assert.equal(await audit('plan.created'),1);
    assert.equal((await send('POST','/platform-admin/api/plans',planBody,admin)).statusCode,409);
    const list=await send('GET','/platform-admin/api/plans?includeInactive=true',undefined,admin);assert.equal(list.json().plans[0].maxDevices,2);
    assert.equal((await send('PATCH',`/platform-admin/api/plans/${randomUUID()}`,planBody,admin)).statusCode,404);
    assert.equal((await send('PATCH',`/platform-admin/api/plans/${planId}`,{...planBody,amountMinor:200000},admin)).statusCode,200);
    assert.equal(Number((await control.query('SELECT count(*) AS n FROM plan_prices WHERE plan_id=$1',[planId])).rows[0].n),2);
    assert.equal(await audit('plan.updated'),1);
  });
  const signup={name:'Enterprise cafe',code:'Cafe_01 With Spaces',ownerUsername:'owner',ownerPassword:'OwnerPassword123!',ownerEmail:'owner.enterprise@example.com',planCode:'QUARTER'};
  await t.test('creation accepts formerly failing slug input and atomically provisions every record',async()=>{
    const result=await send('POST','/platform-admin/api/restaurants',signup,admin);assert.equal(result.statusCode,201,result.body);restaurant=result.json();
    const r=(await control.query('SELECT slug FROM restaurants WHERE id=$1',[restaurant.id])).rows[0];assert.match(r.slug,/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    for(const table of ['branches','users','restaurant_memberships','business_settings','financial_accounts','subscriptions','tenant_storage_allowances'])
      assert.equal(Number((await control.query(`SELECT count(*) AS n FROM ${table} WHERE restaurant_id=$1`,[restaurant.id])).rows[0].n),1,table);
    const subscription=(await control.query('SELECT current_period_end-current_period_start AS duration FROM subscriptions WHERE restaurant_id=$1',[restaurant.id])).rows[0];assert.equal(subscription.duration.days,9);
    assert.equal((await send('POST','/platform-admin/api/restaurants',signup,admin)).statusCode,409);
    assert.equal((await send('POST','/platform-admin/api/restaurants',{...signup,code:'missing',planCode:'UNKNOWN'},admin)).statusCode,404);
    assert.equal((await send('POST','/platform-admin/api/restaurants',{...signup,ownerPassword:'short'},admin)).statusCode,400);
  });
  const signIn=(username='owner',session)=>send('POST','/api/auth/login',{restaurantCode:restaurant.code,username,password:'OwnerPassword123!'},session);
  let sessions;
  await t.test('simultaneous logins across restaurant users cannot exceed the last device slot',async()=>{
    const staff=await send('POST',`/platform-admin/api/restaurants/${restaurant.id}/users`,{username:'staff',displayName:'Staff',role:'cashier',password:'OwnerPassword123!'},admin);assert.equal(staff.statusCode,201,staff.body);
    const first=await signIn();assert.equal(first.statusCode,200,first.body);
    const attempts=await Promise.all([signIn('owner'),signIn('staff')]);assert.deepEqual(attempts.map(r=>r.statusCode).sort(),[200,409]);
    const winner=attempts.find(r=>r.statusCode===200);sessions=[cookie(first),cookie(winner)];
    assert.equal(attempts.find(r=>r.statusCode===409).json().code,'DEVICE_LIMIT_REACHED');
    assert.equal((await send('GET',`/platform-admin/api/restaurants/${restaurant.id}/sessions`,undefined,admin)).json().sessions.length,2);
    const replacement=await signIn('owner',sessions[0]);assert.equal(replacement.statusCode,200,replacement.body);
    assert.equal((await send('GET','/api/auth/me',undefined,sessions[0])).statusCode,401);sessions[0]=cookie(replacement);
    assert.equal((await send('PATCH',`/platform-admin/api/plans/${planId}`,{...planBody,maxDevices:1},admin)).statusCode,200);
    assert.equal((await send('GET',`/platform-admin/api/restaurants/${restaurant.id}/sessions`,undefined,admin)).json().sessions.length,1);
    const statuses=await Promise.all(sessions.map(c=>send('GET','/api/auth/me',undefined,c)));assert.deepEqual(statuses.map(r=>r.statusCode).sort(),[200,401]);
    const alive=sessions[statuses.findIndex(r=>r.statusCode===200)];
    const entitlement=await send('GET','/api/pos/entitlement',undefined,alive,restaurant.id);assert.equal(entitlement.statusCode,200,entitlement.body);
    assert.equal((await send('POST',`/platform-admin/api/restaurants/${restaurant.id}/sessions/revoke-all`,{reason:'Support'},admin)).json().revokedSessions,1);
    assert.equal((await send('GET','/api/pos/entitlement',undefined,alive,restaurant.id)).statusCode,401);
    assert.equal(await audit('restaurant.devices_revoked'),1);
  });
  await t.test('owner email and password change revokes old sessions and redacts audit/DTOs',async()=>{
    const old=await signIn();assert.equal(old.statusCode,200,old.body);
    const url=`/platform-admin/api/restaurants/${restaurant.id}/owner-credentials`;
    assert.equal((await send('POST',url,{newPassword:'short',reason:'Support'},admin)).statusCode,400);
    const result=await send('POST',url,{email:'new.owner.enterprise@example.com',generateTemporary:true,reason:'Forgot password'},admin);assert.equal(result.statusCode,200,result.body);
    const temporary=result.json().temporaryPassword;assert.ok(temporary.length>=24);
    assert.equal((await send('GET','/api/auth/me',undefined,cookie(old))).statusCode,401);
    assert.equal((await signIn()).statusCode,401);
    const next=await send('POST','/api/auth/login',{restaurantCode:restaurant.code,username:'new.owner.enterprise@example.com',password:temporary});assert.equal(next.statusCode,200,next.body);
    await send('POST','/api/auth/logout',undefined,cookie(next));
    const details=(await send('GET',`/platform-admin/api/restaurants/${restaurant.id}`,undefined,admin)).body;
    assert.equal(details.includes('$argon2'),false);assert.equal(details.includes(temporary),false);
    const logs=(await send('GET','/platform-admin/api/audit-logs',undefined,admin)).body;assert.equal(logs.includes(temporary),false);assert.equal(logs.includes('password_hash'),false);
    assert.equal(await audit('owner.credentials_updated'),1);
    assert.equal((await send('POST',`/platform-admin/api/restaurants/${randomUUID()}/owner-credentials`,{email:'unknown@example.com',reason:'test'},admin)).statusCode,404);
  });
  await t.test('subscription assignment preserves suspension; archive/delete and code changes respect history',async()=>{
    const path=`/platform-admin/api/restaurants/${restaurant.id}`;
    await send('POST',`${path}/suspend`,{},admin);
    const renewal=await send('PUT',`${path}/subscription`,{planId,mode:'renew',reason:'Paid quarterly'},admin);assert.equal(renewal.statusCode,200,renewal.body);
    assert.equal((await control.query('SELECT status FROM subscriptions WHERE restaurant_id=$1',[restaurant.id])).rows[0].status,'suspended');
    await send('POST',`${path}/restore`,{},admin);assert.equal((await control.query('SELECT status FROM subscriptions WHERE restaurant_id=$1',[restaurant.id])).rows[0].status,'active');
    assert.equal((await send('DELETE',`/platform-admin/api/plans/${planId}`,undefined,admin)).statusCode,409);
    assert.equal((await send('POST',`/platform-admin/api/plans/${planId}/archive`,{},admin)).statusCode,200);
    assert.equal((await send('POST','/platform-admin/api/restaurants',{...signup,code:'archived'},admin)).statusCode,404);
    assert.equal((await send('POST',`/platform-admin/api/plans/${planId}/activate`,{},admin)).statusCode,200);
    await send('PATCH',path,{code:'changed-code'},admin);
    assert.equal((await send('POST','/api/auth/login',{restaurantCode:restaurant.code,username:'staff',password:'OwnerPassword123!'})).statusCode,401);
    const fresh=await send('POST','/platform-admin/api/restaurants',{...signup,ownerEmail:'fresh@example.com'},admin);assert.equal(fresh.statusCode,201,fresh.body);
    const unused=await send('POST','/platform-admin/api/plans',{...planBody,code:'UNUSED'},admin);assert.equal((await send('DELETE',`/platform-admin/api/plans/${unused.json().id}`,undefined,admin)).statusCode,200);
    assert.equal(await audit('plan.deleted'),1);assert.equal(await audit('subscription.admin_updated'),1);
  });
  await t.test('audit failure rolls back new provisioning and plan changes',async()=>{
    await ownerDB.query(`CREATE FUNCTION fail_enterprise_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action IN ('restaurant.created','plan.created') THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_enterprise_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_enterprise_audit();`);
    try {
      assert.equal((await send('POST','/platform-admin/api/plans',{...planBody,code:'ROLLBACK'},admin)).statusCode,500);
      assert.equal((await control.query("SELECT id FROM plans WHERE code='ROLLBACK'")).rows.length,0);
      assert.equal((await send('POST','/platform-admin/api/restaurants',{...signup,code:'rollback',ownerEmail:'rollback@example.com'},admin)).statusCode,500);
      assert.equal((await control.query("SELECT id FROM restaurants WHERE code='rollback'")).rows.length,0);
      assert.equal((await control.query("SELECT id FROM users WHERE email='rollback@example.com'")).rows.length,0);
    }finally{await ownerDB.query('DROP TRIGGER fail_enterprise_audit ON audit_logs; DROP FUNCTION fail_enterprise_audit()');}
  });
});
