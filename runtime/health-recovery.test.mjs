import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mailbox, COORDINATOR, MAINTENANCE } from './mailbox.mjs';

const NOW=Date.parse('2026-11-02T22:00:00Z');
const idle=(now,id)=>({checked_at:new Date(now).toISOString(),thread:{id,status:{type:'idle'}},latestTurn:{id:id+'-old',status:'completed'}});
function escalate(m,advance) {
  const registry={task_registry:{items:{T1:{id:'T1',owner_thread_id:'worker',status:'engineering_active',authorization_message_id:'human'}}}};
  const first=m.atomic(()=>m.watchdog.select(registry));
  m.atomic(()=>m.watchdog.observe({round_id:first.round_id,snapshots:[idle(NOW,'worker')]}));
  for(const item of m.watchdog.outbox())m.enqueue(item);
  m.db.prepare("INSERT INTO batches(id,lane,state,item_ids,signal_generation,intake_due,snapshot,created_at,finished_at) VALUES ('eligible','coordinator','finished','[]',0,0,'{}',?,?)").run(NOW+1,NOW+2);
  const now=advance();const next=m.atomic(()=>m.watchdog.select(registry));
  m.atomic(()=>m.watchdog.observe({round_id:next.round_id,snapshots:[idle(now,'worker')],coordinator_snapshot:idle(now,COORDINATOR)}));
  const health=m.watchdog.outbox().find(x=>x.lane==='maintenance');assert.ok(health);m.enqueue(health);return health;
}
function resolve(m,health,disposition='complete',now=NOW+300000) {
  const c=m.watchdog.status().find(x=>x.case_key===health.payload.watchdog_case);
  return m.atomic(()=>m.watchdog.resolve({case_key:c.case_key,recovery_key:c.recovery_key,disposition,evidence_ref:'actual-acceptance',
    ...(disposition==='blocked'?{reason:'provider still deleting',resume_condition:'verified provider completion',next_check_at:new Date(now+3600000).toISOString()}:{} )}));
}

test('resolved queued health is retired without a maintenance wake and its receipt survives restart',()=>{
  const root=mkdtempSync(join(tmpdir(),'health-retirement-')),path=join(root,'mail.sqlite');let now=NOW,m=new Mailbox(path,{now:()=>now});
  try {
    const health=escalate(m,()=>now+=300000),payload=JSON.stringify(health.payload);resolve(m,health);
    assert.equal(m.reserve('maintenance',idle(now,MAINTENANCE)).reserved,false);
    const row=m.db.prepare('SELECT state,payload FROM mail WHERE item_key=?').get(health.key);assert.equal(row.state,'superseded');assert.deepEqual(JSON.parse(row.payload),JSON.parse(payload));
    m.close();m=new Mailbox(path,{now:()=>now});
    assert.equal(m.status().superseded_health[0].item_key,health.key);assert.equal(m.enqueue(health).state,'superseded');
    m.enqueue({key:'new-manual',lane:'maintenance',kind:'daily_review',payload:{manual_request:true}});
    assert.equal(m.reserve('maintenance',idle(now,MAINTENANCE)).batch.snapshot.items[0].key,'new-manual');
  }finally{m.close();rmSync(root,{recursive:true,force:true});}
});

test('health resolved after reservation is stopped at final authorization without rewriting the snapshot',()=>{
  let now=NOW;const m=new Mailbox(':memory:',{now:()=>now});const health=escalate(m,()=>now+=300000);
  const b=m.reserve('maintenance',idle(now,MAINTENANCE)).batch;m.setPrompt(b.id,'immutable-health');resolve(m,health,'blocked',now);
  assert.equal(m.authorizeSend(b.id,idle(now,MAINTENANCE)).send,false);
  assert.equal(m.get(b.id).state,'superseded');assert.deepEqual(m.get(b.id).snapshot,b.snapshot);
  assert.equal(m.status().active_batches.length,0);assert.equal(m.releaseReservation(b.id).released,false);m.close();
});

test('unresolved, unknown and already sending health are preserved',()=>{
  let now=NOW;const m=new Mailbox(':memory:',{now:()=>now});const health=escalate(m,()=>now+=300000);
  const b=m.reserve('maintenance',idle(now,MAINTENANCE)).batch;m.setPrompt(b.id,'real-health');assert.equal(m.authorizeSend(b.id,idle(now,MAINTENANCE)).send,true);
  resolve(m,health);assert.equal(m.authorizeSend(b.id,idle(now,MAINTENANCE)).reason,'sending');
  assert.equal(m.get(b.id).state,'sending');assert.equal(m.db.prepare('SELECT state FROM mail WHERE item_key=?').get(health.key).state,'in_batch');
  m.delivery(b.id,{outcome:'sent',receipt:{tool_ack:true}});m.begin(b.id);m.finish(b.id,{processed_keys:[health.key]});
  m.enqueue({key:'unknown-health',lane:'maintenance',kind:'workflow_recovery',payload:{watchdog_case:'not-recorded'}});
  assert.equal(m.reserve('maintenance',idle(now,MAINTENANCE)).batch.snapshot.items[0].key,'unknown-health');m.close();
});

test('legacy health keys deduplicate and their retirement does not hide a later missed generation',()=>{
  let now=NOW;const m=new Mailbox(':memory:',{now:()=>now});const old=escalate(m,()=>now+=300000);
  const legacyKey=old.payload.watchdog_case+':health';
  m.db.prepare('UPDATE mail SET item_key=? WHERE item_key=?').run(legacyKey,old.key);old.key=legacyKey;
  assert.equal(m.watchdog.outbox().filter(x=>x.lane==='maintenance').length,0);
  resolve(m,old,'blocked',now);m.reserve('maintenance',idle(now,MAINTENANCE));
  const registry={task_registry:{items:{T1:{id:'T1',owner_thread_id:'worker',status:'engineering_active',authorization_message_id:'human'}}}};
  now+=3600000;let round=m.atomic(()=>m.watchdog.select(registry));m.atomic(()=>m.watchdog.observe({round_id:round.round_id,snapshots:[idle(now,'worker')]}));
  for(const item of m.watchdog.outbox())m.enqueue(item);
  m.db.prepare("INSERT INTO batches(id,lane,state,item_ids,signal_generation,intake_due,snapshot,created_at,finished_at) VALUES ('later-opportunity','coordinator','finished','[]',0,0,'{}',?,?)").run(now+1,now+2);
  now+=300000;round=m.atomic(()=>m.watchdog.select(registry));m.atomic(()=>m.watchdog.observe({round_id:round.round_id,snapshots:[idle(now,'worker')],coordinator_snapshot:idle(now,COORDINATOR)}));
  const next=m.watchdog.outbox().find(x=>x.lane==='maintenance');assert.ok(next);assert.notEqual(next.key,old.key);m.enqueue(next);
  assert.equal(m.watchdog.outbox().filter(x=>x.lane==='maintenance').length,0);m.close();
});
