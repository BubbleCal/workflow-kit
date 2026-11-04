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

const periodic={enabled:true,timezone:'Asia/Shanghai',interval_minutes:120,first_due_at:'2026-11-05T06:30:00+08:00',authorization_ref:'actual-human-two-hour-request'};
test('two-hour reviews use distinct fixed windows and coalesce missed slots',()=>{
  const first=at(periodic.first_due_at);assert.equal(dailyReviewEvent(first-1,periodic),null);
  const event=dailyReviewEvent(first,periodic);assert.equal(event.payload.report_key,'2026-11-05-maintenance-0630');
  assert.equal(at(event.payload.window_end)-at(event.payload.window_start),7200000);
  assert.deepEqual(dailyReviewEvent(first+7199999,periodic),event);
  const later=dailyReviewEvent(first+7*3600000,periodic);assert.equal(at(later.payload.due_at),first+6*3600000);
  assert.notEqual(later.key,event.key);assert.throws(()=>dailyReviewEvent(first,{...periodic,first_due_at:'2026-11-05T06:30:00'}),/explicit first due/);
});

test('new maintenance inputs wait two hours and are grouped without blocking other lanes',()=>{
  let now=at(periodic.first_due_at)-1;const m=new Mailbox(':memory:',{now:()=>now,maintenanceConfig:()=>periodic});try{
    for(const key of ['manual','recovery'])m.enqueue({key,lane:'maintenance',kind:'daily_review',payload:{manual_request:true}});
    assert.equal(m.reserveQueuedLane('maintenance').reason,'maintenance_interval');now++;
    const batch=m.reserveQueuedLane('maintenance').batch;assert.equal(batch.snapshot.items.length,2);m.setPrompt(batch.id,'scheduled work');m.authorizeQueueSend(batch.id);m.delivery(batch.id,{outcome:'sent',receipt:{queue_id:'original'}});m.begin(batch.id);
    now+=60000;assert.equal(m.begin(batch.id).begun,true);m.finish(batch.id,{processed_keys:['manual','recovery']});
    m.enqueue({key:'new-maintenance',lane:'maintenance',kind:'daily_review',payload:{manual_request:true}});
    assert.equal(m.reserveQueuedLane('maintenance').reason,'maintenance_interval');
    m.enqueue({key:'ordinary-progress',lane:'coordinator',kind:'configuration',payload:{}});assert.equal(m.reserveQueuedLane('coordinator').reserved,true);
    now=at(periodic.first_due_at)+7200000;assert.equal(m.reserveQueuedLane('maintenance').reserved,true);
  }finally{m.close();}
});

test('an already queued old batch defers work and preserves its accepted receipt',()=>{
  let now=at(periodic.first_due_at)-60000,settings=null;const dir=mkdtempSync(join(tmpdir(),'maintenance-cadence-')),path=join(dir,'mailbox.sqlite');let m=new Mailbox(path,{now:()=>now,maintenanceConfig:()=>settings});try{
    m.enqueue({key:'old-input',lane:'maintenance',kind:'daily_review',payload:{manual_request:true}});const b=m.reserveQueuedLane('maintenance').batch;m.setPrompt(b.id,'old batch');m.authorizeQueueSend(b.id);m.delivery(b.id,{outcome:'sent',receipt:{queue_id:'kept'}});
    settings=periodic;const result=m.begin(b.id);assert.equal(result.begun,false);assert.equal(result.deferred,true);assert.equal(m.get(b.id).started_at,null);assert.equal(m.get(b.id).receipt.queue_id,'kept');
    assert.equal(m.begin(b.id).reason,'already_deferred_by_cadence');m.delivery(b.id,{outcome:'sent',receipt:{late_ack:true}});assert.equal(m.get(b.id).state,'deferred');assert.equal(m.get(b.id).receipt.queue_id,'kept');
    m.close();m=new Mailbox(path,{now:()=>now,maintenanceConfig:()=>settings});assert.equal(m.reserveQueuedLane('maintenance').reserved,false);now=at(periodic.first_due_at);
    const next=m.reserveQueuedLane('maintenance').batch;assert.notEqual(next.id,b.id);assert.equal(next.snapshot.items[0].key,'old-input');
  }finally{m.close();rmSync(dir,{recursive:true,force:true});}
});

test('a cadence change before sending releases only the unsent reservation',()=>{
  const now=at(periodic.first_due_at)-1;let settings=null;const m=new Mailbox(':memory:',{now:()=>now,maintenanceConfig:()=>settings});try{
    m.enqueue({key:'unsent',lane:'maintenance',kind:'daily_review',payload:{manual_request:true}});const b=m.reserveQueuedLane('maintenance').batch;m.setPrompt(b.id,'old batch');settings=periodic;
    assert.equal(m.authorizeQueueSend(b.id).send,false);assert.equal(m.get(b.id).state,'deferred');assert.equal(m.get(b.id).receipt.native_message_consumed,false);
  }finally{m.close();}
});

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
