import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlStore } from './control.mjs';
import { Mailbox, COORDINATOR, workPriority } from './mailbox.mjs';

const NOW = Date.parse('2026-11-03T06:00:00Z'), HEAD = 'a'.repeat(40), repo = 'example/project', number = 42;
const identity = { repository:repo, pr_number:number }, key = `${repo}#${number}`;
const observation = (now, patch={}) => ({ ...identity, head_sha:HEAD, state:'open', draft:false,
  updated_at:new Date(NOW).toISOString(), checked_at:new Date(now).toISOString(), evidence_ref:'github-state',
  approval_state:'pending', approval_head:HEAD,approval_evidence_ref:'current-head-review-read',
  checks_state:'pending', checks_scope:'required', checks_head:HEAD, checks_evidence_ref:'required-checks-read', ...patch });
function setup(now=()=>NOW) {
  const c = new ControlStore(':memory:',{now});
  c.lifecycle.track({...identity,task_id:'T-010',owner_thread_id:'owner',authorization_ref:'original-human',
    readiness:{head:HEAD,validation_ref:'matched-S3',technical_review_ref:'source-review',validation_passed:true,technical_review_passed:true}});
  return c;
}
function observe(c,now=NOW,patch={},reviews=[]) {
  const s=observation(now,patch);
  c.feedback.ingest({...s,head_before:s.head_sha,head_after:s.head_sha,complete:{reviews:true,review_comments:true,issue_comments:true,review_threads:true},
    reviews,review_comments:[],issue_comments:[],review_threads:[]});
  c.lifecycle.observe(s,{feedbackCollected:true});
}
function sent(c,head=HEAD) {
  c.db.prepare("INSERT INTO actions(action_key,kind,task_id,scope_key,digest,payload,state,due,created_at,updated_at) VALUES ('ready-url','slack_pr','T-010','pr:42','fixture',?,'sent',?,?,?)")
    .run(JSON.stringify({message:`https://github.com/${repo}/pull/${number}`,expected_head_sha:head}),NOW,NOW,NOW);
}
const idle = now => ({ checked_at:new Date(now).toISOString(),thread:{id:COORDINATOR,status:{type:'idle'}},latestTurn:{id:'coordinator-old',status:'completed'} });
function begin(m) { const b=m.reserve('coordinator',idle(m.now())).batch;m.setPrompt(b.id,'fixed');m.authorizeSend(b.id,idle(m.now()));m.delivery(b.id,{outcome:'sent',receipt:{}});m.begin(b.id);return b; }

test('ready but unannounced work creates one delivery obligation and cannot be labelled waiting for approval',()=>{
  const c=setup();observe(c);
  assert.equal(c.lifecycle.inspect(key).action,'deliver_review');
  const first=c.lifecycle.reconcile()[0];
  assert.deepEqual(c.lifecycle.reconcile(),[first]);
  assert.throws(()=>c.lifecycle.resolve({key:first.payload.lifecycle_key,generation:1,disposition:'wait',evidence_ref:'note',
    wait:{kind:'pr',pr_key:key,head:HEAD,expected:'approval_pending',next_check_at:new Date(NOW+600000).toISOString()}}),/Invalid lifecycle wait/);
  sent(c);
  assert.equal(c.lifecycle.inspect(key).action,'check_merge');
  assert.equal(c.lifecycle.resolve({key:first.payload.lifecycle_key,generation:1,disposition:'receipt',evidence_ref:'actual-send',control_action_key:'ready-url'}).state,'superseded');
  assert.equal(c.lifecycle.reconcile().some(x=>x.payload.action==='deliver_review'),false);
  c.close();
});

test('a test log path alone does not establish review readiness, and failed CI requires a disposition',()=>{
  const c=setup();observe(c);
  c.lifecycle.track({...identity,task_id:'T-010',owner_thread_id:'owner',authorization_ref:'original-human',readiness:{head:HEAD,validation_ref:'test-log',technical_review_ref:'review-log',validation_passed:false,technical_review_passed:true}});
  assert.equal(c.lifecycle.inspect(key).action,'obtain_readiness');
  sent(c);observe(c,NOW,{checks_state:'failed'});
  assert.equal(c.lifecycle.inspect(key).action,'triage_ci');
  assert.equal(c.lifecycle.checkWait({kind:'pr',pr_key:key,head:HEAD,expected:'approval_pending',next_check_at:new Date(NOW+600000).toISOString()}).valid,false);c.close();
});

test('COMMENTED material feedback invalidates merge waiting and queues assessment then repair',()=>{
  const c=setup();observe(c);sent(c);const prior=c.lifecycle.reconcile()[0];
  const reviews=[{id:5743158692,commit_id:HEAD,state:'COMMENTED',body:'Native JSON append now fails; please fix this regression.',user:{login:'reviewer'}}];
  observe(c,NOW,{updated_at:new Date(NOW+1000).toISOString()},reviews);
  assert.equal(c.lifecycle.inspect(key).action,'assess_feedback');
  const item=c.feedback.status(repo,number).items[0];
  c.feedback.assess({...identity,head:HEAD,decisions:[{key:item.key,digest:item.digest,disposition:'actionable',reason:'Reproduced current JSON regression',evidence_ref:'current-code',current_code_relevance_verified:true}]});
  assert.equal(c.lifecycle.inspect(key).action,'repair_feedback');
  c.lifecycle.reconcile();
  assert.equal(c.db.prepare('SELECT state FROM lifecycle_intents WHERE intent_key=?').get(prior.payload.lifecycle_key).state,'superseded');
  assert.equal(c.lifecycle.checkWait({kind:'pr',pr_key:key,head:HEAD,expected:'approval_pending',next_check_at:new Date(NOW+600000).toISOString()}).valid,false);
  c.close();
});

test('closed-unmerged and merged PRs require distinct task-bound follow-through decisions',()=>{
  const c=setup();observe(c,NOW,{state:'closed'});
  const closed=c.lifecycle.reconcile()[0];assert.equal(closed.payload.action,'resolve_closed');
  assert.throws(()=>c.lifecycle.resolve({key:closed.payload.lifecycle_key,generation:1,disposition:'progress',evidence_ref:'decision',progress_resolution:{verified:true,task_ids:['different']}}),/task-bound/);
  c.lifecycle.resolve({key:closed.payload.lifecycle_key,generation:1,disposition:'progress',evidence_ref:'reopen-plan',progress_resolution:{verified:true,task_ids:['T-010'],task_complete:false}});
  observe(c,NOW,{state:'open'});assert.equal(c.lifecycle.inspect(key).action,'deliver_review');
  observe(c,NOW,{state:'closed'});const closedAgain=c.lifecycle.reconcile()[0];
  assert.notEqual(closedAgain.key,closed.key);
  observe(c,NOW,{state:'merged',merged_at:new Date(NOW).toISOString(),merge_sha:'b'.repeat(40)});
  const merged=c.lifecycle.reconcile()[0];assert.equal(merged.payload.action,'decide_after_merge');
  c.lifecycle.resolve({key:merged.payload.lifecycle_key,generation:1,disposition:'progress',evidence_ref:'adoption-successor',progress_resolution:{verified:true,task_ids:['T-010']}});
  assert.equal(c.lifecycle.inspect(key).state,'retired');c.close();
});

test('same facts from a new file do not create duplicate actions; changed metadata requires fresh feedback',()=>{
  const c=setup();observe(c);const initial=c.lifecycle.reconcile()[0];
  c.lifecycle.observe(observation(NOW,{evidence_ref:'another-file'}));assert.deepEqual(c.lifecycle.reconcile(),[initial]);
  c.lifecycle.observe(observation(NOW,{updated_at:new Date(NOW+1000).toISOString()}));
  assert.equal(c.lifecycle.inspect(key).action,'refresh_feedback');c.close();
});

test('a later expiry gets a new durable refresh event instead of reusing an already retired key',()=>{
  let now=NOW;const c=setup(()=>now);observe(c);c.lifecycle.reconcile();
  now+=21*60000;const first=c.lifecycle.reconcile()[0];assert.equal(first.payload.action,'refresh_pr');
  observe(c,now);c.lifecycle.reconcile();
  now+=21*60000;const second=c.lifecycle.reconcile()[0];
  assert.equal(second.payload.action,'refresh_pr');assert.notEqual(first.key,second.key);c.close();
});

test('PR waits expire, bind the exact head and become actionable when the state changes',()=>{
  let now=NOW;const c=setup(()=>now);observe(c);sent(c);const intent=c.lifecycle.reconcile()[0];
  const wait={kind:'pr',pr_key:key,head:HEAD,expected:'approval_pending',next_check_at:new Date(now+600000).toISOString()};
  assert.equal(c.lifecycle.resolve({key:intent.payload.lifecycle_key,generation:1,disposition:'wait',evidence_ref:'current-approval-read',wait}).state,'waiting');
  assert.equal(c.lifecycle.reconcile().length,0);
  now+=600000;observe(c,now);
  const next=c.lifecycle.reconcile()[0];assert.equal(next.payload.lifecycle_generation,2);
  assert.deepEqual(c.lifecycle.reconcile(),[next]);
  now+=21*60000;assert.equal(c.lifecycle.inspect(key).action,'refresh_pr');
  assert.equal(c.lifecycle.checkWait(wait).valid,false);c.close();
});

test('an old-head announcement does not prove delivery of a newly validated review head',()=>{
  const c=setup();observe(c);sent(c);observe(c,NOW,{head_sha:'b'.repeat(40)});
  assert.equal(c.lifecycle.inspect(key).state,'readiness_unknown');
  c.lifecycle.track({...identity,task_id:'T-010',owner_thread_id:'owner',authorization_ref:'original-human',readiness:{head:'b'.repeat(40),validation_ref:'new-head-delta-validation',technical_review_ref:'new-head-review',validation_passed:true,technical_review_passed:true}});
  assert.equal(c.lifecycle.inspect(key).action,'deliver_review');c.close();
});

test('an instance without external delivery routes a local deliverable rather than inventing a Slack requirement',()=>{
  const c=setup();c.lifecycle.deliveryMode='local';observe(c);
  const event=c.lifecycle.reconcile()[0];assert.equal(event.payload.action,'deliver_local');
  c.lifecycle.resolve({key:event.payload.lifecycle_key,generation:1,disposition:'progress',evidence_ref:'actual-local-delivery',progress_resolution:{verified:true,task_ids:['T-010']}});
  assert.equal(c.lifecycle.inspect(key).state,'retired');c.close();
});

test('review blackout defers delivery while feedback repair remains actionable',()=>{
  const now=Date.parse('2026-11-03T01:00:00Z');const c=setup(()=>now);observe(c,now);
  assert.equal(c.lifecycle.inspect(key).state,'review_window');
  assert.equal(c.lifecycle.reconcile().length,0);c.close();
});

test('stored lifecycle contradictions enter the coordinator queue even without an idle worker snapshot',()=>{
  const c=setup();observe(c,NOW,{state:'closed'});
  const m=new Mailbox(':memory:',{now:()=>NOW,lifecycleAccess:fn=>fn(c.lifecycle)});
  m.activateTransitions({source_message_id:'actual-human',actual_human_verified:true});
  assert.equal(m.reconcileTransitions().lifecycle_obligations,1);m.reconcileTransitions();
  assert.equal(m.status().pending[0].count,1);
  const b=begin(m),event=b.snapshot.items[0];
  assert.throws(()=>m.acknowledge(b.id,[event.key]),/Lifecycle obligation/);
  c.lifecycle.resolve({key:event.payload.lifecycle_key,generation:1,disposition:'progress',evidence_ref:'actual-scope-decision',progress_resolution:{verified:true,task_ids:['T-010'],task_complete:true}});
  m.acknowledge(b.id,[event.key]);m.finish(b.id);m.close();c.close();
});

test('arbitrarily named worker outcomes cannot be consumed without a source-task disposition',()=>{
  const m=new Mailbox(':memory:',{now:()=>NOW});m.activateTransitions({source_message_id:'human',actual_human_verified:true});
  m.enqueue({key:'tests-done',lane:'coordinator',kind:'event',payload:{event:'custom_test_package_v93',task_id:'T-010',owner_thread_id:'owner',text:'All tests passed'}});
  const b=begin(m);assert.throws(()=>m.finish(b.id,{processed_keys:['tests-done']}),/Durable successor/);
  const goal={id:'accepted-goal',authorization_ref:'human-task',expected_revision:0,complete:false,stages:[{id:'next',task_id:'T-010',owner_thread_id:'owner',scope_key:'branch:existing',state:'pending',step_id:'deliver',action:'Review the validated package and deliver its PR',depends_on:[]}]};
  m.recordProgress({batch_id:b.id,event_key:'tests-done',goals:[goal],authorization_verified:true,evidence_ref:'actual-test-result'});
  assert.equal(m.progress.status().actions[0].state,'pending');m.finish(b.id);m.close();
});

test('a ready outcome binds its deliverable even when its event label is unfamiliar',()=>{
  const c=new ControlStore(':memory:',{now:()=>NOW});
  const m=new Mailbox(':memory:',{now:()=>NOW,lifecycleAccess:fn=>fn(c.lifecycle)});
  m.activateTransitions({source_message_id:'human',actual_human_verified:true});
  m.enqueue({key:'ready-result',lane:'coordinator',kind:'worker_result',payload:{event:'custom-report',outcome:'ready_for_review',task_id:'T-010',owner_thread_id:'owner',evidence_ref:'accepted-report'}});
  const b=begin(m);
  const goal={id:'root',authorization_ref:'human-scope',expected_revision:0,complete:false,stages:[{id:'deliver',task_id:'T-010',owner_thread_id:'owner',scope_key:'same-branch',state:'pending',step_id:'deliver-pr',action:'Deliver the accepted PR',depends_on:[]}]};
  const input={batch_id:b.id,event_key:'ready-result',authorization_verified:true,evidence_ref:'report',goals:[goal]};
  assert.throws(()=>m.recordProgress(input),/bind its actual PR/);
  m.recordProgress({...input,artifacts:[{kind:'pr',role:'deliverable',...identity,task_id:'T-010',owner_thread_id:'owner'}]});
  assert.equal(c.lifecycle.status().prs[0].pr_key,key);m.finish(b.id);m.close();c.close();
});

test('typed dependency evidence expires or changes instead of renewing a textual blocker',()=>{
  let now=NOW;const m=new Mailbox(':memory:',{now:()=>now});
  const condition={kind:'dependency',fact_key:'api-pin',subject:'sophon:lance-pin',requirement:'JsonQuery accessors'};
  assert.equal(m.waits.check(condition).valid,false);
  const fact={fact_key:'api-pin',kind:'dependency',subject:condition.subject,data:{available:false,requirement:condition.requirement},observed_at:new Date(now).toISOString(),expires_at:new Date(now+600000).toISOString(),evidence_ref:'exact-pin-source'};
  m.waits.observe(fact);assert.equal(m.waits.check(condition).valid,true);
  assert.throws(()=>m.waits.validateGoals([{id:'goal',stages:[{id:'blocked',state:'blocked',blocker:{reason:'waiting'}}]}]),/untyped_wait/);
  now+=600001;assert.equal(m.waits.check(condition).reason,'evidence_expired');
  m.waits.observe({...fact,data:{...fact.data,available:true},observed_at:new Date(now).toISOString(),expires_at:new Date(now+600000).toISOString()});
  assert.equal(m.waits.check(condition).reason,'condition_changed');m.close();
});

test('an answered human decision invalidates a wait without renewing the saved pending note',()=>{
  const m=new Mailbox(':memory:',{now:()=>NOW});let pending=true;m.waits.checkHuman=()=>pending;
  m.waits.observe({fact_key:'decision',kind:'human',subject:'decision:D-001',data:{source_message_id:'actual-request',actual_human_verified:true,pending:true,decision_id:'D-001'},observed_at:new Date(NOW).toISOString(),evidence_ref:'registered-question'});
  const condition={kind:'human',fact_key:'decision',subject:'decision:D-001'};
  assert.equal(m.waits.check(condition).valid,true);pending=false;
  assert.equal(m.waits.check(condition).valid,false);m.close();
});

test('one pending wait survives unrelated goal revisions while a later fact expiry remains detectable',()=>{
  let now=NOW;const m=new Mailbox(':memory:',{now:()=>now});
  const condition={kind:'dependency',fact_key:'dep',subject:'versioned-api',requirement:'getters'};
  const goal={id:'root',revision:1,complete:false,stages:[{id:'api',task_id:'T-014',owner_thread_id:'owner',state:'blocked',blocker:{condition}}]};
  const first=m.waits.violations([goal])[0];m.enqueue(first);
  assert.deepEqual(m.waits.violations([{...goal,revision:2}]),[first]);
  m.waits.observe({fact_key:'dep',kind:'dependency',subject:condition.subject,data:{available:false,requirement:'getters'},observed_at:new Date(now).toISOString(),expires_at:new Date(now+60000).toISOString(),evidence_ref:'fresh-source'});
  m.waits.resolve({event_key:first.key,goal,stage_id:'api',evidence_ref:'refreshed'});
  m.db.prepare("UPDATE mail SET state='acknowledged' WHERE item_key=?").run(first.key);
  now+=60001;const expired=m.waits.violations([goal])[0];assert.notEqual(expired.key,first.key);
  m.enqueue(expired);assert.deepEqual(m.waits.violations([{...goal,revision:3}]),[expired]);m.close();
});

test('activation preserves in-flight batch contracts and aging prevents source work starvation',()=>{
  let now=NOW;const m=new Mailbox(':memory:',{now:()=>now});
  m.enqueue({key:'old-contract',lane:'coordinator',kind:'event',payload:{task_id:'task',owner_thread_id:'owner'}});
  const old=begin(m);m.activateTransitions({source_message_id:'human',actual_human_verified:true});
  assert.equal(old.snapshot.transition_contract_version,1);m.finish(old.id,{processed_keys:['old-contract']});
  const source={kind:'event',payload:{event:'source_intake'},created_at:now};
  const delivery={kind:'event',payload:{event:'pr_lifecycle_action',action:'deliver_review'},created_at:now};
  assert.ok(workPriority(delivery,now)<workPriority(source,now));
  assert.ok(workPriority(source,now+3*3600000)<=workPriority(delivery,now));
  assert.equal(workPriority({kind:'human_command',payload:{},created_at:now},now),0);m.close();
});

test('the cached invariant sweep covers accepted stage gaps while preserving holds and scheduled services',()=>{
  const m=new Mailbox(':memory:',{now:()=>NOW});m.activateTransitions({source_message_id:'human',actual_human_verified:true});
  const task=(id,patch={})=>({id,owner_thread_id:id+'-owner',status:'active',authorization_message_id:'actual-source',...patch});
  const registry={task_registry:{items:{a:task('a'),b:task('b',{hold:true}),c:task('c',{recurring_service:true}),d:task('d',{authorization_message_id:null})}}};
  assert.equal(m.reconcileTransitions(registry).stage_gaps,1);m.reconcileTransitions(registry);
  const rows=m.db.prepare("SELECT payload FROM mail WHERE json_extract(payload,'$.event')='stage_reconciliation'").all();
  assert.equal(rows.length,1);assert.equal(JSON.parse(rows[0].payload).task_id,'a');m.close();
});
