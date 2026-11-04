import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeQueue,validateQueueCompatibility,verifyExecutionProof,verifyNativeBinding} from './native-queue.mjs';
import {OWNER,QUEUE_ID,NOW,compatibilityFixture,nativeProof} from './test-fixtures/reactive.mjs';

test('unloaded owners require a fresh unarchived listing and terminal native turn',()=>{
  const proof=nativeProof({status:'completed'});proof.readback.thread.status.type='notLoaded';
  const verify=()=>verifyNativeBinding(proof,{thread_id:OWNER,workspace:'/task',now:NOW});
  assert.throws(verify,/identity\/workspace/);
  proof.active_listing={source:'codex_app.list_threads',checked_at:new Date(NOW).toISOString(),request:{mode:'history',archived:false},readback:{threads:[{id:OWNER,kind:'codex',hostId:'local',cwd:'/task'}]}};
  assert.equal(verify().verified,true);
  proof.active_listing.request.archived=true;assert.throws(verify,/identity\/workspace/);
  proof.active_listing.request.archived=false;proof.readback.turns[0].status='inProgress';assert.throws(verify,/identity\/workspace/);
});

test('the native adapter only uses fixed queue arguments and records acceptance separately from execution',async()=>{
  let called;const q=new NativeQueue({run:async(binary,args)=>{called={binary,args};return {stdout:`Queued message ${QUEUE_ID} for thread ${OWNER}.\n`};},now:()=>NOW});
  const message='A native queue message with spaces and `literal code`';const result=await q.enqueue(OWNER,message);
  assert.deepEqual(called,{binary:'codex',args:['queue','--thread',OWNER,'--message',message]});
  assert.equal(result.queued,true);assert.equal(result.execution_verified,false);assert.equal(result.queue_id,QUEUE_ID);
});
test('invalid targets are rejected before spawning, and uncertain subprocess outcomes are never retried',async()=>{
  let calls=0;const q=new NativeQueue({run:async()=>{calls++;throw new Error('timeout after submission');}});
  await assert.rejects(()=>q.enqueue('same title','message'),e=>e.not_sent===true);assert.equal(calls,0);
  await assert.rejects(()=>q.enqueue(OWNER,'message'),e=>e.uncertain===true&&e.not_sent!==true);assert.equal(calls,1);
});
test('an exit-zero response without the exact matching queue receipt remains uncertain',async()=>{
  for(const stdout of ['Done','Queued message invalid for thread invalid.',`Queued message ${QUEUE_ID} for thread ${QUEUE_ID}.`]){
    const q=new NativeQueue({run:async()=>({stdout})});await assert.rejects(()=>q.enqueue(OWNER,'message'),e=>e.uncertain===true);
  }
});
test('capability approval requires actual idle and busy native consumption rather than a CLI ACK',()=>{
  const evidence=compatibilityFixture(),probe={cli_version:'codex-cli fixture',host_fingerprint:'fixture-host'};
  assert.equal(validateQueueCompatibility(evidence,probe).verified,true);
  for(const modify of [e=>e.cases.pop(),e=>e.cases[0].readback.turns=[],e=>e.cases[1].readback.turns[1].status='interrupted',
    e=>e.cases[1].readback.turns[0].startedAt=NOW/1000+5,e=>e.cases[0].readback.turns.push(e.cases[0].readback.turns[0]),
    e=>e.cases[1].readback.turns[1].items.at(-1).text='DID_NOT_FINISH']){
    const changed=structuredClone(evidence);modify(changed);assert.throws(()=>validateQueueCompatibility(changed,probe));
  }
  assert.throws(()=>validateQueueCompatibility(evidence,{...probe,cli_version:'another version'}),/match this host/);
  assert.throws(()=>validateQueueCompatibility(evidence,{...probe,host_fingerprint:'another host'}),/match this host/);
});
test('receiver proof binds the exact executing native message, thread, cwd and fresh time',()=>{
  const message='Exact workflow event',proof=nativeProof({message});
  const expected={thread_id:OWNER,workspace:'/task',prompt:message,now:NOW};
  assert.equal(verifyExecutionProof(proof,expected).turn_id,'native-turn');
  assert.equal(verifyExecutionProof({...proof,readback:{content:[{type:'text',text:JSON.stringify(proof.readback)}]}},expected).turn_id,'native-turn');
  for(const patch of [{thread_id:QUEUE_ID},{workspace:'/another'},{prompt:'Different instruction'},{now:NOW+60001}])
    assert.throws(()=>verifyExecutionProof(proof,{...expected,...patch}));
  const ended=nativeProof({message,status:'completed'});assert.throws(()=>verifyExecutionProof(ended,expected),/current executing/);
  assert.equal(verifyExecutionProof(ended,{...expected,terminal:true}).status,'completed');
});
