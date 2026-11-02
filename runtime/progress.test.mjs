import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Mailbox, COORDINATOR } from './mailbox.mjs';
import { ControlStore, assess } from './control.mjs';
import { findContinuationGaps } from './progress.mjs';

const NOW = Date.parse('2026-11-02T16:20:00Z');
const event = key => ({ key, lane: 'coordinator', kind: 'event', payload: { event_type: 'ready_pr', task_id: 'child', current_task_complete: false, continuation_authorized: true, next_action: 'Implement next stage.' } });
const stage = (id, patch = {}) => ({ id, task_id: id, owner_thread_id: 'worker', scope_key: 'branch:one', state: 'pending', step_id: id + ':implementation', action: 'Implement ' + id, depends_on: [], ...patch });
const goal = (patch = {}) => ({ id: 'parent', authorization_ref: 'human-six-stage-scope', expected_revision: 0, complete: false,
  stages: [stage('merged', { state: 'complete', completion_evidence_ref: 'verified-merge' }), stage('next', { depends_on: ['merged'] })], ...patch });
const observation = (patch = {}) => ({ thread_id: 'worker', status: 'idle', turn_status: 'completed', turn_id: 'old-turn', checked_at: new Date(NOW).toISOString(), background_job_running: false, queued_input: false, existing_driver: false, hold: false, ...patch });
function batch(m, key = 'stage-result') {
  m.enqueue(event(key));
  const b = m.reserve('coordinator', { thread: { id: COORDINATOR, status: { type: 'idle' } }, latestTurn: { id: 'coordinator-old', status: 'completed' }, checked_at: new Date(NOW).toISOString() }).batch;
  m.setPrompt(b.id, 'fixed scope');
  m.authorizeSend(b.id, { thread: { id: COORDINATOR, status: { type: 'idle' } }, latestTurn: { id: 'coordinator-old', status: 'completed' }, checked_at: new Date(NOW).toISOString() });
  m.delivery(b.id, { outcome: 'sent', receipt: {} }); m.begin(b.id); return b;
}
function record(m, b, goals = [goal()], key = 'stage-result') { return m.recordProgress({ batch_id: b.id, event_key: key, goals, evidence_ref: 'owner-result-and-authorization', authorization_verified: true }); }

test('a completed-stage event cannot be ACKed or finished without durable remaining-goal disposition', () => {
  const m = new Mailbox(':memory:', { now: () => NOW }), b = batch(m);
  assert.throws(() => m.acknowledge(b.id, ['stage-result']), /Durable successor/);
  assert.throws(() => m.finish(b.id, { processed_keys: ['stage-result'] }), /Durable successor/);
  record(m, b); assert.equal(m.progress.plan([observation()]).eligible[0].stage_id, 'next');
  m.finish(b.id); assert.equal(m.status().pending.length, 0); m.close();
});

test('successor and event consumption survive a coordinator budget boundary and restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-progress-')), path = join(root, 'mail.sqlite');
  let m = new Mailbox(path, { now: () => NOW }); const b = batch(m); record(m, b); m.finish(b.id); m.close();
  m = new Mailbox(path, { now: () => NOW });
  try { assert.equal(m.progress.plan([observation()]).eligible.length, 1); assert.equal(m.status().pending.length, 0); }
  finally { m.close(); rmSync(root, { recursive: true, force: true }); }
});

test('CI or natural observation blocks only its dependents, not independently authorized work', () => {
  const m = new Mailbox(':memory:', { now: () => NOW }), b = batch(m);
  record(m, b, [goal({ stages: [stage('observation', { state: 'blocked', blocker: { reason: 'natural release samples', resume_condition: 'new natural run', evidence_ref: 'no-new-release' } }), stage('independent'), stage('dependent', { depends_on: ['observation'] })] })]);
  const plan = m.progress.plan([observation()]); assert.deepEqual(plan.eligible.map(s => s.stage_id), ['independent']); assert.equal(plan.waiting[0].reason, 'dependency'); m.close();
});

test('busy owners, live jobs, holds, queued input and other drivers never get automatic continuation', () => {
  const m = new Mailbox(':memory:', { now: () => NOW }), b = batch(m); record(m, b);
  for (const patch of [{ status: 'active' }, { background_job_running: true }, { hold: true }, { queued_input: true }, { existing_driver: true }, { checked_at: new Date(NOW - 61000).toISOString() }])
    assert.equal(m.progress.plan([observation(patch)]).eligible.length, 0);
  m.close();
});

test('duplicate events and uncertain dispatch ACKs cannot create a second start', () => {
  const m = new Mailbox(':memory:', { now: () => NOW }), b = batch(m); record(m, b);
  assert.equal(record(m, b).duplicate, true);
  assert.throws(() => record(m, b, [goal({ authorization_ref: 'different-scope' })]), /changed meaning/);
  const key = m.progress.plan([observation()]).eligible[0].key;
  assert.equal(m.atomic(() => m.progress.claim({ key, observation: observation() })).reserved, true);
  assert.equal(m.atomic(() => m.progress.claim({ key, observation: observation() })).reserved, false);
  m.atomic(() => m.progress.delivery({ key, outcome: 'uncertain', evidence_ref: 'timeout-after-send', control_action_key: key }));
  assert.equal(m.progress.plan([observation()]).eligible.length, 0);
  assert.throws(() => m.progress.started({ key, observation: observation(), work_turn_id: 'old-turn', work_evidence_ref: 'ack-only' }), /not actual/);
  assert.equal(m.atomic(() => m.progress.started({ key, observation: observation({ turn_id: 'new-turn', status: 'active' }), work_turn_id: 'new-turn', work_evidence_ref: 'native-tool-execution' })).execution_started, true);
  m.close();
});

test('parent acceptance cannot discard remaining stages or archive their owner', () => {
  const m = new Mailbox(':memory:', { now: () => NOW }), b = batch(m);
  assert.throws(() => record(m, b, [goal({ complete: true, acceptance_verified: true, completion_evidence_ref: 'one-child-merged' })]), /whole-goal/);
  record(m, b); const c = new ControlStore(':memory:', { now: () => NOW, progress: m.progress });
  assert.equal(m.progress.unfinishedForOwner('worker'), true);
  // The existing archive evidence cannot override an unfinished registered parent.
  const e = { verified_at: new Date(NOW).toISOString(), scope_authorized: true, authorization_ref: 'human', policy_version: 'v', current_policy_version: 'v', stopped: false,
    thread_status: 'idle', queued_input: false, pending_dispatch: false, underlying_job_running: false, expected_turn_id: 'x', actual_turn_id: 'x',
    owner_thread_id: 'worker', control_or_service_chat: false, task_complete: true, completion_evidence_saved: true, pending_decision: false, pending_cleanup: false, pending_delivery: false, important_result_delivered: true };
  c.prepare({ key: 'archive-child', kind: 'archive', task_id: 'merged', payload: { thread_id: 'worker' }, evidence: e });
  assert.equal(c.claim({ key: 'archive-child', owner: 'coordinator', evidence: e }).reason, 'owner_has_unfinished_goal_stages'); c.close(); m.close();
});

test('legacy idle incomplete goals are surfaced without restarting running work', () => {
  const tasks = [{ id: 'T029', owner_thread_id: 'worker', incomplete: true, authorized: true, next_action: 'controlled probes' }];
  assert.equal(findContinuationGaps(tasks, [observation()])[0].reason, 'idle_incomplete_without_durable_successor');
  assert.equal(findContinuationGaps(tasks, [observation({ background_job_running: true })])[0].reason, 'preserve_running_work');
});

test('uncertain starts cannot be superseded by a fresh step name and stale revisions cannot drop work', () => {
  const m = new Mailbox(':memory:', { now: () => NOW }), b = batch(m); record(m, b); m.finish(b.id);
  const key = m.progress.plan([observation()]).eligible[0].key;
  m.atomic(() => m.progress.claim({ key, observation: observation() }));
  m.atomic(() => m.progress.delivery({ key, outcome: 'uncertain', evidence_ref: 'unknown-send', control_action_key: key }));
  const next = batch(m, 'new-result');
  const changed = goal({ expected_revision: 1 }); changed.stages[1].step_id = 'different-step'; changed.stages[1].progress_evidence_ref = 'new-report';
  assert.throws(() => record(m, next, [changed], 'new-result'), /Reconcile the original start/);
  assert.throws(() => record(m, next, [goal()], 'new-result'), /revision changed/);
  const dropped = goal({ expected_revision: 1, stages: [stage('another')] });
  assert.throws(() => record(m, next, [dropped], 'new-result'), /drop a requested stage/);
  assert.equal(m.db.prepare('SELECT state FROM mail WHERE item_key=?').get('new-result').state, 'in_batch'); m.close();
});

test('one owner or branch cannot acquire two pending continuations at once', () => {
  const m = new Mailbox(':memory:', { now: () => NOW }), b = batch(m);
  record(m, b, [goal({ stages: [stage('one'), stage('two', { owner_thread_id: 'another-worker' })] })]);
  const observations = [observation(), observation({ thread_id: 'another-worker' })];
  const candidates = m.progress.plan(observations).eligible; assert.equal(candidates.length, 2);
  assert.equal(m.atomic(() => m.progress.claim({ key: candidates[0].key, observation: observations[0] })).reserved, true);
  assert.equal(m.atomic(() => m.progress.claim({ key: candidates[1].key, observation: observations[1] })).reserved, false); m.close();
});

test('the fallback also detects ended owners inside an already registered running goal', () => {
  const m = new Mailbox(':memory:', { now: () => NOW }), b = batch(m);
  record(m, b, [goal({ stages: [stage('running', { state: 'running', turn_id: 'known-turn', running_evidence_ref: 'native-work' })] })]);
  assert.equal(m.progress.plan([observation()]).waiting[0].reason, 'ended_owner_needs_result_reconciliation');
  assert.equal(m.progress.plan([observation({ background_job_running: true })]).eligible.length, 0); m.close();
});

test('a crash before guarded dispatch releases its reservation, while a claimed send stays uncertain', () => {
  const m = new Mailbox(':memory:', { now: () => NOW }), b = batch(m); record(m, b);
  const key = m.progress.plan([observation()]).eligible[0].key;
  m.atomic(() => m.progress.claim({ key, observation: observation() }));
  const evidence = { key, owner_quiescent: true, verified_at: new Date(NOW).toISOString(), evidence_ref: 'native-controller-ended-and-control-ledger' };
  assert.equal(m.atomic(() => m.progress.reconcile(evidence)).state, 'pending');
  m.atomic(() => m.progress.claim({ key, observation: observation() }));
  assert.equal(m.atomic(() => m.progress.reconcile({ ...evidence, control_action: { state: 'claimed', payload: JSON.stringify({ thread_id: 'worker' }) } })).state, 'uncertain');
  assert.equal(m.progress.plan([observation()]).eligible.length, 0); m.close();
});

test('read-only analysis can use verified available capabilities without pretending native Full Access', () => {
  const p = { thread_id: 'worker', run_id: 'read-run', starts_heavy_work: false, execution_mode: 'read_only_analysis', required_capabilities: ['source_read','connector_read'] };
  const e = { verified_at: new Date(NOW).toISOString(), scope_authorized: true, authorization_ref: 'human-assessment', policy_version: 'v', current_policy_version: 'v', stopped: false,
    thread_status: 'idle', queued_input: false, pending_dispatch: false, underlying_job_running: false, expected_turn_id: 'x', actual_turn_id: 'x', owner_matches: true, overlapping_owner: false,
    owner_thread_id: 'worker', work_incomplete: true, existing_driver_owns_step: false, capacity_available: true,
    approval_policy: 'on-request', sandbox_mode: 'workspace-write', network_access_verified: false, runtime_permission_turn_id: 'x',
    read_only_capabilities_verified: true, native_permissions_unchanged: true, native_approval_pending: false, available_capabilities: { source_read: true, connector_read: true } };
  assert.equal(assess('dispatch', p, e, NOW).allowed, true);
  for (const payload of [{ ...p, starts_heavy_work: true }, { ...p, required_capabilities: ['cloud_write'] }, { ...p, execution_mode: 'engineering' }]) assert.equal(assess('dispatch', payload, e, NOW).allowed, false);
  assert.equal(assess('dispatch', p, { ...e, native_approval_pending: true }, NOW).allowed, false);
});

test('a durable read-only step preserves its capability requirements through reservation', () => {
  const m = new Mailbox(':memory:', { now: () => NOW }), b = batch(m);
  record(m, b, [goal({ stages: [stage('source-assessment', { execution_mode: 'read_only_analysis', required_capabilities: ['source_read','connector_read'] })] })]);
  const candidate = m.progress.plan([observation()]).eligible[0];
  const claim = m.atomic(() => m.progress.claim({ key: candidate.key, observation: observation() }));
  assert.equal(claim.execution_mode, 'read_only_analysis');
  assert.deepEqual(claim.required_capabilities, ['source_read','connector_read']); m.close();
});
