import test from 'node:test';
import assert from 'node:assert/strict';
import {subscriptionBoundary} from '../src/server/subscriptions/admin-control-service.mjs';
import {restaurantSlug} from '../src/server/subscriptions/platform-admin-portal-service.mjs';
import {createPostgresAuthRepository} from '../src/server/auth/postgres-auth-repository.mjs';
import {buildHttpApp} from '../src/server/http/app.mjs';
import {createEntitlementService} from '../src/server/auth/entitlement-service.mjs';
const id='11111111-1111-4111-8111-111111111111';

test('restaurant codes with spaces, underscores and non-Latin text produce valid collision-resistant slugs',()=>{
  for(const code of ['Cafe_01','My Restaurant','مطعم','cafe--','😀']) assert.match(restaurantSlug(code,id),/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.notEqual(restaurantSlug('my_cafe',id),restaurantSlug('my_cafe',id.replace(/^1/,'2')));
});
test('calendar renewals clamp month ends and trials use configured days',()=>{
  assert.equal(subscriptionBoundary('2026-01-31T12:00:00Z','month').toISOString(),'2026-02-28T12:00:00.000Z');
  assert.equal(subscriptionBoundary('2026-01-31T12:00:00Z','quarter').toISOString(),'2026-04-30T12:00:00.000Z');
  assert.equal(subscriptionBoundary('2024-02-29T12:00:00Z','year').toISOString(),'2025-02-28T12:00:00.000Z');
  assert.equal(subscriptionBoundary('2026-01-01T00:00:00Z','trial',7).toISOString(),'2026-01-08T00:00:00.000Z');
});
test('a full restaurant seat limit rolls back before session insertion',async()=>{
  const calls=[];let released=false;
  const client={release(){released=true;},async query(sql,values){calls.push({sql,values});
    if(sql.includes('SELECT restaurant_id FROM restaurant_memberships'))return {rows:[{restaurant_id:id}]};
    if(sql.startsWith('SELECT plan_id FROM subscriptions'))return {rows:[{plan_id:id}]};
    if(sql.includes('SELECT code,status FROM restaurants'))return {rows:[{code:'cafe',status:'active'}]};
    if(sql.includes('SELECT s.plan_id,p.max_devices'))return {rows:[{plan_id:id,max_devices:1}]};
    if(sql.includes('SELECT password_hash,status,username,email'))return {rows:[{password_hash:'hash',status:'active',username:'owner',email:null}]};
    if(sql.includes('count(*) AS total'))return {rows:[{total:'1'}]};
    return {rows:[]};}};
  const repo=createPostgresAuthRepository({connect:async()=>client});
  await assert.rejects(repo.createSession({userId:id,expectedRestaurantId:id,expectedRestaurantCode:'cafe',expectedPasswordHash:'hash',expectedUsername:'owner'}),e=>e.code==='DEVICE_LIMIT_REACHED');
  assert.equal(calls.at(-1).sql,'ROLLBACK');assert.equal(released,true);assert.equal(calls.some(c=>c.sql.includes('INSERT INTO sessions')),false);
  assert.ok(calls.findIndex(c=>c.sql.includes('pg_advisory_xact_lock_shared'))<calls.findIndex(c=>c.sql.includes('FROM restaurants')));
});
test('admin plan and credential endpoints guard authentication and validate inputs before writes',async t=>{
  let allowed=false;const calls=[];
  const portal=new Proxy({}, {get:(_,name)=>async input=>{calls.push({name,input});return {id};}});
  const app=await buildHttpApp({authService:{},trustedOrigin:'http://localhost:3000',serveClient:false,
    platformAdminService:{authenticate:async()=>allowed?{admin:{id}}:null},platformAdminPortalService:portal});t.after(()=>app.close());
  const endpoints=[['POST','/platform-admin/api/plans',{}],['PATCH',`/platform-admin/api/plans/${id}`,{}],['DELETE',`/platform-admin/api/plans/${id}`],
    ['POST',`/platform-admin/api/plans/${id}/archive`],['POST',`/platform-admin/api/plans/${id}/activate`],
    ['PUT',`/platform-admin/api/restaurants/${id}/subscription`,{}],['POST',`/platform-admin/api/restaurants/${id}/owner-credentials`,{}],
    ['GET',`/platform-admin/api/restaurants/${id}/sessions`],['POST',`/platform-admin/api/restaurants/${id}/sessions/revoke-all`,{}]];
  for(const [method,url,payload] of endpoints)assert.equal((await app.inject({method,url,payload})).statusCode,401);
  allowed=true;
  const plan={code:'TEST',name:'Test',billingInterval:'quarter',amountMinor:1500,currencyCode:'PKR',maxDevices:2,trialDays:7,isActive:true};
  assert.equal((await app.inject({method:'POST',url:'/platform-admin/api/plans',payload:plan})).statusCode,201);
  for(const bad of [{...plan,maxDevices:0},{...plan,billingInterval:'trial'},{...plan,code:'bad code'},{...plan,amountMinor:-1}])
    assert.equal((await app.inject({method:'POST',url:'/platform-admin/api/plans',payload:bad})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:`/platform-admin/api/restaurants/${id}/owner-credentials`,payload:{newPassword:'short',reason:'support'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:`/platform-admin/api/restaurants/${id}/owner-credentials`,payload:{newPassword:'Password123!',generateTemporary:true,reason:'support'}})).statusCode,400);
  assert.equal(calls.length,1);
});
test('online entitlement issuance requires an authorized live session',async()=>{
  const service=createEntitlementService({secret:'entitlement-control-test-secret-32',authorizeSession:async()=>{throw Object.assign(new Error('Revoked'),{code:'SESSION_REQUIRED'});}});
  await assert.rejects(service.issueForSession({restaurantId:id,userId:id,deviceId:'device',validUntil:'2999-01-01'}),e=>e.code==='SESSION_REQUIRED');
});
