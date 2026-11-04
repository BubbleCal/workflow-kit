import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from './mailbox.mjs';
import { ControlStore, CHANNEL } from './control.mjs';
import { passedReviewGates } from './test-fixtures/pr-review.mjs';
import { activeScopeExclusions, stageScopeExclusion, scopeActionReasons } from './scope-exclusions.mjs';

const now=Date.parse('2026-11-04T06:00:00Z'), task='T-001', key='T-001:java', url='https://github.com/example/service/pull/1', head='a'.repeat(40);
const rule=()=>({task_id:task,status:'excluded',source_message_id:'actual-stop',verbatim_text:'Skip Java builds.',evidence_ref:'native-user-proof',targets:{stages:[{goal_id:'goal',stage_id:'java'}],pr_urls:[url]}});
const registry=()=>({scope_restrictions:{[key]:rule()}});
const binding=()=>({key,source_message_id:'actual-stop',evidence_ref:'native-user-proof'});
const stage=(id,patch={})=>({id,task_id:task,owner_thread_id:'worker',scope_key:'branch:'+id,state:'pending',step_id:id,action:'Perform '+id,depends_on:[],...patch});
const blocked=()=>stage('java',{state:'blocked',scope_excluded_by_user:true,automatic_followup_allowed:false,blocker:{reason:'User excluded scope',resume_condition:'New actual user scope',evidence_ref:'native-user-proof',condition:{kind:'dependency',fact_key:'expired',subject:'java',requirement:'authorization'}}});
const goal=stages=>({id:'goal',authorization_ref:'original-scope',expected_revision:0,complete:false,stages});
const observation=()=>({thread_id:'worker',turn_id:'old',turn_status:'completed',status:'idle',checked_at:new Date(now).toISOString(),background_job_running:false,queued_input:false,existing_driver:false,hold:false});
const record=(m,g,event_key='result')=>m.progress.record({event_key,goals:[g],evidence_ref:'source-progress'});

test('a source-bound stage exclusion survives expired waits without holding independent work',()=>{
  const r=registry(),m=new Mailbox(':memory:',{now:()=>now,taskRegistry:()=>r});
  // Existing excluded stages can bind through their exact actual-user evidence.
  delete r.scope_restrictions[key].targets;
  const g=goal([blocked(),stage('nonjava')]);record(m,g);
  assert.deepEqual(m.waits.violations(m.progress.goals()),[]);
  assert.deepEqual(m.progress.plan([observation()]).eligible.map(x=>x.stage_id),['nonjava']);
  assert.equal(m.watchdog.protection(r,task,'worker'),null);
  const next={...g,expected_revision:1,stages:[blocked(),stage('nonjava',{state:'complete',completion_evidence_ref:'actual-pass'})]};record(m,next,'later');
  assert.equal(m.watchdog.protection(r,task,'worker'),'explicit_stage_scope_exclusion');m.close();
});

test('skipped is source-authorized, preserves history, and never satisfies a real dependency',()=>{
  const r=registry(),m=new Mailbox(':memory:',{now:()=>now,taskRegistry:()=>r});
  const g=goal([stage('historical',{state:'complete',completion_evidence_ref:'historical-pass'}),blocked(),stage('dependent',{depends_on:['java']}),stage('nonjava')]);record(m,g);
  const next={...g,expected_revision:1,stages:g.stages.map(s=>s.id==='java'?{...s,state:'skipped',scope_exclusion:binding()}:s)};
  const bad=structuredClone(next);bad.stages[1].scope_exclusion.source_message_id='invented';assert.throws(()=>record(m,bad,'bad'),/registered user/);
  const passed=structuredClone(next);passed.stages[1].state='complete';passed.stages[1].completion_evidence_ref='skipped';assert.throws(()=>record(m,passed,'passed'),/cannot resume or count as passed/);
  record(m,next,'skip');assert.equal(m.progress.goals()[0].stages[0].completion_evidence_ref,'historical-pass');
  assert.deepEqual(m.progress.plan([observation()]).eligible.map(x=>x.stage_id),['nonjava']);
  assert.equal(m.progress.plan([observation()]).waiting.find(x=>x.stage_id==='dependent').reason,'dependency');
  const restart={...next,expected_revision:2,stages:next.stages.map(s=>s.id==='java'?{...s,state:'pending'}:s)};
  r.scope_restrictions={};assert.throws(()=>record(m,restart,'restart'),/newly authorized stage/);m.close();
});

test('skipping never erases an uncertain or reserved start',()=>{
  const r={scope_restrictions:{}},m=new Mailbox(':memory:',{now:()=>now,taskRegistry:()=>r});const g=goal([stage('java')]);record(m,g);
  const action=m.progress.plan([observation()]).eligible[0];assert.equal(m.progress.claim({key:action.key,observation:observation()}).reserved,true);
  r.scope_restrictions[key]=rule();const skipped={...g,expected_revision:1,stages:[stage('java',{state:'skipped',scope_exclusion:binding()}),stage('remaining')]};
  assert.throws(()=>record(m,skipped,'skip'),/Preserve and reconcile/);
  assert.equal(m.progress.status().actions[0].state,'reserved');assert.equal(m.progress.plan([observation()]).eligible.length,0);m.close();
});

test('only a new explicit source lifts scope restriction and unclassified dispatch cannot evade it',()=>{
  const r=registry();assert.deepEqual(scopeActionReasons(r,'dispatch',task,{}),['explicit_remaining_scope_binding_required']);
  assert.deepEqual(scopeActionReasons(r,'dispatch',task,{scope_keys:[key]}),['scope_excluded_by_actual_user']);
  assert.deepEqual(scopeActionReasons(r,'dispatch',task,{scope_keys:['T-001:non-java-sdk']}),[]);
  assert.deepEqual(scopeActionReasons(r,'dispatch',task,{}, {scope_keys:['T-001:non-java-sdk']}),[]);
  r.scope_restrictions['T-001:second-stop']={...rule(),source_message_id:'second-stop'};
  assert.ok(stageScopeExclusion(r,goal([]),stage('java')));
  delete r.scope_restrictions['T-001:second-stop'];
  r.scope_restrictions[key].status='released';assert.equal(activeScopeExclusions(r,task).length,1);
  Object.assign(r.scope_restrictions[key],{resumed_by_message_id:'actual-resume',resumption_evidence_ref:'new-native-proof'});
  assert.equal(activeScopeExclusions(r,task).length,0);
});

test('a skipped requirement neither means passed nor waives CI for an independent PR',()=>{
  const r=registry(),m=new Mailbox(':memory:',{now:()=>now,taskRegistry:()=>r});
  const g={...goal([stage('java',{state:'skipped',scope_exclusion:binding()})]),complete:true,acceptance_verified:true,completion_evidence_ref:'remaining-contract-accepted'};
  assert.throws(()=>record(m,g),/account for explicitly skipped scope/);
  record(m,{...g,scope_acceptance_ref:'actual-reduced-contract'});assert.equal(m.progress.goals()[0].stages[0].state,'skipped');m.close();
  const c=new ControlStore(':memory:',{now:()=>now,taskRegistry:()=>r}),a=delivery(c,r),other='https://github.com/example/service/pull/2';
  a.payload.message=other;a.evidence.pr_url=other;a.evidence.applicable_ci.pr_url=other;a.evidence.gatekeeper.pr_url=other;
  a.evidence.applicable_ci.checks[0].conclusion='failure';assert.ok(c.prepare(a).reasons.includes('current_applicable_CI_not_passed'));c.close();
});

function delivery(c, r) {
  const e={...passedReviewGates(now,head,url),verified_at:new Date(now).toISOString(),scope_authorized:true,authorization_ref:'actual-source',policy_version:'v',current_policy_version:'v',stopped:false,
    pr_owner:'test-author',pr_open:true,pr_draft:false,ordinary_change:true,material_findings_open:false,validation_current:true,technical_review_current:true,current_head_sha:head,pr_url:url,already_announced:false};
  c.feedback.ingest({repository:'example/service',pr_number:1,head_sha:head,head_before:head,head_after:head,checked_at:e.verified_at,evidence_ref:'all-feedback',complete:{reviews:true,review_comments:true,issue_comments:true,review_threads:true},reviews:[],review_comments:[],issue_comments:[],review_threads:[]});
  return {key:'deliver',kind:'slack_pr',task_id:task,payload:{channel_id:CHANNEL,message:url,expected_head_sha:head},evidence:e};
}
test('current exclusions stop prepared and claimed publication and lifecycle revival without deleting receipts',()=>{
  for(const boundary of ['prepare','claim','send']) {
    const r={scope_restrictions:{}},c=new ControlStore(':memory:',{now:()=>now,taskRegistry:()=>r}),a=delivery(c,r);
    if(boundary==='prepare')r.scope_restrictions[key]=rule();
    const prepared=c.prepare(a);if(boundary==='prepare'){assert.equal(prepared.prepared,false);c.close();continue;}
    assert.equal(prepared.prepared,true);if(boundary==='claim')r.scope_restrictions[key]=rule();
    const claim=c.claim({key:a.key,owner:'coordinator',evidence:a.evidence});
    if(boundary==='claim'){assert.equal(claim.claimed,false);assert.equal(c.db.prepare('select state from actions').get().state,'prepared');c.close();continue;}
    assert.equal(claim.claimed,true);r.scope_restrictions[key]=rule();
    assert.equal(c.authorizeReviewSend({key:a.key,attempt_id:claim.attempt_id,owner:'coordinator',evidence:a.evidence,operation_not_started:true}).send,false);
    assert.equal(c.db.prepare('select state from actions').get().state,'claimed');
    c.lifecycle.track({repository:'example/service',pr_number:1,task_id:task,owner_thread_id:'worker',authorization_ref:'actual-source'});
    assert.equal(c.lifecycle.inspect('example/service#1').action,null);
    assert.equal(c.lifecycle.inspect('example/service#1').state,'scope_excluded_by_actual_user');c.close();
  }
});
