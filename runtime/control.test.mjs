import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assess, resolveCapacity, ControlStore, INBOX, PAGE, CHANNEL } from './control.mjs';

const NOW = Date.parse('2026-11-02T06:00:00Z');
const finiteCapacity = { max_new_heavy_concurrency: 5, max_dispatches_per_run: 5 };
const head = 'a'.repeat(40);
const common = () => ({ verified_at: new Date(NOW).toISOString(), scope_authorized: true,
  authorization_ref: 'human:message-1', policy_version: 'v6', current_policy_version: 'v6', stopped: false });
const dispatchEvidence = () => ({ ...common(), thread_status: 'idle', queued_input: false,
  pending_dispatch: false, underlying_job_running: false, expected_turn_id: 'turn-1',
  actual_turn_id: 'turn-1', owner_matches: true, overlapping_owner: false,
  work_incomplete: true, existing_driver_owns_step: false, capacity_available: true,
  active_heavy_count: 3, dispatches_this_run: 0,
  runtime_permissions_verified: true, runtime_permission_turn_id: 'turn-1', approval_policy: 'never', sandbox_mode: 'danger-full-access', worktree_access_verified: true, registry_access_verified: true, network_access_verified: true,
  owner_thread_id: 'worker-1' });
const action = (key = 'T-001:event-1:continue') => ({ key, kind: 'dispatch', task_id: 'T-001',
  payload: { thread_id: 'worker-1', run_id: 'run-1', starts_heavy_work: true,
    prompt: 'Continue the authorized remaining validation.' }, evidence: dispatchEvidence() });
const createAction = (key = 'new-T-010', work = 'sophon:ENT-3453:implementation') => ({
  key, kind: 'create_thread', task_id: 'T-010',
  payload: { canonical_task_key: work, source_message_id: 'human-parallel',
    verbatim_text: 'Split independent tickets into separate chats.', run_id: 'run-1', starts_heavy_work: false, permission_probe_only: true,
    placement: { project_id: 'test-project', host_id: 'local', method: 'create' },
    native: { target: { type: 'project', projectId: 'test-project', environment: { type: 'local' } } } },
  evidence: { ...common(), actual_human_message_verified: true, source_actor_verified: true,
    explicit_new_thread_request_verified: true, source_message_id: 'human-parallel',
    source_text: 'Split independent tickets into separate chats.', canonical_task_key: work,
    ownership_handoff_verified: true, overlapping_owner: false, duplicate_task_exists: false,
    underlying_job_for_scope_running: false, existing_driver_owns_step: false, pending_dispatch: false,
    worktree_isolated: true, branch_owner_conflict: false, preparation_reused_or_absent: true,
    work_incomplete: true, capacity_available: true, active_heavy_count: 1,
    reserved_heavy_count: 0, dispatches_this_run: 0,
    project_resolution_verified: true, project_resolution_ref: 'native-projects',
    intended_project_id: 'test-project', project_host_id: 'local', project_exists: true } });
const prEvidence = () => ({ ...common(), pr_owner: 'test-author', pr_open: true, pr_draft: false,
  ordinary_change: true, material_findings_open: false, validation_current: true,
  technical_review_current: true, current_head_sha: head,
  pr_url: 'https://github.com/example/service/pull/1' });

test('replayed source events are idempotent and cannot silently change meaning', () => {
  const s = new ControlStore(':memory:', { now: () => NOW });
  const e = { id: 'msg-1', source: 'codex', task_id: 'T-001', source_time: new Date(NOW).toISOString(), data: { status: 'idle' } };
  assert.equal(s.observe(e).recorded, true);
  assert.equal(s.observe(e).recorded, false);
  assert.throws(() => s.observe({ ...e, data: { status: 'completed' } }), /Immutable event/);
  assert.equal(s.status().events, 1); s.close();
});

test('engineering guidance reaches the claimed prompt once without changing human scope or model settings', () => {
  const s = new ControlStore(':memory:', { now: () => NOW }); const a = action('guided');
  a.payload.verbatim_text = 'Original human text'; a.payload.model = 'preserved-choice';
  assert.equal(s.prepare(a).prepared, true);
  assert.equal(s.prepare(a).prepared, false);
  const claim = s.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence });
  assert.equal(claim.claimed, true); assert.equal(claim.payload.model, 'preserved-choice');
  assert.equal(claim.payload.verbatim_text, 'Original human text');
  assert.equal(claim.payload.prompt.split('[workflow-engineering-principles:v1]').length, 2);
  assert.equal(a.payload.prompt.includes('[workflow-engineering-principles:v1]'), false); s.close();
});

test('creation persists native model choices while historical actions retain their original configuration', () => {
  let preference = null;
  const s = new ControlStore(':memory:', { now: () => NOW, modelSelection: () => preference });
  const historical = createAction('historical-model', 'historical-task');
  assert.equal(s.prepare(historical).prepared, true);
  preference = { source_message_id: 'actual-model-choice', model: 'selected-model', thinking: 'xhigh', fast: false, service_tier_control_supported: false };
  assert.equal(s.prepare(historical).reason, 'already_recorded');
  assert.equal(s.claim({ key: historical.key, owner: 'coordinator', evidence: historical.evidence }).payload.native.model, undefined);
  const current = createAction('selected-model', 'new-task');
  assert.equal(s.prepare(current).prepared, true);
  preference = { ...preference, model: 'later-choice' };
  assert.equal(s.prepare(current).reason, 'already_recorded');
  const claim = s.claim({ key: current.key, owner: 'coordinator', evidence: current.evidence });
  assert.equal(claim.claimed, true);
  assert.equal(claim.payload.native.model, 'selected-model');
  assert.equal(claim.payload.native.thinking, 'xhigh');
  assert.equal(Object.hasOwn(claim.payload.native, 'serviceTier'), false);
  assert.equal(claim.payload.model_selection.service_tier_control_supported, false);
  s.close();
});

test('dispatch never wakes active, queued, uncertain, or background-running work', () => {
  for (const patch of [{ thread_status: 'active' }, { queued_input: true }, { queued_input: undefined },
    { underlying_job_running: true }, { pending_dispatch: true }, { existing_driver_owns_step: true },
    { overlapping_owner: true }, { actual_turn_id: 'new-turn' }, { stopped: true }, { capacity_available: false }]) {
    assert.equal(assess('dispatch', action().payload, { ...dispatchEvidence(), ...patch }, NOW).allowed, false, JSON.stringify(patch));
  }
  assert.equal(assess('dispatch', action().payload, dispatchEvidence(), NOW).allowed, true);
});

test('fresh evidence and current policy are required at claim, not only prepare', () => {
  let clock = NOW;
  const s = new ControlStore(':memory:', { now: () => clock });
  s.prepare(action());
  assert.equal(s.claim({ key: action().key, owner: 'coordinator', evidence: { ...dispatchEvidence(), current_policy_version: 'v7' } }).claimed, false);
  clock += 61000;
  assert.equal(s.claim({ key: action().key, owner: 'coordinator', evidence: dispatchEvidence() }).claimed, false);
  s.close();
});

test('ordinary continuation can claim a verified unloaded terminal owner without inventing human input', () => {
  const s = new ControlStore(':memory:', { now: () => NOW });
  const a = action('unloaded-continuation');
  Object.assign(a.evidence, { thread_status: 'notLoaded', thread_archived: false,
    native_approval_pending: false, native_permissions_unchanged: true,
    native_thread_snapshot: { checked_at: common().verified_at,
      thread: { id: a.payload.thread_id, status: { type: 'notLoaded' } },
      latestTurn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(s.prepare(a).prepared, true);
  const claim = s.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence });
  assert.equal(claim.claimed, true);
  assert.equal(claim.payload.dispatch_origin, undefined);
  assert.equal(claim.payload.thread_id, 'worker-1');
  s.settle({ key: a.key, attempt_id: claim.attempt_id, outcome: 'sent', evidence_ref: 'native-send-receipt' });
  assert.equal(s.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence }).claimed, false);
  s.close();
});

test('unloaded recovery requires fresh matching terminal evidence and preserves every existing safety gate', () => {
  const a = action();
  const snapshot = { checked_at: common().verified_at,
    thread: { id: 'worker-1', status: { type: 'notLoaded' } },
    latestTurn: { id: 'turn-1', status: 'completed' } };
  const e = { ...a.evidence, thread_status: 'notLoaded', thread_archived: false,
    native_approval_pending: false, native_permissions_unchanged: true, native_thread_snapshot: snapshot };
  for (const patch of [
    { native_thread_snapshot: undefined }, { thread_archived: true }, { thread_archived: undefined },
    { native_approval_pending: true }, { native_permissions_unchanged: false },
    { queued_input: true }, { pending_dispatch: true }, { underlying_job_running: undefined },
    { underlying_job_running: true }, { existing_driver_owns_step: true }, { overlapping_owner: true },
    { stopped: true }, { runtime_permissions_verified: false }, { actual_turn_id: 'new-turn' },
    { native_thread_snapshot: { ...snapshot, checked_at: new Date(NOW - 61000).toISOString() } },
    { native_thread_snapshot: { ...snapshot, thread: { id: 'other-owner', status: { type: 'notLoaded' } } } },
    { native_thread_snapshot: { ...snapshot, thread: { id: 'worker-1', status: { type: 'notLoaded', activeFlags: ['waitingOnApproval'] } } } },
    ...['inProgress', 'unknown', 'interrupted'].map(status => ({ native_thread_snapshot: { ...snapshot, latestTurn: { id: 'turn-1', status } } })),
  ]) assert.equal(assess('dispatch', a.payload, { ...e, ...patch }, NOW).allowed, false, JSON.stringify(patch));
  const interrupted = { ...e, native_thread_snapshot: { ...snapshot, latestTurn: { id: 'turn-1', status: 'interrupted' } },
    interruption_reconciled: true, interruption_evidence_ref: 'inspected-original-request-and-interruption' };
  assert.equal(assess('dispatch', a.payload, interrupted, NOW).allowed, true);
  assert.equal(assess('dispatch', a.payload, { ...interrupted, interruption_evidence_ref: undefined }, NOW).allowed, false);
  const s = new ControlStore(':memory:', { now: () => NOW });
  s.prepare({ ...a, evidence: e });
  assert.equal(s.claim({ key: a.key, owner: 'coordinator', evidence: { ...e, underlying_job_running: true } }).claimed, false);
  s.close();
});

test('five heavy jobs are allowed, a sixth is blocked, and light work can use the dispatch budget', () => {
  const p = action().payload;
  for (const active_heavy_count of [3, 4])
    assert.equal(assess('dispatch', p, { ...dispatchEvidence(), active_heavy_count }, NOW, finiteCapacity).allowed, true);
  assert.equal(assess('dispatch', p, { ...dispatchEvidence(), active_heavy_count: 5 }, NOW, finiteCapacity).allowed, false);
  assert.equal(assess('dispatch', { ...p, starts_heavy_work: false }, { ...dispatchEvidence(), active_heavy_count: 5 }, NOW, finiteCapacity).allowed, true);
  for (const patch of [{ active_heavy_count: undefined }, { active_heavy_count: -1 }, { dispatches_this_run: undefined }, { dispatches_this_run: 5 }])
    assert.equal(assess('dispatch', p, { ...dispatchEvidence(), ...patch }, NOW, finiteCapacity).allowed, false);
  assert.equal(assess('dispatch', p, { ...dispatchEvidence(), dispatches_this_run: 4 }, NOW, finiteCapacity).allowed, true);
  assert.equal(assess('dispatch', p, dispatchEvidence(), NOW, {}).allowed, false);
});

test('unlimited configuration and the library default admit work above all former quotas', () => {
  const unlimited = resolveCapacity({ automatic_limit: null, max_new_heavy_concurrency: 10, max_dispatches_per_run: 5 });
  assert.equal(unlimited.max_new_heavy_concurrency, null);
  assert.equal(unlimited.max_dispatches_per_run, null);
  const e = { ...dispatchEvidence(), active_heavy_count: 100, reserved_heavy_count: 100, dispatches_this_run: 100 };
  assert.equal(assess('dispatch', action().payload, e, NOW, unlimited).allowed, true);
  assert.equal(assess('dispatch', action().payload, e, NOW).allowed, true);
  for (const patch of [{ capacity_available: false }, { overlapping_owner: true }, { pending_dispatch: true }])
    assert.equal(assess('dispatch', action().payload, { ...e, ...patch }, NOW, unlimited).allowed, false);
});

test('unlimited dispatch does not require a global quota census', () => {
  const e = dispatchEvidence(); delete e.active_heavy_count; delete e.dispatches_this_run;
  assert.equal(assess('dispatch', action().payload, e, NOW).allowed, true);
  const a = createAction(); delete a.evidence.active_heavy_count; delete a.evidence.reserved_heavy_count; delete a.evidence.dispatches_this_run;
  assert.equal(assess(a.kind, a.payload, a.evidence, NOW).allowed, true);
});

test('unlimited creation and dispatch exceed ten in the same run across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-unlimited-'));
  const path = join(dir, 'control.sqlite');
  let s = new ControlStore(path, { now: () => NOW, capacity: resolveCapacity({ automatic_limit: null }) });
  try {
    for (let i = 0; i < 16; i++) {
      if (i === 6) { s.close(); s = new ControlStore(path, { now: () => NOW }); }
      const a = i % 2 ? action(`continue-unlimited-${i}`) : createAction(`create-unlimited-${i}`, `unlimited-work-${i}`);
      a.evidence.active_heavy_count = 100;
      a.evidence.reserved_heavy_count = 100;
      assert.equal(s.prepare(a).prepared, true);
      const claim = s.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence });
      assert.equal(claim.claimed, true, `action ${i}: ${JSON.stringify(claim)}`);
      s.settle({ key: a.key, attempt_id: claim.attempt_id, outcome: 'sent', evidence_ref: `receipt-${i}` });
      assert.equal(s.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence }).claimed, false);
    }
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('claim rechecks heavy capacity and persistently limits the same run to five deliveries', () => {
  const s = new ControlStore(':memory:', { now: () => NOW, capacity: finiteCapacity });
  const a = action(); s.prepare(a);
  assert.equal(s.claim({ key: a.key, owner: 'a', evidence: { ...dispatchEvidence(), dispatches_this_run: -1 } }).claimed, false);
  assert.equal(s.claim({ key: a.key, owner: 'a', evidence: { ...dispatchEvidence(), active_heavy_count: 5 } }).claimed, false);
  for (let i = 0; i < 6; i++) {
    const thread = `worker-${i}`;
    const next = { ...action(`dispatch-${i}`), payload: { ...a.payload, thread_id: thread, starts_heavy_work: false },
      evidence: { ...dispatchEvidence(), owner_thread_id: thread, active_heavy_count: 5 } };
    assert.equal(s.prepare(next).prepared, true);
    const claim = s.claim({ key: next.key, owner: 'a', evidence: next.evidence });
    assert.equal(claim.claimed, i < 5);
    if (claim.claimed) s.settle({ key: next.key, attempt_id: claim.attempt_id, outcome: 'sent', evidence_ref: `receipt-${i}` });
  }
  const anotherRun = { ...action('next-run'), payload: { ...a.payload, run_id: 'run-2' } };
  assert.equal(s.prepare(anotherRun).prepared, true);
  assert.equal(s.claim({ key: anotherRun.key, owner: 'a', evidence: anotherRun.evidence }).claimed, true);
  s.close();
});

test('coordinator automation edits require verified human scope and preserve all other settings', () => {
  const p = { automation_id: 'automation-3', source_message_id: 'human-capacity', expected_config_hash: 'before' };
  const e = { ...common(), actual_human_message_verified: true, source_actor_verified: true,
    source_message_id: 'human-capacity', current_config_hash: 'before', non_prompt_fields_preserved: true };
  assert.equal(assess('automation_update', p, e, NOW).allowed, true);
  assert.equal(assess('automation_update', p, { ...e, current_config_hash: 'changed' }, NOW).allowed, false);
  assert.equal(assess('automation_update', p, { ...e, non_prompt_fields_preserved: false }, NOW).allowed, false);
  assert.equal(assess('automation_update', { ...p, automation_id: 'review-pr' }, e, NOW).allowed, false);
});

test('verified human steering can reach an active owner, but polling cannot impersonate it', () => {
  const p = { thread_id: 'worker-1', source_message_id: 'human-7', verbatim_text: 'Pause T-001 after saving the checkpoint.' };
  const e = { ...common(), actual_human_message_verified: true, source_actor_verified: true,
    source_message_id: 'human-7', source_text: p.verbatim_text, input_already_delivered: false,
    owner_matches: true, owner_thread_id: 'worker-1', thread_status: 'active' };
  assert.equal(assess('human_input', p, e, NOW).allowed, true);
  assert.equal(assess('human_input', p, { ...e, stopped: true }, NOW).allowed, true);
  assert.equal(assess('human_input', p, { ...e, actual_human_message_verified: false }, NOW).allowed, false);
  assert.equal(assess('human_input', { ...p, verbatim_text: 'Continue automatically.' }, e, NOW).allowed, false);
  assert.equal(assess('human_input', p, { ...e, input_already_delivered: true }, NOW).allowed, false);
});

test('new chats require explicit human scope, released ownership and an isolated prepared workspace', () => {
  const a = createAction();
  assert.equal(assess(a.kind, a.payload, a.evidence, NOW).allowed, true);
  for (const patch of [{ explicit_new_thread_request_verified: false }, { source_message_id: 'other' },
    { source_text: 'Invented authorization' }, { ownership_handoff_verified: false },
    { overlapping_owner: true }, { duplicate_task_exists: true }, { pending_dispatch: true },
    { underlying_job_for_scope_running: true }, { worktree_isolated: false },
    { branch_owner_conflict: true }, { preparation_reused_or_absent: false }, { reserved_heavy_count: -1 }])
    assert.equal(assess(a.kind, a.payload, { ...a.evidence, ...patch }, NOW).allowed, false);
  assert.equal(assess(a.kind, a.payload, { ...a.evidence, reserved_heavy_count: 3 }, NOW).allowed, true);
  assert.equal(assess(a.kind, { ...a.payload, starts_heavy_work: true }, { ...a.evidence, reserved_heavy_count: 4 }, NOW).allowed, false);
});

test('new chat creation and continuation share the durable five-dispatch budget', () => {
  const s = new ControlStore(':memory:', { now: () => NOW, capacity: finiteCapacity });
  for (let i = 0; i < 6; i++) {
    const a = i % 2 ? action(`continue-${i}`) : createAction(`create-${i}`, `work-${i}`);
    a.payload.starts_heavy_work = false;
    assert.equal(s.prepare(a).prepared, true);
    const result = s.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence });
    assert.equal(result.claimed, i < 5);
    if (result.claimed) s.settle({ key: a.key, attempt_id: result.attempt_id, outcome: 'sent', evidence_ref: `receipt-${i}` });
  }
  s.close();
});

test('a changed notification key cannot create a second thread for the same canonical work', () => {
  const s = new ControlStore(':memory:', { now: () => NOW });
  const a = createAction(); s.prepare(a);
  const c = s.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence });
  s.settle({ key: a.key, attempt_id: c.attempt_id, outcome: 'sent', evidence_ref: 'created-thread-1' });
  const duplicate = createAction('different-key'); s.prepare(duplicate);
  assert.equal(s.claim({ key: duplicate.key, owner: 'coordinator', evidence: duplicate.evidence }).reason, 'work_thread_already_created');
  s.close();
});

test('receipt deduplication and derived scopes block duplicate concurrent owners', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-control-'));
  const p = join(dir, 'control.sqlite');
  const a = new ControlStore(p, { now: () => NOW });
  const b = new ControlStore(p, { now: () => NOW });
  try {
    assert.equal(a.prepare(action()).prepared, true);
    assert.equal(b.prepare(action()).prepared, false);
    assert.throws(() => a.prepare({ ...action(), payload: { ...action().payload, prompt: 'Different work' } }), /different content/);
    assert.throws(() => a.prepare({ ...action('other'), scope_key: 'bypass-lock' }), /scope_key/);
    const claim = a.claim({ key: action().key, owner: 'a', evidence: dispatchEvidence() });
    assert.equal(claim.claimed, true);
    assert.equal(b.claim({ key: action().key, owner: 'b', evidence: dispatchEvidence() }).claimed, false);
    b.prepare(action('another-event'));
    assert.equal(b.claim({ key: 'another-event', owner: 'b', evidence: dispatchEvidence() }).reason, 'scope_in_use');
    a.settle({ key: action().key, attempt_id: claim.attempt_id, outcome: 'sent', evidence_ref: 'tool-ack-1' });
    assert.equal(b.claim({ key: action().key, owner: 'b', evidence: dispatchEvidence() }).reason, 'sent');
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('crash recovery never automatically repeats a claimed or uncertain action', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-restart-'));
  const p = join(dir, 'control.sqlite');
  let s = new ControlStore(p, { now: () => NOW });
  s.prepare(action()); const c = s.claim({ key: action().key, owner: 'old', evidence: dispatchEvidence() }); s.close();
  s = new ControlStore(p, { now: () => NOW });
  try {
    assert.equal(s.claim({ key: action().key, owner: 'new', evidence: dispatchEvidence() }).reason, 'claimed');
    assert.throws(() => s.reconcile({ key: action().key, confirmed_outcome: 'not_sent', evidence_ref: 'tool-read', owner_quiescent: false, verified_at: common().verified_at }), /quiescent/);
    s.reconcile({ key: action().key, confirmed_outcome: 'not_sent', evidence_ref: 'destination-inspected', owner_quiescent: true, verified_at: common().verified_at });
    const next = s.claim({ key: action().key, owner: 'new', evidence: dispatchEvidence() });
    assert.notEqual(next.attempt_id, c.attempt_id);
    assert.throws(() => s.settle({ key: action().key, attempt_id: c.attempt_id, outcome: 'sent', evidence_ref: 'late-old-result' }), /Stale/);
    s.settle({ key: action().key, attempt_id: next.attempt_id, outcome: 'uncertain', evidence_ref: 'ambiguous-timeout' });
    assert.equal(s.claim({ key: action().key, owner: 'new', evidence: dispatchEvidence() }).reason, 'uncertain');
    s.reconcile({ key: action().key, confirmed_outcome: 'sent', evidence_ref: 'actual-message-found', owner_quiescent: true, verified_at: common().verified_at });
    assert.equal(s.status().actions.find(x => x.state === 'sent').count, 1);
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('only proven non-delivery retries, with backoff and a bounded attempt count', () => {
  let clock = NOW; const s = new ControlStore(':memory:', { now: () => clock });
  s.prepare(action()); const c = s.claim({ key: action().key, owner: 'a', evidence: dispatchEvidence() });
  const retry = s.settle({ key: action().key, attempt_id: c.attempt_id, outcome: 'not_sent', error_class: 'transient_before_send', evidence_ref: 'connection-refused-before-send' });
  assert.equal(retry.state, 'prepared');
  assert.equal(s.claim({ key: action().key, owner: 'a', evidence: dispatchEvidence() }).reason, 'backoff');
  clock += 5000;
  const c2 = s.claim({ key: action().key, owner: 'a', evidence: dispatchEvidence() });
  assert.equal(s.settle({ key: action().key, attempt_id: c2.attempt_id, outcome: 'not_sent', error_class: 'transient_before_send', evidence_ref: 'second-proven-rejection' }).state, 'failed');
  s.close();
});

test('quiet inbox rejects progress and old completion notifications', () => {
  const e = { ...common(), material_change: true, already_notified: false, completion_verified: true };
  assert.equal(assess('notify', { thread_id: INBOX, category: 'progress' }, e, NOW).allowed, false);
  assert.equal(assess('notify', { thread_id: INBOX, category: 'decision' }, e, NOW).allowed, false);
  assert.equal(assess('notify', { thread_id: INBOX, category: 'important_completion' }, e, NOW).allowed, true);
  assert.equal(assess('notify', { thread_id: INBOX, category: 'important_completion' }, { ...e, already_notified: true }, NOW).allowed, false);
});

test('Slack exception is restricted to the matching ready PR URL and channel', () => {
  const p = { channel_id: CHANNEL, message: prEvidence().pr_url, expected_head_sha: head };
  const e = { ...prEvidence(), already_announced: false };
  assert.equal(assess('slack_pr', p, e, NOW).allowed, true);
  for (const patch of [{ channel_id: 'other' }, { message: `${p.message} please review` },
    { message: 'https://github.com/example/service/pull/2' }, { expected_head_sha: 'b'.repeat(40) }])
    assert.equal(assess('slack_pr', { ...p, ...patch }, e, NOW).allowed, false);
});

test('merge requires current-head approval, required checks and repository rules', () => {
  const p = { pr_url: prEvidence().pr_url, expected_head_sha: head };
  const e = { ...prEvidence(), approver: 'test-reviewer', approver_identity_verified: true,
    approval_state: 'APPROVED', approved_head_sha: head, required_checks_pass: true,
    repository_rules_satisfied: true, mergeable: true, admin_override: false };
  assert.equal(assess('merge', p, e, NOW).allowed, true);
  for (const patch of [{ approved_head_sha: 'b'.repeat(40) }, { required_checks_pass: undefined },
    { repository_rules_satisfied: false }, { admin_override: true }, { ordinary_change: false }, { pr_draft: true }])
    assert.equal(assess('merge', p, { ...e, ...patch }, NOW).allowed, false);
});

test('pending merge checks do not block a validated PR from review delivery', () => {
  const e = { ...prEvidence(), already_announced: false, required_checks_pass: false,
    approver: 'test-reviewer', approver_identity_verified: true, approval_state: 'APPROVED',
    approved_head_sha: head, repository_rules_satisfied: true, mergeable: true, admin_override: false };
  assert.equal(assess('slack_pr', { channel_id: CHANNEL, message: e.pr_url, expected_head_sha: head }, e, NOW).allowed, true);
  assert.equal(assess('merge', { pr_url: e.pr_url, expected_head_sha: head }, e, NOW).allowed, false);
  assert.equal(assess('slack_pr', { channel_id: CHANNEL, message: e.pr_url, expected_head_sha: head }, { ...e, validation_current: false }, NOW).allowed, false);
});

test('archive protects pending work and control chats', () => {
  const e = { ...dispatchEvidence(), task_complete: true, completion_evidence_saved: true,
    pending_decision: false, pending_cleanup: false, pending_delivery: false,
    control_or_service_chat: false, important_result_delivered: true };
  assert.equal(assess('archive', { thread_id: 'worker-1' }, e, NOW).allowed, true);
  assert.equal(assess('archive', { thread_id: 'worker-1' }, { ...e, pending_cleanup: true }, NOW).allowed, false);
  assert.equal(assess('archive', { thread_id: INBOX }, { ...e, owner_thread_id: INBOX }, NOW).allowed, false);
});

test('auth checks and browser scope do not start healthy or competing logins', () => {
  const e = { ...common(), current_auth_failure: true, profile_and_account_verified: true,
    human_only_factor_required: false, external_browser: true, other_login_owner: false };
  const s = new ControlStore(':memory:', { now: () => NOW });
  const a = { key: 'auth-1', kind: 'auth', task_id: 'T-001', payload: { host_id: 'local', profile: 'devland' }, evidence: e };
  s.prepare(a); s.prepare({ ...a, key: 'auth-2', payload: { host_id: 'local', profile: 'devrel' } });
  assert.equal(s.claim({ key: a.key, owner: 'a', evidence: e }).claimed, true);
  assert.equal(s.claim({ key: 'auth-2', owner: 'b', evidence: e }).reason, 'scope_in_use');
  assert.equal(assess('auth', a.payload, { ...e, current_auth_failure: false }, NOW).allowed, false);
  assert.equal(assess('auth', a.payload, { ...e, human_only_factor_required: true }, NOW).allowed, false);
  s.close();
});

test('Notion updates require the authorized page and preservation of manual content', () => {
  const e = { ...common(), content_changed: true, manual_content_preserved: true };
  assert.equal(assess('notion_sync', { page_id: PAGE }, e, NOW).allowed, true);
  assert.equal(assess('notion_sync', { page_id: 'another-page' }, e, NOW).allowed, false);
  assert.equal(assess('notion_sync', { page_id: PAGE }, { ...e, manual_content_preserved: false }, NOW).allowed, false);
});

test('legacy receipts survive migration and processing pause does not cancel work', () => {
  const s = new ControlStore(':memory:', { now: () => NOW });
  s.importLegacy([{ key: 'old-sent', status: 'sent' }, { key: 'old-prepared', status: 'prepared' }]);
  assert.equal(s.prepare(action('old-sent')).state, 'sent');
  assert.equal(s.claim({ key: 'old-prepared', owner: 'a', evidence: dispatchEvidence() }).reason, 'uncertain');
  s.prepare(action());
  assert.deepEqual(s.processing(false), { processing: false, running_work_interrupted: false });
  assert.equal(s.claim({ key: action().key, owner: 'a', evidence: dispatchEvidence() }).reason, 'processing_paused');
  s.processing(true);
  assert.equal(s.claim({ key: action().key, owner: 'a', evidence: dispatchEvidence() }).claimed, true);
  s.close();
});

const replacementArchive = () => ({ key: 'archive-replace', kind: 'archive', task_id: 'T-010',
  payload: { thread_id: 'old-owner', purpose: 'explicit_owner_replacement', source_message_id: 'human-replace', verbatim_text: 'Save progress, archive these chats and create replacements.', checkpoint_sha256: 'b'.repeat(64) },
  evidence: { ...common(), thread_status: 'idle', queued_input: false, pending_dispatch: false, old_writer_quiescent: true, expected_turn_id: 'old-turn', actual_turn_id: 'old-turn', owner_thread_id: 'old-owner', control_or_service_chat: false, actual_human_message_verified: true, source_actor_verified: true, replacement_request_verified: true, source_message_id: 'human-replace', source_text: 'Save progress, archive these chats and create replacements.', checkpoint_saved: true, checkpoint_sha256: 'b'.repeat(64), resources_preserved: true, preserved_jobs_handoff_verified: true, task_remains_incomplete: true, task_complete: false } });

test('explicit replacement preserves incomplete tasks but requires quiescence, checkpoint and human scope', () => {
  const a = replacementArchive();
  assert.equal(assess(a.kind,a.payload,a.evidence,NOW).allowed,true);
  assert.equal(assess(a.kind,{...a.payload,purpose:undefined},a.evidence,NOW).allowed,false);
  for (const patch of [{thread_status:'active'}, {queued_input:true}, {checkpoint_saved:false}, {old_writer_quiescent:false}, {resources_preserved:false}, {preserved_jobs_handoff_verified:false}, {source_message_id:'forged'}])
    assert.equal(assess(a.kind,a.payload,{...a.evidence,...patch},NOW).allowed,false);
  assert.equal(assess(a.kind,{...a.payload,thread_id:INBOX},{...a.evidence,owner_thread_id:INBOX},NOW).allowed,false);
});

test('replacement creation binds the latest original creation and archived owner; cannot replace twice', () => {
  const s=new ControlStore(':memory:',{now:()=>NOW});
  const send = a => { assert.equal(s.prepare(a).prepared,true); const c=s.claim({key:a.key,owner:'coordinator',evidence:a.evidence}); if(c.claimed)s.settle({key:a.key,attempt_id:c.attempt_id,outcome:'sent',evidence_ref:'receipt'}); return c; };
  const first=createAction(); assert.equal(send(first).claimed,true);
  const ar=replacementArchive(); assert.equal(send(ar).claimed,true);
  const r=createAction('replacement');r.payload.source_message_id=ar.payload.source_message_id;r.payload.verbatim_text=ar.payload.verbatim_text;
  r.payload.replacement={old_thread_id:'old-owner',archive_key:ar.key,prior_creation_key:first.key,checkpoint_sha256:ar.payload.checkpoint_sha256};
  Object.assign(r.evidence,{source_message_id:r.payload.source_message_id,source_text:r.payload.verbatim_text,replacement_request_verified:true,old_thread_archived:true,old_writer_quiescent:true,old_thread_id:'old-owner',checkpoint_sha256:ar.payload.checkpoint_sha256,checkpoint_saved:true,resources_preserved:true});
  const bad={...r,key:'bad-chain',payload:{...r.payload,replacement:{...r.payload.replacement,archive_key:'nonexistent'}}};
  assert.equal(send(bad).reason,'replacement_receipt_chain_invalid');
  assert.equal(send(r).claimed,true);
  assert.equal(send({...r,key:'second-replacement'}).reason,'replacement_receipt_chain_invalid');s.close();
});

test('new owners probe first, and productive continuation requires effective turn permissions', () => {
  const c=createAction();
  assert.equal(assess(c.kind,{...c.payload,starts_heavy_work:true},c.evidence,NOW).allowed,false);
  const a=action();
  for(const patch of [{runtime_permissions_verified:false},{runtime_permission_turn_id:'old-turn'},{approval_policy:'on-request'},{sandbox_mode:'workspace-write'},{network_access_verified:false},{registry_access_verified:undefined}])
    assert.equal(assess(a.kind,a.payload,{...a.evidence,...patch},NOW).allowed,false);
});

test('only durable verified current manual assignments are exempt from automatic capacity', () => {
  const s=new ControlStore(':memory:',{now:()=>NOW,capacity:finiteCapacity});const a=action('manual');
  Object.assign(a.payload,{dispatch_origin:'manual_direct',canonical_task_key:'manual-work',source_message_id:'actual-human',verbatim_text:'Investigate this incident now.',manual_event_key:'inbox:actual-human'});
  Object.assign(a.evidence,{active_heavy_count:8,dispatches_this_run:5,manual_assignment_verified:true,manual_event_verified:true,actual_human_message_verified:true,source_actor_verified:true,source_message_id:'actual-human',source_text:a.payload.verbatim_text,canonical_task_key:'manual-work'});
  assert.equal(s.prepare(a).prepared,true);
  assert.equal(s.claim({key:a.key,owner:'coordinator',evidence:a.evidence}).claimed,false);
  s.observe({source:'inbox',id:'actual-human',task_id:'T-001',source_time:new Date(NOW).toISOString(),data:{actor:'human',kind:'manual_task_assignment',message_id:'actual-human',text:a.payload.verbatim_text,canonical_task_key:'manual-work'}});
  assert.equal(s.claim({key:a.key,owner:'coordinator',evidence:a.evidence}).claimed,true);
  const forged={...a,key:'forged',task_id:'T-002',payload:{...a.payload,thread_id:'worker-2'},evidence:{...a.evidence,owner_thread_id:'worker-2'}};assert.equal(s.prepare(forged).prepared,true);assert.equal(s.claim({key:forged.key,owner:'coordinator',evidence:forged.evidence}).claimed,false);
  assert.equal(assess('dispatch',action().payload,{...dispatchEvidence(),active_heavy_count:5},NOW,finiteCapacity).allowed,false);s.close();
});

test('explicit manual engineering starts skip workflow probes but require durable authorization', () => {
  const s = new ControlStore(':memory:', { now: () => NOW });
  const a = createAction('direct-start', 'sophon:manual-direct');
  Object.assign(a.payload, { dispatch_origin: 'manual_direct', start_engineering_directly: true,
    permission_probe_only: false, starts_heavy_work: true, manual_event_key: 'inbox:direct-start' });
  Object.assign(a.evidence, { manual_assignment_verified: true, manual_event_verified: true,
    manual_start_authorized: true, manual_start_event_verified: true });
  assert.equal(assess(a.kind, a.payload, a.evidence, NOW).allowed, true);
  assert.equal(assess(a.kind, a.payload, { ...a.evidence, manual_start_authorized: false }, NOW).allowed, false);
  assert.equal(assess(a.kind, a.payload, { ...a.evidence, overlapping_owner: true }, NOW).allowed, false);
  assert.equal(s.prepare(a).prepared, true);
  assert.equal(s.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence }).claimed, false);
  s.observe({ source: 'inbox', id: 'direct-start', task_id: a.task_id,
    source_time: new Date(NOW).toISOString(), data: { actor: 'human', kind: 'manual_task_assignment',
      message_id: a.payload.source_message_id, text: a.payload.verbatim_text,
      canonical_task_key: a.payload.canonical_task_key, start_engineering_directly: true } });
  assert.equal(s.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence }).claimed, true);
  s.close();
});

test('manual capacity exemption alone does not remove the workflow probe phase', () => {
  const c = createAction();
  Object.assign(c.payload, { dispatch_origin: 'manual_direct', starts_heavy_work: true, permission_probe_only: false });
  Object.assign(c.evidence, { manual_assignment_verified: true, manual_event_verified: true });
  assert.equal(assess(c.kind, c.payload, c.evidence, NOW).allowed, false);
});

test('a human can resume a restored unloaded owner without an extra UI-loading gate', () => {
  const p = { thread_id: 'restored-owner', source_message_id: 'human-resume', verbatim_text: 'Continue the existing task now.' };
  const e = { ...common(), actual_human_message_verified: true, source_actor_verified: true,
    source_message_id: p.source_message_id, source_text: p.verbatim_text, input_already_delivered: false,
    owner_matches: true, owner_thread_id: p.thread_id, thread_status: 'notLoaded',
    explicit_resume_request_verified: true, thread_archived: false, latest_turn_quiescent: true,
    pending_dispatch: false, overlapping_owner: false };
  assert.equal(assess('human_input', p, e, NOW).allowed, true);
  for (const patch of [{ explicit_resume_request_verified: false }, { thread_archived: true },
    { latest_turn_quiescent: false }, { pending_dispatch: true }, { overlapping_owner: true }]) {
    assert.equal(assess('human_input', p, { ...e, ...patch }, NOW).allowed, false);
  }
});


test('human-requested recovery can restore an archived incomplete owner without claiming completion', () => {
  const payload={thread_id:'old-owner',archived:false,source_message_id:'human-resume',verbatim_text:'Resume these interrupted tasks now.'};
  const e={...common(),actual_human_message_verified:true,source_actor_verified:true,resume_request_verified:true,source_message_id:payload.source_message_id,source_text:payload.verbatim_text,owner_thread_id:'old-owner',control_or_service_chat:false,thread_archived:true,old_writer_quiescent:true,overlapping_owner:false,pending_dispatch:false,work_incomplete:true,checkpoint_saved:true,resources_preserved:true};
  assert.equal(assess('unarchive',payload,e,NOW).allowed,true);
  for(const patch of [{actual_human_message_verified:false},{source_message_id:'forged'},{thread_archived:false},{old_writer_quiescent:false},{overlapping_owner:true},{pending_dispatch:true},{checkpoint_saved:false}])assert.equal(assess('unarchive',payload,{...e,...patch},NOW).allowed,false);
  assert.equal(assess('unarchive',{...payload,thread_id:INBOX},{...e,owner_thread_id:INBOX},NOW).allowed,false);
  const st=new ControlStore(':memory:',{now:()=>NOW});const a={key:'restore',task_id:'T-011',kind:'unarchive',payload,evidence:e};assert.equal(st.prepare(a).prepared,true);assert.equal(st.claim({key:a.key,owner:'coordinator',evidence:e}).claimed,true);st.close();
});


test('automatic running and dispatch ceilings share one configured value', () => {
  const p=action().payload,e={...dispatchEvidence(),active_heavy_count:9,dispatches_this_run:9};
  const c={automatic_limit:10,max_new_heavy_concurrency:10,max_dispatches_per_run:10};
  assert.equal(assess('dispatch',p,e,NOW,c).allowed,true);
  assert.equal(assess('dispatch',p,{...e,active_heavy_count:10},NOW,c).allowed,false);
  assert.equal(assess('dispatch',p,{...e,dispatches_this_run:10},NOW,c).allowed,false);
  assert.equal(assess('dispatch',p,e,NOW,{...c,max_dispatches_per_run:5}).allowed,false);
  assert.equal(assess('dispatch',p,e,NOW,{...c,automatic_limit:5}).allowed,false);
});


test('the CLI capacity projection derives both legacy fields from the canonical setting', () => {
  const c=resolveCapacity({automatic_limit:10,max_new_heavy_concurrency:3,max_dispatches_per_run:5});
  assert.equal(c.max_new_heavy_concurrency,10);assert.equal(c.max_dispatches_per_run,10);
  assert.deepEqual(resolveCapacity({}),{});
});


test('standup prompt refinement preserves draft-only and exact-interval scope', () => {
 const p={automation_id:'daily-pr-standup-draft',source_message_id:'human-refine',expected_config_hash:'h'};const e={...common(),actual_human_message_verified:true,source_actor_verified:true,source_message_id:'human-refine',current_config_hash:'h',non_prompt_fields_preserved:true,standup_refinement_authorized:true,draft_only_preserved:true,exact_interval_preserved:true};
 assert.equal(assess('automation_update',p,e,NOW).allowed,true);
 assert.equal(assess('automation_update',p,{...e,draft_only_preserved:false},NOW).allowed,false);
 assert.equal(assess('automation_update',p,{...e,exact_interval_preserved:false},NOW).allowed,false);
});
