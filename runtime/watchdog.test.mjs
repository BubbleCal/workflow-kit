import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mailbox, COORDINATOR, MAINTENANCE } from './mailbox.mjs';

const NOW = Date.parse('2026-11-02T17:00:00Z');
const task = (id = 'T1', owner = 'worker') => ({ id, owner_thread_id: owner, status: 'engineering_active', authorization_message_id: 'actual-human', role: 'implementation' });
const registry = tasks => ({ task_registry: { items: Object.fromEntries(tasks.map(t => [t.id,t])) } });
const poll = (now, owner = 'worker', patch = {}) => ({ checked_at: new Date(now).toISOString(), thread: { id: owner, status: { type: 'idle', activeFlags: [] } }, latestTurn: { id: owner + '-old', status: 'completed' }, ...patch });
const select = (m, tasks = [task()]) => m.atomic(() => m.watchdog.select(registry(tasks)));
const observe = (m, r, snapshots, coordinator) => m.atomic(() => m.watchdog.observe({ round_id: r.round_id, snapshots, coordinator_snapshot: coordinator }));
function flush(m) { for (const item of m.watchdog.outbox()) m.enqueue(item); }
function completedRound(m, at, keys = []) {
  m.db.prepare("INSERT INTO batches(id,lane,state,item_ids,signal_generation,intake_due,snapshot,created_at,finished_at) VALUES (?,'coordinator','finished','[]',0,0,?,?,?)").run('coordinator-'+at,JSON.stringify({items:keys.map(key=>({key}))}),at,at+1);
}

test('an idle unfinished owner is recovered without any worker completion event, including after restart', () => {
  const dir = mkdtempSync(join(tmpdir(),'workflow-watchdog-')), path = join(dir,'mail.sqlite');
  let m = new Mailbox(path,{now:()=>NOW}); const r=select(m); observe(m,r,[poll(NOW)]); const item=m.watchdog.outbox()[0];
  assert.equal(item.lane,'coordinator'); assert.equal(item.kind,'recovery'); assert.equal(m.progress.status().actions.length,0);
  m.close(); m=new Mailbox(path,{now:()=>NOW});
  try { assert.equal(m.watchdog.outbox()[0].key,item.key); flush(m); assert.equal(observe(m,r,[poll(NOW)]).duplicate,true); assert.equal(m.status().pending[0].count,1); }
  finally { m.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('native busy/approval, known jobs, holds and existing drivers never trigger a restart', () => {
  for(const patch of [{thread:{id:'worker',status:{type:'active',activeFlags:[]}}},{thread:{id:'worker',status:{type:'idle',activeFlags:['waitingOnApproval']}}},{background_job_running:true},{hold:true},{existing_driver:true}]) {
    const m=new Mailbox(':memory:',{now:()=>NOW}); observe(m,select(m),[poll(NOW,'worker',patch)]);assert.equal(m.watchdog.outbox().length,0);m.close();
  }
  const m=new Mailbox(':memory:',{now:()=>NOW});
  assert.equal(select(m,[{...task('done'),task_complete:true},{...task('held'),hold:true},{...task('archived'),archived:true}]).owners.length,0);m.close();
});

test('a missed eligible coordinator round escalates once into the existing maintenance lane', () => {
  let now=NOW; const m=new Mailbox(':memory:',{now:()=>now});let r=select(m);observe(m,r,[poll(now)]);flush(m);
  now+=300000;r=select(m);completedRound(m,NOW+1000);
  observe(m,r,[poll(now)],poll(now,COORDINATOR));
  const health=m.watchdog.outbox().find(x=>x.lane==='maintenance');assert.equal(health.kind,'workflow_recovery');
  m.enqueue({key:'manual-inflight',lane:'maintenance',kind:'daily_review',payload:{manual_request:true}});flush(m);
  assert.equal(m.db.prepare("SELECT count(*) n FROM mail WHERE item_key=?").get(health.key).n,1);
  now+=300000;r=select(m);observe(m,r,[poll(now)],poll(now,COORDINATOR));flush(m);
  assert.equal(m.db.prepare("SELECT count(*) n FROM mail WHERE kind='workflow_recovery'").get().n,1);m.close();
});

test('busy coordinator and mere elapsed time are not a missed eligible round', () => {
  let now=NOW;const m=new Mailbox(':memory:',{now:()=>now});observe(m,select(m),[poll(now)]);flush(m);
  now+=3600000;observe(m,select(m),[poll(now)],poll(now,COORDINATOR));assert.equal(m.watchdog.outbox().length,0);
  now+=300000;completedRound(m,NOW+1000);observe(m,select(m),[poll(now)],poll(now,COORDINATOR,{thread:{id:COORDINATOR,status:{type:'active'}}}));assert.equal(m.watchdog.outbox().length,0);m.close();
});

test('recovery ACK requires durable disposition and a real blocker has a bounded recheck', () => {
  let now=NOW;const m=new Mailbox(':memory:',{now:()=>now});observe(m,select(m),[poll(now)]);flush(m);
  const b=m.reserve('coordinator',poll(now,COORDINATOR)).batch;m.setPrompt(b.id,'fixed');m.authorizeSend(b.id,poll(now,COORDINATOR));m.delivery(b.id,{outcome:'sent',receipt:{}});m.begin(b.id);
  const item=b.snapshot.items[0];assert.throws(()=>m.acknowledge(b.id,[item.key]),/actual watchdog/);
  assert.throws(()=>m.watchdog.resolve({case_key:item.payload.watchdog_case,recovery_key:item.key,disposition:'running',evidence_ref:'send-ack',new_turn_id:'worker-old'}),/not resumed work/);
  m.atomic(()=>m.watchdog.resolve({case_key:item.payload.watchdog_case,recovery_key:item.key,disposition:'blocked',evidence_ref:'actual-live-job',reason:'job running',resume_condition:'job exits and owner result verified',next_check_at:new Date(now+900000).toISOString()}));
  m.acknowledge(b.id,[item.key]);m.finish(b.id);now+=300000;observe(m,select(m),[poll(now)]);assert.equal(m.watchdog.outbox().length,0);
  now+=900000;observe(m,select(m),[poll(now)]);assert.equal(m.watchdog.outbox()[0].key.endsWith('recovery:2'),true);m.close();
});

test('durable cursor rotates a bounded sweep rather than repeatedly inspecting the same owners', () => {
  let now=NOW;const m=new Mailbox(':memory:',{now:()=>now});const tasks=Array.from({length:7},(_,i)=>task('T'+i,'worker'+i));
  const a=select(m,tasks);assert.equal(a.owners.length,4);assert.deepEqual(select(m,tasks),a);
  now+=300000;const b=select(m,tasks);assert.equal(new Set([...a.owners,...b.owners].map(x=>x.thread_id)).size,7);m.close();
});

test('manual addenda remain queued while maintenance is unfinished; scheduled days still coalesce', () => {
  const m=new Mailbox(':memory:',{now:()=>NOW});
  m.enqueue({key:'first-human',lane:'maintenance',kind:'daily_review',payload:{manual_request:true}});
  assert.equal(m.enqueue({key:'second-human',lane:'maintenance',kind:'daily_review',payload:{manual_request:true}}).queued,true);
  m.enqueue({key:'daily1',lane:'maintenance',kind:'daily_review',payload:{date:'2026-11-03'}});
  assert.equal(m.enqueue({key:'daily2',lane:'maintenance',kind:'daily_review',payload:{date:'2026-11-04'}}).reason,'previous_review_unfinished');m.close();
});

function pendingGoal(m, tasks) {
  m.progress.record({ event_key: 'accepted-goal', evidence_ref: 'human-scope', goals: [{
    id: 'scope', authorization_ref: 'human-scope', expected_revision: 0, complete: false,
    stages: tasks.map(t => ({ id: t.id, task_id: t.id, owner_thread_id: t.owner_thread_id,
      scope_key: t.id, state: 'pending', step_id: t.id, action: 'Continue accepted work', depends_on: [] })),
  }] });
}

test('progress goals cannot reintroduce control chats, services or explicit text holds', () => {
  const m = new Mailbox(':memory:', { now: () => NOW });
  const tasks = [task('setup', 'setup'), task('coordinator', 'coordinator'), task('inbox', 'inbox'),
    task('dispatcher', 'dispatcher'), task('meeting', 'meetings'),
    { ...task('held'), hold: 'Yang said leave these tickets alone', status: 'deferred' },
    { ...task('service', 'shared'), role: 'scheduled_service' }, task('engineering', 'shared')];
  const r = { ...registry(tasks), setup_thread_id: 'setup', coordinator_thread_id: 'coordinator',
    decision_inbox_thread_id: 'inbox', queue_transport: { dispatcher_thread_id: 'dispatcher' },
    meeting_prep: { worker_thread_id: 'meetings' } };
  pendingGoal(m, tasks);
  assert.deepEqual(m.watchdog.select(r).owners, [{ thread_id: 'shared', host_id: 'local', task_ids: ['engineering'] }]);
  m.close();
});

test('a newly applied hold protects even an already selected round', () => {
  const m = new Mailbox(':memory:', { now: () => NOW });
  const r = select(m);
  m.watchdog.observe({ round_id: r.round_id, snapshots: [poll(NOW)], registry: registry([{ ...task(), hold: 'Explicit human hold' }]) });
  assert.equal(m.watchdog.outbox().length, 0);
  m.close();
});

test('protected false positives close without completing goals and resume detection after release', () => {
  let now = NOW; const m = new Mailbox(':memory:', { now: () => now });
  pendingGoal(m, [task()]); observe(m, select(m), [poll(now)]);
  const item = m.watchdog.outbox()[0]; flush(m);
  const resolution = { case_key: item.payload.watchdog_case, recovery_key: item.key,
    disposition: 'protected', evidence_ref: 'actual-human-hold', reason: 'Explicit hold in registry' };
  assert.throws(() => m.watchdog.resolve({ ...resolution, registry: registry([task()]) }), /not protected/);
  m.watchdog.resolve({ ...resolution, registry: registry([{ ...task(), hold: 'Wait for my instruction' }]) });
  assert.equal(m.watchdog.canAck(resolution.case_key, resolution.recovery_key), true);
  assert.equal(m.progress.unfinishedForOwner('worker'), true);
  now += 300000;
  assert.equal(select(m, [{ ...task(), hold: 'Wait for my instruction' }]).owners.length, 0);
  now += 300000;
  observe(m, select(m), [poll(now)]);
  assert.equal(m.watchdog.outbox()[0].key, resolution.case_key + ':recovery:2');
  m.close();
});

test('a queued diagnostic retires when its accepted stage completes, while the next stage remains discoverable', () => {
  let now = NOW; const m = new Mailbox(':memory:', { now: () => now });
  pendingGoal(m, [task()]); observe(m, select(m), [poll(now)]); flush(m);
  const item = m.db.prepare('SELECT * FROM watchdog_cases').get();
  const key = m.progress.status().actions[0].action_key;
  m.watchdog.resolve({ case_key: item.case_key, recovery_key: item.recovery_key, disposition: 'queued',
    continuation_key: key, evidence_ref: 'durable-next-step' });
  const g = m.progress.goals()[0];
  m.progress.record({ event_key: 'accepted-stage-result', evidence_ref: 'actual-result', goals: [{
    ...g, expected_revision: g.revision, stages: [
      { ...g.stages[0], state: 'complete', completion_evidence_ref: 'accepted-deliverable' },
      { ...g.stages[0], id: 'next', step_id: 'next', action: 'Continue remaining scope' },
    ],
  }] });
  now += 300000;
  const r = select(m);
  assert.equal(m.watchdog.status()[0].phase, 'resolved');
  assert.equal(m.progress.unfinishedForOwner('worker'), true);
  observe(m, r, [poll(now, 'worker', { latestTurn: { id: 'worker-new', status: 'completed' } })]);
  assert.equal(m.watchdog.outbox().length, 1);
  assert.notEqual(m.watchdog.outbox()[0].key, item.recovery_key);
  m.close();
});

test('actual continuation execution retires a queued diagnostic even when the new owner turn is busy', () => {
  let now = NOW; const m = new Mailbox(':memory:', { now: () => now });
  pendingGoal(m, [task()]); observe(m, select(m), [poll(now)]); flush(m);
  const c = m.watchdog.status()[0], key = m.progress.status().actions[0].action_key;
  m.watchdog.resolve({ case_key: c.case_key, recovery_key: c.recovery_key, disposition: 'queued', continuation_key: key, evidence_ref: 'queued' });
  const o = { thread_id: 'worker', status: 'idle', turn_status: 'completed', turn_id: 'worker-old',
    checked_at: new Date(now).toISOString(), background_job_running: false, queued_input: false, existing_driver: false, hold: false };
  assert.equal(m.progress.claim({ key, observation: o }).reserved, true);
  m.progress.delivery({ key, outcome: 'sent', control_action_key: key, evidence_ref: 'transport' });
  now += 300000; select(m);
  assert.equal(m.watchdog.status()[0].phase, 'queued');
  m.progress.started({ key, observation: { ...o, status: 'active', turn_id: 'new-turn', checked_at: new Date(now).toISOString() }, work_turn_id: 'new-turn', work_evidence_ref: 'native-productive-work' });
  now += 300000;
  observe(m, select(m), [poll(now, 'worker', { thread: { id: 'worker', status: { type: 'active' } } })]);
  assert.equal(m.watchdog.status()[0].phase, 'resolved');
  assert.equal(m.watchdog.outbox().length, 0);
  assert.equal(m.progress.status().actions[0].state, 'running');
  m.close();
});

test('a finished action without execution or accepted exact-stage evidence is not sufficient retirement', () => {
  let now = NOW; const m = new Mailbox(':memory:', { now: () => now });
  pendingGoal(m, [task()]); observe(m, select(m), [poll(now)]);
  const c = m.watchdog.status()[0], key = m.progress.status().actions[0].action_key;
  m.watchdog.resolve({ case_key: c.case_key, recovery_key: c.recovery_key, disposition: 'queued', continuation_key: key, evidence_ref: 'queued' });
  m.db.prepare("UPDATE continuation_actions SET state='finished' WHERE action_key=?").run(key);
  now += 300000; select(m);
  assert.equal(m.watchdog.status()[0].phase, 'queued');
  assert.equal(m.progress.unfinishedForOwner('worker'), true);
  m.close();
});


test('health distinguishes queue admission gaps from an unhandled offered recovery',()=>{
  for(const admitted of [false,true]){
    let now=NOW;const m=new Mailbox(':memory:',{now:()=>now});observe(m,select(m),[poll(now)]);
    const recovery=m.watchdog.outbox()[0];flush(m);completedRound(m,NOW+1000,admitted?[recovery.key]:['unrelated-item']);
    now+=300000;observe(m,select(m),[poll(now)],poll(now,COORDINATOR));
    const health=m.watchdog.outbox().find(i=>i.lane==='maintenance');
    assert.equal(health.payload.recovery_in_batch,admitted);
    assert.equal(health.payload.health_reason,admitted?'recovery_unhandled':'queue_admission_gap');
    assert.equal(health.payload.source_recovery_key,recovery.key);m.close();
  }
});

function startedWithoutRecoveryBinding(m,now,{preflight='worker-old',stageTask='T1'}={}){
  const key=m.progress.status().actions.find(a=>a.stage_id===stageTask).action_key;
  const o={thread_id:'worker',status:'idle',turn_status:'completed',turn_id:preflight,checked_at:new Date(now).toISOString(),background_job_running:false,queued_input:false,existing_driver:false,hold:false};
  assert.equal(m.progress.claim({key,observation:o}).reserved,true);
  m.progress.delivery({key,outcome:'sent',control_action_key:key,evidence_ref:'guarded-send-receipt'});
  m.progress.started({key,observation:{...o,status:'active',turn_id:'worker-new'},work_turn_id:'worker-new',work_evidence_ref:'actual-owner-source-work'});
  return key;
}

test('actual same-task continuation retires an unbound recovery without hiding its unfinished goal',()=>{
  let now=NOW;const m=new Mailbox(':memory:',{now:()=>now});pendingGoal(m,[task()]);observe(m,select(m),[poll(now)]);flush(m);
  const c=m.watchdog.status()[0];completedRound(m,NOW+1,[c.recovery_key]);now+=300000;observe(m,select(m),[poll(now)],poll(now,COORDINATOR));flush(m);
  const health=m.db.prepare("SELECT item_key FROM mail WHERE lane='maintenance'").get();assert.ok(health);
  const action=startedWithoutRecoveryBinding(m,now);now+=300000;select(m);
  const resolved=m.watchdog.status()[0];assert.equal(resolved.phase,'resolved');assert.equal(m.watchdog.canAck(c.case_key,c.recovery_key),true);
  assert.equal(m.progress.unfinishedForOwner('worker'),true);assert.equal(m.progress.status().actions[0].state,'running');
  assert.equal(JSON.parse(resolved.resolution).reconciliation.actions[0].continuation_key,action);
  assert.equal(m.db.prepare('SELECT state FROM mail WHERE item_key=?').get(c.recovery_key).state,'pending');
  assert.equal(m.reserve('maintenance',poll(now,MAINTENANCE)).reserved,false);
  assert.equal(m.db.prepare('SELECT state FROM mail WHERE item_key=?').get(health.item_key).state,'superseded');m.close();
});

test('unbound retirement rejects a wrong preflight turn, unrelated task, partial task coverage or send-only receipt',()=>{
  for(const mode of ['different-turn','different-task','partial-coverage','send-only','old-generation','ambiguous']){
    let now=NOW;const m=new Mailbox(':memory:',{now:()=>now});
    pendingGoal(m,[task(),...(mode==='different-task'||mode==='partial-coverage'?[task('T2')]:[])]);
    observe(m,select(m),[poll(now)]);const c=m.watchdog.status()[0];
    if(mode==='different-task')m.db.prepare('UPDATE watchdog_cases SET tasks=? WHERE case_key=?').run(JSON.stringify(['T1']),c.case_key);
    startedWithoutRecoveryBinding(m,now,{preflight:mode==='different-turn'?'unrelated-old':'worker-old',stageTask:mode==='different-task'?'T2':'T1'});
    if(mode==='old-generation')m.db.prepare('UPDATE watchdog_cases SET opportunity_after=? WHERE case_key=?').run(now+1,c.case_key);
    if(mode==='ambiguous'){const a=m.db.prepare("SELECT * FROM continuation_actions WHERE state='running'").get(),receipt={...JSON.parse(a.receipt),control_action_key:'duplicate'};m.db.prepare('INSERT INTO continuation_actions VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('duplicate',a.goal_id,a.stage_id,a.owner_thread_id,a.scope_key,a.payload,a.state,a.preflight_turn,a.actual_turn,JSON.stringify(receipt),a.updated_at);}
    if(mode==='send-only')m.db.prepare("UPDATE continuation_actions SET state='sent',actual_turn=NULL,receipt=? WHERE state='running'").run(JSON.stringify({outcome:'sent',evidence_ref:'transport-only'}));
    now+=300000;select(m);assert.notEqual(m.watchdog.status()[0].phase,'resolved',mode);m.close();
  }
});

test('shrinking the task set in the same idle turn reuses its unresolved covering recovery',()=>{
  let now=NOW;const m=new Mailbox(':memory:',{now:()=>now}),tasks=[task('T1'),task('T2')];
  observe(m,select(m,tasks),[poll(now)]);flush(m);const original=m.db.prepare('SELECT * FROM watchdog_cases').get();
  now+=300000;observe(m,select(m,[task('T2')]),[poll(now)]);flush(m);
  assert.equal(m.db.prepare('SELECT COUNT(*) AS n FROM watchdog_cases').get().n,1);
  assert.equal(m.db.prepare("SELECT COUNT(*) AS n FROM mail WHERE kind='recovery'").get().n,1);
  assert.equal(m.db.prepare('SELECT recovery_payload FROM watchdog_cases WHERE case_key=?').get(original.case_key).recovery_payload,original.recovery_payload);
  assert.deepEqual(JSON.parse(original.tasks),['T1','T2']);m.close();
});

test('subset coalescing preserves new tasks, new turns and explicit blocked dispositions',()=>{
  for(const mode of ['new-task','new-turn','blocked']){
    let now=NOW;const m=new Mailbox(':memory:',{now:()=>now}),initial=mode==='new-task'?[task('T1')]:[task('T1'),task('T2')];
    observe(m,select(m,initial),[poll(now)]);flush(m);const c=m.watchdog.status()[0];
    if(mode==='blocked')m.watchdog.resolve({case_key:c.case_key,recovery_key:c.recovery_key,disposition:'blocked',evidence_ref:'verified-live-job',reason:'One existing job still runs',resume_condition:'Its result is verified',next_check_at:new Date(now+3600000).toISOString()});
    now+=300000;const selected=mode==='new-task'?[task('T1'),task('T2')]:[task('T2')];
    observe(m,select(m,selected),[poll(now,'worker',mode==='new-turn'?{latestTurn:{id:'worker-next',status:'completed'}}:{})]);flush(m);
    assert.equal(m.db.prepare('SELECT COUNT(*) AS n FROM watchdog_cases').get().n,2,mode);m.close();
  }
});

test('a shrinking task set cannot generate a second escalation for the same unresolved idle gap',()=>{
  let now=NOW;const m=new Mailbox(':memory:',{now:()=>now}),tasks=[task('T1'),task('T2')];
  observe(m,select(m,tasks),[poll(now)]);flush(m);const c=m.watchdog.status()[0];completedRound(m,NOW+1,[c.recovery_key]);
  now+=300000;observe(m,select(m,tasks),[poll(now)],poll(now,COORDINATOR));flush(m);
  now+=300000;observe(m,select(m,[task('T2')]),[poll(now)],poll(now,COORDINATOR));flush(m);
  assert.equal(m.db.prepare("SELECT COUNT(*) AS n FROM mail WHERE kind='workflow_recovery'").get().n,1);
  assert.equal(m.watchdog.status().length,1);m.close();
});

test('an escalated queued disposition cannot absorb an independently actionable subset',()=>{
  let now=NOW;const m=new Mailbox(':memory:',{now:()=>now}),tasks=[task('T1'),task('T2')];pendingGoal(m,tasks);
  observe(m,select(m,tasks),[poll(now)]);flush(m);const c=m.watchdog.status()[0],action=m.progress.status().actions.find(a=>a.stage_id==='T1').action_key;
  m.watchdog.resolve({case_key:c.case_key,recovery_key:c.recovery_key,disposition:'queued',continuation_key:action,evidence_ref:'actual-pending-action'});
  completedRound(m,NOW+1,[c.recovery_key]);now+=300000;observe(m,select(m,tasks),[poll(now)],poll(now,COORDINATOR));
  assert.equal(m.watchdog.status()[0].phase,'escalated');
  now+=300000;observe(m,select(m,[{...tasks[0],hold:true},tasks[1]]),[poll(now)]);
  assert.equal(m.watchdog.status().length,2);m.close();
});
