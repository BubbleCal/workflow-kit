import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,nativeProof,OWNER,QUEUE_ID} from './test-fixtures/reactive.mjs';
import {MessageTrigger} from './message-trigger.mjs';
import {triggerMessage,verifyTriggerExecution,settleTriggerDiscovery} from './trigger-proof.mjs';
import {ReactiveDriver} from './reactive-driver.mjs';
import {workFixture,DISCOVERY} from './test-fixtures/work.mjs';
import {Mailbox} from './mailbox.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const TRIGGER='44444444-4444-4444-8444-444444444444';
const config=()=>({message_trigger:{enabled:true,thread_id:TRIGGER,workspace:'/trigger',interval_ms:60000,authorization_ref:'real-human-authority',source_message_id:'human:trigger'}});
function setup(){const f=fixture();f.activate();f.event();const cfg=config(),q=new MessageTrigger(f.c,cfg);const actor=()=>nativeProof({thread:TRIGGER,workspace:'/trigger',turn:'trigger-run-'+Math.floor(f.now()/60000),now:f.now()});const owner=(patch={})=>nativeProof({turn:'previous-owner-turn',status:'completed',now:f.now(),...patch});
 const register=()=>{const w=f.s.openWake('T-1')??f.s.reserveQueuedWake('T-1').wake;q.registerTask(f.s.task('T-1'),w,'Exact runtime-authored message > literal &gt;');return w.id;};
 const claim=id=>{q.run({native_proof:actor()});const p=q.prepare({id,actor_proof:actor(),native_proof:owner()});assert(p.prepared);f.advance(1);return q.claim({id,digest:p.digest,actor_proof:actor(),native_proof:owner()});};
 return{...f,q,cfg,actor,owner,register,claim};}
function relay(f,id,{sender=TRIGGER,text,turn='actual-owner-turn',status='inProgress'}={}){const r=triggerMessage(f.c.db,id),p=nativeProof({thread:r.owner_id,workspace:r.workspace,turn,now:f.now(),status});p.readback.turns[0].items=[{type:'functionCallOutput',namespace:'codex_app',name:'send_message_to_thread',output:{truncated:false,text:`<codex_delegation>\n  <source_thread_id>${sender}</source_thread_id>\n  <input>${text??r.prompt}</input>\n</codex_delegation>`}}];return p;}

test('runtime registers once; trigger sends immutable input once, original owner begins and completes, then a new cycle can send',()=>{
 const f=setup();try{const id=f.register();assert.equal(f.register(),id);assert.equal(f.q.pending().messages.length,1);assert.equal(f.s.openWake('T-1').queue_id,null);
 const claim=f.claim(id);assert(claim.send);assert.deepEqual(claim.arguments,{threadId:OWNER,hostId:'local',prompt:'Exact runtime-authored message > literal &gt;'});
 assert.equal(f.q.claim({id,digest:claim.digest,actor_proof:f.actor(),native_proof:f.owner()}).send,false);
 const r=f.q.settle({id,attempt_id:claim.attempt_id,actor_proof:f.actor(),native_result:{structuredContent:{threadId:OWNER}},evidence_ref:'real-send-result'});assert.equal(r.state,'sent');assert.equal(r.execution_verified,false);assert.equal(f.s.openWake('T-1').started_at,null);
 const proof=relay(f,id);f.s.begin({task_id:'T-1',wake_id:id,native_proof:proof});assert.equal(f.s.openWake('T-1').state,'running');assert.equal(f.s.openWake('T-1').turn_id,'actual-owner-turn');
 f.decide({wake_id:id,disposition:'wait',plan:undefined,next_action_at:new Date(f.now()+1000).toISOString()});f.s.finish({task_id:'T-1',wake_id:id,turn_id:'actual-owner-turn',evidence_ref:'real-result'});assert.equal(triggerMessage(f.c.db,id).state,'finished');
 f.advance(60001);f.s.expireWaits();f.event('actual-new-feedback',{review:'changed'});const next=f.register();assert.notEqual(next,id);assert(f.claim(next).send);assert.equal(f.c.db.prepare('SELECT count(*) n FROM rt_trigger_messages').get().n,2);
 }finally{f.c.close();}
});

test('busy, input/failed, paused, future action time, stale/changed target, wrong actor and digest never grant send',()=>{
 for(const change of ['busy','failed','input','paused','wait','stale','changed','actor','digest','scope','processing']){const f=setup();try{const id=f.register();f.q.run({native_proof:f.actor()});const p=f.q.prepare({id,actor_proof:f.actor(),native_proof:f.owner()});f.advance(1);let native=f.owner(),actor=f.actor(),digest=p.digest;
  if(change==='busy')native=f.owner({status:'inProgress'});if(change==='failed')native=f.owner({status:'failed'});if(change==='input')native.readback.thread.status.activeFlags=['waitingOnApproval'];
  if(change==='paused')f.mode('paused');if(change==='wait')f.c.db.prepare("INSERT INTO rt_owner_wait_windows VALUES (?,?,?,?,?,?,?,?)").run(OWNER,'T-1',id,f.now()+60000,'waiting','known deadline','{}',f.now());
  if(change==='stale'){f.advance(61000);actor=f.actor();}if(change==='changed')native=f.owner({turn:'different-turn'});if(change==='actor')actor=f.owner();if(change==='digest')digest='invented';
  if(change==='scope')f.c.taskRegistry=()=>({scope_restrictions:{'T-1:held':{task_id:'T-1',source_message_id:'human:hold',evidence_ref:'actual-hold',verbatim_text:'Hold the original scope',status:'excluded',targets:{scope_keys:['held']}}}});
  if(change==='processing')f.c.db.prepare("UPDATE settings SET value='off' WHERE key='processing'").run();
  let result;try{result=f.q.claim({id,digest,native_proof:native,actor_proof:actor});}catch{result={send:false};}assert.equal(result.send,false,change);assert.equal(triggerMessage(f.c.db,id).state,'pending');
 }finally{f.c.close();}}
});

test('uncertain native outcomes and process loss preserve one claimed attempt with no retry or queue fallback',async()=>{
 const f=setup();try{const id=f.register(),claim=f.claim(id);assert.equal(f.q.pending().messages.length,0);assert.equal(f.q.pending().unresolved.length,1);
 const q=new MessageTrigger(f.c,f.cfg);assert.equal(q.claim({id,digest:claim.digest,actor_proof:f.actor(),native_proof:f.owner()}).send,false);
 q.settle({id,attempt_id:claim.attempt_id,actor_proof:f.actor(),native_result:{isError:true,content:[{type:'text',text:'timeout outcome unknown'}]},evidence_ref:'original-error'});assert.equal(triggerMessage(f.c.db,id).state,'uncertain');assert.equal(q.pending().messages.length,0);
 let sends=0;const driver=new ReactiveDriver({root:'/missing',control:f.c,queue:{enqueue(){sends++;}},config:{},capability:{verified:true},now:f.now,log:()=>{}});await driver.deliver(f.s.task('T-1'));assert.equal(sends,0);await driver.close();
 }finally{f.c.close();}
});

test('new context supersedes only an unsent registration and preserves its unhandled events',()=>{
 const f=setup();try{const id=f.register();f.event('new-fact',{review:'actually changed'});assert.equal(triggerMessage(f.c.db,id).prompt,'Exact runtime-authored message > literal &gt;');assert.equal(f.s.openWake('T-1'),null);assert(f.s.checkpoint('T-1').events.length>=2);assert.notEqual(f.register(),id);assert.equal(triggerMessage(f.c.db,id).state,'cancelled');
 }finally{f.c.close();}
});

test('accepted legacy queue receipt is never converted or resent by the new trigger',()=>{
 const f=setup();try{const w=f.s.reserveQueuedWake('T-1').wake;f.c.db.prepare("UPDATE rt_wakes SET state='queued',queue_id=? WHERE id=?").run(QUEUE_ID,w.id);
 assert.equal(f.q.registerTask(f.s.task('T-1'),f.s.openWake('T-1'),'replacement').registered,false);assert.equal(f.s.openWake('T-1').queue_id,QUEUE_ID);assert.equal(f.q.pending().messages.length,0);
 }finally{f.c.close();}
});

test('native receipt alone, wrong sender, rewritten/truncated content or same-turn steering cannot prove execution',()=>{
 const f=setup();try{const id=f.register();f.claim(id);const expected={thread_id:OWNER,workspace:'/task',now:f.now()};
 for(const proof of [f.owner({status:'inProgress'}),relay(f,id,{sender:OWNER}),relay(f,id,{text:'rewritten'}),relay(f,id,{turn:'previous-owner-turn'})])assert.throws(()=>verifyTriggerExecution(f.c.db,id,proof,expected));
 const truncated=relay(f,id);truncated.readback.turns[0].items[0].output.truncated=true;assert.throws(()=>verifyTriggerExecution(f.c.db,id,truncated,expected));
 const escaped=relay(f,id,{text:'Exact runtime-authored message &gt; literal &amp;gt;'});assert.equal(verifyTriggerExecution(f.c.db,id,escaped,expected).turn_id,'actual-owner-turn');
 }finally{f.c.close();}
});

test('driver registers ordinary work durably without making any native queue submission',async()=>{
 const f=setup();let driver;try{let sends=0;driver=new ReactiveDriver({root:'/missing',control:f.c,queue:{enqueue(){sends++;}},config:f.cfg,capability:null,now:f.now,log:()=>{}});await driver.deliver(f.s.task('T-1'));await driver.deliver(f.s.task('T-1'));assert.equal(sends,0);assert.equal(f.q.pending().messages.length,1);assert.match(triggerMessage(f.c.db,f.s.openWake('T-1').id).prompt,/includeOutputs=true/);
 }finally{await driver?.close();f.c.close();}
});

test('discovery uses the same immutable source batch and original creation actor guards through direct trigger delivery',async()=>{
 const f=workFixture(),dir=mkdtempSync(join(tmpdir(),'trigger-discovery-'));let mailbox,driver;try{
 f.config.instance_root=dir;f.work.setPolicy({key:'discovery_owns_creation',enabled:true,allowed_kinds:['work'],source_message_id:'human:creation',verbatim_text:'Discovery creates accepted tasks',actual_human_verified:true,evidence_ref:'original-creation-authority'});
 const t=f.work.create({canonical_key:'accepted-real-work',title:'Accepted work',objective:'Implement scoped work',requirements:[{id:'done',text:'Verify result'}]}).task;f.accept(t.id);
 const cfg={...config()},q=new MessageTrigger(f.c,cfg);let queued=0;
 driver=new ReactiveDriver({root:dir,control:f.c,queue:{enqueue(){queued++;assert.fail('Direct discovery must not use native queue');}},config:cfg,capability:{verified:true},now:f.now,log:()=>{}});
 await driver.discoveryTick();const pending=q.pending().messages;assert.equal(pending.length,1,JSON.stringify(f.c.db.prepare("SELECT key,data FROM rt_diagnostics WHERE key='discovery'").all()));const id=pending[0].id,r=triggerMessage(f.c.db,id),b=f.c.discovery.batch(r.data.batch_id);assert.equal(r.prompt,b.prompt);
 const actor=()=>nativeProof({thread:TRIGGER,workspace:'/trigger',turn:'trigger-run-'+Math.floor(f.now()/60000),now:f.now()}),owner=()=>nativeProof({thread:DISCOVERY,status:'completed',turn:'previous-discovery',now:f.now()});
 q.run({native_proof:actor()});const p=q.prepare({id,actor_proof:actor(),native_proof:owner()});f.advance(1);const claim=q.claim({id,digest:p.digest,actor_proof:actor(),native_proof:owner()});assert(claim.send);
 const proof=relay(f,id,{turn:'actual-discovery-turn'});const result=f.c.discovery.begin({batch_id:b.id,generation:b.generation,native_proof:proof});assert.equal(result.state,'running');
 const task=f.work.get(t.id),actorInput={role:'discovery',thread_id:DISCOVERY,batch_id:b.id,generation:b.generation,native_proof:proof};assert.equal(f.work.creation.actor(task.id,actorInput).turn_id,'actual-discovery-turn');
 const wrong=structuredClone(proof);wrong.readback.turns[0].items[0].output.text=wrong.readback.turns[0].items[0].output.text.replace(TRIGGER,OWNER);assert.throws(()=>f.work.creation.actor(task.id,{...actorInput,native_proof:wrong}));
 q.settle({id,attempt_id:claim.attempt_id,actor_proof:actor(),native_result:{structuredContent:{threadId:DISCOVERY}},evidence_ref:'original-send-receipt'});
 f.c.discovery.finish({batch_id:b.id,generation:b.generation,source_results:[],owner_creation_reason:'Original accepted owner setup intentionally retained by the integration fixture'});
 mailbox=new Mailbox(join(dir,'mailbox.sqlite'),{now:f.now});assert.equal(settleTriggerDiscovery(f.c.db,mailbox,b,DISCOVERY,f.now()).transport,'native_trigger');assert.equal(mailbox.db.prepare('SELECT state FROM mail WHERE item_key=?').get(id).state,'acknowledged');
 f.c.discovery.reconcileMailbox(mailbox);assert.equal(queued,0);assert.equal(f.work.get(t.id).owner_thread_id,null);
 }finally{mailbox?.close();await driver?.close();f.c.close();rmSync(dir,{recursive:true,force:true});}
});

test('a busy first owner cannot starve later owners across bounded trigger invocations',()=>{
 const f=setup();try{const first=f.register();const original=f.s.task('T-1').contract;
 for(let n=2;n<=5;n++){const owner=`${n}1111111-1111-4111-8111-111111111111`,id=`T-${n}`;f.s.adopt({task_id:id,owner_thread_id:owner,contract:{...original,canonical_key:'work-'+n},source_message_id:'human:distinct-work',actual_human_verified:true});f.s.setMode({task_id:id,mode:'active',source_message_id:'human:start',actual_human_verified:true,native_binding:nativeProof({thread:owner,status:'completed',now:f.now()}),queue_compatibility_verified:true,legacy_quiescent:true});f.s.ingest({event_id:'event-'+n,task_id:id,source:'actual',subject:'work-'+n,type:'change',observed_at:f.now(),payload:{changed:true},evidence_ref:'actual-source',debounce_ms:0});const w=f.s.reserveQueuedWake(id).wake;f.q.registerTask(f.s.task(id),w,'Exact work '+n);}
 const seen=[];for(let n=0;n<5;n++){seen.push(f.q.pending({limit:1}).messages[0].id);f.advance(60000);}assert.equal(new Set(seen).size,5);assert.equal(seen[0],first);assert.equal(triggerMessage(f.c.db,first).state,'pending');
 }finally{f.c.close();}
});


test('the trigger cannot send beyond its bounded run even with fresh owner proofs',()=>{
 const f=setup();try{const id=f.register();f.q.run({native_proof:f.actor()});f.advance(50001);const p=f.q.prepare({id,actor_proof:f.actor(),native_proof:f.owner()});f.advance(1);assert.equal(f.q.claim({id,digest:p.digest,actor_proof:f.actor(),native_proof:f.owner()}).reason,'trigger_run_budget');assert.equal(triggerMessage(f.c.db,id).state,'pending');}finally{f.c.close();}
});

test('autonomous trigger observation binds real ordinary work before sender ACK and never reopens a finished cycle',()=>{
 const f=setup();try{
  f.c.work.setPolicy({key:'owner_autonomy',enabled:true,allowed_kinds:['work'],source_message_id:'human:autonomy',verbatim_text:'Let runtime handle execution bookkeeping',evidence_ref:'actual-human',actual_human_verified:true});
  const id=f.register(),claim=f.claim(id),proof=relay(f,id);
  const observed=f.q.observe({id,native_proof:proof,actor_proof:f.actor()});assert.equal(observed.execution_bound,true);assert.equal(observed.owner_begin_required,false);
  assert.equal(f.s.openWake('T-1').turn_id,'actual-owner-turn');assert.equal(f.s.openWake('T-1').state,'running');
  f.q.settle({id,attempt_id:claim.attempt_id,actor_proof:f.actor(),native_result:{structuredContent:{threadId:OWNER}},evidence_ref:'actual-send-ack'});
  assert.equal(f.s.openWake('T-1').state,'running');
  f.decide({wake_id:id,disposition:'wait',plan:undefined,next_action_at:new Date(f.now()+1000).toISOString()});f.s.finish({task_id:'T-1',wake_id:id,turn_id:'actual-owner-turn',evidence_ref:'actual-checkpoint'});
  const terminal=relay(f,id,{status:'completed'});f.q.observe({id,native_proof:terminal,actor_proof:f.actor()});
  assert.equal(triggerMessage(f.c.db,id).state,'finished');assert.equal(f.s.openWake('T-1'),null);
 }finally{f.c.close();}
});

test('autonomous observation never binds a paused task or interprets a terminal no-op as ongoing engineering',()=>{
 for(const stopped of ['paused','terminal']){const f=setup();try{
  f.c.work.setPolicy({key:'owner_autonomy',enabled:true,allowed_kinds:['work'],source_message_id:'human:autonomy',verbatim_text:'Automatic execution bookkeeping',evidence_ref:'actual-human',actual_human_verified:true});
  const id=f.register();f.claim(id);if(stopped==='paused')f.mode('paused');
  const proof=relay(f,id,{status:stopped==='terminal'?'completed':'inProgress'}),observed=f.q.observe({id,native_proof:proof,actor_proof:f.actor()});
  assert.equal(observed.execution_observed,true);assert.notEqual(f.s.openWake('T-1')?.state,'running');assert.notEqual(observed.execution_bound,true);
 }finally{f.c.close();}}
});
