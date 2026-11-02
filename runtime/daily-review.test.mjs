import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dailyReviewEvent } from './daily-review.mjs';
import { Mailbox, MAINTENANCE, COORDINATOR, renderPrompt } from './mailbox.mjs';

const config = { enabled: true, timezone: 'Asia/Shanghai', time: '05:00', first_date: '2026-11-03', authorization_ref: 'human-daily-review' };
const at = value => Date.parse(value);
const idle = (now, id = MAINTENANCE, turn = 'old-turn') => ({ checked_at: new Date(now).toISOString(), thread: { id, status: { type: 'idle' } }, latestTurn: { id: turn, status: 'completed' } });

test('daily review starts at Beijing 05:00 with a fixed preceding 24-hour window', () => {
  assert.equal(dailyReviewEvent(at('2026-11-02T20:59:59Z'), config), null);
  const event = dailyReviewEvent(at('2026-11-02T21:00:00Z'), config);
  assert.equal(event.key, 'workflow-daily-review:2026-11-03');
  assert.equal(event.payload.window_start, '2026-11-01T21:00:00.000Z');
  assert.equal(event.payload.window_end, '2026-11-02T21:00:00.000Z');
  assert.deepEqual(dailyReviewEvent(at('2026-11-03T20:59:59Z'), config), event);
  assert.equal(dailyReviewEvent(at('2026-11-03T21:00:00Z'), config).payload.date, '2026-11-04');
});

test('delayed startup catches up only the latest due day, including year rollover', () => {
  const event = dailyReviewEvent(at('2027-01-01T19:00:00Z'), config);
  assert.equal(event.payload.date, '2027-01-01');
  assert.equal(event.payload.due_at, '2026-12-31T21:00:00.000Z');
  assert.equal(dailyReviewEvent(at('2027-01-01T21:00:00Z'), config).payload.date, '2027-01-02');
  assert.equal(dailyReviewEvent(at('2027-01-01T21:00:00Z'), { ...config, enabled: false }), null);
});

test('daily admission deduplicates across restarts and does not accumulate unfinished days', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-daily-'));
  const path = join(dir, 'mailbox.sqlite'); let now = at('2026-11-02T21:00:00Z');
  let m = new Mailbox(path, { now: () => now });
  try {
    const first = dailyReviewEvent(now, config);
    assert.equal(m.enqueue(first).queued, true); m.close();
    now += 3600000; m = new Mailbox(path, { now: () => now });
    assert.equal(m.enqueue(dailyReviewEvent(now, config)).reason, 'duplicate');
    now = at('2026-11-05T21:00:00Z');
    assert.equal(m.enqueue(dailyReviewEvent(now, config)).reason, 'previous_review_unfinished');
    assert.equal(m.status().pending.find(x => x.lane === 'maintenance').count, 1);
  } finally { m.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('maintenance waits for idle and a stable turn without blocking coordinator work', () => {
  const now = at('2026-11-02T21:00:00Z'); const m = new Mailbox(':memory:', { now: () => now });
  m.enqueue(dailyReviewEvent(now, config));
  const busy = { ...idle(now), thread: { id: MAINTENANCE, status: { type: 'active' } } };
  assert.equal(m.reserve('maintenance', busy).reserved, false);
  m.enqueue({ key: 'ready-pr', lane: 'coordinator', kind: 'event', payload: {} });
  assert.equal(m.reserve('coordinator', idle(now, COORDINATOR)).reserved, true);
  const batch = m.reserve('maintenance', idle(now)).batch;
  m.setPrompt(batch.id, renderPrompt(batch, '/tmp/daily-batch.json'));
  assert.equal(m.authorizeSend(batch.id, idle(now, MAINTENANCE, 'human-turn')).send, false);
  assert.equal(m.releaseReservation(batch.id).released, true); m.close();
});

test('unfinished maintenance resumes the same date and completion admits the next due day', () => {
  let now = at('2026-11-02T21:00:00Z'); const m = new Mailbox(':memory:', { now: () => now });
  const event = dailyReviewEvent(now, config); m.enqueue(event);
  function start() {
    const b = m.reserve('maintenance', idle(now)).batch;
    m.setPrompt(b.id, renderPrompt(b, '/tmp/daily-batch.json'));
    assert.equal(m.authorizeSend(b.id, idle(now)).send, true);
    m.delivery(b.id, { outcome: 'sent', receipt: {} });
    const started = m.begin(b.id);
    assert.equal(Date.parse(started.deadline) - now, 20 * 60000);
    return b;
  }
  m.finish(start().id, { processed_keys: [] });
  const resumed = start();
  assert.equal(resumed.snapshot.items[0].key, event.key);
  m.finish(resumed.id, { processed_keys: [event.key] });
  assert.equal(m.enqueue(event).state, 'acknowledged');
  now = at('2026-11-04T21:00:00Z');
  assert.equal(m.enqueue(dailyReviewEvent(now, config)).queued, true); m.close();
});
