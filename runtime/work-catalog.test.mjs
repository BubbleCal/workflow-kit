import test from 'node:test';
import assert from 'node:assert/strict';
import {OWNER,nativeProof} from './test-fixtures/reactive.mjs';
import {workFixture,MAIN,DISCOVERY} from './test-fixtures/work.mjs';

test('autonomous exploration is an idempotent built-in ordinary task with every external source disabled',()=>{
  const f=workFixture();try{
    const first=f.work.seedBuiltins();assert.equal(first.created,true);assert.equal(f.work.seedBuiltins().task.id,first.task.id);
    assert.equal(f.work.list().length,1);assert.equal(first.task.kind,'exploration');assert.equal(first.task.owner_thread_id,null);
    assert.ok(f.c.discovery.sources().every(s=>!s.enabled));
    assert.deepEqual(f.c.discovery.enqueueDue({enqueue(){throw new Error('Discovery must stay idle');}},'/instance'),{queued:false,reason:'no_enabled_source_due'});
    f.accept(first.task.id);f.bind(first.task.id);const w=f.begin(first.task.id);
    assert.equal(f.c.reactive.task(first.task.id).contract.task_kind,'exploration');assert.equal(w.state,'running');
    assert.equal(f.c.discovery.status().batches.length,0);
  }finally{f.c.close();}
});
test('discovery and main conversations cannot be repurposed as exploration execution owners',()=>{
  const f=workFixture();try{
    const t=f.work.seedBuiltins().task;f.accept(t.id);
    assert.throws(()=>f.bind(t.id,DISCOVERY),/cannot own ordinary execution or exploration/);
    assert.throws(()=>f.bind(t.id,MAIN),/cannot own ordinary execution or exploration/);
    f.bind(t.id);assert.equal(f.work.get(t.id).owner_thread_id,OWNER);
  }finally{f.c.close();}
});
test('research can finish with no actionable finding without manufacturing tasks or waking discovery',()=>{
  const f=workFixture();try{
    const t=f.work.seedBuiltins().task;f.accept(t.id);f.bind(t.id);const w=f.begin(t.id);
    const report=f.work.recordReport({task_id:t.id,owner_thread_id:OWNER,report_key:'report-1',outcome:'no_actionable_findings',
      summary:'The inspected hypotheses did not improve the measured workload',evidence_refs:['baseline','results']});
    assert.equal(report.discovery_wake_required,false);assert.deepEqual(report.proposals,[]);
    const rt=f.c.reactive.task(t.id);
    f.c.reactive.decide({task_id:t.id,owner_thread_id:OWNER,wake_id:w.id,expected_context_rev:rt.context_rev,expected_plan_rev:0,
      disposition:'complete',reason:'Bounded research report completed',evidence_refs:['report-1'],
      acceptance:t.data.requirements.map(r=>({requirement_id:r.id,passed:true,evidence_ref:'report-1'}))});
    assert.equal(f.c.reactive.finish({task_id:t.id,wake_id:w.id,turn_id:'native-turn',evidence_ref:'report-1'}).task_complete,true);
    assert.equal(f.work.list().length,1);assert.equal(f.c.discovery.status().batches.length,0);
  }finally{f.c.close();}
});
test('exploration findings create ordinary candidates but never grant implementation authority',()=>{
  const f=workFixture();try{
    const t=f.work.seedBuiltins().task;f.accept(t.id);f.bind(t.id);f.begin(t.id);
    const data={task_id:t.id,owner_thread_id:OWNER,report_key:'finding-1',outcome:'findings',summary:'Duplicate scans are worth removing',evidence_refs:['profile'],
      proposals:[{canonical_key:'project:remove-duplicate-scans',title:'Remove duplicate scans',objective:'Preserve results while reducing redundant work',requirements:[{id:'correct',text:'Same results'}]}]};
    const report=f.work.recordReport(data);assert.equal(report.proposals.length,1);
    const proposal=f.work.get(report.proposals[0]);assert.equal(proposal.state,'candidate');assert.equal(proposal.owner_thread_id,null);
    assert.throws(()=>f.work.start(f.c.reactive,{task_id:proposal.id,queue_compatibility_verified:true}),/task_not_accepted/);
    assert.equal(f.work.recordReport(data).duplicate,true);assert.equal(f.work.list().length,2);
    assert.throws(()=>f.work.recordReport({...data,report_key:'bad',outcome:'inconclusive'}),/cannot manufacture/);
  }finally{f.c.close();}
});
test('task configuration uses revisions even when updates occur in the same millisecond',()=>{
  const f=workFixture();try{
    const t=f.work.seedBuiltins().task,input={task_id:t.id,expected_revision:0,changes:{objective:'Inspect one bounded area'},source_message_id:'user:scope',actual_human_verified:true};
    f.work.configure(input);assert.throws(()=>f.work.configure(input),/Task changed/);
  }finally{f.c.close();}
});
test('creation requests require real authority and remain unique across retries',()=>{
  const f=workFixture();try{
    const t=f.work.seedBuiltins().task;f.accept(t.id);
    assert.throws(()=>f.work.requestOwner({task_id:t.id,source_message_id:'candidate',verbatim_text:'an external idea'}),/Explicit authorization/);
    const input={task_id:t.id,source_message_id:'user:create',verbatim_text:'Create an execution conversation for this task',actual_human_verified:true,explicit_new_thread_request_verified:true};
    assert.equal(f.work.requestOwner(input).action_key,f.work.requestOwner(input).action_key);
    assert.equal(f.c.db.prepare('SELECT COUNT(*) AS n FROM work_owner_requests').get().n,1);
  }finally{f.c.close();}
});

test('standing owner creation policy preserves actual authorization and task-kind limits',()=>{
 const f=workFixture();try{const t=f.work.seedBuiltins().task;f.accept(t.id);
  assert.throws(()=>f.work.setPolicy({key:'create_owner',enabled:true,allowed_kinds:['exploration']}),/actual user authorization/);
  f.work.setPolicy({key:'create_owner',enabled:true,allowed_kinds:['exploration'],actual_human_verified:true,
   source_message_id:'user:create-policy',verbatim_text:'Create owners for accepted exploration tasks',evidence_ref:'actual-create-grant'});
  const request=f.work.requestOwner({task_id:t.id});assert.equal(request.request.source_message_id,'user:create-policy');
  const other=f.work.create({canonical_key:'ordinary-work',title:'Work',objective:'Deliver work',requirements:[{id:'r',text:'Complete'}]}).task;f.accept(other.id);
  assert.throws(()=>f.work.requestOwner({task_id:other.id}),/creation authorization/);
 }finally{f.c.close();}
});

test('project acceptance waits for child work and research reports reach its original owner directly',()=>{
 const f=workFixture();try{
  const project=f.work.create({kind:'project',canonical_key:'project',title:'Project',objective:'Integrate results',requirements:[{id:'integrated',text:'Integrated acceptance'}]}).task;
  f.accept(project.id);f.bind(project.id);const parentWake=f.begin(project.id);
  const child=f.work.create({kind:'exploration',canonical_key:'project-research',parent_id:project.id,title:'Research',objective:'Inspect alternatives',requirements:[{id:'report',text:'Report the evidence'}]}).task;
  f.accept(child.id);
  const dependent=f.work.create({canonical_key:'dependent',title:'Dependent',objective:'Build on research',depends_on:[child.id],requirements:[{id:'r',text:'Deliver'}]}).task;
  f.accept(dependent.id);assert.ok(f.work.blockers(dependent.id).includes(`dependency:${child.id}`));
  const parentDecision=()=>({task_id:project.id,owner_thread_id:OWNER,wake_id:parentWake.id,expected_context_rev:f.c.reactive.task(project.id).context_rev,expected_plan_rev:0,
   disposition:'complete',reason:'Integrated project validation',evidence_refs:['integration'],acceptance:[{requirement_id:'integrated',passed:true,evidence_ref:'integration'}]});
  assert.throws(()=>f.c.reactive.decide(parentDecision()),/unfinished_child/);
  const childOwner='66666666-6666-4666-8666-666666666666';f.bind(child.id,childOwner);
  // Use the public queue/receiver protocol for the second independent owner.
  f.work.start(f.c.reactive,{task_id:child.id,queue_compatibility_verified:true});const w=f.c.reactive.reserveQueuedWake(child.id).wake;
  const prompt=`[workflow-event:${w.id}] child research`;
  f.c.db.prepare("UPDATE rt_wakes SET state='queued',queue_id='child-queue',prompt=? WHERE id=?").run(prompt,w.id);
  f.c.reactive.begin({task_id:child.id,wake_id:w.id,native_proof:nativeProof({thread:childOwner,message:prompt,now:f.now()})});
  f.work.onReportInside=(id,event)=>f.work.publishToParentInside(f.c.reactive,id,event);
  f.work.recordReport({task_id:child.id,owner_thread_id:childOwner,report_key:'child-report',outcome:'inconclusive',summary:'Insufficient evidence',evidence_refs:['experiment']});
  assert.ok(f.c.reactive.checkpoint(project.id).events.some(e=>e.type==='research_report'));
  f.c.reactive.decide({task_id:child.id,owner_thread_id:childOwner,wake_id:w.id,expected_context_rev:f.c.reactive.task(child.id).context_rev,expected_plan_rev:0,
   disposition:'complete',reason:'Bounded evidence recorded',evidence_refs:['child-report'],acceptance:[{requirement_id:'report',passed:true,evidence_ref:'child-report'}]});
  f.c.reactive.finish({task_id:child.id,wake_id:w.id,turn_id:'native-turn',evidence_ref:'child-report'});
  assert.ok(f.c.reactive.checkpoint(project.id).events.some(e=>e.type==='child_completed'));
  assert.ok(!f.work.blockers(dependent.id).includes(`dependency:${child.id}`));
  f.c.reactive.decide(parentDecision());assert.equal(f.c.reactive.task(project.id).status,'complete');
  assert.equal(f.c.discovery.status().batches.length,0);
 }finally{f.c.close();}
});

test('an exploration member can report when another task is primary in the shared wake',()=>{
 const f=workFixture();try{const t=f.work.seedBuiltins().task;f.accept(t.id);f.bind(t.id);f.work.start(f.c.reactive,{task_id:t.id,queue_compatibility_verified:true});
  const original=f.c.reactive.registry;f.c.reactive.registry=()=>{const r=original();return {...r,task_registry:{items:{...r.task_registry.items,'T-primary':{canonical_key:'primary',owner_thread_id:OWNER}}}};};
  f.c.reactive.adopt({task_id:'T-primary',owner_thread_id:OWNER,contract:{...f.work.contract(t.id),canonical_key:'primary',task_kind:'work'},source_message_id:'user:primary',actual_human_verified:true});
  f.c.reactive.setModes({task_ids:[t.id,'T-primary'],mode:'active',source_message_id:'user:shared',actual_human_verified:true,native_binding:nativeProof({status:'completed',now:f.now()}),queue_compatibility_verified:true,legacy_quiescent:true});
  const w=f.c.reactive.reserveQueuedWake('T-primary').wake,prompt='shared owner work';assert.ok(w.member_ids.includes(t.id));
  f.c.db.prepare("UPDATE rt_wakes SET state='queued',prompt=? WHERE id=?").run(prompt,w.id);
  f.c.reactive.begin({task_id:'T-primary',wake_id:w.id,native_proof:nativeProof({message:prompt,now:f.now()})});
  const result=f.work.recordReport({task_id:t.id,owner_thread_id:OWNER,report_key:'shared-member-report',outcome:'inconclusive',summary:'Bounded evidence is insufficient',evidence_refs:['observations']});
  assert.equal(result.recorded,true);
 }finally{f.c.close();}
});

test('historical control aliases do not prevent native ordinary service ownership',()=>{
 const f=workFixture();try{
  f.config.threads.coordinator=OWNER;
  const task=f.work.seedBuiltins().task;f.accept(task.id);f.bind(task.id);
  assert.equal(f.work.get(task.id).owner_thread_id,OWNER);
 }finally{f.c.close();}
});


test('completed history has no owner-needed blocker and cannot start again',()=>{
 const f=workFixture();try{
  const task=f.work.seedBuiltins().task;f.c.db.prepare("UPDATE work_items SET state='completed' WHERE id=?").run(task.id);
  assert.deepEqual(f.work.blockers(task.id),[]);assert.equal(f.work.start(f.c.reactive,{task_id:task.id,queue_compatibility_verified:true}).reason,'already_complete');
  assert.equal(f.c.reactive.task(task.id),null);
 }finally{f.c.close();}
});
