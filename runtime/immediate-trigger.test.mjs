import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox, COORDINATOR } from './mailbox.mjs';
import { ControlStore, routeControlPreparation, INBOX } from './control.mjs';

const NOW=Date.parse('2026-11-04T12:00:00Z'),dispatcher='dispatcher';
function setup() {
  const registry={coordinator_thread_id:COORDINATOR,queue_transport:{dispatcher_thread_id:dispatcher,immediate_human_trigger:{enabled:true,source_message_id:'actual-rule'}},task_registry:{items:{}}};
  return {registry,m:new Mailbox(':memory:',{now:()=>NOW,taskRegistry:()=>registry}),c:new ControlStore(':memory:',{now:()=>NOW,taskRegistry:()=>registry})};
}
function input(id='human') {return {key:`admit:${id}`,kind:'human_input',task_id:'T-001',payload:{thread_id:COORDINATOR,source_thread_id:INBOX,source_message_id:id,verbatim_text:'Continue authorized work'},evidence:{verified_at:new Date(NOW).toISOString(),scope_authorized:true,authorization_ref:'actual-human-source',policy_version:'v',current_policy_version:'v',stopped:false,actual_human_message_verified:true,source_actor_verified:true,source_message_id:id,source_text:'Continue authorized work',input_already_delivered:false,owner_matches:true,owner_thread_id:COORDINATOR,thread_status:'active'}};}
const snapshot=(type='idle',turn='before')=>({checked_at:new Date(NOW).toISOString(),thread:{id:dispatcher,status:{type,activeFlags:[]}},latestTurn:{id:turn,status:type==='idle'?'completed':'inProgress'}});
const enqueue=(x,id='human')=>routeControlPreparation(input(id),x.c,x.m,NOW);
const close=x=>{x.c.close();x.m.close();};

test('a live native control runtime replaces the manual dispatcher but admission is still evidenced',()=>{
  const x=setup();try{
    enqueue(x);x.m.immediate.nativeControlRuntime=()=>true;
    assert.equal(x.m.immediate.invocation('human',snapshot(),x.c).reason,'native_queue_control_runtime');
    assert.equal(x.m.immediate.status('human')[0].covered,false);
    const batch=x.m.reserveQueuedLane('coordinator').batch;
    assert.equal(x.m.immediate.status('human')[0].coverage.batch_id,batch.id);
    assert.equal(x.m.immediate.status('human')[0].coverage.execution_verified,false);
    assert.equal(x.c.db.prepare("SELECT COUNT(*) n FROM actions WHERE action_key LIKE 'human-trigger:%'").get().n,0);
  }finally{close(x);}
});

test('actual human admission returns an immediate guarded native call and durable receipt exactly once',()=>{
  const x=setup(),r=enqueue(x);assert.equal(r.immediate_trigger[0].source_message_id,'human');
  assert.equal(x.m.immediate.invocation('human',snapshot(),x.c).prepared,true);
  const claim=x.m.immediate.invocation('human',snapshot(),x.c,true);assert.equal(claim.send,true);
  assert.deepEqual(Object.keys(claim.native_arguments).sort(),['hostId','prompt','threadId']);
  assert.equal(claim.native_arguments.threadId,dispatcher);assert.match(claim.native_arguments.prompt,/workflow-human-trigger:human/);
  x.c.settle({key:claim.key,attempt_id:claim.attempt_id,outcome:'sent',evidence_ref:'actual-native-tool-receipt'});
  assert.equal(x.m.immediate.invocation('human',snapshot(),x.c).reason,'already_invoked');
  enqueue(x);assert.equal(x.m.db.prepare('SELECT COUNT(*) n FROM immediate_human_triggers').get().n,1);
  assert.equal(x.c.db.prepare("SELECT attempts FROM actions WHERE action_key=?").get(claim.key).attempts,1);close(x);
});
test('busy dispatcher coalesces; coverage requires a real plan watermark and late arrivals remain pending',()=>{
  const x=setup();enqueue(x,'first');
  assert.equal(x.m.immediate.invocation('first',snapshot('active'),x.c).coalesced,true);
  assert.equal(x.c.db.prepare("SELECT COUNT(*) n FROM actions WHERE action_key LIKE 'human-trigger:%'").get().n,0);
  const watermark=x.m.db.prepare('SELECT MAX(seq) n FROM mail').get().n;enqueue(x,'late');
  assert.deepEqual(x.m.immediate.cover(watermark,{coordinator_snapshot_verified:false}).covered,[]);
  assert.deepEqual(x.m.immediate.cover(watermark,{coordinator_snapshot_verified:true,reason:'coordinator_busy'}).covered,['first']);
  assert.equal(x.m.immediate.status('late')[0].covered,false);
  assert.equal(x.m.immediate.invocation('first',snapshot(),x.c).reason,'already_observed');
  assert.equal(x.m.immediate.invocation('late',snapshot(),x.c).prepared,true);close(x);
});
test('changed or busy second snapshot cannot start an overlapping trigger',()=>{
  const x=setup();enqueue(x);x.m.immediate.invocation('human',snapshot(),x.c);
  assert.equal(x.m.immediate.invocation('human',snapshot('active'),x.c,true).send,false);
  assert.equal(x.m.immediate.invocation('human',snapshot('idle','different'),x.c,true).reason,'fresh_matching_second_snapshot_required');
  assert.equal(x.m.immediate.invocation('human',{...snapshot(),thread:{id:'unrelated-worker',status:{type:'idle'}}},x.c,true).send,false);close(x);
});
test('uncertain transport is retained even if another round covers the work',()=>{
  const x=setup();enqueue(x);x.m.immediate.invocation('human',snapshot(),x.c);const claim=x.m.immediate.invocation('human',snapshot(),x.c,true);
  x.c.settle({key:claim.key,attempt_id:claim.attempt_id,outcome:'uncertain',evidence_ref:'tool-timeout'});
  x.m.immediate.cover(100,{coordinator_snapshot_verified:true});
  assert.equal(x.m.immediate.status('human',x.c)[0].transport.state,'uncertain');
  assert.equal(x.m.immediate.invocation('human',snapshot(),x.c).reason,'reconcile_uncertain_native_invocation');close(x);
});
test('informational and machine input never cause immediate invocation',()=>{
  const x=setup(),i=input();i.payload.action_required=false;assert.equal(routeControlPreparation(i,x.c,x.m,NOW).immediate_trigger,undefined);
  x.m.enqueue({key:'machine',lane:'coordinator',kind:'event',payload:{event:'periodic'}});
  assert.equal(x.m.immediate.status().length,0);
  assert.throws(()=>x.m.enqueue({key:'fake',lane:'coordinator',kind:'event',payload:{source_message_id:'fake'},human_trigger:{actual_human_message_verified:true,source_actor_verified:true}}),/authenticated human/);
  assert.equal(x.m.db.prepare("SELECT COUNT(*) n FROM mail WHERE item_key='fake'").get().n,0);close(x);
});
test('already consumed actual source is reconciled without a second native wake',()=>{
  const x=setup(),i=input();x.registry.queue_transport.immediate_human_trigger.enabled=false;routeControlPreparation(i,x.c,x.m,NOW);
  x.m.db.prepare("UPDATE mail SET state='acknowledged',completed_at=? WHERE item_key=?").run(NOW,i.key);
  x.registry.queue_transport.immediate_human_trigger.enabled=true;const result=routeControlPreparation(i,x.c,x.m,NOW);
  assert.equal(result.immediate_trigger[0].covered,true);assert.equal(x.m.immediate.invocation('human',snapshot(),x.c).send,false);close(x);
});
test('replaying an older consumed envelope does not cover a later admission from the same source',()=>{
  const x=setup();enqueue(x);const first=x.m.db.prepare('SELECT * FROM mail').get();
  const proof={actual_human_message_verified:true,source_actor_verified:true,source_message_id:'human'};
  x.m.enqueue({key:'second-envelope',lane:'coordinator',kind:'human_command',payload:JSON.parse(first.payload),human_trigger:proof});
  x.m.atomic(()=>x.m.immediate.admit({...first,state:'acknowledged',completed_at:NOW},proof));
  assert.equal(x.m.immediate.status('human')[0].covered,false);close(x);
});
