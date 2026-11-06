import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,OWNER,nativeProof} from './test-fixtures/reactive.mjs';
import {ReviewClosure,reviewClosureArchiveActor} from './review-closure.mjs';

function setup(){
 const f=fixture(),dir=mkdtempSync(join(tmpdir(),'review-closure-'));
 const policy={enabled:true,owner_thread_id:'queue-owner',terminal_pr_completion:{enabled:true,source_message_id:'human:close',evidence_ref:'actual-user'}};
 mkdirSync(join(dir,'review-queue'));writeFileSync(join(dir,'review-queue/config.json'),JSON.stringify(policy));f.c.work.config.instance_root=dir;
 f.c.work.create({id:'T-1',canonical_key:'review:example/service#1',title:'Review',objective:'Review only',source:{kind:'user',review_only:true},pull_requests:[{repository:'example/service',pr_number:1}]});
 const q=new ReviewClosure(f.c,policy),input={task_id:'T-1',executor_thread_id:OWNER,pr:{url:'https://github.com/example/service/pull/1',state:'closed',head_sha:'a'.repeat(40),closed_at:new Date(f.now()).toISOString(),checked_at:new Date(f.now()).toISOString(),evidence_ref:'actual-pr'},native_proof:nativeProof({status:'completed',now:f.now()}),underlying_job_running:false,queued_input:false,pending_delivery:false,pending_cleanup:false,resources_preserved:true,evidence_ref:'saved-summary'};
 return {...f,q,input,policy,cleanup:()=>{f.c.close();rmSync(dir,{recursive:true,force:true});}};
}
test('terminal PR closes unfinished review without pretending review happened, preserves history and deduplicates',()=>{
 const f=setup();try{
  assert.equal(f.q.targets().length,1);const before=f.s.task('T-1');
  const r=f.q.complete(f.input);assert.equal(r.completed,true);assert.equal(r.closure.review_work_completed,false);
  const t=f.s.task('T-1');assert.equal(t.status,'complete');assert.equal(t.mode,'paused');assert.equal(t.contract.retired,true);
  assert.equal(t.contract_rev,before.contract_rev+1);assert.equal(f.c.work.get('T-1').state,'completed');
  assert.equal(f.q.complete(f.input).replayed,true);assert.equal(f.s.task('T-1').contract_rev,t.contract_rev);
  assert.equal(f.q.targets().length,1); // Native archive remains a separate verified action.
 }finally{f.cleanup();}
});
test('only fresh exact terminal PRs qualify; merge evidence is not inferred from closed',()=>{
 const f=setup();try{
  for(const pr of [{state:'open'},{url:'https://github.com/example/service/pull/2'},{checked_at:new Date(f.now()-300001).toISOString()},{state:'merged'}])assert.throws(()=>f.q.complete({...f.input,pr:{...f.input.pr,...pr}}));
  assert.equal(f.q.complete({...f.input,pr:{...f.input.pr,state:'merged',merge_sha:'b'.repeat(40),merged_at:new Date(f.now()).toISOString()}}).completed,true);
 }finally{f.cleanup();}
});
test('implementation tasks and services cannot use terminal-review completion',()=>{
 const f=fixture();try{assert.throws(()=>new ReviewClosure(f.c,{terminal_pr_completion:{enabled:true,source_message_id:'human',evidence_ref:'auth'}}).complete({task_id:'T-1'}),/single-PR review/);}finally{f.c.close();}
 const g=setup();try{const t=g.s.task('T-1');g.s.amend({task_id:'T-1',expected_contract_rev:t.contract_rev,contract:{...t.contract,schedule_sources:['daily']},source_message_id:'human',actual_human_verified:true});assert.equal(g.q.targets().length,0);}finally{g.cleanup();}
});
test('running turns, pending wakes, resources, unknown effects and unrecognized actors block closure',()=>{
 const f=setup();try{
  for(const patch of [{executor_thread_id:'other'},{underlying_job_running:true},{pending_delivery:true},{pending_cleanup:true},{queued_input:true},{resources_preserved:false},{native_proof:nativeProof({now:f.now()})}])assert.throws(()=>f.q.complete({...f.input,...patch}));
  f.activate();f.event();f.begin();assert.throws(()=>f.q.complete(f.input),/pending wake/);
 }finally{f.cleanup();}
});
test('Review Queue archive authority is limited to saved terminal reviews and exact owner',()=>{
 const f=setup();try{
  const p={purpose:'review_pr_terminal',thread_id:OWNER,source_message_id:'human:close'};
  assert.equal(reviewClosureArchiveActor(f.c,'archive','T-1',p,{},'queue-owner'),false);
  f.q.complete(f.input);
  assert.equal(reviewClosureArchiveActor(f.c,'archive','T-1',p,{},'queue-owner'),true);
  for(const [kind,patch,actor] of [['merge',{},'queue-owner'],['archive',{thread_id:'other'},'queue-owner'],['archive',{source_message_id:'wrong'},'queue-owner'],['archive',{},'other']])assert.equal(reviewClosureArchiveActor(f.c,kind,'T-1',{...p,...patch},{},actor),false);
  const t=f.s.task('T-1');assert.deepEqual(f.s.actionReasons('archive','T-1',{...p,runtime_context:{contract_rev:t.contract_rev,context_rev:t.context_rev,plan_rev:t.plan_rev}}),[]);
 }finally{f.cleanup();}
});
