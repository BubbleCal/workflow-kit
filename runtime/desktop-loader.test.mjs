import test from 'node:test';
import assert from 'node:assert/strict';
import {DesktopLoader,verifyDesktopLoader} from './desktop-loader.mjs';
import {queueHostFingerprint} from './native-queue.mjs';
import {OWNER} from './test-fixtures/reactive.mjs';

test('desktop navigation requires an explicit user request; automatic callers cannot open UI',async()=>{
  const calls=[],loader=new DesktopLoader({bundle_id:'com.openai.codex',run:async(binary,args)=>calls.push({binary,args})});
  await assert.rejects(loader.open(OWNER),/Automatic UI navigation is disabled/);assert.equal(calls.length,0);
  const result=await loader.open(OWNER,{user_requested_navigation:true});
  assert.deepEqual(calls,[{binary:'/usr/bin/open',args:['-g','-b','com.openai.codex',`codex://threads/${OWNER}`]}]);
  assert.equal(result.execution_verified,false);
  await assert.rejects(loader.open('new?prompt=execute',{user_requested_navigation:true}),/existing native thread UUID/);
  assert.throws(()=>new DesktopLoader({bundle_id:'other.application'}),/OpenAI desktop/);
});

test('desktop evidence binds host, App and unchanged native turn',()=>{
  const snapshot=type=>({polls:[{thread:{id:OWNER,hostId:'local',status:{type}},latestTurn:{id:'existing-turn',status:'completed'}}]});
  const proof={source:'codex_app.wait_threads',bundle_id:'com.openai.codex',host_fingerprint:queueHostFingerprint(),before:snapshot('notLoaded'),after:snapshot('idle')};
  assert.equal(verifyDesktopLoader(proof,'com.openai.codex').verified,true);
  assert.throws(()=>verifyDesktopLoader({...proof,host_fingerprint:'other-host'},'com.openai.codex'),/same-host/);
  proof.after.polls[0].latestTurn.id='new-turn';assert.throws(()=>verifyDesktopLoader(proof,'com.openai.codex'),/same-host/);
});

test('idle-only navigation rechecks real activity immediately before open and preserves a returning user',async()=>{
 let calls=0,reads=0;
 const policy={mode:'idle_only',authorization_ref:'actual-user',min_idle_ms:600000};
 const idle={source:'macos_hid_and_power_assertions',checked_at:1000,idle_ms:600000,user_active:false,display_busy:false};
 const loader=new DesktopLoader({bundle_id:'com.openai.codex',run:async()=>{calls++;},now:()=>1000,read_activity:async()=>{reads++;return {...idle,idle_ms:reads===1?0:600000};}});
 assert.equal((await loader.open(OWNER,{idle_policy:policy})).open_requested,false);assert.equal(calls,0);
 assert.equal((await loader.open(OWNER,{idle_policy:policy,can_open:()=>false})).open_requested,false);assert.equal(calls,0);
 assert.equal((await loader.open(OWNER,{idle_policy:policy})).open_requested,true);assert.equal(calls,1);
 const unavailable=new DesktopLoader({bundle_id:'com.openai.codex',run:async()=>{calls++;},now:()=>1000,read_activity:async()=>{throw new Error('activity unavailable');}});
 assert.equal((await unavailable.open(OWNER,{idle_policy:policy})).reason,'activity_unavailable');assert.equal(calls,1);
});
