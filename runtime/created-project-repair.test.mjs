import test from 'node:test';
import assert from 'node:assert/strict';
import {workFixture,MAIN,DISCOVERY} from './test-fixtures/work.mjs';
import {nativeProof,OWNER} from './test-fixtures/reactive.mjs';
import {bindings} from './instance.mjs';
import {prepareTaskOwner} from './calendar-preparation.mjs';
import {reconcileAcceptedSource} from './created-project-repair.mjs';

async function setup(){
 const f=workFixture();f.config.scope.project_id=bindings.scope.project_id??'project';
 f.work.setPolicy({key:'discovery_owns_creation',enabled:true,allowed_kinds:['work'],actual_human_verified:true,source_message_id:'roles',verbatim_text:'Discovery creates accepted task owners',evidence_ref:'actual-role-policy'});
 const source={kind:'user',url:'https://example.com/issue/1',source_thread_id:MAIN,source_turn_id:'original-human-turn',source_message_id:'original-human',verbatim_text:'Start this specific implementation task'};
 const t=f.work.create({canonical_key:'issue:1',title:'Original implementation',workspace:'/task',objective:'Fix input invalidation',source,requirements:[{id:'done',text:'Correctness acceptance'}]}).task;
 f.work.accept({task_id:t.id,source_message_id:source.source_message_id,actual_human_verified:true,evidence_ref:'actual-request',start_requested:true});
 const trigger=f.work.creation.triggers()[0],relay={thread_id:DISCOVERY,intent:'correction',...source,prompt:`Start ${t.id} ${t.canonical_key}`},key='main-original-task-relay';
 f.c.db.prepare("INSERT INTO actions(action_key,kind,task_id,scope_key,digest,payload,state,owner,receipt,due,created_at,updated_at) VALUES (?,'human_input','discovery','scope','digest',?,'sent',?,?,0,?,?)").run(key,JSON.stringify(relay),MAIN,JSON.stringify({outcome:'sent',native_result:{structuredContent:{threadId:DISCOVERY}}}),f.now(),f.now());
 const proof=nativeProof({thread:DISCOVERY,turn:'discovery-native-turn',now:f.now()});proof.readback.turns[0].items=[{type:'functionCallOutput',namespace:'codex_app',name:'send_message_to_thread',output:{truncated:false,text:`<codex_delegation>\n  <source_thread_id>${MAIN}</source_thread_id>\n  <input>${relay.prompt}</input>\n</codex_delegation>`}}];
 const human=nativeProof({thread:MAIN,turn:source.source_turn_id,message:source.verbatim_text,now:f.now()});human.readback.turns[0].items[0].id=source.source_message_id;
 f.work.creation.beginManual({task_id:t.id,trigger_key:trigger.trigger_key,action_key:key,source_message_id:source.source_message_id,evidence_ref:'actual-relay',native_proof:proof,human_authorization:human});
 const actor={thread_id:DISCOVERY,trigger_key:trigger.trigger_key,native_proof:proof},project=f.config.scope.project_id;
 const p=await prepareTaskOwner(f.c,{task_id:t.id,creation_actor:actor,projects:[{hostId:'local',projectId:project}],project_catalog_ref:'actual-project',checked_at:new Date(f.now()).toISOString()});
 const claim=f.c.claim({key:p.key,owner:DISCOVERY,evidence:p.evidence});assert(claim.claimed);
 f.c.settle({key:p.key,attempt_id:claim.attempt_id,outcome:'sent',evidence_ref:'original-create',native_result:{threadId:OWNER,hostId:'local'}});
 const repair={key:`project-repair:${p.key}`,kind:'repair_created_project',task_id:t.id,payload:{creation_key:p.key,thread_id:OWNER,host_id:'local',project_id:project},evidence:{verified_at:new Date(f.now()).toISOString(),scope_authorized:true,authorization_ref:'actual-request',policy_version:'test',current_policy_version:'test',stopped:false,creation_actor:actor,human_authorization:human,created_owner_proof:nativeProof({message:claim.payload.native.prompt,status:'completed',now:f.now()}),complete_thread_listing:{source:'codex_app.list_threads',checked_at:new Date(f.now()).toISOString(),evidence_ref:'actual-full-list',request:{mode:'history',archived:false},readback:{threads:[],nextCursor:null}},project_listing:{source:'codex_app.list_projects',checked_at:new Date(f.now()).toISOString(),evidence_ref:'actual-projects',readback:{projects:[{projectId:project,hostId:'local',path:'/task'}]}}}};
 return {...f,t,source,human,actor,p,repair};
}

test('a genuinely created missing owner can reassert only its original project, while real membership still gates bind/start',async()=>{
 const f=await setup();try{
  const original=f.c.db.prepare('SELECT receipt FROM actions WHERE action_key=?').get(f.p.key).receipt;
  assert.equal(f.c.prepare(f.repair).prepared,true);
  assert.equal(f.c.claim({key:f.repair.key,owner:MAIN,evidence:f.repair.evidence}).claimed,false);
  const claim=f.c.claim({key:f.repair.key,owner:DISCOVERY,evidence:f.repair.evidence});assert(claim.claimed,JSON.stringify(claim));
  f.c.settle({key:f.repair.key,attempt_id:claim.attempt_id,outcome:'sent',evidence_ref:'single-native-move',native_result:{threadId:OWNER}});
  const binding={task_id:f.t.id,owner_thread_id:OWNER,creation_action_key:f.p.key,creation_actor:f.actor,evidence_ref:'actual-owner',native_binding:nativeProof({status:'completed',now:f.now()})};
  assert.throws(()=>f.work.bindOwner(binding),/project readback/);
  assert(f.c.confirmCreation({key:f.p.key,snapshot:{id:OWNER,hostId:'local',projectId:f.config.scope.project_id},source:'list_threads',verified_at:new Date(f.now()).toISOString(),evidence_ref:'actual-after-move-list'}).setup_complete);
  f.work.bindOwner(binding);f.work.start(f.c.reactive,{task_id:f.t.id,creation_actor:f.actor,queue_compatibility_verified:true});
  assert.equal(f.c.db.prepare("SELECT COUNT(*) n FROM actions WHERE kind='create_thread'").get().n,1);
  assert.equal(f.c.db.prepare('SELECT receipt FROM actions WHERE action_key=?').get(f.p.key).receipt,original);
  assert.equal(f.c.prepare({...f.repair,key:'another-project-repair'}).prepared,false);
 }finally{f.c.close();}
});

test('missing-membership repair rejects fabricated sources, foreign projects, partial listings, busy owners and changed actors at prepare and claim',async()=>{
 const changes=[f=>{f.c.db.prepare("DELETE FROM work_rules WHERE key='discovery_owns_creation'").run();},f=>{f.repair.payload.project_id='foreign';},f=>{f.repair.key='repeat-key';},f=>{f.repair.evidence.complete_thread_listing.readback.nextCursor='more';},f=>{f.repair.evidence.complete_thread_listing.readback.threads=[{id:OWNER,projectId:'other'}];},f=>{f.repair.evidence.created_owner_proof.readback.thread.status.type='active';},f=>{f.repair.evidence.created_owner_proof.readback.turns[0].items[0].content[0].text='different setup';},f=>{f.repair.evidence.human_authorization.readback.turns[0].items[0].id='agent-not-human';},f=>{f.repair.evidence.creation_actor.native_proof.readback.turns[0].id='different-native-actor';},f=>{f.c.db.prepare("UPDATE actions SET state='uncertain' WHERE action_key=?").run(f.p.key);},f=>{f.advance(61000);}];
 for(const change of changes){const f=await setup();try{change(f);assert.equal(f.c.prepare(f.repair).prepared,false);assert.equal(f.work.get(f.t.id).owner_thread_id,null);}finally{f.c.close();}}
 const f=await setup();try{assert(f.c.prepare(f.repair).prepared);f.advance(61000);assert.equal(f.c.claim({key:f.repair.key,owner:DISCOVERY,evidence:f.repair.evidence}).claimed,false);assert.equal(f.c.db.prepare('SELECT state FROM actions WHERE action_key=?').get(f.repair.key).state,'prepared');}finally{f.c.close();}
});

test('source-only repair uses the original accepted human proof and CAS, preserves issue/scope, and rejects conflicting attribution',()=>{
 const f=workFixture();try{
  const t=f.work.create({canonical_key:'old-registration',title:'Original scope',objective:'Original goal',workspace:'/task',requirements:[{id:'done',text:'Original acceptance'}],source:{kind:'user',url:'https://example.com/issue/1'}}).task;
  f.work.accept({task_id:t.id,actual_human_verified:true,source_message_id:'human-original',evidence_ref:'actual-request'});
  const before=f.work.get(t.id),human=nativeProof({thread:MAIN,turn:'human-turn',message:'Start original scope',now:f.now()});human.readback.turns[0].items[0].id='human-original';
  const input={task_id:t.id,expected_revision:before.revision,source_thread_id:MAIN,source_turn_id:'human-turn',source_message_id:'human-original',verbatim_text:'Start original scope',human_authorization:human,evidence_ref:'actual-original-human',actual_human_verified:true};
  assert.throws(()=>reconcileAcceptedSource(f.c,{...input,expected_revision:before.revision+1}));
  assert.throws(()=>reconcileAcceptedSource(f.c,{...input,source_message_id:'different'}));
  assert(reconcileAcceptedSource(f.c,input).reconciled);const after=f.work.get(t.id);
  assert.deepEqual(after.authorization,before.authorization);assert.deepEqual({...after.data,source:before.data.source},before.data);
  assert(reconcileAcceptedSource(f.c,input).already_reconciled);
  assert.throws(()=>reconcileAcceptedSource(f.c,{...input,source_turn_id:'another-turn'}));
 }finally{f.c.close();}
});
