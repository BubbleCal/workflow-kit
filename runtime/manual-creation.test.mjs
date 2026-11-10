import test from 'node:test';
import assert from 'node:assert/strict';
import {workFixture,MAIN,DISCOVERY} from './test-fixtures/work.mjs';
import {nativeProof,OWNER} from './test-fixtures/reactive.mjs';
import {prepareTaskOwner} from './calendar-preparation.mjs';
import {bindings} from './instance.mjs';

function setup(){
 const f=workFixture();f.config.scope.project_id=bindings.scope.project_id??'project';
 f.work.setPolicy({key:'discovery_owns_creation',enabled:true,allowed_kinds:['work'],source_message_id:'human:roles',verbatim_text:'Main registers; discovery creates accepted owners',actual_human_verified:true,evidence_ref:'actual-role-request'});
 const old=f.work.create({canonical_key:'older-source-work',title:'Older work',objective:'Preserve original source setup',requirements:[{id:'done',text:'Existing scope'}]}).task;f.accept(old.id);
 const q=f.c.discovery.enqueueDue({enqueue:()=>({queued:true})},'/instance'),oldBatch=f.c.discovery.batch(q.batch_id);
 const source={kind:'user',source_thread_id:MAIN,source_turn_id:'human-turn',source_message_id:'human:new-task',verbatim_text:'Create a bounded research task',evidence_ref:'actual-new-task'};
 const task=f.work.create({canonical_key:'research:manual',title:'Bounded research',objective:'Investigate only the accepted scope',workspace:'/task',requirements:[{id:'done',text:'Deliver evidence'}],source}).task;
 f.work.accept({task_id:task.id,source_message_id:source.source_message_id,actual_human_verified:true,evidence_ref:source.evidence_ref,start_requested:true});
 const trigger=f.work.creation.triggers()[0];
 const payload={thread_id:DISCOVERY,intent:'correction',...source,prompt:`Start ${task.id} canonical ${task.canonical_key} under the actual human request`};
 const key='human:new-task:relay';f.c.db.prepare("INSERT INTO actions(action_key,kind,task_id,scope_key,digest,payload,state,owner,receipt,due,created_at,updated_at) VALUES (?,'human_input','discovery','scope','digest',?,'sent',?,?,0,?,?)").run(key,JSON.stringify(payload),MAIN,JSON.stringify({outcome:'sent',native_result:{structuredContent:{threadId:DISCOVERY},isError:false}}),f.now(),f.now());
 const proof=nativeProof({thread:DISCOVERY,turn:'manual-relay-turn',now:f.now()});proof.readback.turns[0].items=[{type:'functionCallOutput',namespace:'codex_app',name:'send_message_to_thread',output:{truncated:false,text:`<codex_delegation>\n  <source_thread_id>${MAIN}</source_thread_id>\n  <input>${payload.prompt}</input>\n</codex_delegation>`}}];
 const human=nativeProof({thread:MAIN,turn:source.source_turn_id,message:source.verbatim_text,now:f.now()});human.readback.turns[0].items[0].id=source.source_message_id;
 return {...f,task,oldBatch,input:{task_id:task.id,trigger_key:trigger.trigger_key,action_key:key,source_message_id:source.source_message_id,evidence_ref:'actual-native-relay',native_proof:proof,human_authorization:human},actor:{thread_id:DISCOVERY,trigger_key:trigger.trigger_key,native_proof:proof}};
}

test('a real manual request creates, binds and starts once without entering or rewriting an unrelated pending scan',async()=>{
 const f=setup();try{
  const before=f.c.db.prepare('SELECT * FROM discovery_batches WHERE id=?').get(f.oldBatch.id);assert(!f.oldBatch.snapshot.creation_work?.task_ids?.includes(f.task.id));
  assert.throws(()=>f.work.requestOwner({task_id:f.task.id,creation_actor:f.actor}),/manual_creation/);
  const ack=f.work.creation.beginManual(f.input);assert.equal(ack.turn_id,'manual-relay-turn');assert.equal(ack.original_queue_consumed,false);
  assert.equal(f.work.creation.beginManual(f.input).already_begun,true);
  const project={projects:[{hostId:'local',projectId:f.config.scope.project_id}],project_catalog_ref:'actual-projects',checked_at:new Date(f.now()).toISOString()};
  const p=await prepareTaskOwner(f.c,{task_id:f.task.id,creation_actor:f.actor,...project});assert.equal(p.preparation.prepared,true,JSON.stringify(p.preparation));
  assert.equal(f.c.claim({key:p.key,owner:MAIN,evidence:p.evidence}).claimed,false);
  const claim=f.c.claim({key:p.key,owner:DISCOVERY,evidence:p.evidence});assert(claim.claimed,JSON.stringify(claim));
  f.c.settle({key:p.key,attempt_id:claim.attempt_id,outcome:'sent',evidence_ref:'actual-create',native_result:{threadId:OWNER,hostId:'local'}});
  f.c.confirmCreation({key:p.key,snapshot:{id:OWNER,hostId:'local',projectId:f.config.scope.project_id},source:'list_threads',verified_at:new Date(f.now()).toISOString(),evidence_ref:'actual-project-readback'});
  f.work.bindOwner({task_id:f.task.id,owner_thread_id:OWNER,creation_action_key:p.key,creation_actor:f.actor,evidence_ref:'actual-binding',native_binding:nativeProof({thread:OWNER,status:'completed',now:f.now()})});
  f.work.start(f.c.reactive,{task_id:f.task.id,creation_actor:f.actor,queue_compatibility_verified:true});assert.equal(f.work.creation.executed(f.work.get(f.task.id)),undefined);
  const w=f.c.reactive.reserveQueuedWake(f.task.id).wake,prompt=`[workflow-event:${w.id}] accepted research`;
  f.c.db.prepare("UPDATE rt_wakes SET state='queued',queue_id='real-queue',prompt=? WHERE id=?").run(prompt,w.id);
  f.c.reactive.begin({task_id:f.task.id,wake_id:w.id,native_proof:nativeProof({thread:OWNER,message:prompt,turn:'research-owner-turn',now:f.now()})});
  assert.equal(f.work.creation.executed(f.work.get(f.task.id)).turn_id,'research-owner-turn');
  assert.deepEqual(f.c.db.prepare('SELECT * FROM discovery_batches WHERE id=?').get(f.oldBatch.id),before);
  assert.equal(f.c.db.prepare('SELECT COUNT(*) n FROM work_owner_requests').get().n,1);assert.equal(f.c.db.prepare("SELECT COUNT(*) n FROM actions WHERE kind='create_thread'").get().n,1);
  assert.equal(f.work.creation.triggers().length,0);
 }finally{f.c.close();}
});

test('manual setup rejects forged, stale, wrong-scope and non-human relay authority without consuming the trigger',()=>{
 const changes=[
  f=>{f.input.human_authorization.readback.turns[0].items[0].id='wrong-human';},
  f=>{f.input.native_proof.readback.turns[0].items[0].output.truncated=true;},
  f=>{f.input.native_proof.readback.thread.cwd='/different';},
  f=>{f.advance(61000);},
  f=>{f.input.trigger_key='other-trigger';},
  f=>{f.c.db.prepare("UPDATE actions SET state='uncertain' WHERE action_key=?").run(f.input.action_key);},
  f=>{f.c.db.prepare('UPDATE actions SET owner=? WHERE action_key=?').run(OWNER,f.input.action_key);},
  f=>{f.c.db.prepare("UPDATE work_items SET state='candidate' WHERE id=?").run(f.task.id);},
  f=>{const t=f.work.get(f.task.id);t.data.source.source_message_id='different-request';f.c.db.prepare('UPDATE work_items SET data=? WHERE id=?').run(JSON.stringify(t.data),t.id);},
  f=>{f.input.native_proof.readback.turns[0].status='completed';f.input.native_proof.readback.thread.status.type='idle';},
 ];
 for(const change of changes){const f=setup();try{change(f);assert.throws(()=>f.work.creation.beginManual(f.input));assert.equal(f.c.db.prepare("SELECT state FROM work_creation_triggers WHERE task_id=?").get(f.task.id).state,'pending');assert.equal(f.c.db.prepare('SELECT COUNT(*) n FROM work_owner_requests').get().n,0);}finally{f.c.close();}}
});

test('acknowledged manual setup retains its actor and uncertain creation receipt; changed scope and stale actor fail closed',async()=>{
 const f=setup();try{
  f.work.creation.beginManual(f.input);
  const p=await prepareTaskOwner(f.c,{task_id:f.task.id,creation_actor:f.actor,projects:[{hostId:'local',projectId:f.config.scope.project_id}],project_catalog_ref:'actual-projects',checked_at:new Date(f.now()).toISOString()});
  const claim=f.c.claim({key:p.key,owner:DISCOVERY,evidence:p.evidence});assert(claim.claimed);f.c.settle({key:p.key,attempt_id:claim.attempt_id,outcome:'uncertain',evidence_ref:'lost-native-result'});
  assert.equal((await prepareTaskOwner(f.c,{task_id:f.task.id,creation_actor:f.actor,projects:[{hostId:'local',projectId:f.config.scope.project_id}],project_catalog_ref:'actual-projects',checked_at:new Date(f.now()).toISOString()})).state,'uncertain');
  assert.equal(f.c.db.prepare("SELECT COUNT(*) n FROM actions WHERE kind='create_thread'").get().n,1);
  const proof=structuredClone(f.actor.native_proof);proof.readback.turns[0].id='other-turn';assert.throws(()=>f.work.creation.actor(f.task.id,{...f.actor,native_proof:proof}),/turn_changed/);
  const t=f.work.get(f.task.id);t.data.objective='Different scope';f.c.db.prepare('UPDATE work_items SET data=? WHERE id=?').run(JSON.stringify(t.data),t.id);assert.throws(()=>f.work.creation.actor(t.id,f.actor),/scope_changed/);
 }finally{f.c.close();}
});


test('manual requests preserve another acknowledged discovery writer and cannot attach a scan identity',()=>{
 const f=setup();try{
  f.c.discovery.begin({batch_id:f.oldBatch.id,generation:f.oldBatch.generation,native_proof:nativeProof({thread:DISCOVERY,message:f.oldBatch.prompt,turn:'existing-scan-turn',now:f.now()})});
  assert.throws(()=>f.work.creation.beginManual(f.input),/existing_owner_and_writer/);
  assert.equal(f.c.db.prepare('SELECT state FROM work_creation_triggers WHERE trigger_key=?').get(f.input.trigger_key).state,'pending');
  f.c.db.prepare("UPDATE discovery_batches SET state='checkpointed' WHERE id=?").run(f.oldBatch.id);
  f.work.creation.beginManual(f.input);assert.throws(()=>f.work.creation.actor(f.task.id,{...f.actor,batch_id:f.oldBatch.id,generation:f.oldBatch.generation}),/must_not_rewrite_scan/);
 }finally{f.c.close();}
});
