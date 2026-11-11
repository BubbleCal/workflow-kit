import test from 'node:test';
import assert from 'node:assert/strict';
import {workFixture,DISCOVERY} from './test-fixtures/work.mjs';
import {nativeProof,OWNER} from './test-fixtures/reactive.mjs';
import {prepareTaskOwner} from './calendar-preparation.mjs';
import {bindings} from './instance.mjs';
import {INBOX} from './control.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Mailbox} from './mailbox.mjs';
import {inspectInbox} from './inbox-policy.mjs';

const CHILD='77777777-7777-4777-8777-777777777777';
const rule={key:'accept_result_followups',enabled:true,allowed_kinds:['work'],actual_human_verified:true,
 source_message_id:'human:result-followthrough',verbatim_text:'Implement useful evidenced result followups in independent owners',evidence_ref:'human-result-scope'};
const proposal=()=>({canonical_key:'measured-cache-reuse',problem:'Unchanged fragments are reloaded after append',evidence_refs:['s3-append-profile'],
 evidence_limits:'One S3 workload and exact binary; no global speedup claim',expected_benefit:'Avoid measured unchanged-fragment reads',disposition:'implement',actions:['implementation','testing','benchmark'],reason:'A bounded implementation hypothesis supported by the profile',
 task:{title:'Reuse unchanged fragments',objective:'Implement and validate cache reuse for append',workspace:'/task',requirements:[{id:'correct',text:'Preserve old and new snapshot addresses under eviction'}],
  difficulty_assessment:{scope:'bounded',uncertainty:'material',validation:'specialist',complexity:'difficult',target_repositories:['example/service'],repository_evidence_ref:'accepted-repository',reason:'Snapshot identity and cache accounting need targeted validation'}}});
function fixture(constraints=[],path){
 const f=workFixture(path);f.config.scope.project_id=bindings.scope.project_id??'project';f.config.scope.repositories.push('example/service');f.work.setPolicy(rule);
 const parent=f.work.create({canonical_key:'finite-benchmark',title:'Benchmark',objective:'Deliver an evidenced comparison',workspace:'/task',constraints,requirements:[{id:'report',text:'Deliver the measured result'}]}).task;
 f.accept(parent.id);f.bind(parent.id);const wake=f.begin(parent.id);
 return {...f,parent,wake,report:(followups=[proposal()],extra={})=>f.work.recordReport({task_id:parent.id,owner_thread_id:OWNER,report_key:'benchmark-result',outcome:'findings',summary:'Measured avoidable fragment reload',evidence_refs:['s3-report'],followups,...extra})};
}

test('an exact result followup decision reaches the strict inbox once without authorizing execution',()=>{
 const root=mkdtempSync(join(tmpdir(),'result-decision-inbox-')),f=fixture([],join(root,'control.sqlite')),m=new Mailbox(join(root,'mailbox.sqlite'));
 const previous={layout:bindings.layout,strict:bindings.delivery.main_inbox_strict,ownerManaged:bindings.delivery.owner_managed};
 try{
  bindings.layout='native';bindings.delivery.main_inbox_strict=true;bindings.delivery.owner_managed=true;
  const report=f.report([{...proposal(),disposition:'decision',requires_additional_authority:true}]),row=report.followups[0];
  assert.equal(row.state,'decision');assert.equal(row.task_id,null);complete(f);
  const key=`result-decision:${row.followup_key}`,notice=f.c.db.prepare('select payload from work_notices where key=?').get(key);
  const input={key,lane:'inbox',kind:'decision',payload:JSON.parse(notice.payload)};
  assert.equal(inspectInbox(root,{...input,payload:{...input.payload,text:'Forged decision'}}).allowed,false);
  assert.equal(inspectInbox(root,{...input,key:'invented-key'}).allowed,false);
  assert.equal(m.enqueue(input).queued,true);assert.equal(m.enqueue(input).queued,false);
  const completion=JSON.parse(f.c.db.prepare('select payload from work_notices where key=?').get(`complete:${f.wake.id}`).payload);
  assert.match(completion.text,/原任务已验收。.*后续待决.*尚未全部解决/);
  f.c.db.prepare("update work_result_followups set state='no_action' where followup_key=?").run(row.followup_key);
  assert.equal(inspectInbox(root,input).allowed,false);
  assert.equal(f.work.list().length,1);assert.equal(f.c.reactive.task(f.parent.id).status,'complete');
 }finally{bindings.layout=previous.layout;bindings.delivery.main_inbox_strict=previous.strict;bindings.delivery.owner_managed=previous.ownerManaged;m.close();f.c.close();rmSync(root,{recursive:true,force:true});}
});
function complete(f){
 const t=f.c.reactive.task(f.parent.id);
 f.c.reactive.decide({task_id:t.task_id,owner_thread_id:OWNER,wake_id:f.wake.id,expected_context_rev:t.context_rev,expected_plan_rev:t.plan_rev,disposition:'complete',reason:'Finite measurement delivered',evidence_refs:['report'],acceptance:[{requirement_id:'report',passed:true,evidence_ref:'report'}]});
 f.c.reactive.finish({task_id:t.task_id,wake_id:f.wake.id,turn_id:'native-turn',evidence_ref:'report'});
}
const projects=f=>({projects:[{hostId:'local',projectId:f.config.scope.project_id,label:'Project'}],project_catalog_ref:'native-projects',checked_at:new Date(f.now()).toISOString()});

test('ordinary benchmark result reaches a guarded owner, queue and verified execution once',async()=>{
 const f=fixture();try{
  const report=f.report(),childId=report.followups[0].task_id;
  assert.equal(f.work.get(childId).state,'accepted');assert.equal(f.work.get(childId).data.parent_id,null);
  f.work.followthrough.advance(f.c.reactive,{queue_compatibility_verified:true});
  const p=await prepareTaskOwner(f.c,{task_id:childId,...projects(f)});assert.equal(p.preparation.prepared,true,JSON.stringify(p.preparation));
  const claim=f.c.claim({key:p.key,owner:DISCOVERY,evidence:p.evidence});assert.equal(claim.claimed,true,JSON.stringify(claim));
  f.c.settle({key:p.key,attempt_id:claim.attempt_id,outcome:'sent',evidence_ref:'native-create',native_result:{threadId:CHILD,hostId:'local'}});
  f.c.confirmCreation({key:p.key,snapshot:{id:CHILD,hostId:'local',projectId:f.config.scope.project_id},source:'list_threads',verified_at:new Date(f.now()).toISOString(),evidence_ref:'native-project-readback'});
  f.work.bindOwner({task_id:childId,owner_thread_id:CHILD,creation_action_key:p.key,evidence_ref:'native-owner',native_binding:nativeProof({thread:CHILD,status:'completed',now:f.now()})});
  f.work.followthrough.advance(f.c.reactive,{queue_compatibility_verified:true});
  assert.equal(f.work.followthrough.status()[0].execution_started,false);
  const w=f.c.reactive.reserveQueuedWake(childId).wake,prompt=`[workflow-event:${w.id}] bounded implementation`;
  f.c.db.prepare("UPDATE rt_wakes SET state='queued',queue_id='child-queue',prompt=? WHERE id=?").run(prompt,w.id);
  f.c.reactive.begin({task_id:childId,wake_id:w.id,native_proof:nativeProof({thread:CHILD,message:prompt,turn:'actual-child-turn',now:f.now()})});
  f.work.followthrough.advance(f.c.reactive,{queue_compatibility_verified:true});
  assert.equal(f.work.followthrough.status()[0].actual_turn_id,'actual-child-turn');
  assert.equal(f.report().duplicate,true);assert.equal(f.work.list().length,2);
  assert.equal(f.c.db.prepare('SELECT COUNT(*) n FROM work_owner_requests').get().n,1);
  complete(f);assert.equal(f.c.reactive.task(f.parent.id).status,'complete');
 }finally{f.c.close();}
});

test('canonical duplicate reports route to the existing owner without creating another task',()=>{
 const f=fixture();try{
  const target=f.work.create({...proposal().task,canonical_key:proposal().canonical_key}).task;f.accept(target.id);f.bind(target.id,CHILD);
  f.work.start(f.c.reactive,{task_id:target.id,queue_compatibility_verified:true});
  assert.equal(f.report().followups[0].task_id,target.id);f.work.followthrough.advance(f.c.reactive);
  assert.equal(f.work.list().length,2);assert.equal(f.c.db.prepare('SELECT COUNT(*) n FROM work_owner_requests').get().n,0);
  assert.equal(f.c.reactive.checkpoint(target.id).events.filter(e=>e.type==='result_followup').length,1);
  f.work.followthrough.advance(f.c.reactive);assert.equal(f.c.reactive.checkpoint(target.id).events.filter(e=>e.type==='result_followup').length,1);
 }finally{f.c.close();}
});

for(const constraint of ['Assessment-only: no product changes','Implementation hold until Yang decides'])test(`result admission preserves ${constraint}`,()=>{
 const f=fixture([constraint]);try{assert.equal(f.report().followups[0].state,'blocked');assert.equal(f.work.list().length,1);assert.equal(f.work.followthrough.pending().owners.length,0);}finally{f.c.close();}
});

test('no actionable finding creates no implementation or discovery work',()=>{
 const f=fixture();try{f.report([],{outcome:'no_actionable_findings'});complete(f);assert.equal(f.work.list().length,1);assert.deepEqual(f.work.followthrough.pending(),{reviews:[],owners:[]});}finally{f.c.close();}
});

test('ordinary completion without a structured report requests a fixed verified result review',()=>{
 const f=fixture();try{
  complete(f);const review=f.work.followthrough.pending().reviews[0];assert.ok(review);
  const due=f.c.discovery.enqueueDue({enqueue:()=>({queued:true})},'/instance');const b=f.c.discovery.batch(due.batch_id);
  assert.equal(b.snapshot.sources.length,0);assert.equal(b.result_followthrough.reviews[0].review_key,review.review_key);
  f.c.discovery.begin({batch_id:b.id,generation:b.generation,native_proof:nativeProof({thread:DISCOVERY,message:b.prompt,now:f.now()})});
  assert.throws(()=>f.c.discovery.finish({batch_id:b.id,generation:b.generation,source_results:[]}),/Verify actual followup/);
  assert.throws(()=>f.report([proposal()],{review_key:review.review_key,native_proof:nativeProof({thread:CHILD,status:'completed',now:f.now()})}),/original-owner/);
  f.report([proposal()],{review_key:review.review_key,native_proof:nativeProof({status:'completed',now:f.now()})});
  assert.equal(f.c.reactive.task(f.parent.id).status,'complete');assert.equal(f.work.followthrough.pending().reviews.length,0);
 }finally{f.c.close();}
});

test('uncertain native creation retains the exact action and task for reconciliation',async()=>{
 const f=fixture();try{
  const id=f.report().followups[0].task_id;f.work.followthrough.advance(f.c.reactive);
  const p=await prepareTaskOwner(f.c,{task_id:id,...projects(f)});assert.equal(p.preparation.prepared,true,JSON.stringify(p.preparation));
  const claim=f.c.claim({key:p.key,owner:DISCOVERY,evidence:p.evidence});assert.equal(claim.claimed,true);
  f.c.settle({key:p.key,attempt_id:claim.attempt_id,outcome:'uncertain',evidence_ref:'native-tool-disconnected'});
  f.work.followthrough.advance(f.c.reactive);
  assert.equal(f.work.followthrough.status()[0].state,'creation_uncertain');assert.equal(f.work.followthrough.status()[0].execution_started,false);
  assert.equal((await prepareTaskOwner(f.c,{task_id:id,...projects(f)})).state,'uncertain');
  f.report();f.work.followthrough.advance(f.c.reactive);assert.equal(f.work.list().length,2);
  assert.equal(f.c.db.prepare("SELECT COUNT(*) n FROM actions WHERE kind='create_thread'").get().n,1);
 }finally{f.c.close();}
});

test('result followups require standing authority and valid scoped evidence',()=>{
 const f=fixture();try{
  f.work.setPolicy({...rule,enabled:false});assert.equal(f.report().followups[0].state,'blocked');assert.equal(f.work.list().length,1);
  assert.throws(()=>f.report([{...proposal(),evidence_refs:[]}],{report_key:'invalid-evidence'}),/Followup needs evidence/);
 }finally{f.c.close();}
});

test('completed report replay is read-only and does not reopen the assessment',()=>{
 const f=fixture();try{f.report();complete(f);assert.equal(f.report().duplicate,true);assert.equal(f.c.reactive.task(f.parent.id).status,'complete');assert.equal(f.work.list().length,2);}finally{f.c.close();}
});

test('new finding reaches an already running canonical owner instead of borrowing its earlier turn',()=>{
 const f=fixture();try{
  const target=f.work.create({...proposal().task,canonical_key:proposal().canonical_key}).task;f.accept(target.id);f.bind(target.id,CHILD);
  f.work.start(f.c.reactive,{task_id:target.id,queue_compatibility_verified:true});const w=f.c.reactive.reserveQueuedWake(target.id).wake,prompt=`[workflow-event:${w.id}] original work`;
  f.c.db.prepare("UPDATE rt_wakes SET state='queued',queue_id='existing',prompt=? WHERE id=?").run(prompt,w.id);
  f.c.reactive.begin({task_id:target.id,wake_id:w.id,native_proof:nativeProof({thread:CHILD,message:prompt,turn:'earlier-owner-turn',now:f.now()})});
  f.report();f.work.followthrough.advance(f.c.reactive);
  assert.equal(f.work.followthrough.status()[0].execution_started,false);
  assert.equal(f.c.reactive.checkpoint(target.id).events.filter(e=>e.type==='result_followup').length,1);
  assert.equal(f.work.followthrough.pending().owners[0].state,'routed');
  // Simulate a process ending after event persistence but before the phase update.
  f.c.db.prepare("UPDATE work_result_followups SET state='existing_owner'").run();f.advance(5000);
  f.work.followthrough.advance(f.c.reactive);assert.equal(f.c.reactive.checkpoint(target.id).events.filter(e=>e.type==='result_followup').length,1);
  const current=f.c.reactive.task(target.id);
  f.c.reactive.decide({task_id:target.id,owner_thread_id:CHILD,wake_id:w.id,expected_context_rev:current.context_rev,expected_plan_rev:current.plan_rev,disposition:'complete',reason:'New finding addressed with independent acceptance',evidence_refs:['finding-acceptance'],acceptance:[{requirement_id:'correct',passed:true,evidence_ref:'finding-acceptance'}]});
  f.work.followthrough.advance(f.c.reactive);assert.equal(f.work.followthrough.status()[0].actual_turn_id,'earlier-owner-turn');
  assert.equal(f.work.followthrough.status()[0].state,'complete');
 }finally{f.c.close();}
});

test('explicit already-assigned result catchup reuses actual execution without resending the work',()=>{
 const f=fixture();try{
  const target=f.work.create({...proposal().task,canonical_key:proposal().canonical_key}).task;f.accept(target.id);f.bind(target.id,CHILD);
  f.work.start(f.c.reactive,{task_id:target.id,queue_compatibility_verified:true});const w=f.c.reactive.reserveQueuedWake(target.id).wake,prompt=`[workflow-event:${w.id}] authorized followup`;
  f.c.db.prepare("UPDATE rt_wakes SET state='queued',queue_id='already-assigned',prompt=? WHERE id=?").run(prompt,w.id);
  f.c.reactive.begin({task_id:target.id,wake_id:w.id,native_proof:nativeProof({thread:CHILD,message:prompt,turn:'actual-assigned-turn',now:f.now()})});
  f.report([{...proposal(),disposition:'existing',existing_task_id:target.id,existing_work_evidence_ref:'s3-append-profile'}]);f.work.followthrough.advance(f.c.reactive);
  assert.equal(f.work.followthrough.status()[0].actual_turn_id,'actual-assigned-turn');
  assert.equal(f.c.reactive.checkpoint(target.id).events.filter(e=>e.type==='result_followup').length,0);
 }finally{f.c.close();}
});

test('expanded goals need a durable decision and disallowed actions never create work',()=>{
 const f=fixture();try{
  const row=f.report([{...proposal(),requires_additional_authority:true}]).followups[0];assert.equal(row.state,'decision');assert.equal(f.work.list().length,1);
  assert.equal(f.c.db.prepare("SELECT COUNT(*) n FROM work_notices WHERE json_extract(payload,'$.result_followup_decision')=1").get().n,1);
  assert.throws(()=>f.report([{...proposal(),actions:['deployment']}],{report_key:'no-deploy'}),/authority covers only/);
 }finally{f.c.close();}
});

test('bound result work waits for its real dependency and later starts once',()=>{
 const f=fixture();try{
  const dependency=f.work.create({...proposal().task,canonical_key:'dependency'}).task;f.accept(dependency.id);f.bind(dependency.id,CHILD);
  const p=proposal();p.task.depends_on=[dependency.id];const id=f.report([p]).followups[0].task_id;
  f.bind(id,'88888888-8888-4888-8888-888888888888');f.work.followthrough.advance(f.c.reactive,{queue_compatibility_verified:true});
  assert.equal(f.work.followthrough.status()[0].state,'waiting_dependency');assert.equal(f.c.reactive.task(id),null);assert.equal(f.work.followthrough.pending().owners.length,1);
  // Complete the dependency through the same ordinary native protocol.
  f.work.start(f.c.reactive,{task_id:dependency.id,queue_compatibility_verified:true});const w=f.c.reactive.reserveQueuedWake(dependency.id).wake,prompt=`[workflow-event:${w.id}] dependency`;
  f.c.db.prepare("UPDATE rt_wakes SET state='queued',queue_id='dependency',prompt=? WHERE id=?").run(prompt,w.id);
  f.c.reactive.begin({task_id:dependency.id,wake_id:w.id,native_proof:nativeProof({thread:CHILD,message:prompt,now:f.now()})});
  const t=f.c.reactive.task(dependency.id);f.c.reactive.decide({task_id:dependency.id,owner_thread_id:CHILD,wake_id:w.id,expected_context_rev:t.context_rev,expected_plan_rev:t.plan_rev,disposition:'complete',reason:'Dependency acceptance verified',evidence_refs:['dependency-proof'],acceptance:[{requirement_id:'correct',passed:true,evidence_ref:'dependency-proof'}]});
  f.c.reactive.finish({task_id:dependency.id,wake_id:w.id,turn_id:'native-turn',evidence_ref:'dependency-proof'});
  f.work.followthrough.advance(f.c.reactive,{queue_compatibility_verified:true});assert.equal(f.c.reactive.task(id).mode,'active');
 }finally{f.c.close();}
});

test('proven non-delivery retries the same creation action after backoff and binds one owner',async()=>{
 const f=fixture();try{
  const id=f.report().followups[0].task_id;f.work.followthrough.advance(f.c.reactive);const p=await prepareTaskOwner(f.c,{task_id:id,...projects(f)});
  const first=f.c.claim({key:p.key,owner:DISCOVERY,evidence:p.evidence});assert.equal(first.claimed,true);
  f.c.settle({key:p.key,attempt_id:first.attempt_id,outcome:'not_sent',error_class:'transient_before_send',evidence_ref:'transport-proved-not-sent'});
  assert.equal(f.c.claim({key:p.key,owner:DISCOVERY,evidence:p.evidence}).reason,'backoff');f.advance(5000);
  const retry=await prepareTaskOwner(f.c,{task_id:id,...projects(f)});assert.equal(retry.key,p.key);
  const second=f.c.claim({key:p.key,owner:DISCOVERY,evidence:retry.evidence});assert.equal(second.claimed,true);
  f.c.settle({key:p.key,attempt_id:second.attempt_id,outcome:'sent',evidence_ref:'native-created',native_result:{threadId:CHILD,hostId:'local'}});
  f.c.confirmCreation({key:p.key,snapshot:{id:CHILD,hostId:'local',projectId:f.config.scope.project_id},source:'list_threads',verified_at:new Date(f.now()).toISOString(),evidence_ref:'native-project'});
  f.work.bindOwner({task_id:id,owner_thread_id:CHILD,creation_action_key:p.key,evidence_ref:'native-owner',native_binding:nativeProof({thread:CHILD,status:'completed',now:f.now()})});
  f.work.followthrough.advance(f.c.reactive,{queue_compatibility_verified:true});assert.equal(f.c.reactive.task(id).mode,'active');assert.equal(f.work.list().length,2);
 }finally{f.c.close();}
});

for(const structured of [true,false])test(`ordinary completion notification handles structured result=${structured}`,()=>{
 const f=fixture();try{
  const report={report_key:'notify-result',outcome:'findings',summary:'Measured reload',evidence_refs:['s3-result'],followups:[proposal()]};
  const input={key:`notify:${structured}`,kind:'notify',task_id:f.parent.id,payload:{thread_id:INBOX,category:'important_completion',result_reference:'actual-report',...(structured?{result_report:report}:{})},
   evidence:{verified_at:new Date(f.now()).toISOString(),scope_authorized:true,authorization_ref:'human-result',policy_version:'v1',current_policy_version:'v1',stopped:false,material_change:true,already_notified:false,completion_verified:true,executor_thread_id:OWNER}};
  const prepared=f.c.prepare(input);assert.equal(prepared.prepared,true,JSON.stringify(prepared));
  assert.equal(f.work.followthrough.pending().reviews.length,structured?0:1);assert.equal(f.work.list().length,structured?2:1);
  f.c.prepare(input);assert.equal(f.work.list().length,structured?2:1);assert.equal(f.work.followthrough.pending().reviews.length,structured?0:1);
 }finally{f.c.close();}
});

test('result-only checkpoint preserves its fixed review across the global discovery interval',()=>{
 const f=fixture();try{
  f.config.discovery={min_start_interval_ms:900000};complete(f);
  const due=f.c.discovery.enqueueDue({enqueue:()=>({queued:true})},'/instance'),b=f.c.discovery.batch(due.batch_id);
  f.c.discovery.begin({batch_id:b.id,generation:b.generation,native_proof:nativeProof({thread:DISCOVERY,message:b.prompt,now:f.now()})});
  assert.equal(f.c.discovery.finish({batch_id:b.id,generation:b.generation,source_results:[],result_followups_reason:'Original native result not yet readable'}).checkpointed,true);
  assert.equal(f.c.discovery.enqueueDue({enqueue:()=>({queued:true})},'/instance').reason,'discovery_start_interval');
  f.advance(900000);const again=f.c.discovery.enqueueDue({enqueue:()=>({queued:true})},'/instance');assert.equal(again.batch_id,b.id);
  const resumed=f.c.discovery.batch(b.id);assert.equal(resumed.generation,2);assert.deepEqual(resumed.snapshot.result_work,b.snapshot.result_work);
 }finally{f.c.close();}
});

test('typed original execution hold also blocks independent implementation admission',()=>{
 const f=fixture();try{
  const contract=f.c.reactive.task(f.parent.id).contract;contract.execution_hold='Wait for explicit Yang resumption';
  f.c.db.prepare('UPDATE rt_tasks SET contract=? WHERE task_id=?').run(JSON.stringify(contract),f.parent.id);
  assert.equal(f.report().followups[0].state,'blocked');assert.equal(f.work.list().length,1);
 }finally{f.c.close();}
});

test('a reviewed findings result needs an explicit disposition and never queues a review of its own review',()=>{
 const f=fixture();try{f.report([]);complete(f);const pending=f.work.followthrough.pending().reviews[0];assert(pending);const proof=nativeProof({status:'completed',now:f.now()}),old={task_id:f.parent.id,owner_thread_id:OWNER,report_key:'benchmark-result',outcome:'findings',summary:'Measured avoidable fragment reload',evidence_refs:['s3-report'],review_key:pending.review_key,native_proof:proof};
 const duplicate=f.work.recordReport(old);assert(duplicate.requires_new_review_report);assert.equal(f.work.followthrough.pending().reviews.length,1);
 assert.throws(()=>f.work.recordReport({...old,report_key:'review-disposition'}),/explicit structured followup/);
 const result=f.work.recordReport({...old,report_key:'review-disposition',outcome:'no_actionable_findings',summary:'Existing authorized work covers this result; no independent new task is supported'});assert(result.recorded);assert.equal(f.work.followthrough.pending().reviews.length,0);assert.equal(f.work.recordReport({...old,report_key:'review-disposition',outcome:'no_actionable_findings',summary:'Existing authorized work covers this result; no independent new task is supported'}).review_recorded,true);
 assert.equal(f.work.list().length,1);assert.equal(f.c.reactive.task(f.parent.id).status,'complete');
 }finally{f.c.close();}
});
