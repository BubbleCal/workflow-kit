import { passedReviewGates } from './test-fixtures/pr-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assess, ControlStore, CHANNEL } from './control.mjs';
import {REVIEW_WINDOW,scopedReviewRule,reviewWindowAt} from './review-window.mjs';
import {contract} from './test-fixtures/reactive.mjs';

const head = 'a'.repeat(40), url = 'https://github.com/example/service/pull/1';
const at = time => Date.parse('2026-11-03T' + time + '+08:00');
const evidence = (now, kind = 'slack_pr') => ({ ...passedReviewGates(now,head,url,kind), verified_at: new Date(now).toISOString(),
  scope_authorized: true, authorization_ref: 'human-review-window', policy_version: 'v', current_policy_version: 'v', stopped: false,
  pr_owner: 'test-author', pr_open: true, pr_draft: kind === 'pr_ready', ordinary_change: true,
  material_findings_open: false, validation_current: true, technical_review_current: true,
  current_head_sha: head, pr_url: url, already_announced: false });
const action = (now, kind = 'slack_pr') => ({ key: kind + ':head-a', kind, task_id: 'T-test',
  payload: { expected_head_sha: head, ...(kind === 'slack_pr' ? { channel_id: CHANNEL, message: url } : { pr_url: url, operation: 'mark_ready' }) },
  evidence: evidence(now, kind) });
function refreshFeedback(c,now) {
  c.feedback.ingest({repository:'example/service',pr_number:1,head_sha:head,head_before:head,head_after:head,checked_at:new Date(now).toISOString(),evidence_ref:'complete-empty-feedback-fixture',
    complete:{reviews:true,review_comments:true,issue_comments:true,review_threads:true},reviews:[],review_comments:[],issue_comments:[],review_threads:[]});
  return c;
}

test('review delivery obeys Beijing boundaries for Slack and draft-to-ready', () => {
  for (const kind of ['slack_pr','pr_ready']) for (const [time, allowed] of [['02:59:59',true],['03:00:00',false],['09:59:59',false],['10:00:00',true]]) {
    const now = at(time), a = action(now, kind);
    assert.equal(assess(kind, a.payload, a.evidence, now).allowed, allowed, kind + ':' + time);
  }
});

test('deferred review survives restart, requires fresh matching evidence at the window end, and sends only once', () => {
  const dir = mkdtempSync(join(tmpdir(),'review-window-')), path = join(dir,'actions.sqlite');
  let now = at('03:00:00'), c = refreshFeedback(new ControlStore(path, { now: () => now }),now);
  const a = action(now);
  try {
    assert.equal(c.prepare(a).deferred, true);
    assert.equal(c.status().deferred_reviews[0].due, at('10:00:00'));
    c.close(); c = new ControlStore(path, { now: () => now });
    assert.equal(c.prepare(a).state, 'deferred');
    assert.equal(c.claim({ key: a.key, owner: 'coordinator', evidence: evidence(now) }).claimed, false);
    now = at('10:00:00');
    refreshFeedback(c,now);
    assert.equal(c.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence }).claimed, false);
    assert.equal(c.claim({ key: a.key, owner: 'coordinator', evidence: { ...evidence(now), current_head_sha: 'b'.repeat(40) } }).claimed, false);
    const claim = c.claim({ key: a.key, owner: 'coordinator', evidence: evidence(now) });
    assert.equal(claim.claimed, true);
    const args = { key: a.key, attempt_id: claim.attempt_id, owner: 'coordinator', evidence: evidence(now), operation_not_started: true };
    assert.equal(c.authorizeReviewSend(args).send, true);
    assert.equal(c.authorizeReviewSend(args).send, false);
    c.settle({ key: a.key, attempt_id: claim.attempt_id, outcome: 'sent', evidence_ref: 'actual-receipt' });
    assert.equal(c.claim({ key: a.key, owner: 'coordinator', evidence: evidence(now) }).claimed, false);
  } finally { c.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('both prepared and claimed actions are stopped when the send crosses 03:00', () => {
  for (const claimed of [false,true]) {
    let now = at('02:59:59'); const c = new ControlStore(':memory:',{now:()=>now}), a = action(now);
    refreshFeedback(c,now);c.prepare(a); const claim = claimed ? c.claim({ key:a.key, owner:'coordinator', evidence:evidence(now) }) : null;
    now = at('03:00:00');
    const result = claimed ? c.authorizeReviewSend({ key:a.key, attempt_id:claim.attempt_id, owner:'coordinator', evidence:evidence(now), operation_not_started:true }) : c.claim({key:a.key,owner:'coordinator',evidence:evidence(now)});
    assert.equal(result.deferred,true); assert.equal(c.status().deferred_reviews.length,1); c.close();
  }
});

test('an already authorized but uncertain send is not silently reset across the boundary', () => {
  let now = at('02:59:59'); const c = new ControlStore(':memory:',{now:()=>now}), a=action(now);
  refreshFeedback(c,now);c.prepare(a); const claim=c.claim({key:a.key,owner:'coordinator',evidence:evidence(now)});
  const args={key:a.key,attempt_id:claim.attempt_id,owner:'coordinator',evidence:evidence(now),operation_not_started:true};
  const permit=c.authorizeReviewSend(args);assert.equal(permit.send,true);assert.equal(permit.valid_until,at('03:00:00'));
  now=at('03:00:00'); assert.equal(c.authorizeReviewSend({...args,evidence:evidence(now)}).send,false);
  assert.equal(c.db.prepare('SELECT state FROM actions WHERE action_key=?').get(a.key).state,'claimed');c.close();
});

test('the review window does not pause already-delivered PR merge gates', () => {
  const now=at('06:00:00'), a=action(now);
  const e={...a.evidence,approver:'test-reviewer',approver_identity_verified:true,approval_state:'APPROVED',approved_head_sha:head,
    required_checks_pass:true,repository_rules_satisfied:true,mergeable:true,admin_override:false};
  const inside=assess('merge',{pr_url:url,expected_head_sha:head},e,now);
  assert.equal(inside.allowed,true);
  assert.equal(assess('merge',{pr_url:url,expected_head_sha:head},{...e,approved_head_sha:'b'.repeat(40)},now).allowed,false);
});

const scopedException={id:'pe-weekend',actual_human_verified:true,source_message_id:'human:pe-now',evidence_ref:'actual-pe-instruction',task_ids:['T-012'],valid_from:'2026-11-07T12:00:00+08:00',valid_until:'2026-11-09T11:00:00+08:00',waive_weekly_blackout:true,retain_daily_blackout:true};
const scopedRule=()=>({...REVIEW_WINDOW,scoped_weekly_exceptions:[scopedException]});
const bindPR=c=>c.reactive.adopt({task_id:'T-012',owner_thread_id:'pe-owner',contract:{...contract(),pull_requests:[{repository:'example/service',pr_number:1}]},source_message_id:'actual-pe-task',actual_human_verified:true});

test('scoped weekend exception requires exact task and current PR binding and retains every daily blackout',()=>{
 const window=(date,task_id='T-012',prs=[{repository:'example/service',pr_number:1}])=>reviewWindowAt(Date.parse(date),scopedReviewRule(scopedRule(),Date.parse(date),{task_id,pull_requests:prs,payload:{pr_url:url}}));
 assert.equal(window('2026-11-07T18:00:00+08:00').blocked,false);
 assert.equal(window('2026-11-07T18:00:00+08:00','T-025').blocked,true);
 assert.equal(window('2026-11-07T18:00:00+08:00','T-012',[]).blocked,true);
 assert.equal(window('2026-11-07T18:00:00+08:00','T-012',[{repository:'example/service',pr_number:2}]).blocked,true);
 assert.equal(window('2026-11-07T11:59:59+08:00').blocked,true);
 assert.equal(window('2026-11-08T03:00:00+08:00').blocked,true);
 assert.equal(window('2026-11-08T09:59:59+08:00').next_eligible_at,Date.parse('2026-11-08T10:00:00+08:00'));
 assert.equal(window('2026-11-09T10:59:59+08:00').blocked,false);
 assert.equal(window('2026-11-09T11:00:00+08:00').scoped_exception_id,undefined);
 assert.equal(window('2026-11-14T18:00:00+08:00').blocked,true);
});

test('weekend scoped prepare, deferred claim and final send use fresh task binding without waiving technical gates',()=>{
 for(const kind of ['slack_pr','pr_ready']){
  let now=Date.parse('2026-11-07T18:00:00+08:00'),enabled=false;const c=new ControlStore(':memory:',{now:()=>now,reviewRule:()=>enabled?scopedRule():REVIEW_WINDOW});
  try{bindPR(c);refreshFeedback(c,now);const a={...action(now,kind),task_id:'T-012'};
   assert.equal(c.prepare(a).deferred,true);enabled=true;
   assert.equal(c.status().deferred_reviews[0].due_now,true);
   assert.equal(c.claim({key:a.key,owner:'coordinator',evidence:{...evidence(now,kind),validation_current:false}}).claimed,false);
   const claim=c.claim({key:a.key,owner:'coordinator',evidence:evidence(now,kind)});assert.equal(claim.claimed,true,JSON.stringify(claim));
   const permit=c.authorizeReviewSend({key:a.key,attempt_id:claim.attempt_id,owner:'coordinator',evidence:evidence(now,kind),operation_not_started:true});assert.equal(permit.send,true,JSON.stringify(permit));
  }finally{c.close();}
 }
});

test('scoped expiry bounds a send permit and binding changes between prepare, claim and send restore the weekly guard',()=>{
 for(const boundary of ['claim','send','expiry','expired-before-send']){
  let now=Date.parse('2026-11-08T17:59:59+08:00');const c=new ControlStore(':memory:',{now:()=>now,reviewRule:()=>({...REVIEW_WINDOW,scoped_weekly_exceptions:[{...scopedException,valid_until:'2026-11-08T18:00:00+08:00'}]})});
  try{bindPR(c);refreshFeedback(c,now);const a={...action(now),task_id:'T-012'};assert.equal(c.prepare(a).prepared,true);
   if(boundary==='claim'){const t=c.reactive.task('T-012');c.reactive.amend({task_id:t.task_id,expected_contract_rev:t.contract_rev,contract:{...t.contract,pull_requests:[]},actual_human_verified:true,source_message_id:'actual-unbind'});assert.equal(c.claim({key:a.key,owner:'coordinator',evidence:evidence(now)}).deferred,true);continue;}
   const claim=c.claim({key:a.key,owner:'coordinator',evidence:evidence(now)});assert(claim.claimed);
   if(boundary==='expired-before-send'){now=Date.parse('2026-11-08T18:00:00+08:00');assert.equal(c.authorizeReviewSend({key:a.key,attempt_id:claim.attempt_id,owner:'coordinator',evidence:evidence(now),operation_not_started:true}).deferred,true);}
   else if(boundary==='send'){const t=c.reactive.task('T-012');c.reactive.amend({task_id:t.task_id,expected_contract_rev:t.contract_rev,contract:{...t.contract,pull_requests:[]},actual_human_verified:true,source_message_id:'actual-unbind'});assert.equal(c.authorizeReviewSend({key:a.key,attempt_id:claim.attempt_id,owner:'coordinator',evidence:evidence(now),operation_not_started:true}).deferred,true);}
   else{const permit=c.authorizeReviewSend({key:a.key,attempt_id:claim.attempt_id,owner:'coordinator',evidence:evidence(now),operation_not_started:true});assert.equal(permit.valid_until,Date.parse('2026-11-08T18:00:00+08:00'));}
  }finally{c.close();}
 }
});

test('weekly blackout covers the weekend until Monday 11 and retains daily boundaries', async () => {
  const {reviewWindowAt,REVIEW_WINDOW}=await import('./review-window.mjs');
  const cases=[
    ['2026-11-06T23:59:59+08:00',false,null,'2026-11-07T00:00:00+08:00'],
    ['2026-11-07T00:00:00+08:00',true,'2026-11-09T11:00:00+08:00'],
    ['2026-11-08T12:00:00+08:00',true,'2026-11-09T11:00:00+08:00'],
    ['2026-11-09T02:59:59+08:00',true,'2026-11-09T11:00:00+08:00'],
    ['2026-11-09T10:59:59+08:00',true,'2026-11-09T11:00:00+08:00'],
    ['2026-11-09T11:00:00+08:00',false,null,'2026-11-10T03:00:00+08:00'],
    ['2026-11-10T03:00:00+08:00',true,'2026-11-10T10:00:00+08:00'],
    ['2026-11-10T10:00:00+08:00',false,null,'2026-11-11T03:00:00+08:00']
  ];
  for(const [date,blocked,next,nextBlock] of cases){
    const now=Date.parse(date),w=reviewWindowAt(now,REVIEW_WINDOW);
    assert.equal(w.blocked,blocked,date);
    assert.equal(w.next_eligible_at,next?Date.parse(next):now,date);
    if(nextBlock)assert.equal(w.next_block_at,Date.parse(nextBlock),date);
    for(const kind of ['slack_pr','pr_ready']){
      const a=action(now,kind),result=assess(kind,a.payload,a.evidence,now,undefined,REVIEW_WINDOW);
      assert.equal(result.reasons.includes('review_delivery_blackout'),blocked,kind+date);
    }
  }
  assert.throws(()=>reviewWindowAt(Date.now(),{...REVIEW_WINDOW,weekly_blackout:{...REVIEW_WINDOW.weekly_blackout,end_time:'bad'}}));
});

test('a Friday permit expires at Saturday midnight and an unstarted send defers until Monday 11', async () => {
  const {REVIEW_WINDOW}=await import('./review-window.mjs');
  let now=Date.parse('2026-11-06T23:59:59+08:00');
  const c=new ControlStore(':memory:',{now:()=>now,reviewRule:()=>REVIEW_WINDOW}),a=action(now);
  try{
    refreshFeedback(c,now);assert.equal(c.prepare(a).prepared,true);
    const claim=c.claim({key:a.key,owner:'coordinator',evidence:evidence(now)});
    assert.equal(claim.claimed,true);
    const args={key:a.key,attempt_id:claim.attempt_id,owner:'coordinator',evidence:evidence(now),operation_not_started:true};
    const permit=c.authorizeReviewSend(args);assert.equal(permit.send,true);
    assert.equal(permit.valid_until,Date.parse('2026-11-07T00:00:00+08:00'));
    // An unstarted action must not reuse the expiring authorization across the boundary.
    now=Date.parse('2026-11-07T00:00:00+08:00');
    const later=c.authorizeReviewSend({...args,evidence:evidence(now)});
    assert.equal(later.send,false);
  }finally{c.close();}
  now=Date.parse('2026-11-08T12:00:00+08:00');
  const queued=refreshFeedback(new ControlStore(':memory:',{now:()=>now,reviewRule:()=>REVIEW_WINDOW}),now);
  try{
    assert.equal(queued.prepare(action(now)).deferred,true);
    assert.equal(queued.status().deferred_reviews[0].due,Date.parse('2026-11-09T11:00:00+08:00'));
  }finally{queued.close();}
});
