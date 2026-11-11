import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,QUEUE_ID,nativeProof} from './test-fixtures/reactive.mjs';
import {OwnerWork} from './owner-work.mjs';
import {wakePrompt} from './reactive-driver.mjs';

function setup(){
 const f=fixture();
 for(const key of ['owner_autonomy','continuous_authorized_work'])f.c.work.setPolicy({key,enabled:true,allowed_kinds:['work','project','exploration'],source_message_id:'human:autonomy',verbatim_text:'Own the goal, try bounded approaches and keep working; routine technical choices are yours.',evidence_ref:'actual-human-instruction',actual_human_verified:true});
 f.activate();f.event();const wake=f.s.reserveQueuedWake('T-1').wake,prompt='Actual accepted goal wake';
 f.c.db.prepare("UPDATE rt_wakes SET prompt=?,state='queued',queue_id=? WHERE id=?").run(prompt,QUEUE_ID,wake.id);
 const work=new OwnerWork(f.c),lease={task_id:'T-1',owner_thread_id:OWNER,wake_id:wake.id};
 const start=()=>work.run({...lease,op:'start',native_proof:nativeProof({message:prompt,now:f.now()})});
 const update=(op,patch={})=>work.run({...lease,op,evidence_ref:'actual-result',...patch});
 return{...f,work,wake,lease,start,update};
}

test('one work entry starts real execution and persists concrete progress without manual revision or plan bookkeeping',()=>{
 const f=setup();try{const before=f.s.task('T-1').contract,start=f.start();assert.equal(start.started,true);assert.equal(start.goal,before.objective);
  assert.equal(start.turn_id,'native-turn');assert.equal(f.work.run({...f.lease,op:'start'}).started,true);
  const result=f.update('progress',{next_action:'Measure the observed allocation bottleneck'});assert.equal(result.finished,false);assert.equal(result.disposition,'continue');
  f.event('actual-new-profile',{finding:'Separate allocation from IO'});
  f.update('progress',{next_action:'Test the allocation fix',jobs:[{id:'existing-job',state:'running'}]});
  f.update('progress',{next_action:'Compare its output with the baseline'});
  assert.deepEqual(f.s.task('T-1').contract,before);assert.equal(f.s.openWake('T-1').state,'running');
  const brief=f.work.run({...f.lease,op:'status'});assert.equal(brief.frontier.next_action,'Compare its output with the baseline');assert.equal(brief.frontier.jobs[0].id,'existing-job');
 }finally{f.c.close();}
});

test('an action-specific permission question does not stop independent authorized engineering',()=>{
 const f=setup();try{f.start();const original=f.s.task('T-1').contract;
  const result=f.update('question',{kind:'authority',question:'May the current PR be sent externally?',why_owner_cannot_decide:'The human review hold applies to delivery',blocked_actions:['slack_pr'],next_action:'Finish the independent compatibility investigation'});
  assert.equal(result.disposition,'continue');assert.equal(result.question.scope,'action');assert.equal(result.finished,false);
  assert.equal(f.s.task('T-1').status,'ready');assert.deepEqual(f.s.task('T-1').contract,original);
  assert.equal(f.s.openWake('T-1').state,'running');
 }finally{f.c.close();}
});

test('routine technical choices become owner experiments while a genuine all-work human boundary closes the turn once',()=>{
 const f=setup();try{f.start();const own=f.update('question',{question:'Which bounded cache layout should I try first?',all_work_blocked:true});
  assert.equal(own.technical_choice_owned,true);assert.equal(own.question,null);assert.equal(f.s.task('T-1').status,'ready');
  const input={kind:'scope',question:'May I change the explicitly frozen public API?',why_owner_cannot_decide:'The accepted contract explicitly forbids this API change',all_work_blocked:true,update_id:'actual-human-boundary'};
  const stopped=f.update('question',input);assert.equal(stopped.disposition,'needs_decision');assert.equal(stopped.finished,true);
  const count=f.c.db.prepare('SELECT count(*) n FROM rt_decisions').get().n;
  assert.equal(f.update('question',input).replayed,true);assert.equal(f.c.db.prepare('SELECT count(*) n FROM rt_decisions').get().n,count);
  assert.throws(()=>f.update('question',{...input,question:'Changed question under the same receipt'}),/cannot change intent/);
 }finally{f.c.close();}
});

test('a real timed wait auto-finishes, stays quiet before its deadline and completes only with full goal evidence',()=>{
 const f=setup();try{f.start();const until=f.now()+60000;
  const r=f.update('wait',{next_action_at:new Date(until).toISOString(),reason:'The acknowledged job checkpoint is not useful before this time'});
  assert.equal(r.finished,true);assert.equal(f.s.task('T-1').status,'waiting');assert.equal(f.s.task('T-1').wake_at,null);
  f.advance(59999);f.s.expireWaits();assert.equal(f.s.task('T-1').wake_at,null);
 }finally{f.c.close();}
 const complete=setup();try{complete.start();assert.throws(()=>complete.update('complete',{acceptance:[]}),/evidence for every/);
  const acceptance=complete.s.task('T-1').contract.requirements.map(r=>({requirement_id:r.id,passed:true,evidence_ref:'actual-whole-goal-result'}));
  const r=complete.update('complete',{acceptance});assert.equal(r.finished,true);assert.equal(complete.s.task('T-1').status,'complete');
  assert.equal(complete.update('complete',{acceptance}).replayed,true);
 }finally{complete.c.close();}
});

test('new facts arriving at the stopping boundary keep the actual work turn open for reassessment',()=>{
 const f=setup();try{f.start();const finish=f.s.finish.bind(f.s);let injected=false;
  f.s.finish=input=>{if(!injected){injected=true;f.event('late-real-feedback',{finding:'A new actionable failure'});}return finish(input);};
  const acceptance=f.s.task('T-1').contract.requirements.map(r=>({requirement_id:r.id,passed:true,evidence_ref:'actual-acceptance-before-new-feedback'}));
  const r=f.update('complete',{acceptance});
  assert.equal(r.finished,false);assert.equal(r.new_information,true);assert.equal(f.s.openWake('T-1').state,'running');
  assert.throws(()=>f.s.finish({task_id:'T-1',wake_id:f.wake.id,turn_id:'native-turn',evidence_ref:'ignore-new-facts'}),/New information/);
 }finally{f.c.close();}
});

test('autonomy preserves actor identity, actual native proof, pauses and existing task-wide decisions',()=>{
 const f=setup();try{
  assert.throws(()=>f.work.run({...f.lease,op:'start'}),/actual current native/);
  assert.throws(()=>f.work.run({...f.lease,owner_thread_id:'different-owner',op:'start'}),/original task owner/);
  const wrong=nativeProof({message:'Different message',now:f.now()});assert.throws(()=>f.work.run({...f.lease,op:'start',native_proof:wrong}));
  f.start();f.mode('paused');assert.throws(()=>f.update('progress',{next_action:'Ignore the pause'}),/paused/);
 }finally{f.c.close();}
});

test('the new owner wake leads with goal-directed work and leaves fixed service batches on their existing protocol',()=>{
 const f=setup();try{
  const prompt=wakePrompt('/instance',f.s.task('T-1'),f.wake,f.s.checkpoint('T-1'));
  assert.match(prompt,/整个目标/);assert.match(prompt,/runtime work/);assert.doesNotMatch(prompt,/begin → checkpoint → decide → finish/);
  assert.match(prompt,/OWNER_CONTINUATION.md/);assert.ok(prompt.length<700);
  const service=wakePrompt('/instance',{task_id:'T-maintenance',contract:{service_lane:'maintenance'}},{id:'maintenance'}, {owner_autonomy:{enabled:true},events:[{type:'service_batch_ready',payload:{batch_id:'fixed-batch'}}]});
  assert.match(service,/fixed-batch/);assert.match(service,/begin → checkpoint → decide → finish/);
 }finally{f.c.close();}
});

test('overlapping retries record one work update even when another caller commits between checkpoint and write',()=>{
 const f=setup();try{f.start();const original=f.s.decide.bind(f.s);let raced=false;
  const request={...f.lease,op:'progress',update_id:'one-real-update',next_action:'Validate the scoped repair',evidence_ref:'actual-repair'};
  f.s.decide=input=>{if(!raced){raced=true;f.work.run(request);}return original(input);};
  const result=f.work.run(request);assert.equal(result.replayed,true);
  assert.equal(f.c.db.prepare("SELECT count(*) n FROM rt_decisions WHERE json_extract(data,'$.work_update.key')=?").get(f.wake.id+':one-real-update').n,1);
 }finally{f.c.close();}
});
