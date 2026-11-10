import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './test-fixtures/reactive.mjs';
import {OwnerHealth,classifyOwnerHealth} from './owner-health.mjs';

function setup(){
 const f=fixture();f.c.work.setPolicy({key:'continuous_authorized_work',enabled:true,allowed_kinds:['work','project','exploration'],actual_human_verified:true,source_message_id:'human:continuous',verbatim_text:'Continue authorized unfinished goals; only material human decisions stop them',evidence_ref:'actual-human-rule'});
 f.activate();f.event();const w=f.begin(),id=f.s.task('T-1').contract.requirements[0].id;
 const progress={remaining_requirements:[id],next_action:'Obtain the missing scoped human choice',jobs:[],dependencies:[]};
 const decision_request={kind:'scope',scope:'task',question:'May this work cross the explicitly prohibited API boundary?',why_owner_cannot_decide:'The proposed alternative exceeds the accepted API scope',blocked_requirements:[id],evidence_refs:['actual-api-boundary'],independent_authorized_work:[]};
 return {...f,w,progress,decision_request,decide:patch=>f.decide({wake_id:w.id,...patch})};
}

test('a negative phase report or external-only hold cannot become a whole-task human decision while authorized work remains',()=>{
 const f=setup();try{
  assert.throws(()=>f.decide({disposition:'needs_decision',reason:'One experiment failed; should we continue or pause?'}),/material human-only/);
  assert.throws(()=>f.decide({disposition:'needs_decision',progress:f.progress,decision_request:{...f.decision_request,kind:'negative_result'}}),/material human-only/);
  assert.throws(()=>f.decide({disposition:'needs_decision',progress:f.progress,decision_request:{...f.decision_request,independent_authorized_work:['Measure the bounded next hypothesis without external delivery']}}),/continue independent/);
  assert.notEqual(f.s.task('T-1').status,'needs_decision');
  assert.equal(f.c.db.prepare('SELECT COUNT(*) n FROM rt_decisions').get().n,0);
 }finally{f.c.close();}
});

test('a real scoped human boundary records its remaining goal and waits without losing the original holds',()=>{
 const f=setup();try{
  const before=f.s.task('T-1').contract;f.decide({disposition:'needs_decision',progress:f.progress,decision_request:f.decision_request});
  assert.equal(f.s.task('T-1').status,'needs_decision');assert.deepEqual(f.s.task('T-1').contract,before);
  const data=JSON.parse(f.c.db.prepare('SELECT data FROM rt_decisions').get().data);assert.deepEqual(data.progress,f.progress);assert.deepEqual(data.decision_request,f.decision_request);
  f.s.finish({task_id:'T-1',wake_id:f.w.id,turn_id:f.w.turn_id,evidence_ref:'actual-human-boundary-checkpoint'});
 }finally{f.c.close();}
});

test('whole-goal acceptance can still complete without manufacturing another optimization cycle',()=>{
 const f=setup();try{
  const acceptance=f.s.task('T-1').contract.requirements.map(r=>({requirement_id:r.id,passed:true,evidence_ref:'actual-whole-goal-acceptance'}));
  f.decide({disposition:'complete',acceptance});assert.equal(f.s.task('T-1').status,'complete');
  assert.equal(f.s.finish({task_id:'T-1',wake_id:f.w.id,turn_id:f.w.turn_id,evidence_ref:'accepted-result'}).task_complete,true);
 }finally{f.c.close();}
});

test('a stale decision projection cannot hide an actual running or failed native wake, while real pauses stay protected',()=>{
 const f=setup();try{
  f.decide({disposition:'needs_decision',progress:f.progress,decision_request:f.decision_request});
  const h=new OwnerHealth(f.c,{now:f.now});assert(h.targets().some(t=>t.task_id==='T-1'));
  const task=f.s.task('T-1'),active={thread:{status:{type:'active',activeFlags:[]}},latestTurn:{id:f.w.turn_id,status:'inProgress'}};
  assert.equal(classifyOwnerHealth(task,f.w,active),'running');
  assert.equal(classifyOwnerHealth(task,f.w,{...active,thread:{status:{type:'idle'}},latestTurn:{id:f.w.turn_id,status:'failed',error:{message:'400 Codex: Bad Request'}}}),'turn_failed');
  assert.equal(classifyOwnerHealth({...task,mode:'paused'},f.w,active),'protected');
  assert.equal(classifyOwnerHealth(task,null,{thread:{status:{type:'idle'}},latestTurn:{id:f.w.turn_id,status:'completed'}}),'protected');
 }finally{f.c.close();}
});
