import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,OWNER,nativeProof} from './test-fixtures/reactive.mjs';
import {OwnerHealth,classifyOwnerHealth} from './owner-health.mjs';
import {queueOwnerHealth} from './owner-delivery.mjs';
import {Mailbox} from './mailbox.mjs';
const task={mode:'active',status:'ready',contract:{}},wake={id:'wake',state:'running',turn_id:'t'};
const snap=(status,turnStatus,error=null)=>({thread:{id:OWNER,hostId:'local',status:{type:status,activeFlags:[]}},latestTurn:{id:'t',status:turnStatus,error}});
test('context exhaustion and unfinished terminal turns are distinct from actual running work',()=>{
 assert.equal(classifyOwnerHealth(task,wake,snap('idle','failed',{message:"Codex ran out of room in the model's context window"})),'context_window_exhausted');
 assert.equal(classifyOwnerHealth(task,wake,snap('idle','completed')),'unfinished_terminal_turn');
 assert.equal(classifyOwnerHealth(task,wake,snap('active','inProgress')),'running');
 assert.equal(classifyOwnerHealth(task,{...wake,state:'queued',turn_id:null},snap('notLoaded','completed')),'queued_unconsumed');
 assert.equal(classifyOwnerHealth({...task,mode:'paused'},wake,snap('idle','failed')),'protected');
});
test('fresh native observations retain unresolved queues and count distinct context failures',()=>{
 const f=fixture();try{f.activate();f.event();const w=f.begin(),h=new OwnerHealth(f.c,{now:f.now});
 const proof=(s)=>({source:'codex_app.wait_threads',checked_at:new Date(f.now()).toISOString(),evidence_ref:'actual-tool-export',readback:{polls:[s]}});
 let s=snap('idle','failed',{code:'context_length_exceeded'});s.latestTurn.id=w.turn_id;
 assert.equal(h.observe({task_id:'T-1',native_proof:proof(s)}).context_failures,1);
 assert.equal(h.observe({task_id:'T-1',native_proof:proof(s)}).context_failures,1);
 const active=snap('active','inProgress');active.latestTurn.id='next-turn';h.observe({task_id:'T-1',native_proof:proof(active)});
 s.latestTurn.id='next-turn';assert.equal(h.observe({task_id:'T-1',native_proof:proof(s)}).next_action,'checkpoint_and_replace_if_authorized');
 assert.throws(()=>h.observe({task_id:'T-1',native_proof:{...proof(s),checked_at:new Date(f.now()-61000).toISOString()}}),/Fresh/);
 const unrelated=structuredClone(s);unrelated.thread.id='other';assert.throws(()=>h.observe({task_id:'T-1',native_proof:proof(unrelated)}),/matching/);
 }finally{f.c.close();}
});
test('acknowledged health mail does not permanently hide an unconsumed wake',()=>{
 const root=mkdtempSync(join(tmpdir(),'owner-health-')),f=fixture(join(root,'control.sqlite'),root),m=new Mailbox(join(root,'mailbox.sqlite'),{now:f.now});
 try{f.activate();f.event();const w=f.begin();f.c.db.prepare("UPDATE rt_wakes SET state='queued',turn_id=NULL WHERE id=?").run(w.id);f.advance(1200000);
 const control={db:f.c.db,reactive:{tasks:()=>[...f.s.tasks(),{mode:'active',contract:{service_lane:'maintenance'}}],task:id=>f.s.task(id)}};
 const run=()=>queueOwnerHealth({control,mailbox:m,now:f.now});run();run();assert.equal(m.db.prepare('SELECT count(*) n FROM mail').get().n,1);
 m.db.prepare("UPDATE mail SET state='processed'").run();run();assert.equal(m.db.prepare('SELECT count(*) n FROM mail').get().n,1);
 f.advance(1800001);run();assert.equal(m.db.prepare('SELECT count(*) n FROM mail').get().n,2);
 f.c.db.prepare("UPDATE rt_tasks SET status='complete' WHERE task_id='T-1'").run();f.advance(7200000);run();assert.equal(m.db.prepare('SELECT count(*) n FROM mail').get().n,2);
 }finally{m.close();f.c.close();rmSync(root,{recursive:true,force:true});}
});
test('future scheduled and genuinely waiting tasks do not receive premature recovery',()=>{
 const f=fixture();try{f.activate();f.c.db.prepare("UPDATE rt_tasks SET status='waiting',wake_at=NULL WHERE task_id='T-1'").run();const h=new OwnerHealth(f.c,{now:f.now});assert.deepEqual(h.targets(),[]);f.event();assert.equal(h.targets().length,1);}finally{f.c.close();}
});


test('unconsumed queues are inspected before healthy owners in a bounded health sweep',()=>{
 const f=fixture();try{
  const tasks=[{...task,task_id:'busy',owner_id:'busy-owner',updated_at:1},{...task,task_id:'queued',owner_id:'queued-owner',updated_at:2}];
  const h=new OwnerHealth({db:f.c.db,reactive:{waitPolicy:{blocked:()=>null},tasks:()=>tasks,openWake:id=>({id,created_at:id==='busy'?1:2,state:id==='busy'?'running':'queued'})},work:f.c.work},{now:f.now});
  assert.equal(h.targets({limit:1})[0].task_id,'queued');
 }finally{f.c.close();}
});

test('actual followup and trigger execution never claim consumption of an original native queue',()=>{
 for(const transport of ['native_queue','native_followup','native_trigger']){
  const f=fixture();try{f.activate();f.event();const wake=f.begin();f.c.db.prepare('UPDATE rt_wakes SET transport=? WHERE id=?').run(transport,wake.id);
   const h=new OwnerHealth(f.c,{now:f.now}),result=h.observe({task_id:'T-1',native_proof:nativeProof({now:f.now()})});
   assert.equal(result.state,'running');assert.equal(result.execution_started,true);assert.equal(result.queue_consumed,transport==='native_queue');
  }finally{f.c.close();}
 }
});
