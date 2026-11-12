import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,cpSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fixture,OWNER,NOW} from './test-fixtures/reactive.mjs';
import {Mailbox} from './mailbox.mjs';
import {NativeServices} from './native-services.mjs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';

function setup(lane='coordinator') {
 const root=mkdtempSync(join(tmpdir(),'native-service-')),f=fixture(join(root,'control.sqlite'),root);
 const contract={...f.s.task('T-1').contract,service_lane:lane,schedule_sources:[`service:${lane}`]};
 f.c.db.prepare('UPDATE rt_tasks SET contract=? WHERE task_id=?').run(JSON.stringify(contract),'T-1');
 if(lane==='maintenance'){mkdirSync(join(root,'daily-review'));writeFileSync(join(root,'daily-review/config.json'),JSON.stringify({enabled:true,interval_minutes:120,first_due_at:new Date(NOW).toISOString(),timezone:'Asia/Shanghai',authorization_ref:'human-maintenance'}));}
 const m=new Mailbox(join(root,'mailbox.sqlite'),{now:f.now});
 const service=new NativeServices({root,control:f.c,config:{service_tasks:{[lane]:'T-1'}},now:f.now});
 const enqueue=key=>m.enqueue({key,lane,kind:lane==='coordinator'?'configuration':'workflow_recovery',payload:{text:'Scope-bound service work'}});
 return {...f,root,m,service,enqueue,close(){m.close();f.c.close();rmSync(root,{recursive:true,force:true});}};
}
test('ordinary service execution uses one actual owner wake and an immutable input batch',()=>{
 const f=setup();try{
  f.enqueue('input');f.activate();f.service.bridge();f.service.bridge();
  const b=f.m.db.prepare('SELECT * FROM batches').get(),snapshot=b.snapshot;
  assert.equal(JSON.parse(snapshot).delivery_transport,'native_task');
  assert.equal(f.m.db.prepare('SELECT count(*) n FROM batches').get().n,1);
  assert.equal(f.m.authorizeQueueSend(b.id).send,false);
  assert.throws(()=>f.m.begin(b.id),/service_begin/);
  assert.throws(()=>f.service.begin({task_id:'T-1',owner_thread_id:OWNER,wake_id:'invented',batch_id:b.id}),/actual native/i);
  const w=f.begin();
  f.c.db.prepare('UPDATE rt_wakes SET queue_id=NULL WHERE id=?').run(w.id); // Actual consumption may precede the CLI receipt.
  assert.throws(()=>f.service.begin({task_id:'T-1',owner_thread_id:'other',wake_id:w.id,batch_id:b.id}),/owner/);
  assert.equal(f.service.begin({task_id:'T-1',owner_thread_id:OWNER,wake_id:w.id,batch_id:b.id}).begun,true);
  assert.equal(f.m.get(b.id).snapshot.service_task_id,'T-1');assert.equal(JSON.stringify(f.m.get(b.id).snapshot),JSON.stringify(JSON.parse(snapshot)));
  assert.throws(()=>f.service.assertFinished('T-1',w.id),/Finish the actual service batch/);
  f.m.finish(b.id,{processed_keys:['input']});f.service.assertFinished('T-1',w.id);
  f.decide({wake_id:w.id,disposition:'cycle_complete',plan:undefined,acceptance:f.s.task('T-1').contract.requirements.map(r=>({requirement_id:r.id,passed:true,evidence_ref:'service-result'}))});
  f.s.finish({task_id:'T-1',wake_id:w.id,turn_id:'native-turn',evidence_ref:'cycle'});
  f.service.bridge();assert.equal(f.m.db.prepare('SELECT count(*) n FROM batches').get().n,1);
 }finally{f.close();}
});
test('paused service and two-hour maintenance cadence prevent new execution batches',()=>{
 const f=setup('maintenance');try{
  f.service.bridge();assert.equal(f.m.db.prepare('SELECT count(*) n FROM batches').get().n,0);
  f.activate();f.service.bridge();const b=f.m.db.prepare('SELECT id FROM batches').get();const w=f.begin();
  f.service.begin({task_id:'T-1',owner_thread_id:OWNER,wake_id:w.id,batch_id:b.id});
  const keys=f.m.get(b.id).snapshot.items.map(i=>i.key);f.m.finish(b.id,{processed_keys:keys});
  f.decide({wake_id:w.id,disposition:'cycle_complete',plan:undefined,acceptance:f.s.task('T-1').contract.requirements.map(r=>({requirement_id:r.id,passed:true,evidence_ref:'review-result'}))});f.s.finish({task_id:'T-1',wake_id:w.id,turn_id:'native-turn',evidence_ref:'cycle'});
  f.enqueue('new-diagnostic');f.advance(7199999);f.service.bridge();assert.equal(f.m.db.prepare('SELECT count(*) n FROM batches').get().n,1);
  f.advance(2);f.service.bridge();assert.equal(f.m.db.prepare('SELECT count(*) n FROM batches').get().n,2);
 }finally{f.close();}
});

test('registering an ordinary service does not manufacture an initial work cycle',()=>{
 const f=setup();try{
  const contract={...f.s.task('T-1').contract,canonical_key:'second-service',service_lane:'maintenance'};
  f.s.adopt({task_id:'T-service',owner_thread_id:'33333333-3333-4333-8333-333333333333',contract,source_message_id:'human-service',actual_human_verified:true});
  assert.equal(f.s.task('T-service').status,'waiting');assert.equal(f.s.task('T-service').wake_at,null);
 }finally{f.close();}
});

test('standing service inputs coalesce while unfinished and do not admit while paused',()=>{
 const f=setup();try{
  f.service.config.service_inputs=[{id:'calendar',lane:'coordinator',interval_ms:3600000,authorization_ref:'actual-calendar-prep',payload:{event:'calendar-upkeep'}}];
  f.service.bridge();assert.equal(f.m.db.prepare('SELECT count(*) n FROM mail').get().n,0);
  f.activate();f.service.bridge();f.advance(3600001);f.service.bridge();
  assert.equal(f.m.db.prepare("SELECT count(*) n FROM mail WHERE json_extract(payload,'$.service_input_id')='calendar'").get().n,1);
 }finally{f.close();}
});


test('the public runtime CLI claims an ordinary service batch after actual begin',()=>{
 const f=setup();try{
  f.enqueue('cli-input');f.activate();f.service.bridge();const b=f.m.db.prepare('SELECT id FROM batches').get(),w=f.begin();
  cpSync(dirname(fileURLToPath(import.meta.url)),join(f.root,'runtime'),{recursive:true});
  for(const folder of ['t3','guards'])cpSync(join(dirname(fileURLToPath(import.meta.url)),'..',folder),join(f.root,folder),{recursive:true});
  writeFileSync(join(f.root,'instance.json'),JSON.stringify({layout:'native',instance_id:'fixture',scope:{project_id:'project',project_root:f.root},threads:{main:'main'},legacy_roles:{coordinator:'coordinator',maintenance:'maintenance'}}));
  writeFileSync(join(f.root,'runtime.json'),JSON.stringify({schema_version:2,transport:'native_queue',service_tasks:{coordinator:'T-1'}}));
  writeFileSync(join(f.root,'input.json'),JSON.stringify({op:'service_begin',task_id:'T-1',owner_thread_id:OWNER,wake_id:w.id,batch_id:b.id}));
  const output=execFileSync(process.execPath,['--input-type=module','-e',"import {runtimeMain} from './runtime/reactive-cli.mjs';await runtimeMain(['op','--file','input.json'],{root:process.cwd()});"],{cwd:f.root,encoding:'utf8'});
  assert.equal(JSON.parse(output).begun,true);assert.equal(f.m.get(b.id).state,'running');
 }finally{f.close();}
});
test('an unclaimed service batch can be retried after an ended wake with new evidence',()=>{
 const f=setup();try{
  f.enqueue('input');f.activate();f.service.bridge();const b=f.m.db.prepare('SELECT id FROM batches').get(),w=f.begin();
  f.decide({wake_id:w.id,disposition:'needs_decision',plan:undefined});f.s.finish({task_id:'T-1',wake_id:w.id,turn_id:'native-turn',evidence_ref:'actual-interface-error'});
  f.event('interface-fixed',{capability:'service_begin',available:true});f.service.bridge();const retry=f.begin();
  assert.notEqual(retry.id,w.id);assert.equal(f.service.begin({task_id:'T-1',owner_thread_id:OWNER,wake_id:retry.id,batch_id:b.id}).begun,true);
  assert.equal(f.m.db.prepare('SELECT count(*) n FROM batches').get().n,1);
 }finally{f.close();}
});

test('service observations cannot bypass fixed-batch admission or maintenance cadence',()=>{
 const f=setup('maintenance');try{
  f.activate();const before=f.s.task('T-1');
  f.event('unrelated-pr',{head:'new-head'});
  assert.equal(f.s.task('T-1').status,'waiting');assert.equal(f.s.task('T-1').wake_at,null);
  assert.equal(f.s.reserveQueuedWake('T-1').reserved,false);
  assert.equal(f.s.task('T-1').context_rev,before.context_rev+1);
 }finally{f.close();}
});
