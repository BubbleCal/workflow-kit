import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scopeActionReasons} from './scope-exclusions.mjs';
import {fixture,contract,plan,nativeProof,NOW,OWNER,QUEUE_ID} from './test-fixtures/reactive.mjs';

test('shared owners retain separate contracts and consume one grouped wake',()=>{
  const f=fixture();try{
    f.s.adopt({task_id:'T-2',owner_thread_id:OWNER,contract:{...contract(),canonical_key:'other-goal'},source_message_id:'human:migrate',actual_human_verified:true});
    f.s.setModes({task_ids:['T-1','T-2'],mode:'active',source_message_id:'human:migrate',actual_human_verified:true,native_binding:f.binding(),queue_compatibility_verified:true,legacy_quiescent:true});
    f.event();f.event('second',{result:'pending'},{task_id:'T-2'});
    const w=f.s.reserveQueuedWake('T-1').wake;
    assert.deepEqual(w.member_ids,['T-1','T-2']);
    assert.equal(f.s.reserveQueuedWake('T-2').reserved,false);
    f.c.db.prepare("UPDATE rt_wakes SET state='queued',prompt='group' WHERE id=?").run(w.id);
    f.s.begin({task_id:'T-1',wake_id:w.id,native_proof:nativeProof({message:'group'})});
    f.decide({wake_id:w.id,disposition:'needs_decision',plan:undefined});
    assert.throws(()=>f.s.finish({task_id:'T-1',wake_id:w.id,turn_id:'native-turn',evidence_ref:'partial'}),/member|concrete plan/);
    f.s.decide({task_id:'T-2',owner_thread_id:OWNER,wake_id:w.id,expected_context_rev:f.s.task('T-2').context_rev,expected_plan_rev:0,disposition:'needs_decision',reason:'Original independent approval still required',evidence_refs:['original-hold']});
    assert.equal(f.s.finish({task_id:'T-2',wake_id:w.id,turn_id:'native-turn',evidence_ref:'both-disposed'}).finished,true);
    assert.notEqual(f.s.task('T-1').contract.canonical_key,f.s.task('T-2').contract.canonical_key);
  }finally{f.c.close();}
});

test('owner cutover is atomic and requires coverage without reclassifying completed aliases',()=>{
  const f=fixture();try{
    f.s.adopt({task_id:'T-2',owner_thread_id:OWNER,contract:{...contract(),canonical_key:'second'},source_message_id:'human',actual_human_verified:true});
    const registry={scope:{project_id:'project'},task_registry:{items:{'T-1':{canonical_key:'query-work',owner_thread_id:OWNER},'T-2':{canonical_key:'second',owner_thread_id:OWNER},'T-old':{owner_thread_id:OWNER,task_complete:true,status:'complete_archived_verified'}}}};
    f.s.registry=()=>registry;
    assert.throws(()=>f.activate(),/all unfinished tasks/);
    f.c.importLegacy([{key:'unknown-second-effect',task_id:'T-2',status:'sending'}]);
    const request={task_ids:['T-1','T-2'],mode:'active',source_message_id:'human',actual_human_verified:true,native_binding:f.binding(),queue_compatibility_verified:true,legacy_quiescent:true};
    assert.throws(()=>f.s.setModes(request),/in-flight/);
    assert.deepEqual(f.s.tasks().map(t=>t.mode),['shadow','shadow']);
    assert.equal(registry.task_registry.items['T-old'].completed,undefined);
  }finally{f.c.close();}
});

test('a late sibling event cannot bypass a running or uncertain owner delivery',()=>{
  const f=fixture();try{
    f.s.adopt({task_id:'T-2',owner_thread_id:OWNER,contract:{...contract(),canonical_key:'second'},source_message_id:'human',actual_human_verified:true});
    f.activate();f.event();const w=f.begin();
    f.s.setMode({task_id:'T-2',mode:'active',source_message_id:'human',actual_human_verified:true,native_binding:f.binding(),queue_compatibility_verified:true,legacy_quiescent:true});
    f.event('late',{new:'fact'},{task_id:'T-2'});
    assert.equal(f.s.reserveQueuedWake('T-2').reason,'owner_wake_in_flight');
    f.c.db.prepare("UPDATE rt_wakes SET state='uncertain' WHERE id=?").run(w.id);
    assert.equal(f.s.reserveQueuedWake('T-2').reason,'owner_wake_in_flight');
    assert.deepEqual(f.s.openWake('T-1').member_ids,['T-1']);
  }finally{f.c.close();}
});

test('immutable events deduplicate, reject changed identities and preserve newer source observations',()=>{
  const f=fixture();try{
    assert.equal(f.event().changed,true);assert.equal(f.event().duplicate,true);assert.throws(()=>f.event('e1',{changed:true}),/immutable/);
    f.advance(1000);f.event('e2',{review:'changes_requested'});f.event('old',{review:'pending'},{observed_at:NOW-1});
    assert.equal(f.s.checkpoint('T-1').facts[0].data.review,'changes_requested');assert.equal(f.s.task('T-1').context_rev,2);
    assert.equal(f.event('same',{review:'changes_requested'}).unchanged,true);
  }finally{f.c.close();}
});
test('coalescing cannot postpone an event forever',()=>{
  const f=fixture();try{f.event('e0',{n:0},{debounce_ms:3000});for(let n=1;n<7;n++){f.advance(1000);f.event(`e${n}`,{n},{debounce_ms:3000});}
    assert.equal(f.s.task('T-1').wake_at,NOW+5000);
  }finally{f.c.close();}
});
test('a plan may replace its implementation steps while retaining every user requirement and its history',()=>{
  const f=fixture();try{
    f.event();f.decide();const before=f.s.plan('T-1');f.advance(1000);f.event('counterexample',{bottleneck:'duplicate scans'});
    const bad=plan('scan');bad.steps[0].requirement_ids=['latency'];assert.throws(()=>f.decide({plan:bad}),/drop an acceptance requirement/);
    f.decide({plan:plan('remove duplicate scans')});assert.equal(f.s.plan('T-1').revision,2);
    const old=f.c.db.prepare('SELECT * FROM rt_plans WHERE revision=1').get();assert.equal(old.state,'superseded');assert.deepEqual(JSON.parse(old.plan),before.plan);
  }finally{f.c.close();}
});
test('new evidence invalidates a wait before the desktop consumes its next queued message',()=>{
  const f=fixture();try{
    f.event();f.decide();f.s.checkWait=()=>({valid:true});
    const wait={facts:f.s.checkpoint('T-1').facts.map(({subject,version})=>({subject,version})),condition:{kind:'pr'},expires_at:NOW+60000,resume_condition:'Review responds'};
    f.decide({disposition:'wait',plan:undefined,wait});f.activate();f.event('review',{review:'changes_requested'});
    assert.equal(f.s.checkpoint('T-1').wait.state,'invalidated');const w=f.s.reserveQueuedWake('T-1').wake;
    assert.equal(w.preflight_turn,null);assert.equal(w.turn_id,null);assert.equal(w.transport,'native_queue');
    assert.throws(()=>f.s.begin({task_id:'T-1',wake_id:w.id,native_proof:nativeProof()}),/actual new turn/);
  }finally{f.c.close();}
});
test('typed waits require real current facts and expiry creates one reassessment',()=>{
  const f=fixture();try{
    f.event();f.decide();const wait={facts:f.s.checkpoint('T-1').facts.map(({subject,version})=>({subject,version})),condition:{kind:'pr'},expires_at:NOW+1000,resume_condition:'Read the new review'};
    assert.throws(()=>f.decide({disposition:'wait',plan:undefined,wait}),/Typed wait/);
    f.s.checkWait=()=>({valid:true});f.decide({disposition:'wait',plan:undefined,wait});f.advance(1000);f.s.expireWaits();f.s.expireWaits();
    assert.equal(f.s.checkpoint('T-1').events.length,1);
  }finally{f.c.close();}
});
test('activation requires desktop queue compatibility and native identity without claiming control of the session',()=>{
  const f=fixture();try{
    const request={task_id:'T-1',mode:'active',source_message_id:'user:activate',actual_human_verified:true,native_binding:f.binding(),legacy_quiescent:true};
    assert.throws(()=>f.s.setMode(request),/queue consumption/);
    assert.throws(()=>f.s.setMode({...request,queue_compatibility_verified:true,native_binding:nativeProof({workspace:'/wrong'})}),/identity\/workspace/);
    assert.throws(()=>f.s.setMode({...request,queue_compatibility_verified:true,legacy_quiescent:false}),/legacy batches/);
    assert.equal(f.s.setMode({...request,queue_compatibility_verified:true}).mode,'active');
    assert.deepEqual(f.s.actionReasons('task_wake','T-1',{}),['direct_app_server_transport_removed']);
  }finally{f.c.close();}
});
test('native acceptance is not execution, and execution is not contract completion',()=>{
  const f=fixture();try{
    f.event();f.activate();const w=f.begin();assert.equal(w.state,'running');
    assert.throws(()=>f.decide({wake_id:w.id,disposition:'complete',plan:undefined,acceptance:[]}),/every contract requirement/);
    f.decide({wake_id:w.id,disposition:'complete',plan:undefined,acceptance:contract().requirements.map(r=>({requirement_id:r.id,passed:true,evidence_ref:'actual-validation'}))});
    assert.equal(f.s.finish({task_id:'T-1',wake_id:w.id,turn_id:'native-turn',evidence_ref:'report'}).task_complete,true);
  }finally{f.c.close();}
});
test('queued and uncertain messages block a second submission across restart',()=>{
  const root=mkdtempSync(join(tmpdir(),'queue-state-'));let f;try{
    const path=join(root,'control.sqlite');f=fixture(path);f.event();f.activate();const w=f.s.reserveQueuedWake('T-1').wake;
    f.c.db.prepare("UPDATE rt_wakes SET state='queued',queue_id=? WHERE id=?").run(QUEUE_ID,w.id);f.c.close();f=fixture(path);
    assert.equal(f.s.reserveQueuedWake('T-1').reason,'wake_in_flight');
    f.c.db.prepare("UPDATE rt_wakes SET state='uncertain' WHERE id=?").run(w.id);assert.equal(f.s.reserveQueuedWake('T-1').reason,'wake_in_flight');
  }finally{f?.c.close();rmSync(root,{recursive:true,force:true});}
});
test('user amendments invalidate the plan and stale contexts cannot authorize effects',()=>{
  const f=fixture();try{
    f.event();const original=f.decide();f.activate();assert.deepEqual(f.s.actionReasons('merge','T-1',{runtime_context:original.action_context}),[]);
    const next={...contract(),requirements:[...contract().requirements,{id:'memory',text:'Preserve the memory budget'}]};
    assert.throws(()=>f.s.amend({task_id:'T-1',expected_contract_rev:1,contract:next,source_message_id:'external:review',actual_human_verified:false}),/actual user/);
    f.s.amend({task_id:'T-1',expected_contract_rev:1,contract:next,source_message_id:'human:change',actual_human_verified:true});
    assert.equal(f.s.plan('T-1'),null);assert.equal(f.s.task('T-1').contract_rev,2);
    assert.deepEqual(f.s.actionReasons('merge','T-1',{runtime_context:original.action_context}),['reactive_plan_or_evidence_changed']);
  }finally{f.c.close();}
});
test('queue delivery retains user scope exclusions and the immutable prompt binding',()=>{
  const f=fixture();try{
    f.s.amend({task_id:'T-1',expected_contract_rev:1,contract:{...contract(),scope_keys:['remaining']},source_message_id:'human:scope',actual_human_verified:true});
    f.activate();const w=f.s.reserveQueuedWake('T-1').wake;f.c.db.prepare('UPDATE rt_wakes SET prompt=? WHERE id=?').run('event',w.id);
    const p={thread_id:OWNER,wake_id:w.id,prompt:'event',scope_keys:['remaining']};assert.deepEqual(f.s.actionReasons('task_queue','T-1',p),[]);
    assert.notDeepEqual(f.s.actionReasons('task_queue','T-1',{...p,prompt:'different work'}),[]);
    const r={scope_restrictions:{skip:{task_id:'T-1',source_message_id:'human',evidence_ref:'source',verbatim_text:'Skip this',status:'excluded',targets:{scope_keys:['excluded']}}}};
    assert.deepEqual(scopeActionReasons(r,'task_queue','T-1',p),[]);
    assert.deepEqual(scopeActionReasons(r,'task_queue','T-1',{...p,scope_keys:['excluded']}),['scope_excluded_by_actual_user']);
  }finally{f.c.close();}
});
test('pause and rollback preserve native queue receipts instead of pretending cancellation',()=>{
  const f=fixture();try{
    f.event();f.activate();const w=f.s.reserveQueuedWake('T-1').wake;
    f.c.db.prepare("UPDATE rt_wakes SET state='queued' WHERE id=?").run(w.id);f.mode('paused');
    assert.equal(f.s.openWake('T-1').state,'queued');assert.throws(()=>f.mode('legacy'),/in-flight/);
    assert.equal(f.s.checkpoint('T-1').events.length,1);
  }finally{f.c.close();}
});
