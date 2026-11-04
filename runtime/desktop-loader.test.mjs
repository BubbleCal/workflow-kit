import test from 'node:test';
import assert from 'node:assert/strict';
import {DesktopLoader,verifyDesktopLoader} from './desktop-loader.mjs';
import {queueHostFingerprint} from './native-queue.mjs';
import {OWNER} from './test-fixtures/reactive.mjs';

test('desktop loading uses only the verified App and existing-chat deep link',async()=>{
  const calls=[],loader=new DesktopLoader({bundle_id:'com.openai.codex',run:async(binary,args)=>calls.push({binary,args})});
  const result=await loader.open(OWNER);
  assert.deepEqual(calls,[{binary:'/usr/bin/open',args:['-g','-b','com.openai.codex',`codex://threads/${OWNER}`]}]);
  assert.equal(result.execution_verified,false);
  await assert.rejects(loader.open('new?prompt=execute'),/existing native thread UUID/);
  assert.throws(()=>new DesktopLoader({bundle_id:'other.application'}),/OpenAI desktop/);
});

test('desktop evidence binds host, App and unchanged native turn',()=>{
  const snapshot=type=>({polls:[{thread:{id:OWNER,hostId:'local',status:{type}},latestTurn:{id:'existing-turn',status:'completed'}}]});
  const proof={source:'codex_app.wait_threads',bundle_id:'com.openai.codex',host_fingerprint:queueHostFingerprint(),before:snapshot('notLoaded'),after:snapshot('idle')};
  assert.equal(verifyDesktopLoader(proof,'com.openai.codex').verified,true);
  assert.throws(()=>verifyDesktopLoader({...proof,host_fingerprint:'other-host'},'com.openai.codex'),/same-host/);
  proof.after.polls[0].latestTurn.id='new-turn';assert.throws(()=>verifyDesktopLoader(proof,'com.openai.codex'),/same-host/);
});
