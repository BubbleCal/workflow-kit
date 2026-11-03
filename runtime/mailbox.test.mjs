import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mailbox, COORDINATOR, INBOX, isIdle, renderPrompt } from './mailbox.mjs';

const NOW = Date.parse('2026-11-02T10:00:00Z');
const idle = (id = COORDINATOR, turn = 'previous-turn', now = NOW) => ({ checked_at: new Date(now).toISOString(), thread: { id, status: { type: 'idle', activeFlags: [] } }, latestTurn: { id: turn, status: 'completed' } });
const command = key => ({ key, lane: 'coordinator', kind: 'human_command', payload: { text: `Work on ${key}`, source_message_id: key } });
function sent(store, lane = 'coordinator') {
  const observation = idle(lane === 'coordinator' ? COORDINATOR : INBOX);
  const b = store.reserve(lane, observation).batch;
  store.setPrompt(b.id, renderPrompt(b, `/tmp/${b.id}.json`));
  assert.equal(store.authorizeSend(b.id, observation).send, true);
  store.delivery(b.id, { outcome: 'sent', receipt: { tool_ack: true } });
  return b;
}

test('a busy coordinator receives no messages while repeated timer ticks coalesce', () => {
  let now = NOW; const m = new Mailbox(':memory:', { now: () => now });
  const busy = { ...idle(), thread: { id: COORDINATOR, status: { type: 'active', activeFlags: [] } } };
  for (let i = 0; i < 10; i++) { now += 15 * 60000; m.tick(); assert.equal(m.reserve('coordinator', { ...busy, checked_at: new Date(now).toISOString() }).reserved, false); }
  assert.equal(m.status().active_batches.length, 0);
  assert.equal(m.status().lanes.find(x => x.lane === 'coordinator').generation, 1);
  const b = m.reserve('coordinator', idle(COORDINATOR, 'previous-turn', now));
  assert.equal(b.reserved, true); m.close();
});

test('an explicit coordinator model request reaches the next idle delivery as supported native arguments', () => {
  const m = new Mailbox(':memory:', { now: () => NOW });
  const payload = { text: 'Use the requested model and effort', source_message_id: 'actual-human-model',
    intent: 'coordinator_model_change', target_thread_id: COORDINATOR, user_model_request_verified: true,
    native_model: { model: 'requested-model', thinking: 'xhigh', serviceTier: 'priority' } };
  m.enqueue({ key: 'model-choice', lane: 'coordinator', kind: 'human_command', payload });
  const busy = { ...idle(), thread: { id: COORDINATOR, status: { type: 'active' } } };
  assert.equal(m.reserve('coordinator', busy).reserved, false);
  const b = m.reserve('coordinator', idle()).batch;
  m.setPrompt(b.id, 'fixed batch');
  assert.equal(m.authorizeSend(b.id, busy).send, false);
  const permit = m.authorizeSend(b.id, idle());
  assert.equal(permit.model, 'requested-model');
  assert.equal(permit.thinking, 'xhigh');
  assert.equal(Object.hasOwn(permit, 'serviceTier'), false);
  assert.equal(m.authorizeSend(b.id, idle()).send, false);
  m.close();
});

test('ordinary events cannot alter a control model', () => {
  for (const patch of [{ kind: 'event' }, { verified: false }, { target: 'another-owner' }]) {
    const m = new Mailbox(':memory:', { now: () => NOW });
    m.enqueue({ key: 'not-a-model-grant', lane: 'coordinator', kind: patch.kind ?? 'human_command',
      payload: { source_message_id: 'source', intent: 'coordinator_model_change',
        user_model_request_verified: patch.verified ?? true, target_thread_id: patch.target ?? COORDINATOR,
        native_model: { model: 'other-model', thinking: 'xhigh' } } });
    const b = m.reserve('coordinator', idle()).batch; m.setPrompt(b.id, 'fixed');
    const permit = m.authorizeSend(b.id, idle());
    assert.equal(Object.hasOwn(permit, 'model'), false); m.close();
  }
});

test('input arriving during a run belongs only to the next fixed batch', () => {
  const m = new Mailbox(':memory:', { now: () => NOW });
  m.enqueue(command('a')); m.signal(); const b = sent(m); m.begin(b.id);
  m.enqueue(command('b')); m.signal(); m.signal();
  assert.deepEqual(m.get(b.id).snapshot.items.map(x => x.key), ['a']);
  assert.equal(m.reserve('coordinator', idle()).reason, 'batch_in_flight');
  assert.throws(() => m.finish(b.id, { processed_keys: ['b'] }), /outside fixed batch/);
  m.finish(b.id, { processed_keys: ['a'] });
  const next = m.reserve('coordinator', idle(COORDINATOR, 'completed-batch')).batch;
  assert.deepEqual(next.snapshot.items.map(x => x.key), ['b']);
  assert.equal(next.signal_generation, 2); m.close();
});

test('two dispatcher connections cannot reserve two batches for one lane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-mailbox-'));
  const a = new Mailbox(join(dir, 'queue.sqlite'), { now: () => NOW });
  const b = new Mailbox(join(dir, 'queue.sqlite'), { now: () => NOW });
  try { a.enqueue(command('a')); assert.equal(a.reserve('coordinator', idle()).reserved, true); assert.equal(b.reserve('coordinator', idle()).reason, 'batch_in_flight'); }
  finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a new turn between reservation and sending cancels permission to send', () => {
  const m = new Mailbox(':memory:', { now: () => NOW }); m.enqueue(command('a'));
  const b = m.reserve('coordinator', idle()).batch; m.setPrompt(b.id, 'fixed');
  assert.equal(m.authorizeSend(b.id, idle(COORDINATOR, 'new-user-turn')).send, false);
  assert.equal(m.releaseReservation(b.id).released, true);
  assert.equal(m.status().pending[0].count, 1); m.close();
});

test('unknown, stale, queued or active target states never authorize a wake', () => {
  assert.equal(isIdle(idle(), NOW), true);
  assert.equal(isIdle(idle(), NOW + 61000), false);
  assert.equal(isIdle({ ...idle(), latestTurn: { status: 'inProgress' } }, NOW), false);
  assert.equal(isIdle({ ...idle(), thread: { status: { type: 'idle', activeFlags: ['queued'] } } }, NOW), false);
  assert.equal(isIdle(null, NOW), false);
});

test('inbox notifications wait while the user is active and routine noise is rejected', () => {
  const m = new Mailbox(':memory:', { now: () => NOW });
  assert.throws(() => m.enqueue({ key: 'progress', lane: 'inbox', kind: 'progress', payload: {} }), /Routine/);
  m.enqueue({ key: 'done', lane: 'inbox', kind: 'important_completion', payload: { text: 'T-001 completed.' } });
  assert.equal(m.reserve('inbox', { ...idle(INBOX), thread: { id: INBOX, status: { type: 'active' } } }).reserved, false);
  const b = sent(m, 'inbox'); m.begin(b.id); m.finish(b.id, { processed_keys: ['done'] });
  assert.equal(m.enqueue({ key: 'done', lane: 'inbox', kind: 'important_completion', payload: { text: 'T-001 completed.' } }).queued, false);
  assert.equal(m.reserve('inbox', idle(INBOX)).reason, 'nothing_due'); m.close();
});

test('inbox finish consumes the displayed batch by default, never requeues its notice', () => {
  const m = new Mailbox(':memory:', { now: () => NOW });
  m.enqueue({ key: 'ready', lane: 'inbox', kind: 'important_completion', payload: { text: 'Ready.' } });
  const b = sent(m, 'inbox'); m.begin(b.id); m.finish(b.id);
  assert.equal(m.status().pending.length, 0);
  assert.deepEqual(m.receipts()[0].acknowledged_keys, ['ready']); m.close();
});

test('delivery uncertainty survives restart and is never blindly retried', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-restart-')); const p = join(dir, 'q.sqlite');
  let m = new Mailbox(p, { now: () => NOW }); m.enqueue(command('a'));
  const b = m.reserve('coordinator', idle()).batch; m.setPrompt(b.id, 'fixed'); m.authorizeSend(b.id, idle());
  m.delivery(b.id, { outcome: 'uncertain', receipt: { timeout: true } }); m.close();
  m = new Mailbox(p, { now: () => NOW });
  try { assert.equal(m.reserve('coordinator', idle()).reason, 'batch_in_flight'); assert.throws(() => m.recover(b.id, { target_idle: true, evidence_ref: 'idle-only' }), /uncertainty/); m.begin(b.id); m.finish(b.id, { processed_keys: ['a'] }); assert.equal(m.status().pending.length, 0); }
  finally { m.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('worker completion before transport acknowledgment cannot be overwritten', () => {
  const m = new Mailbox(':memory:', { now: () => NOW }); m.enqueue(command('a'));
  const b = m.reserve('coordinator', idle()).batch; m.setPrompt(b.id, 'fixed'); m.authorizeSend(b.id, idle());
  m.begin(b.id); m.finish(b.id, { processed_keys: ['a'] });
  assert.equal(m.delivery(b.id, { outcome: 'sent', receipt: { delayed_ack: true } }).state, 'finished');
  assert.equal(m.get(b.id).state, 'finished'); m.close();
});

test('partial progress is checkpointed and recovery retries only unacknowledged input', () => {
  const m = new Mailbox(':memory:', { now: () => NOW }); m.enqueue(command('a')); m.enqueue(command('b'));
  const b = sent(m); m.begin(b.id); m.acknowledge(b.id, ['a']);
  assert.throws(() => m.recover(b.id, { target_idle: false, evidence_ref: 'still-running' }), /idle/);
  m.recover(b.id, { target_idle: true, evidence_ref: 'turn-failed' });
  const next = m.reserve('coordinator', idle()).batch; assert.deepEqual(next.snapshot.items.map(x => x.key), ['b']); m.close();
});

test('pausing admission leaves existing work intact and immutable keys prevent changed replays', () => {
  const m = new Mailbox(':memory:', { now: () => NOW }); m.enqueue(command('a'));
  assert.throws(() => m.enqueue({ ...command('a'), payload: { text: 'changed' } }), /Immutable/);
  assert.deepEqual(m.pause('coordinator', false), { lane: 'coordinator', enabled: false, running_work_interrupted: false });
  assert.equal(m.reserve('coordinator', idle()).reason, 'lane_paused');
  m.pause('coordinator', true); assert.equal(m.reserve('coordinator', idle()).reserved, true); m.close();
});
