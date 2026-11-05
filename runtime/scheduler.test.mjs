import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ControlStore} from './control.mjs';
import {fixture,contract,OWNER,NOW,nativeProof} from './test-fixtures/reactive.mjs';
import {scheduleTime} from './scheduler.mjs';

const MIN=60000,ID='runtime:research';
const auth={source_message_id:'user:schedule',evidence_ref:'actual-schedule-instruction',actual_human_verified:true};
const input=(patch={})=>({id:ID,task_id:'T-1',kind:'interval',start_at:new Date(NOW+MIN).toISOString(),interval_ms:MIN,timezone:'Asia/Shanghai',...auth,...patch});
function setup(path=':memory:'){
 const f=fixture(path);f.s.amend({task_id:'T-1',expected_contract_rev:1,contract:{...contract(),trigger_only:true,schedule_sources:[ID]},source_message_id:'user:recurring-scope',actual_human_verified:true});
 f.activate();return {...f,timer:f.c.scheduler};
}
function finish(f,w,{disposition='cycle_complete',evidence='current-run-results'}={}){
 f.decide({wake_id:w.id,disposition,plan:undefined,evidence_refs:[evidence],acceptance:f.s.task('T-1').contract.requirements.map(r=>({requirement_id:r.id,passed:true,evidence_ref:evidence}))});
 return f.s.finish({task_id:'T-1',wake_id:w.id,turn_id:'native-turn',evidence_ref:evidence});
}

test('one-time timers do not run early and finish only after actual per-run execution and acceptance',()=>{
 const f=setup();try{f.timer.create(input({kind:'once',interval_ms:undefined}));
  assert.equal(f.timer.tick().admitted,0);assert.equal(f.s.task('T-1').wake_at,null);f.advance(MIN);
  assert.equal(f.timer.tick().admitted,1);assert.equal(f.timer.tick().admitted,0);
  const run=f.timer.runs(ID)[0];assert.equal(run.state,'admitted');assert.equal(run.started_at,null);
  assert.equal(f.s.checkpoint('T-1').schedule_runs[0].id,run.id);
  const w=f.begin();assert.equal(f.timer.runs(ID)[0].state,'running');finish(f,w);
  const done=f.timer.runs(ID)[0];assert.equal(done.state,'completed');assert.equal(done.result.acceptance.length,2);
  assert.equal(done.result.checkpoint_evidence_ref,'current-run-results');assert.equal(f.timer.get(ID).status,'finished');
  f.advance(10*MIN);assert.equal(f.timer.tick().admitted,0);
 }finally{f.c.close();}
});
test('multiple same-day periodic runs keep distinct identities, current evidence and one original owner',()=>{
 const f=setup();try{f.timer.create(input());f.advance(MIN);f.timer.tick();finish(f,f.begin(),{evidence:'run-one'});
  f.advance(MIN);f.timer.tick();finish(f,f.begin(),{evidence:'run-two'});
  const runs=f.timer.runs(ID);assert.equal(runs.length,2);assert.notEqual(runs[0].id,runs[1].id);
  assert.notEqual(runs[0].event_id,runs[1].event_id);assert.deepEqual(runs.map(r=>r.result.evidence_refs),[['run-one'],['run-two']]);
  assert.ok(runs.every(r=>r.owner_id===OWNER));assert.equal(f.s.tasks().length,1);assert.equal(f.timer.get(ID).next_at,NOW+3*MIN);
 }finally{f.c.close();}
});
test('a restart coalesces missed occurrences without replaying already admitted events',()=>{
 const root=mkdtempSync(join(tmpdir(),'runtime-timer-')),path=join(root,'control.sqlite');const f=setup(path);let reopened;
 try{f.timer.create(input());f.c.close();f.advance(5*MIN+1000);
  reopened=new ControlStore(path,{now:f.now,taskRegistry:()=>null});const timer=reopened.scheduler;
  assert.equal(timer.tick().admitted,1);const run=timer.runs(ID)[0];
  assert.equal(run.first_due_at,NOW+MIN);assert.equal(run.due_at,NOW+5*MIN);assert.equal(run.occurrences,5);
  assert.equal(timer.get(ID).next_at,NOW+6*MIN);assert.equal(timer.tick().admitted,0);
  const second=new ControlStore(path,{now:f.now,taskRegistry:()=>null});try{assert.equal(second.scheduler.tick().admitted,0);assert.equal(second.scheduler.runs(ID).length,1);}finally{second.close();}
 }finally{reopened?.close();rmSync(root,{recursive:true,force:true});}
});
test('busy cycles accumulate one pending run and preserve the executing context until completion',()=>{
 const f=setup();try{f.timer.create(input());f.advance(MIN);f.timer.tick();const w=f.begin(),rev=f.s.task('T-1').context_rev;
  f.advance(3*MIN);assert.equal(f.timer.tick().admitted,0);assert.equal(f.s.task('T-1').context_rev,rev);
  const pending=f.timer.runs(ID).find(r=>r.state==='pending');assert.equal(pending.occurrences,3);
  f.advance(MIN);f.timer.tick();assert.equal(f.timer.runs(ID).filter(r=>r.state==='pending').length,1);
  assert.equal(f.timer.runs(ID).find(r=>r.state==='pending').occurrences,4);
  finish(f,w);assert.equal(f.timer.tick().admitted,1);assert.equal(f.timer.runs(ID).find(r=>r.state==='admitted').id,pending.id);
 }finally{f.c.close();}
});
test('skip overlap records missed occurrences without scheduling replacement work',()=>{
 const f=setup();try{f.timer.create(input({overlap:'skip'}));f.advance(MIN);f.timer.tick();const w=f.begin();
  f.advance(3*MIN);f.timer.tick();const skipped=f.timer.runs(ID).find(r=>r.state==='skipped');assert.equal(skipped.occurrences,3);
  finish(f,w);assert.equal(f.timer.tick().admitted,0);assert.equal(f.timer.runs(ID).filter(r=>r.state==='pending').length,0);
 }finally{f.c.close();}
});
test('paused schedules coalesce elapsed slots on resume and cancelled pending work never revives',()=>{
 const f=setup();try{f.timer.create(input());f.timer.change({id:ID,expected_revision:1,action:'pause',...auth});
  f.advance(4*MIN);assert.equal(f.timer.tick().admitted,0);
  assert.throws(()=>f.timer.change({id:ID,expected_revision:1,action:'resume',...auth}),/reread/);
  f.timer.change({id:ID,expected_revision:2,action:'resume',...auth});f.mode('paused');f.timer.tick();
  assert.equal(f.timer.runs(ID)[0].state,'pending');assert.equal(f.timer.runs(ID)[0].occurrences,4);
  f.timer.change({id:ID,expected_revision:3,action:'cancel',...auth});assert.equal(f.timer.runs(ID)[0].state,'cancelled');
  f.activate();assert.equal(f.timer.tick().admitted,0);
  assert.throws(()=>f.timer.change({id:ID,expected_revision:4,action:'resume',...auth}),/Terminal/);
 }finally{f.c.close();}
});
test('cancellation preserves an accepted running cycle and never cancels its actual work',()=>{
 const f=setup();try{f.timer.create(input());f.advance(MIN);f.timer.tick();const w=f.begin();
  const result=f.timer.change({id:ID,expected_revision:1,action:'cancel',...auth});assert.equal(result.accepted_runs_preserved.length,1);
  assert.equal(f.s.openWake('T-1').state,'running');finish(f,w);assert.equal(f.timer.runs(ID)[0].state,'completed');
  f.advance(10*MIN);assert.equal(f.timer.tick().admitted,0);assert.equal(f.timer.get(ID).status,'cancelled');
 }finally{f.c.close();}
});
test('task pauses, explicit holds and uncertain native receipts are never bypassed',()=>{
 const f=setup();try{f.timer.create(input());f.mode('paused');f.advance(MIN);f.timer.tick();assert.equal(f.timer.runs(ID)[0].state,'pending');
  f.activate();f.s.amend({task_id:'T-1',expected_contract_rev:2,contract:{...f.s.task('T-1').contract,execution_hold:true},source_message_id:'user:hold',actual_human_verified:true});
  assert.equal(f.timer.tick().admitted,0);
  f.s.amend({task_id:'T-1',expected_contract_rev:3,contract:{...f.s.task('T-1').contract,execution_hold:false},source_message_id:'user:resume',actual_human_verified:true});
  assert.equal(f.timer.tick().admitted,1);const w=f.s.reserveQueuedWake('T-1').wake;
  f.c.db.prepare("UPDATE rt_wakes SET state='uncertain' WHERE id=?").run(w.id);f.advance(MIN);f.timer.tick();
  assert.equal(f.s.openWake('T-1').state,'uncertain');assert.equal(f.timer.runs(ID).filter(r=>r.state==='admitted').length,1);
 }finally{f.c.close();}
});
test('fixed intervals retain elapsed-time semantics across timezone DST changes and clock reversal',()=>{
 const f=setup();try{const start='2026-11-01T01:30:00-04:00';f.timer.create(input({timezone:'America/New_York',start_at:start,interval_ms:86400000}));
  f.timer.tick();const run=f.timer.runs(ID)[0];assert.equal((run.due_at-scheduleTime(start))%86400000,0);
  const next=f.timer.get(ID).next_at;f.advance(-MIN);f.timer.tick();assert.equal(f.timer.get(ID).next_at,next);
  assert.equal(scheduleTime('2026-11-05T09:00:00+08:00'),Date.parse('2026-11-05T01:00:00Z'));
  assert.throws(()=>scheduleTime('2026-11-05T09:00:00'),/explicit UTC offset/);
  assert.throws(()=>f.timer.create(input({id:'runtime:other',timezone:'Mars/Olympus'})),RangeError);
 }finally{f.c.close();}
});
test('schedule creation requires bound actual user authority and retries cannot redefine it',()=>{
 const f=setup();try{
  assert.throws(()=>f.timer.create(input({actual_human_verified:false})),/actual user/);
  assert.throws(()=>f.timer.create(input({id:'runtime:unbound'})),/authorized task contract/);
  assert.equal(f.timer.create(input()).created,true);assert.equal(f.timer.create(input()).created,false);
  assert.throws(()=>f.timer.create(input({interval_ms:2*MIN})),/different immutable/);
  assert.throws(()=>f.timer.create(input({interval_ms:1})),/one minute/);
  const old=f.s.task('T-1');f.s.amend({task_id:'T-1',expected_contract_rev:old.contract_rev,contract:{...old.contract,schedule_sources:[ID,'existing-app-timer']},source_message_id:'user:native',actual_human_verified:true});
  assert.throws(()=>f.timer.create(input()),/existing native schedule/);
 }finally{f.c.close();}
});
test('whole-goal completion ends periodic scheduling while cycle completion keeps it enabled',()=>{
 const f=setup();try{f.timer.create(input());f.advance(MIN);f.timer.tick();const w=f.begin();f.advance(MIN);f.timer.tick();
  finish(f,w,{disposition:'complete'});assert.equal(f.timer.get(ID).status,'finished');assert.equal(f.timer.runs(ID).find(r=>r.occurrences===1&&r.state==='cancelled').blocked_reason,'whole_task_complete');
  f.advance(MIN);assert.equal(f.timer.tick().admitted,0);
 }finally{f.c.close();}
});

test('calendar overflow is rejected instead of silently moving a one-time trigger',()=>{
 for(const stamp of ['2026-02-30T09:00:00+08:00','2026-11-05T24:00:00Z','2026-13-01T00:00:00Z'])assert.throws(()=>scheduleTime(stamp),/Invalid calendar/);
 assert.equal(scheduleTime('2028-02-29T00:00:00Z'),Date.parse('2028-02-29T00:00:00Z'));
});
test('shared owners consume one grouped wake with distinct scheduled run results',()=>{
 const f=setup();try{const second='runtime:second';f.s.adopt({task_id:'T-2',owner_thread_id:OWNER,contract:{...contract(),canonical_key:'second',trigger_only:true,schedule_sources:[second]},source_message_id:'user:second',actual_human_verified:true});
  f.s.setModes({task_ids:['T-1','T-2'],mode:'active',source_message_id:'user:enable',actual_human_verified:true,native_binding:f.binding(),queue_compatibility_verified:true,legacy_quiescent:true});
  f.timer.create(input());f.timer.create(input({id:second,task_id:'T-2'}));f.advance(MIN);assert.equal(f.timer.tick().admitted,2);
  const w=f.begin();assert.deepEqual(w.member_ids,['T-1','T-2']);
  for(const task_id of w.member_ids)f.s.decide({task_id,owner_thread_id:OWNER,wake_id:w.id,expected_context_rev:f.s.task(task_id).context_rev,expected_plan_rev:0,
   disposition:'cycle_complete',reason:'Independent cycle delivered',evidence_refs:[`result:${task_id}`],acceptance:contract().requirements.map(r=>({requirement_id:r.id,passed:true,evidence_ref:`result:${task_id}`}))});
  f.s.finish({task_id:'T-2',wake_id:w.id,turn_id:'native-turn',evidence_ref:'grouped-completion'});
  assert.deepEqual(f.timer.runs(ID)[0].result.evidence_refs,['result:T-1']);assert.deepEqual(f.timer.runs(second)[0].result.evidence_refs,['result:T-2']);
  assert.equal(f.timer.runs(ID)[0].wake_id,f.timer.runs(second)[0].wake_id);
 }finally{f.c.close();}
});
test('a cycle waiting for a human remains open across wakes and blocks another round',()=>{
 const f=setup();try{f.timer.create(input());f.advance(MIN);f.timer.tick();const first=f.begin();
  f.decide({wake_id:first.id,disposition:'needs_decision',plan:undefined});f.s.finish({task_id:'T-1',wake_id:first.id,turn_id:'native-turn',evidence_ref:'pending-human'});
  f.advance(MIN);assert.equal(f.timer.tick().admitted,0);assert.equal(f.timer.runs(ID).filter(r=>r.state==='running').length,1);
  f.event('actual-answer',{answer:'Continue with original bounded scope'},{type:'human_command'});const next=f.begin();finish(f,next);
  assert.equal(f.timer.runs(ID).filter(r=>r.state==='completed').length,1);assert.equal(f.timer.runs(ID).find(r=>r.state==='completed').wake_id,next.id);
  assert.equal(f.timer.tick().admitted,1);
 }finally{f.c.close();}
});
