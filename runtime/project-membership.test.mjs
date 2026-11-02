import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore, assess, resolvePlacement } from './control.mjs';

const now = Date.parse('2026-11-02T15:55:00Z');
const common = () => ({ verified_at: new Date(now).toISOString(), scope_authorized: true,
  authorization_ref: 'human:new-task', policy_version: 'placement-v1', current_policy_version: 'placement-v1', stopped: false });
function creation(project = 'project-example', method = 'create') {
  return { key: 'create:work-1', task_id: 'T-182', kind: 'create_thread', payload: {
    canonical_task_key: 'work-1', source_message_id: 'human-1', verbatim_text: 'Create an assessment task.',
    permission_probe_only: true, starts_heavy_work: false, run_id: 'run-1',
    placement: { project_id: project, host_id: 'local', method, reason: 'Verified human project context' },
    native: { target: method === 'create' ? { type: 'project', projectId: project, environment: { type: 'local' } } : { type: 'projectless', directoryName: 'assessment' } },
  }, evidence: { ...common(), actual_human_message_verified: true, source_actor_verified: true,
    explicit_new_thread_request_verified: true, source_message_id: 'human-1', source_text: 'Create an assessment task.',
    canonical_task_key: 'work-1', ownership_handoff_verified: true, overlapping_owner: false,
    duplicate_task_exists: false, underlying_job_for_scope_running: false, existing_driver_owns_step: false,
    pending_dispatch: false, worktree_isolated: true, branch_owner_conflict: false,
    preparation_reused_or_absent: true, work_incomplete: true, capacity_available: true,
    project_resolution_verified: true, project_resolution_ref: 'native-project-catalog-and-human-scope',
    intended_project_id: project, project_host_id: 'local', project_exists: project !== null,
    intentional_projectless_verified: project === null,
  } };
}
function sent(store, action = creation(), native_result = { threadId: 'thread-1', hostId: 'local' }) {
  assert.equal(store.prepare(action).prepared, true);
  const claim = store.claim({ key: action.key, owner: 'coordinator', evidence: action.evidence });
  assert.equal(claim.claimed, true);
  return store.settle({ key: action.key, attempt_id: claim.attempt_id, outcome: 'sent', evidence_ref: 'create-tool-ack', native_result });
}
const observation = (projectId = 'project-example', patch = {}) => ({ key: 'create:work-1', source: 'list_threads',
  verified_at: new Date(now).toISOString(), evidence_ref: 'native-list-threads',
  snapshot: { id: 'thread-1', hostId: 'local', projectId, ...patch } });

test('the original projectless permission-probe omission is rejected before creation', () => {
  const a = creation(); delete a.payload.placement;
  a.payload.native.target = { type: 'projectless', directoryName: 'assessment' };
  assert.equal(assess(a.kind, a.payload, a.evidence, now).allowed, false);
});

test('project resolution refuses missing or ambiguous destinations instead of falling back to projectless', () => {
  const input = { projects: [{ projectId: 'project-example', hostId: 'local', label: 'Example Project' }],
    project_label: 'Example Project', host_id: 'local', source_ref: 'list-projects' };
  assert.equal(resolvePlacement(input).native_target.projectId, 'project-example');
  assert.equal(resolvePlacement({ ...input, staging: true }).placement.method, 'move');
  assert.throws(() => resolvePlacement({ ...input, projects: [] }), /missing or ambiguous/);
  assert.throws(() => resolvePlacement({ ...input, projects: [...input.projects, { ...input.projects[0], projectId: 'duplicate-label' }] }), /ambiguous/);
  assert.throws(() => resolvePlacement({ ...input, project_label: undefined }), /absence/);
  assert.throws(() => resolvePlacement({ host_id: 'remote-host', projectless: true, reason: 'scratch', source_ref: 'human' }), /cannot be projectless/);
});

test('resolved project intent must match the native create target or explicit follow-up move', () => {
  const a = creation();
  assert.equal(assess(a.kind, a.payload, a.evidence, now).allowed, true);
  a.payload.native.target.projectId = 'other';
  assert.equal(assess(a.kind, a.payload, a.evidence, now).allowed, false);
  const staged = creation('project-example', 'move');
  assert.equal(assess(staged.kind, staged.payload, staged.evidence, now).allowed, true);
  assert.equal(assess(staged.kind, staged.payload, { ...staged.evidence, intended_project_id: 'other' }, now).allowed, false);
});

test('intentional projectless and other-project tasks retain their explicit placement', () => {
  for (const [project, method] of [[null, 'projectless'], ['another-project', 'create']]) {
    const s = new ControlStore(':memory:', { now: () => now }); const a = creation(project, method);
    assert.equal(sent(s, a).setup_complete, false);
    assert.equal(s.confirmCreation(observation(project)).setup_complete, true);
    s.close();
  }
});

test('create ACK and move ACK do not complete setup without matching native readback', () => {
  const s = new ControlStore(':memory:', { now: () => now }); const a = creation('project-example', 'move');
  assert.equal(sent(s, a, { structuredContent: {}, content: [{ type: 'text', text: JSON.stringify({ threadId: 'thread-1', hostId: 'local' }) }] }).setup_complete, false);
  const pending = s.confirmCreation(observation(null));
  assert.equal(pending.setup_complete, false);
  const move = { key: 'assign:thread-1:project-example', task_id: a.task_id, kind: 'assign_project',
    payload: { creation_key: a.key, thread_id: 'thread-1', host_id: 'local', project_id: 'project-example' },
    evidence: { ...common(), project_resolution_verified: true, project_exists: true,
      intended_project_id: 'project-example', project_host_id: 'local', owner_thread_id: 'thread-1',
      actual_host_id: 'local', actual_project_id: null, membership_observed: true } };
  assert.equal(s.prepare(move).prepared, true);
  const claim = s.claim({ key: move.key, owner: 'coordinator', evidence: move.evidence });
  assert.equal(claim.claimed, true);
  s.settle({ key: move.key, attempt_id: claim.attempt_id, outcome: 'sent', evidence_ref: 'move-ack' });
  assert.equal(s.status().pending_thread_setups.length, 1);
  assert.equal(s.confirmCreation(observation()).setup_complete, true);
  assert.equal(s.status().pending_thread_setups.length, 0);
  assert.equal(s.recordCreation({ key: a.key, native_result: { threadId: 'thread-1', hostId: 'local' }, evidence: { ...common(), identity_verified: true, evidence_ref: 'same-ack' } }).setup_complete, true);
  assert.equal(s.confirmCreation(observation('new-human-project')).project_changed_since_setup, true);
  assert.equal(s.status().pending_thread_setups.length, 0);
  const duplicate = { ...a, key: 'another-create-key' }; s.prepare(duplicate);
  assert.equal(s.claim({ key: duplicate.key, owner: 'coordinator', evidence: duplicate.evidence }).claimed, false);
  s.close();
});

test('an unexpected creation identity still records the sent action and cannot trigger duplicate creation', () => {
  const s = new ControlStore(':memory:', { now: () => now });
  const result = sent(s, creation(), { threadId: 'thread-1', hostId: 'unexpected-host' });
  assert.equal(result.state, 'sent'); assert.equal(result.setup_complete, false);
  assert.match(result.identity_error, /identity/);
  assert.equal(s.db.prepare('SELECT state FROM actions WHERE action_key=?').get('create:work-1').state, 'sent');
  assert.equal(s.status().pending_thread_setups[0].state, 'identity_pending'); s.close();
});

test('pending project placement survives restart and cannot be verified by stale or wrong identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-project-')); const path = join(dir, 'control.sqlite');
  let s = new ControlStore(path, { now: () => now }); sent(s); s.close();
  s = new ControlStore(path, { now: () => now });
  try {
    assert.equal(s.status().pending_thread_setups.length, 1);
    for (const patch of [{ id: 'wrong-thread' }, { hostId: 'remote-host' }])
      assert.throws(() => s.confirmCreation(observation('project-example', patch)), /identity/);
    assert.throws(() => s.confirmCreation({ ...observation(), verified_at: new Date(now - 61000).toISOString() }), /Fresh/);
    assert.equal(s.confirmCreation(observation('wrong-project')).setup_complete, false);
    assert.equal(s.confirmCreation(observation()).setup_complete, true);
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('queued client identity is not a usable thread or a completed placement', () => {
  const s = new ControlStore(':memory:', { now: () => now });
  sent(s, creation(), { clientThreadId: 'client-1' });
  assert.throws(() => s.confirmCreation(observation()), /identity/);
  const e = { ...common(), identity_verified: true, evidence_ref: 'native-client-resolution', client_thread_id: 'client-1' };
  assert.throws(() => s.recordCreation({ key: 'create:work-1', native_result: { threadId: 'thread-1', hostId: 'local' }, evidence: { ...e, client_thread_id: 'other' } }), /client/);
  s.recordCreation({ key: 'create:work-1', native_result: { threadId: 'thread-1', hostId: 'local' }, evidence: e });
  assert.equal(s.confirmCreation(observation()).setup_complete, true); s.close();
});

test('automatic continuation waits for placement and placement does not grant runtime permissions', () => {
  const s = new ControlStore(':memory:', { now: () => now }); sent(s);
  const a = { key: 'continue-created', task_id: 'T-182', kind: 'dispatch',
    payload: { thread_id: 'thread-1', run_id: 'run-2', starts_heavy_work: false },
    evidence: { ...common(), thread_status: 'idle', queued_input: false, pending_dispatch: false,
      underlying_job_running: false, expected_turn_id: 'turn-1', actual_turn_id: 'turn-1',
      owner_matches: true, overlapping_owner: false, owner_thread_id: 'thread-1', work_incomplete: true,
      existing_driver_owns_step: false, capacity_available: true, runtime_permissions_verified: true,
      runtime_permission_turn_id: 'turn-1', approval_policy: 'never', sandbox_mode: 'danger-full-access',
      worktree_access_verified: true, registry_access_verified: true, network_access_verified: true } };
  assert.equal(s.prepare(a).prepared, true);
  assert.equal(s.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence }).reason, 'created_owner_project_setup_incomplete');
  s.confirmCreation(observation());
  const blocked = s.claim({ key: a.key, owner: 'coordinator', evidence: { ...a.evidence, runtime_permissions_verified: false } });
  assert.equal(blocked.claimed, false); assert.ok(blocked.reasons.includes('effective_runtime_permissions_not_ready'));
  assert.equal(s.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence }).claimed, true); s.close();
});

test('uncertain project assignment is resolved by observed membership rather than a repeated move', () => {
  const s = new ControlStore(':memory:', { now: () => now }); sent(s, creation('project-example', 'move'));
  const a = { key: 'move-uncertain', task_id: 'T-182', kind: 'assign_project',
    payload: { creation_key: 'create:work-1', thread_id: 'thread-1', host_id: 'local', project_id: 'project-example' },
    evidence: { ...common(), owner_thread_id: 'thread-1', actual_host_id: 'local', actual_project_id: null,
      membership_observed: true, project_resolution_verified: true, project_exists: true,
      intended_project_id: 'project-example', project_host_id: 'local', thread_status: 'active' } };
  assert.equal(s.prepare(a).prepared, true);
  const claim = s.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence });
  assert.equal(claim.claimed, true);
  s.settle({ key: a.key, attempt_id: claim.attempt_id, outcome: 'uncertain', evidence_ref: 'timeout-after-send' });
  s.prepare({ ...a, key: 'another-move-key' });
  assert.equal(s.claim({ key: 'another-move-key', owner: 'coordinator', evidence: a.evidence }).reason, 'scope_in_use');
  assert.equal(s.confirmCreation(observation()).setup_complete, true);
  assert.equal(s.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence }).claimed, false); s.close();
});
