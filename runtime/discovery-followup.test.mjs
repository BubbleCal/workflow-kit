import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {workFixture,MAIN,DISCOVERY} from './test-fixtures/work.mjs';
import {nativeProof} from './test-fixtures/reactive.mjs';
import {beginDiscoveryFollowup,beginDiscoveryInteractive,settleDiscoveryDelivery} from './discovery-followup.mjs';
import {prepareTaskOwner} from './calendar-preparation.mjs';
import {bindings} from './instance.mjs';

function setup(){
 const f=workFixture(),dir=mkdtempSync(join(tmpdir(),'discovery-relay-'));f.config.instance_root=dir;f.config.scope.project_id=bindings.scope.project_id??'project';
 f.work.setPolicy({key:'discovery_owns_creation',enabled:true,allowed_kinds:['work'],source_message_id:'human:create',verbatim_text:'Discovery creates accepted tasks',actual_human_verified:true,evidence_ref:'actual-rule'});
 const task=f.work.create({canonical_key:'actual-work',title:'Accepted work',objective:'Implement accepted scope',requirements:[{id:'done',text:'Verify result'}]}).task;f.accept(task.id);
 const q=f.c.discovery.enqueueDue({enqueue:()=>({queued:true})},dir),b=f.c.discovery.batch(q.batch_id);
 const m=new DatabaseSync(join(dir,'mailbox.sqlite'));m.exec('CREATE TABLE mail(item_key TEXT PRIMARY KEY,batch_id TEXT,state TEXT)');m.prepare("INSERT INTO mail VALUES (?,NULL,'pending')").run(b.mail_key);m.close();
 const p={thread_id:DISCOVERY,intent:'correction',source_message_id:'human:repair',source_thread_id:MAIN,source_turn_id:'human-turn',verbatim_text:'Repair workflow blockers and continue accepted work',prompt:'Process the existing accepted task using the same discovery batch'};
 const key='human:discovery-followup';f.c.db.prepare("INSERT INTO actions(action_key,kind,task_id,scope_key,digest,payload,state,owner,receipt,due,created_at,updated_at) VALUES (?,'human_input','discovery','scope','digest',?,'sent',?,?,0,?,?)").run(key,JSON.stringify(p),MAIN,JSON.stringify({outcome:'sent',native_result:{structuredContent:{threadId:DISCOVERY},isError:false}}),f.now(),f.now());
 const proof=nativeProof({thread:DISCOVERY,turn:'actual-relay-turn',now:f.now()});proof.readback.turns[0].items=[{type:'functionCallOutput',namespace:'codex_app',name:'send_message_to_thread',output:{truncated:false,text:`<codex_delegation>\n  <source_thread_id>${MAIN}</source_thread_id>\n  <input>${p.prompt}</input>\n</codex_delegation>`}}];
 const human=nativeProof({thread:MAIN,message:p.verbatim_text,turn:p.source_turn_id,now:f.now()});human.readback.turns[0].items[0].id=p.source_message_id;
 return {...f,dir,b,task,input:{batch_id:b.id,generation:b.generation,expected_mail_key:b.mail_key,action_key:key,source_message_id:p.source_message_id,actual_human_verified:true,evidence_ref:'actual-relay-proof',native_proof:proof,human_authorization:human},close(){f.c.close();rmSync(dir,{recursive:true,force:true});}};
}

test('an actual authorized discovery relay begins the same unsent batch and retains all owner creation guards',async()=>{
 const f=setup();try{
  assert.throws(()=>f.c.discovery.begin({batch_id:f.b.id,generation:f.b.generation,native_proof:f.input.native_proof}),/exact queued prompt/);
  const r=beginDiscoveryFollowup(f.c,f.input);assert.equal(r.original_queue_consumed,false);assert.equal(r.batch.id,f.b.id);assert.equal(r.batch.generation,f.b.generation);assert(r.unsent_delivery_superseded);
  const actor={thread_id:DISCOVERY,batch_id:f.b.id,generation:f.b.generation,native_proof:f.input.native_proof};
  const result=await prepareTaskOwner(f.c,{task_id:f.task.id,creation_actor:actor,projects:[{hostId:'local',projectId:f.config.scope.project_id}],project_catalog_ref:'actual-project-catalog',checked_at:new Date(f.now()).toISOString()});
  assert.equal(result.preparation.prepared,true,JSON.stringify(result.preparation));assert.equal(f.c.claim({key:result.key,owner:MAIN,evidence:result.evidence}).claimed,false);
  assert.equal(f.c.discovery.begin({batch_id:f.b.id,generation:f.b.generation,native_proof:f.input.native_proof}).state,'running');
  const late=f.c.discovery.begin({batch_id:f.b.id,generation:f.b.generation,native_proof:nativeProof({thread:DISCOVERY,message:f.b.prompt,turn:'late-original-queue',now:f.now()})});assert.equal(late.skipped,true);assert.equal(f.c.discovery.batch(f.b.id).state,'running');
  assert.equal(beginDiscoveryFollowup(f.c,f.input).batch.id,f.b.id);assert.equal(f.c.db.prepare('SELECT COUNT(*) n FROM discovery_batches').get().n,1);
 }finally{f.close();}
});

test('discovery relay rejects another generation, target, source proof, truncated message or already acknowledged writer',()=>{
 for(const change of[f=>{f.input.generation++;},f=>{f.input.expected_mail_key='other';},f=>{f.input.human_authorization.readback.turns[0].items[0].id='wrong-human';},f=>{f.input.native_proof.readback.turns[0].items[0].output.truncated=true;},f=>{f.c.db.prepare('INSERT INTO work_creation_runs VALUES (?,?,?,?)').run(f.b.id,f.b.generation,DISCOVERY,'other-acknowledged-turn');}]){
  const f=setup();try{change(f);assert.throws(()=>beginDiscoveryFollowup(f.c,f.input));assert.equal(f.c.discovery.batch(f.b.id).state,'pending');}finally{f.close();}
 }
});


test('a relay checkpoints the original batch and settles its unsent delivery without inventing queue consumption',()=>{
 const f=setup();try{
  beginDiscoveryFollowup(f.c,f.input);
  const input={batch_id:f.b.id,generation:f.b.generation,owner_creation_reason:'Original owner setup retained',source_results:f.b.snapshot.sources.map(s=>({source_id:s.source_id,complete:false,reason:'Bounded source work retained'}))};
  const result=f.c.discovery.finish(input);assert.equal(result.checkpointed,true);
  const db=new DatabaseSync(join(f.dir,'mailbox.sqlite')),mailbox={db,finish(){assert.fail('No queue was sent, so no queue may be acknowledged');}};
  try{const receipt=settleDiscoveryDelivery(f.c,mailbox,f.b,result);assert.equal(receipt.original_queue_consumed,false);assert.equal(receipt.state,'checkpointed');assert.equal(db.prepare('SELECT state FROM mail WHERE item_key=?').get(f.b.mail_key).state,'superseded');assert.deepEqual(settleDiscoveryDelivery(f.c,mailbox,f.b,result),receipt);assert.equal(f.c.discovery.finish(input).duplicate,true);
   db.prepare("UPDATE mail SET state='pending'").run();assert.throws(()=>settleDiscoveryDelivery(f.c,mailbox,f.b,result),/authenticated superseded/);
  }finally{db.close();}
 }finally{f.close();}
});

test('an actual direct human correction can acknowledge the unchanged pending scan without a fabricated queued message',async()=>{
 const f=setup();try{
  const text='Find the missing direct work requests',proof=nativeProof({thread:DISCOVERY,turn:'actual-human-correction',message:text,now:f.now()});proof.readback.turns[0].items[0].id='actual-human-message';
  const input={batch_id:f.b.id,generation:f.b.generation,expected_mail_key:f.b.mail_key,actual_human_verified:true,source_message_id:'actual-human-message',verbatim_text:text,evidence_ref:'actual-human-correction-proof',native_proof:proof};
  const original=f.c.discovery.batch(f.b.id).snapshot,ack=beginDiscoveryInteractive(f.c,input);assert.equal(ack.original_queue_consumed,false);assert.equal(ack.turn_id,'actual-human-correction');
  assert.deepEqual(f.c.discovery.batch(f.b.id).snapshot,original);
  const actor={thread_id:DISCOVERY,batch_id:f.b.id,generation:f.b.generation,native_proof:proof};
  assert.equal((await prepareTaskOwner(f.c,{task_id:f.task.id,creation_actor:actor,projects:[{hostId:'local',projectId:f.config.scope.project_id}],project_catalog_ref:'actual-project-catalog',checked_at:new Date(f.now()).toISOString()})).preparation.prepared,true);
  const result=f.c.discovery.finish({batch_id:f.b.id,generation:f.b.generation,source_results:[],owner_creation_reason:'Preserve actual setup blocker'});assert(result.checkpointed);
  const db=new DatabaseSync(join(f.dir,'mailbox.sqlite'));try{const settlement=settleDiscoveryDelivery(f.c,{db},f.b,result);assert.equal(settlement.transport,'direct_human');assert.equal(settlement.original_queue_consumed,false);}finally{db.close();}
 }finally{f.close();}
});

test('direct discovery acknowledgement rejects machine prompts, wrong identities, stale proofs and another writer',()=>{
 const changes=[f=>{f.input.actual_human_verified=false;},f=>{f.input.source_message_id='wrong-message';},f=>{f.input.native_proof.readback.thread.cwd='/other';},f=>{f.advance(61000);},f=>{f.input.verbatim_text='[workflow-discovery:machine]';f.input.native_proof.readback.turns[0].items[0].content[0].text=f.input.verbatim_text;},f=>{f.c.db.prepare('INSERT INTO work_creation_runs VALUES (?,?,?,?)').run(f.b.id,f.b.generation,DISCOVERY,'another-writer');}];
 for(const change of changes){const f=setup();try{const text='Find missing professional work';f.input={batch_id:f.b.id,generation:f.b.generation,expected_mail_key:f.b.mail_key,source_message_id:'human:correction',verbatim_text:text,actual_human_verified:true,evidence_ref:'actual-direct-proof',native_proof:nativeProof({thread:DISCOVERY,message:text,now:f.now()})};f.input.native_proof.readback.turns[0].items[0].id='human:correction';change(f);assert.throws(()=>beginDiscoveryInteractive(f.c,f.input));assert.equal(f.c.discovery.batch(f.b.id).state,'pending');}finally{f.close();}}
});


test('a direct human correction resumes the original checkpoint in a new generation without replacing windows or old delivery evidence',()=>{
 const f=setup();try{
  f.c.discovery.begin({batch_id:f.b.id,generation:f.b.generation,native_proof:nativeProof({thread:DISCOVERY,message:f.b.prompt,turn:'old-scan-turn',now:f.now()})});
  f.c.discovery.finish({batch_id:f.b.id,generation:f.b.generation,source_results:[],owner_creation_reason:'Saved real setup blocker'});
  const original=f.c.discovery.batch(f.b.id),text='Find missing directed work',proof=nativeProof({thread:DISCOVERY,message:text,turn:'actual-new-human-turn',now:f.now()});proof.readback.turns[0].items[0].id='human:missing';
  const input={batch_id:f.b.id,generation:f.b.generation,expected_mail_key:f.b.mail_key,source_message_id:'human:missing',verbatim_text:text,actual_human_verified:true,evidence_ref:'actual-current-direct-proof',native_proof:proof};
  const result=beginDiscoveryInteractive(f.c,input);assert.equal(result.generation,2);assert(result.resumed_checkpoint);assert.equal(result.original_queue_consumed,false);
  assert.deepEqual(f.c.discovery.batch(f.b.id).snapshot,original.snapshot);assert.equal(f.c.discovery.batch(f.b.id).pages.length,original.pages.length);
  assert.equal(f.c.db.prepare('SELECT COUNT(*) n FROM discovery_batches').get().n,1);
  assert.throws(()=>beginDiscoveryInteractive(f.c,input),/identity/);
  const end=f.c.discovery.finish({batch_id:f.b.id,generation:result.generation,source_results:[],owner_creation_reason:'Remaining actual setup blocker'});
  const db=new DatabaseSync(join(f.dir,'mailbox.sqlite'));try{const receipt=settleDiscoveryDelivery(f.c,{db},f.c.discovery.batch(f.b.id),end);assert.equal(receipt.transport,'direct_human');assert.equal(receipt.original_queue_consumed,false);}finally{db.close();}
 }finally{f.close();}
});


test('interactive checkpoint recovery preserves the single-writer invariant and reports an actionable earlier-pending-batch prerequisite',()=>{
 const f=setup();try{
  f.c.discovery.begin({batch_id:f.b.id,generation:1,native_proof:nativeProof({thread:DISCOVERY,message:f.b.prompt,turn:'old-scan-turn',now:f.now()})});
  f.c.discovery.finish({batch_id:f.b.id,generation:1,source_results:[],owner_creation_reason:'Real retained setup blocker'});
  const other=f.work.create({canonical_key:'second-human-work',title:'Second task',objective:'Independent accepted work',requirements:[{id:'done',text:'Existing acceptance'}]}).task;f.work.accept({task_id:other.id,actual_human_verified:true,source_message_id:'human:other',evidence_ref:'actual-other',start_requested:true});
  const pending=f.c.discovery.enqueueDue({enqueue:()=>({queued:true})},f.dir);assert.notEqual(pending.batch_id,f.b.id);
  const snapshot=f.c.db.prepare('SELECT snapshot FROM discovery_batches WHERE id=?').get(pending.batch_id).snapshot,text='Find missed work',proof=nativeProof({thread:DISCOVERY,message:text,turn:'actual-correction-turn',now:f.now()});proof.readback.turns[0].items[0].id='human:correction';
  assert.throws(()=>beginDiscoveryInteractive(f.c,{batch_id:f.b.id,generation:1,expected_mail_key:f.b.mail_key,source_message_id:'human:correction',verbatim_text:text,actual_human_verified:true,evidence_ref:'real-human-proof',native_proof:proof}),/first acknowledging and checkpointing/);
  assert.equal(f.c.discovery.batch(f.b.id).state,'checkpointed');assert.equal(f.c.discovery.batch(f.b.id).generation,1);assert.equal(f.c.db.prepare('SELECT snapshot FROM discovery_batches WHERE id=?').get(pending.batch_id).snapshot,snapshot);assert.equal(f.c.discovery.batch(pending.batch_id).state,'pending');
 }finally{f.close();}
});

test('an interrupted direct-human scan recovers its exact native turn and pages without inventing queue consumption',()=>{
 const f=setup();try{
  const text='Find the missed direct requests',proof=nativeProof({thread:DISCOVERY,message:text,turn:'actual-direct-intake',now:f.now()});proof.readback.turns[0].items[0].id='actual:correction';
  beginDiscoveryInteractive(f.c,{batch_id:f.b.id,generation:1,expected_mail_key:f.b.mail_key,source_message_id:'actual:correction',verbatim_text:text,actual_human_verified:true,evidence_ref:'actual-direct-proof',native_proof:proof});
  const input={batch_id:f.b.id,generation:1,native_proof:proof,effects_reconciled:true,evidence_ref:'actual-terminal-proof'};
  assert.throws(()=>f.c.discovery.recover(input),/terminal/);
  proof.readback.turns[0].status='interrupted';proof.readback.thread.status.type='notLoaded';
  const wrong=structuredClone(input);wrong.native_proof.readback.turns[0].id='another-turn';assert.throws(()=>f.c.discovery.recover(wrong),/another verified/);
  const original=f.c.discovery.batch(f.b.id).snapshot,r=f.c.discovery.recover(input);assert.equal(r.recovered,true);assert.equal(f.c.discovery.batch(f.b.id).state,'checkpointed');assert.deepEqual(f.c.discovery.batch(f.b.id).snapshot,original);
  const db=new DatabaseSync(join(f.dir,'mailbox.sqlite'));try{assert.equal(settleDiscoveryDelivery(f.c,{db},f.b,r).original_queue_consumed,false);}finally{db.close();}
 }finally{f.close();}
});
