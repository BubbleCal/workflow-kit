import test from 'node:test';
import assert from 'node:assert/strict';
import {workFixture,MAIN,DISCOVERY} from './test-fixtures/work.mjs';
import {nativeProof,OWNER} from './test-fixtures/reactive.mjs';
import {prepareTaskOwner} from './calendar-preparation.mjs';
import {bindings} from './instance.mjs';
import {ReviewIntake} from './review-intake.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function fixture(){
 const f=workFixture();f.config.scope.project_id=bindings.scope.project_id??'project';f.config.discovery={min_start_interval_ms:900000};
 f.work.setPolicy({key:'discovery_owns_creation',enabled:true,allowed_kinds:['work','project','exploration'],source_message_id:'human:roles',verbatim_text:'Main registers; discovery creates accepted task owners',actual_human_verified:true,evidence_ref:'actual-role-request'});
 const task=(key='actual-work',start=false,source)=>{const t=f.work.create({canonical_key:key,title:key,objective:'Deliver the accepted scope',workspace:'/task',requirements:[{id:'done',text:'Verify the result'}],source}).task;
  f.work.accept({task_id:t.id,source_message_id:'human:'+key,evidence_ref:'actual-task-request',actual_human_verified:true,start_requested:start});return f.work.get(t.id);};
 const mail=[];const enqueue=()=>f.c.discovery.enqueueDue({enqueue:v=>{if(!mail.some(x=>x.key===v.key))mail.push(v);return {queued:true,key:v.key};}},'/instance');
 const begin=()=>{const q=enqueue(),b=f.c.discovery.batch(q.batch_id),proof=nativeProof({thread:DISCOVERY,message:b.prompt,turn:'discovery-turn-'+b.generation,now:f.now()});
  f.c.discovery.begin({batch_id:b.id,generation:b.generation,native_proof:proof});return {b,actor:{thread_id:DISCOVERY,batch_id:b.id,generation:b.generation,native_proof:proof}};};
 return {...f,task,enqueue,begin,mail};
}

test('accepted ownerless work reaches discovery creation, binding, queue and actual begin once; main is rejected',async()=>{
 const f=fixture();try{
  f.c.modelSelection=()=>({mode:'task_difficulty',source_message_id:'human:model-policy',routes:{simple:{model:'routine-model',thinking:'low'},other:{model:'default-model',thinking:'high'}}});
  const override={actual_human_verified:true,source_message_id:'human:actual-work',verbatim_text:'Use the selected model',evidence_ref:'actual-model-choice',canonical_task_key:'actual-work',model:'selected-model',thinking:'high'};
  const t=f.task('actual-work',false,{kind:'user',model_override:override}),{b,actor}=f.begin();assert.equal(f.c.discovery.batch(b.id).owner_creation[0].task_id,t.id);
  const main={...actor,thread_id:MAIN,native_proof:nativeProof({thread:MAIN,message:b.prompt,now:f.now()})};
  assert.throws(()=>f.work.requestOwner({task_id:t.id,creation_actor:main}),/discovery_actor/);
  const project={projects:[{hostId:'local',projectId:f.config.scope.project_id,label:'Project'}],project_catalog_ref:'actual-projects',checked_at:new Date(f.now()).toISOString()};
  await assert.rejects(prepareTaskOwner(f.c,{task_id:t.id,...project,creation_actor:main}),/discovery_actor/);
  const p=await prepareTaskOwner(f.c,{task_id:t.id,...project,creation_actor:actor});assert.equal(p.preparation.prepared,true,JSON.stringify(p.preparation));
  assert.equal(f.work.requestOwner({task_id:t.id,creation_actor:actor}).request.source_message_id,'human:roles');
  assert.equal(f.work.get(t.id).authorization.source_message_id,'human:actual-work');
  assert.equal(f.c.prepare({key:'main-bypass',kind:'create_thread',task_id:t.id,payload:{},evidence:{creation_actor:main}}).allowed,false);
  assert.equal(f.c.claim({key:p.key,owner:MAIN,evidence:p.evidence}).claimed,false);
  const claim=f.c.claim({key:p.key,owner:DISCOVERY,evidence:p.evidence});assert.equal(claim.claimed,true,JSON.stringify(claim));
  assert.equal(claim.payload.native.model,'selected-model');assert.equal(claim.payload.native.thinking,'high');
  f.c.settle({key:p.key,attempt_id:claim.attempt_id,outcome:'sent',evidence_ref:'actual-native-create',native_result:{threadId:OWNER,hostId:'local'}});
  f.c.confirmCreation({key:p.key,snapshot:{id:OWNER,hostId:'local',projectId:f.config.scope.project_id},source:'list_threads',verified_at:new Date(f.now()).toISOString(),evidence_ref:'actual-project-readback'});
  const bind={task_id:t.id,owner_thread_id:OWNER,creation_action_key:p.key,evidence_ref:'native-owner',native_binding:nativeProof({thread:OWNER,status:'completed',now:f.now()})};
  assert.throws(()=>f.work.bindOwner({...bind,creation_actor:main}),/discovery_actor/);f.work.bindOwner({...bind,creation_actor:actor});
  assert.throws(()=>f.work.start(f.c.reactive,{task_id:t.id,queue_compatibility_verified:true,creation_actor:main}),/discovery_actor/);
  f.c.reactive.adopt({task_id:t.id,owner_thread_id:OWNER,contract:f.work.contract(t.id),source_message_id:'human:actual-work',actual_human_verified:true});
  assert.throws(()=>f.work.start(f.c.reactive,{task_id:t.id,queue_compatibility_verified:true,creation_actor:main}),/discovery_actor/);
  f.work.start(f.c.reactive,{task_id:t.id,queue_compatibility_verified:true,creation_actor:actor});
  assert.equal(f.work.creation.pending()[0].state,'queued');
  assert.throws(()=>f.c.discovery.finish({batch_id:b.id,generation:b.generation,source_results:[]}),/Verify actual owner/);
  const w=f.c.reactive.reserveQueuedWake(t.id).wake,prompt=`[workflow-event:${w.id}] accepted work`;
  f.c.db.prepare("UPDATE rt_wakes SET state='queued',queue_id='actual-queue',prompt=? WHERE id=?").run(prompt,w.id);
  f.c.reactive.begin({task_id:t.id,wake_id:w.id,native_proof:nativeProof({thread:OWNER,message:prompt,turn:'real-owner-turn',now:f.now()})});
  assert.deepEqual(f.work.creation.pending(),[]);assert.equal(f.c.discovery.finish({batch_id:b.id,generation:b.generation,source_results:[]}).finished,true);
  assert.equal(f.c.db.prepare('SELECT COUNT(*) n FROM work_owner_requests').get().n,1);assert.equal(f.c.db.prepare("SELECT COUNT(*) n FROM actions WHERE kind='create_thread'").get().n,1);
  assert.equal(f.work.creation.requestStart({task_id:t.id,source_message_id:'human:repeat',actual_human_verified:true,evidence_ref:'actual-repeat'}).reason,'existing_owner_preserved');
 }finally{f.c.close();}
});

test('explicit human start bypasses the scan interval once, never reenters a busy discovery batch or changes candidates',()=>{
 const f=fixture();try{
  const t=f.task(),{b}=f.begin();f.c.discovery.finish({batch_id:b.id,generation:b.generation,source_results:[],owner_creation_reason:'Actual project setup unavailable'});
  f.advance(1000);assert.equal(f.enqueue().reason,'discovery_start_interval');
  const next=f.task('immediate',true);const q=f.enqueue(),newBatch=f.c.discovery.batch(q.batch_id);assert.notEqual(newBatch.id,b.id);
  assert(newBatch.snapshot.creation_work.task_ids.includes(next.id));assert.equal(f.mail.length,2);
  const third=f.task('busy-arrival',true);assert.equal(f.enqueue().batch_id,newBatch.id);assert.equal(f.mail.length,2);assert(!f.c.discovery.batch(newBatch.id).snapshot.creation_work.task_ids.includes(third.id));
  const proof=nativeProof({thread:DISCOVERY,message:newBatch.prompt,now:f.now()});f.c.discovery.begin({batch_id:newBatch.id,generation:newBatch.generation,native_proof:proof});
  assert(f.work.creation.triggers().some(x=>x.task_id===third.id));assert(!f.work.creation.triggers().some(x=>x.task_id===next.id));
  assert.equal(f.enqueue().reason,'discovery_in_progress');
  const candidate=f.work.create({canonical_key:'unaccepted',title:'Source idea',objective:'Not accepted'}).task;
  assert.throws(()=>f.work.creation.requestStart({task_id:candidate.id,actual_human_verified:true,source_message_id:'not-authority',evidence_ref:'source'}),/accepted task/);
  assert(!f.work.creation.pending().some(x=>x.task_id===candidate.id));
 }finally{f.c.close();}
});

test('creation authority requires the actual acknowledged current discovery turn, and uncertain creation is retained',async()=>{
 const f=fixture();try{const t=f.task(),{b,actor}=f.begin();
  assert.throws(()=>f.work.requestOwner({task_id:t.id,creation_actor:{...actor,generation:9}}),/running_discovery/);
  assert.throws(()=>f.work.requestOwner({task_id:t.id,creation_actor:{...actor,native_proof:nativeProof({thread:DISCOVERY,message:b.prompt,turn:'unacknowledged-turn',now:f.now()})}}),/turn_changed/);
  assert.throws(()=>f.c.discovery.begin({batch_id:b.id,generation:b.generation,native_proof:nativeProof({thread:DISCOVERY,message:b.prompt,turn:'duplicate-turn',now:f.now()})}),/turn_changed/);
  const p=await prepareTaskOwner(f.c,{task_id:t.id,creation_actor:actor,projects:[{hostId:'local',projectId:f.config.scope.project_id}],project_catalog_ref:'actual',checked_at:new Date(f.now()).toISOString()});
  const c=f.c.claim({key:p.key,owner:DISCOVERY,evidence:p.evidence});assert(c.claimed);f.c.settle({key:p.key,attempt_id:c.attempt_id,outcome:'uncertain',evidence_ref:'lost-native-receipt'});
  assert.equal(f.work.creation.pending()[0].state,'uncertain');assert.equal((await prepareTaskOwner(f.c,{task_id:t.id,creation_actor:actor,projects:[{hostId:'local',projectId:f.config.scope.project_id}],project_catalog_ref:'actual',checked_at:new Date(f.now()).toISOString()})).state,'uncertain');
  f.advance(61000);assert.throws(()=>f.work.requestOwner({task_id:t.id,creation_actor:actor}),/Fresh native/);
 }finally{f.c.close();}
});

test('the separately authorized Review Queue retains only its selected read-only creation scope',()=>{
 const f=workFixture(),dir=mkdtempSync(join(tmpdir(),'review-actor-'));try{
  f.config.instance_root=dir;const service=f.work.create({canonical_key:'review-service',title:'Review Queue',objective:'Select authorized reviews',requirements:[{id:'scope',text:'Read-only reviews'}]}).task;
  f.accept(service.id);f.bind(service.id);const wake=f.begin(service.id);
  const policy={enabled:true,task_id:service.id,owner_thread_id:OWNER,timezone:'Asia/Shanghai',daily_limit:5,github_login:'yang',sources:{explicit_request:{enabled:true}},authorization_ref:'actual-review-policy'};
  mkdirSync(join(dir,'review-queue'));writeFileSync(join(dir,'review-queue/config.json'),JSON.stringify(policy));
  const pr={url:'https://github.com/example/service/pull/9',state:'open',draft:false,head_sha:'a'.repeat(40),base_sha:'b'.repeat(40),author:'someone'};
  const admission=new ReviewIntake(f.c,policy).admit({owner_thread_id:OWNER,source:'explicit_request',evidence_ref:'actual-review-request',pr,checked_at:new Date(f.now()).toISOString()});assert(admission.admitted);
  const t=f.work.create({canonical_key:admission.key,title:'Review PR9',objective:'Read-only assessment',requirements:[{id:'report',text:'Deliver review'}],source:{kind:'user',review_only:true,review_queue_service_task_id:service.id,pr_url:pr.url},pull_requests:[{repository:'example/service',pr_number:9}]}).task;f.accept(t.id);
  f.work.setPolicy({key:'discovery_owns_creation',enabled:true,allowed_kinds:['work'],source_message_id:'human:roles',verbatim_text:'Discovery creates ordinary owners; retain authorized review service',evidence_ref:'actual-role-request',actual_human_verified:true});
  const actor={thread_id:OWNER,native_proof:nativeProof({thread:OWNER,message:wake.prompt,now:f.now()})};
  assert.equal(f.work.creation.actor(t.id,actor).review_service,service.id);assert.deepEqual(f.work.creation.pending(),[]);
  assert.throws(()=>f.work.creation.actor(t.id,{...actor,thread_id:MAIN}),/discovery_actor/);
  const other=f.work.create({canonical_key:'implementation',title:'Implement',objective:'Different work',requirements:[{id:'done',text:'Implement'}]}).task;f.accept(other.id);
  assert.throws(()=>f.work.creation.actor(other.id,actor),/authorized_review_actor/);
 }finally{f.c.close();rmSync(dir,{recursive:true,force:true});}
});
