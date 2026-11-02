import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assess, ControlStore, CHANNEL } from './control.mjs';

const head = 'a'.repeat(40), url = 'https://github.com/example/service/pull/1';
const at = time => Date.parse('2026-11-03T' + time + '+08:00');
const evidence = (now, kind = 'slack_pr') => ({ verified_at: new Date(now).toISOString(),
  scope_authorized: true, authorization_ref: 'human-review-window', policy_version: 'v', current_policy_version: 'v', stopped: false,
  pr_owner: 'test-author', pr_open: true, pr_draft: kind === 'pr_ready', ordinary_change: true,
  material_findings_open: false, validation_current: true, technical_review_current: true,
  current_head_sha: head, pr_url: url, already_announced: false });
const action = (now, kind = 'slack_pr') => ({ key: kind + ':head-a', kind, task_id: 'T-test',
  payload: { expected_head_sha: head, ...(kind === 'slack_pr' ? { channel_id: CHANNEL, message: url } : { pr_url: url, operation: 'mark_ready' }) },
  evidence: evidence(now, kind) });

test('review delivery obeys Beijing boundaries for Slack and draft-to-ready', () => {
  for (const kind of ['slack_pr','pr_ready']) for (const [time, allowed] of [['03:59:59',true],['04:00:00',false],['11:59:59',false],['12:00:00',true]]) {
    const now = at(time), a = action(now, kind);
    assert.equal(assess(kind, a.payload, a.evidence, now).allowed, allowed, kind + ':' + time);
  }
});

test('deferred review survives restart, requires fresh matching evidence at noon, and sends only once', () => {
  const dir = mkdtempSync(join(tmpdir(),'review-window-')), path = join(dir,'actions.sqlite');
  let now = at('04:00:00'), c = new ControlStore(path, { now: () => now });
  const a = action(now);
  try {
    assert.equal(c.prepare(a).deferred, true);
    assert.equal(c.status().deferred_reviews[0].due, at('12:00:00'));
    c.close(); c = new ControlStore(path, { now: () => now });
    assert.equal(c.prepare(a).state, 'deferred');
    assert.equal(c.claim({ key: a.key, owner: 'coordinator', evidence: evidence(now) }).claimed, false);
    now = at('12:00:00');
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

test('both prepared and claimed actions are stopped when the send crosses 04:00', () => {
  for (const claimed of [false,true]) {
    let now = at('03:59:59'); const c = new ControlStore(':memory:',{now:()=>now}), a = action(now);
    c.prepare(a); const claim = claimed ? c.claim({ key:a.key, owner:'coordinator', evidence:evidence(now) }) : null;
    now = at('04:00:00');
    const result = claimed ? c.authorizeReviewSend({ key:a.key, attempt_id:claim.attempt_id, owner:'coordinator', evidence:evidence(now), operation_not_started:true }) : c.claim({key:a.key,owner:'coordinator',evidence:evidence(now)});
    assert.equal(result.deferred,true); assert.equal(c.status().deferred_reviews.length,1); c.close();
  }
});

test('an already authorized but uncertain send is not silently reset across the boundary', () => {
  let now = at('03:59:59'); const c = new ControlStore(':memory:',{now:()=>now}), a=action(now);
  c.prepare(a); const claim=c.claim({key:a.key,owner:'coordinator',evidence:evidence(now)});
  const args={key:a.key,attempt_id:claim.attempt_id,owner:'coordinator',evidence:evidence(now),operation_not_started:true};
  const permit=c.authorizeReviewSend(args);assert.equal(permit.send,true);assert.equal(permit.valid_until,at('04:00:00'));
  now=at('04:00:00'); assert.equal(c.authorizeReviewSend({...args,evidence:evidence(now)}).send,false);
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
