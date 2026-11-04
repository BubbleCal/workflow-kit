import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from './control.mjs';
import { scopeActionReasons } from './scope-exclusions.mjs';

const NOW=Date.parse('2026-11-04T06:00:00Z');
export const contract=()=>({objective:'Reduce query latency without changing results',authorization_ref:'human:original',
  project_id:'project',workspace:'/task',canonical_key:'query-work',constraints:['Preserve query semantics'],job_sources:['native'],
  requirements:[{id:'correct',text:'Existing queries return the same results'},{id:'latency',text:'Meet the agreed latency target'}]});
export const plan=action=>({steps:[{id:action,action,requirement_ids:['correct','latency'],depends_on:[]}],
  assumptions:[{id:'bottleneck',claim:action==='cache'?'Remote reads dominate':'Repeated scans dominate',status:'supported',evidence_refs:['profile']} ]});
export function fixture(path=':memory:') {
  let time=NOW;
  const c=new ControlStore(path,{now:()=>time,taskRegistry:()=>null}),s=c.reactive;
  const adopt=()=>s.adopt({task_id:'T-1',owner_thread_id:'worker',contract:contract(),source_message_id:'human:migrate',actual_human_verified:true});
  adopt();
  const observation=()=>({thread_id:'worker',project_id:'project',workspace:'/task',status:'idle',turn_id:'old-turn',turn_status:'completed',
    queued_input:false,background_job_running:false,approval_pending:false,permissions_preserved:true,checked_at:time});
  const event=(key='e1',payload={review:'pending'},patch={})=>s.ingest({event_id:key,task_id:'T-1',source:'github',subject:'repo#1',type:'pr_changed',
    observed_at:time,payload,evidence_ref:`source:${key}`,debounce_ms:0,...patch});
  const decide=(patch={})=>s.decide({task_id:'T-1',owner_thread_id:'worker',expected_context_rev:s.task('T-1').context_rev,
    expected_plan_rev:s.task('T-1').plan_rev,disposition:'revise',reason:'Profile identifies the bottleneck',evidence_refs:['profile'],plan:plan('cache'),...patch});
  const activate=()=>s.setMode({task_id:'T-1',mode:'active',source_message_id:'human:activate',actual_human_verified:true,observation:observation(),legacy_quiescent:true});
  return {c,s,observation,event,decide,activate,advance:ms=>{time+=ms;},now:()=>time};
}

test('events are durable, duplicate identities are immutable, and older observations cannot restore stale state',()=>{
  const f=fixture();try{
    assert.equal(f.s.task('T-1').mode,'shadow');
    assert.equal(f.event().changed,true);assert.equal(f.event().duplicate,true);
    assert.throws(()=>f.event('e1',{review:'approved'}),/immutable/);
    f.advance(1000);assert.equal(f.event('e2',{review:'changes_requested'}).changed,true);
    f.advance(1000);assert.equal(f.event('e3',{review:'pending'},{observed_at:NOW-1000}).stale,true);
    assert.equal(f.s.checkpoint('T-1').facts[0].data.review,'changes_requested');
    assert.equal(f.s.task('T-1').context_rev,2);
    assert.equal(f.event('e4',{review:'changes_requested'}).unchanged,true);
    assert.equal(f.s.task('T-1').context_rev,2);
  }finally{f.c.close();}
});

test('event coalescing has a maximum delay and never postpones a task indefinitely',()=>{
  const f=fixture();try{
    f.event('e0',{n:0},{debounce_ms:3000});
    for(let n=1;n<=6;n++){f.advance(1000);f.event(`e${n}`,{n},{debounce_ms:3000});}
    assert.equal(f.s.task('T-1').wake_at,NOW+5000);
  }finally{f.c.close();}
});

test('new evidence can replace the implementation plan but cannot drop user requirements',()=>{
  const f=fixture();try{
    f.event();f.decide();const first=f.s.plan('T-1');
    f.advance(1000);f.event('profile',{bottleneck:'repeated scan'});
    const dropped=plan('deduplicate scans');dropped.steps[0].requirement_ids=['latency'];
    assert.throws(()=>f.decide({plan:dropped}),/drop an acceptance requirement/);
    f.decide({plan:plan('deduplicate scans'),alternatives_considered:['cache does not remove duplicate CPU work']});
    assert.equal(f.s.plan('T-1').revision,2);assert.equal(f.s.plan('T-1').plan.steps[0].id,'deduplicate scans');
    const historical=f.c.db.prepare('SELECT * FROM rt_plans WHERE task_id=? AND revision=1').get('T-1');
    assert.equal(historical.state,'superseded');assert.deepEqual(JSON.parse(historical.plan),first.plan);
    assert.deepEqual(f.s.task('T-1').contract.requirements,contract().requirements);
  }finally{f.c.close();}
});

test('a factual change invalidates waits immediately, even before a busy owner can be woken',()=>{
  const f=fixture();try{
    f.event();f.decide();f.s.checkWait=()=>({valid:true});
    const facts=f.s.checkpoint('T-1').facts.map(({subject,version})=>({subject,version}));
    f.decide({disposition:'wait',plan:undefined,wait:{facts,condition:{kind:'pr',expected:'approval_pending'},expires_at:NOW+60000,resume_condition:'Reviewer responds'}});
    assert.equal(f.s.task('T-1').status,'waiting');
    f.activate();f.advance(1000);f.event('changes',{review:'changes_requested'});
    assert.equal(f.s.checkpoint('T-1').wait.state,'invalidated');assert.equal(f.s.task('T-1').dirty,true);
    assert.throws(()=>f.s.reserveWake('T-1',{...f.observation(),status:'active'}),/idle owner/);
    assert.equal(f.s.openWake('T-1'),null);
  }finally{f.c.close();}
});

test('textual waiting cannot replace real typed wait evidence, and expiry schedules reassessment once',()=>{
  const f=fixture();try{
    f.event();f.decide();
    const wait={facts:f.s.checkpoint('T-1').facts.map(({subject,version})=>({subject,version})),expires_at:NOW+1000,resume_condition:'Wait for reviewer'};
    assert.throws(()=>f.decide({disposition:'wait',plan:undefined,wait}),/Typed wait/);
    f.s.checkWait=condition=>({valid:condition?.kind==='pr'});wait.condition={kind:'pr'};
    f.decide({disposition:'wait',plan:undefined,wait});f.advance(1000);f.s.expireWaits();f.s.expireWaits();
    assert.equal(f.s.checkpoint('T-1').events.length,1);assert.equal(f.s.checkpoint('T-1').events[0].type,'wait_expired');
  }finally{f.c.close();}
});

test('old-context decisions and action plans are fenced after an event or a replan',()=>{
  const f=fixture();try{
    f.event();const decision=f.decide();f.activate();
    assert.deepEqual(f.s.actionReasons('merge','T-1',{runtime_context:decision.action_context}),[]);
    f.event('new',{review:'changes_requested'});
    assert.deepEqual(f.s.actionReasons('merge','T-1',{runtime_context:decision.action_context}),['reactive_plan_or_evidence_changed']);
    assert.throws(()=>f.decide({expected_context_rev:1}),/context\/plan changed/);
    assert.deepEqual(f.s.actionReasons('dispatch','T-1',{}),['reactive_plan_or_evidence_changed']);
  }finally{f.c.close();}
});

test('mode cutover refuses live work and uncertainty, and pausing keeps all evidence',()=>{
  const f=fixture();try{
    f.event();assert.throws(()=>f.s.setMode({task_id:'T-1',mode:'active',source_message_id:'human:activate',actual_human_verified:true,
      observation:f.observation(),legacy_quiescent:false}),/legacy batches/);
    f.activate();const w=f.s.reserveWake('T-1',f.observation()).wake;
    assert.throws(()=>f.s.setMode({task_id:'T-1',mode:'legacy',source_message_id:'human:rollback',actual_human_verified:true,
      observation:f.observation(),legacy_quiescent:true}),/in-flight/);
    f.s.setMode({task_id:'T-1',mode:'paused',source_message_id:'human:pause',actual_human_verified:true});
    assert.equal(f.s.openWake('T-1').id,w.id);assert.equal(f.s.checkpoint('T-1').events.length,1);
  }finally{f.c.close();}
});

test('send acknowledgement is not execution, and execution is not whole-task completion',()=>{
  const f=fixture();try{
    f.event();f.activate();const w=f.s.reserveWake('T-1',f.observation()).wake;
    assert.throws(()=>f.s.begin({task_id:'T-1',wake_id:w.id,owner_thread_id:'worker',turn_id:'new-turn',evidence_ref:'native'}),/actual new turn/);
    f.c.db.prepare("UPDATE rt_wakes SET state='sent',turn_id='new-turn' WHERE id=?").run(w.id);
    f.s.begin({task_id:'T-1',wake_id:w.id,owner_thread_id:'worker',turn_id:'new-turn',evidence_ref:'actual-command'});
    assert.throws(()=>f.decide({wake_id:w.id,disposition:'complete',plan:undefined,acceptance:[{requirement_id:'latency',passed:true,evidence_ref:'benchmark'}]}),/every contract requirement/);
    f.decide({wake_id:w.id,disposition:'complete',plan:undefined,acceptance:contract().requirements.map(r=>({requirement_id:r.id,passed:true,evidence_ref:'validated:'+r.id}))});
    assert.equal(f.s.finish({task_id:'T-1',wake_id:w.id,turn_id:'new-turn',evidence_ref:'report'}).task_complete,true);
  }finally{f.c.close();}
});

test('persistent events, superseded plans and uncertain wakes survive a process restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'reactive-state-')),path=join(dir,'control.sqlite');
  let f;try{
    f=fixture(path);f.event();f.decide();f.activate();f.event('changed',{review:'changes_requested'});
    const wake=f.s.reserveWake('T-1',f.observation()).wake;
    f.c.db.prepare("UPDATE rt_wakes SET state='uncertain' WHERE id=?").run(wake.id);f.c.close();
    f=fixture(path);assert.equal(f.s.openWake('T-1').state,'uncertain');assert.equal(f.s.task('T-1').context_rev,2);
    assert.equal(f.s.reserveWake('T-1',f.observation()).reason,'wake_in_flight');
  }finally{f?.c.close();rmSync(dir,{recursive:true,force:true});}
});

test('only a user-sourced contract amendment changes requirements and preserves the old contract',()=>{
  const f=fixture();try{
    f.event();f.decide();const next={...contract(),requirements:[...contract().requirements,{id:'memory',text:'Stay inside the agreed memory budget'}]};
    assert.throws(()=>f.s.amend({task_id:'T-1',expected_contract_rev:1,contract:next,source_message_id:'review:external',actual_human_verified:false}),/actual user/);
    f.s.amend({task_id:'T-1',expected_contract_rev:1,contract:next,source_message_id:'human:new-constraint',actual_human_verified:true});
    assert.equal(f.s.task('T-1').contract_rev,2);assert.equal(f.s.plan('T-1'),null);
    assert.throws(()=>f.decide({disposition:'continue',plan:undefined}),/concrete plan/);
    assert.throws(()=>f.decide({plan:plan('cache')}),/drop an acceptance requirement/);
    assert.equal(f.c.db.prepare('SELECT COUNT(*) AS n FROM rt_contracts').get().n,2);
  }finally{f.c.close();}
});

test('unknown external jobs and unreconciled user interruptions prevent a wake',()=>{
  const f=fixture();try{
    assert.throws(()=>f.s.assertIdle(f.s.task('T-1'),{...f.observation(),turn_status:'interrupted'}),/idle owner/);
    const task={...f.s.task('T-1'),contract:{...contract(),job_sources:['native','remote-build']}};
    assert.throws(()=>f.s.assertIdle(task,f.observation()),/unknown/);
    f.event('job',{state:'running'},{subject:'remote-build'});assert.throws(()=>f.s.assertIdle(task,f.observation()),/running or unknown/);
    f.advance(1000);f.event('job-finished',{state:'complete'},{subject:'remote-build'});assert.doesNotThrow(()=>f.s.assertIdle(task,f.observation()));
    f.advance(60001);assert.throws(()=>f.s.assertIdle(task,f.observation()),/running or unknown/);
  }finally{f.c.close();}
});

test('reactive wakes preserve explicit remaining scope and cannot revive a user exclusion',()=>{
  const f=fixture();try{
    const c={...contract(),scope_keys:['remaining-work']};
    f.s.amend({task_id:'T-1',expected_contract_rev:1,contract:c,source_message_id:'human:remaining',actual_human_verified:true});f.activate();
    const wake=f.s.reserveWake('T-1',f.observation()).wake;
    f.c.db.prepare('UPDATE rt_wakes SET prompt=? WHERE id=?').run('Evidence update',wake.id);
    const payload={wake_id:wake.id,thread_id:'worker',prompt:'Evidence update',scope_keys:['remaining-work']};
    assert.deepEqual(f.s.actionReasons('task_wake','T-1',payload),[]);
    assert.deepEqual(f.s.actionReasons('task_wake','T-1',{...payload,scope_keys:['excluded-work']}),['reactive_wake_changed_or_paused']);
    const registry={scope_restrictions:{'T-1:skip':{task_id:'T-1',source_message_id:'human:skip',evidence_ref:'source',verbatim_text:'Skip that scope',status:'excluded',targets:{scope_keys:['excluded-work']}}}};
    assert.deepEqual(scopeActionReasons(registry,'task_wake','T-1',payload),[]);
    assert.deepEqual(scopeActionReasons(registry,'task_wake','T-1',{...payload,scope_keys:['excluded-work']}),['scope_excluded_by_actual_user']);
  }finally{f.c.close();}
});
