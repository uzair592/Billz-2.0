import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readLegacyApp,extractInlineScript,extractDeclaration} from './helpers/legacy-source.mjs';
import {buildHttpApp} from '../src/server/http/app.mjs';

test('local unlock has no derived recovery PIN or default credentials',async()=>{
 const source=extractInlineScript(await readLegacyApp());
 assert.equal(source.includes('computeRecoveryPin'),false);assert.equal(source.includes('LOCAL-DEMO-2026'),false);
 assert.equal(source.includes('openForcedPinResetModal'),false);assert.match(source,/let systemPinCode = "";/);
 const unlock=extractDeclaration(source,'function attemptUnlock()','function showAppAfterUnlock()');
 let unlocked=0;const classList={add(){},remove(){}};
 const context=vm.createContext({window:{BILLZ_MANAGED:false},pinInputBuffer:'7875',systemPinCode:'9137',safeStorageSet(){},
  showAppAfterUnlock(){unlocked++;},renderPinDots(){},document:{getElementById:()=>({classList}),querySelector:()=>({classList,offsetWidth:0})}});
 vm.runInContext(unlock+';attemptUnlock();',context);assert.equal(unlocked,0);
 context.pinInputBuffer='9137';vm.runInContext('attemptUnlock()',context);assert.equal(unlocked,1);
 context.window.BILLZ_MANAGED=true;context.pinInputBuffer='9137';vm.runInContext('attemptUnlock()',context);assert.equal(unlocked,1);
});
test('development PIN fixtures are explicit and cannot seed managed or ordinary copies',async()=>{
 const source=extractInlineScript(await readLegacyApp());const seed=extractDeclaration(source,'async function seedDevelopmentPin()','function showOnboarding()');
 for(const window of [{},{BILLZ_MANAGED:true,BILLZ_DEVELOPMENT_DEMO:true,BILLZ_DEVELOPMENT_PIN:'8429'},{BILLZ_DEVELOPMENT_DEMO:true,BILLZ_DEVELOPMENT_PIN:'8429'}]) {
  const writes=[];const ctx=vm.createContext({window,systemPinCode:'',idbGet:async()=>null,idbSet:async(...args)=>writes.push(args)});
  await vm.runInContext(seed+';seedDevelopmentPin()',ctx);
  assert.equal(writes.length,window.BILLZ_DEVELOPMENT_DEMO&&!window.BILLZ_MANAGED?2:0);
 }
});
test('served POS contains no external domains and forces development flags off',async t=>{
 const app=await buildHttpApp({authService:{},trustedOrigin:'http://localhost:3000'});t.after(()=>app.close());
 const response=await app.inject('/');assert.equal(response.statusCode,200);
 assert.equal(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(response.body),false,'external domain in served HTML');
 assert.ok(response.body.includes('window.BILLZ_DEVELOPMENT_DEMO = false'));
 for(const symbol of ['callLicenseApi','runLicenseHeartbeat','LICENSE_DEFAULT_ENDPOINT','imjalalahmad.com'])assert.equal(response.body.includes(symbol),false);
});
