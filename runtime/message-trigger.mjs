import {scopeActionReasons} from './scope-exclusions.mjs';
import {ownerAutonomyPolicy} from './owner-continuation.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {nativeReadback,verifyNativeBinding} from './native-queue.mjs';
import {triggerMessage,verifyTriggerExecution} from './trigger-proof.mjs';
import {TriggerFallback} from './trigger-fallback.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
const parse=r=>({...r,data:JSON.parse(r.data)});
export function validateMessageTrigger(p){
 if(!p?.enabled)return;
 if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(p.thread_id??'')||!p.workspace||!p.authorization_ref||!p.source_message_id||!Number.isInteger(p.interval_ms)||p.interval_ms<60000||p.interval_ms>900000)
  throw Error('Verified dedicated message trigger, human authority and bounded interval required');
}
// The runtime authors immutable messages; the native trigger only transmits them.
export class MessageTrigger {
 constructor(control,config){
  this.c=control;this.db=control.db;this.s=control.reactive;this.now=control.now;this.config=config;validateMessageTrigger(config.message_trigger);
  this.db.exec(`CREATE TABLE IF NOT EXISTS rt_trigger_messages (
   id TEXT PRIMARY KEY,kind TEXT NOT NULL,task_id TEXT,owner_id TEXT NOT NULL,sender_id TEXT NOT NULL,
   workspace TEXT NOT NULL,prompt TEXT NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL,state TEXT NOT NULL,
   attempt_id TEXT,preflight_turn TEXT,preflight_at INTEGER,claimed_at INTEGER,receipt TEXT,execution_turn TEXT,
   created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,last_offered_at INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS rt_trigger_runs (turn_id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,source_thread_id TEXT NOT NULL);`);
  if(!this.db.prepare('PRAGMA table_info(rt_trigger_messages)').all().some(c=>c.name==='last_offered_at'))this.db.exec('ALTER TABLE rt_trigger_messages ADD COLUMN last_offered_at INTEGER NOT NULL DEFAULT 0');
  this.fallback=new TriggerFallback(control,config);
 }
 get policy(){return this.config.message_trigger;}
 actor(proof){
  if(!this.policy?.enabled)throw Error('Message trigger disabled');
  verifyNativeBinding(proof,{thread_id:this.policy.thread_id,workspace:this.policy.workspace,now:this.now()});
  const r=nativeReadback(proof.readback),t=r.turns?.[0];
  if(r.thread.status.type!=='active'||t?.status!=='inProgress'||t.error)throw Error('Actual running dedicated trigger required');
  return t.id;
 }
 run({native_proof}){
  return this.c.atomic(()=>{const turn=this.actor(native_proof),old=this.db.prepare('SELECT * FROM rt_trigger_runs WHERE turn_id=?').get(turn);
   if(old)return{allowed:true,turn_id:turn,replayed:true};
   const last=this.db.prepare('SELECT MAX(started_at) at FROM rt_trigger_runs').get().at;
   if(last!==null&&this.now()-last<this.policy.interval_ms)return{allowed:false,reason:'trigger_interval',next_at:last+this.policy.interval_ms};
   this.db.prepare('INSERT INTO rt_trigger_runs VALUES (?,?,?)').run(turn,this.now(),this.policy.thread_id);return{allowed:true,turn_id:turn};});
 }
 reasons(r){
  if(!this.policy?.enabled||r.sender_id!==this.policy.thread_id)return['trigger_binding_changed'];
  if(this.db.prepare("SELECT value FROM settings WHERE key='processing'").get()?.value!=='on')return['processing_paused'];
  const recoveryReasons=this.fallback.reasons(r);if(recoveryReasons.length)return recoveryReasons;
  if(r.owner_id===this.policy.thread_id||r.owner_id===this.config.inbox?.thread_id&&this.config.inbox?.delivery_mode==='on_request')return['human_only_or_self_target'];
  if(r.kind==='discovery'){
   const b=this.c.discovery.batch(r.data.batch_id);
   if(!b||b.state!=='pending'||b.generation!==r.data.generation||b.prompt!==r.prompt||this.c.discovery.config.threads.discovery!==r.owner_id)return['discovery_generation_changed'];
   try{this.c.discovery.checkBatch(b.id);}catch{return['discovery_scope_changed'];}
   if(this.db.prepare("SELECT 1 FROM actions WHERE owner=? AND state IN ('claimed','uncertain')").get(r.owner_id))return['discovery_effect_in_flight'];
   return[];
  }
  const wake=this.s.openWake(r.task_id),task=this.s.task(r.task_id);
  if(!task||wake?.id!==r.id||wake.transport!=='native_trigger'||wake.owner_id!==r.owner_id||wake.prompt!==r.prompt||wake.queue_id)return['wake_changed_or_already_queued'];
  if(!['reserved','claimed','queued','uncertain','running'].includes(wake.state))return['wake_terminal'];
  if(JSON.stringify([...wake.member_ids].sort())!==JSON.stringify(r.data.members.map(m=>m.task_id).sort()))return['registered_group_changed'];
  try{this.s.assertOwnerCoverage(r.owner_id);}catch{return['owner_membership_changed'];}
  for(const saved of r.data.members){
   const t=this.s.task(saved.task_id);
   if(!t||t.owner_id!==r.owner_id||t.mode!=='active'||['complete','needs_decision'].includes(t.status))return['owner_paused_or_decision'];
   if(this.s.waitPolicy.blocked(t.task_id))return['owner_next_action_not_due'];
   if(t.context_rev!==saved.context_rev||t.plan_rev!==saved.plan_rev||t.contract_rev!==saved.contract_rev)return['message_context_changed'];
   try{this.s.assertQueueOwner(t);}catch{return['owner_hold_or_scope_changed'];}
   const scope=scopeActionReasons(this.c.taskRegistry(),'task_queue',t.task_id,{scope_keys:t.contract.scope_keys??[]});if(scope.length)return scope;
   if(this.db.prepare("SELECT 1 FROM actions WHERE task_id=? AND state IN ('claimed','uncertain')").get(t.task_id))return['effect_in_flight'];
  }
  if(this.db.prepare("SELECT 1 FROM rt_wakes WHERE owner_id=? AND id<>? AND state IN ('reserved','claimed','queued','running','uncertain')").get(r.owner_id,r.id))return['owner_execution_in_flight'];
  return[];
 }
 registerTask(task,wake,prompt){
  return this.c.atomic(()=>{
   if(!wake)return{registered:false,reason:'no_due_wake'};
   const recovery=this.fallback.registration('task',task.owner_id,task.task_id,wake.id);
   if(recovery?.deferred)return{registered:false,reason:'recovery_backoff',next_at:recovery.next_at};
   this.db.prepare("UPDATE rt_trigger_messages SET state='cancelled',updated_at=? WHERE task_id=? AND state='pending' AND id<>? AND id IN (SELECT id FROM rt_wakes WHERE state IN ('superseded','finished','ended_unresolved'))").run(this.now(),task.task_id,wake.id);
   const old=triggerMessage(this.db,wake.id);
   if(old){
    if(old.state==='pending'&&this.reasons(old).some(x=>['message_context_changed','owner_paused_or_decision','owner_hold_or_scope_changed'].includes(x))){
     this.db.prepare("UPDATE rt_trigger_messages SET state='cancelled',updated_at=? WHERE id=? AND state='pending'").run(this.now(),old.id);
     this.db.prepare("UPDATE rt_wakes SET state='superseded',completed_at=? WHERE id=? AND state='reserved'").run(this.now(),old.id);
     return{registered:false,reason:'unsent_message_superseded',events_preserved:true};
    }if(old.state==='pending')this.fallback.attach(old);return{registered:true,id:old.id,state:old.state};
   }
   if(!this.policy?.enabled||wake.state!=='reserved'||wake.queue_id||wake.transport!=='native_queue'||wake.owner_id!==task.owner_id||
    this.db.prepare("SELECT 1 FROM actions WHERE action_key=? AND state IN ('claimed','sent','uncertain')").get(wake.id))return{registered:false,reason:'preserve_existing_transport'};
   if(recovery)prompt+='\n本次接续已中断的执行：先读上次结果和现有作业，保留健康编译、代码与已完成实验，再从 checkpoint 继续；不要重启或重复整轮工作。';
   const members=wake.member_ids.map(id=>{const t=this.s.task(id);return{task_id:id,context_rev:t.context_rev,plan_rev:t.plan_rev,contract_rev:t.contract_rev};});
   this.db.prepare("UPDATE rt_wakes SET prompt=?,transport='native_trigger' WHERE id=? AND state='reserved'").run(prompt,wake.id);
   const r={id:wake.id,kind:'task',task_id:task.task_id,owner_id:task.owner_id,sender_id:this.policy.thread_id,workspace:task.contract.workspace,prompt,data:{members,authorization_ref:this.policy.authorization_ref}};
   this.fallback.attach(r);
   const reasons=this.reasons(r);if(reasons.length)throw Error(reasons.join(','));
   this.insert(r);return{registered:true,id:r.id,state:'pending',native_message_sent:false};
  });
 }
 registerDiscovery(batch){
  return this.c.atomic(()=>{
   const recovery=this.fallback.registration('discovery',this.c.discovery.config.threads.discovery,null,batch.mail_key);
   if(recovery?.deferred)return{registered:false,reason:'recovery_backoff',next_at:recovery.next_at};
   const old=triggerMessage(this.db,batch.mail_key);if(old){if(old.state==='pending')this.fallback.attach(old);return{registered:true,id:old.id,state:old.state};}
   const r={id:batch.mail_key,kind:'discovery',task_id:null,owner_id:this.c.discovery.config.threads.discovery,sender_id:this.policy.thread_id,workspace:this.c.discovery.config.thread_workspaces?.discovery??this.c.discovery.config.scope.project_root,prompt:batch.prompt,data:{batch_id:batch.id,generation:batch.generation,authorization_ref:this.policy.authorization_ref}};
   this.fallback.attach(r);
   const reasons=this.reasons(r);if(reasons.length)throw Error(reasons.join(','));this.insert(r);return{registered:true,id:r.id,state:'pending'};
  });
 }
 insert(r){if(typeof r.prompt!=='string'||!r.prompt.trim()||Buffer.byteLength(r.prompt)>65536)throw Error('Bounded immutable prompt required');
  this.db.prepare("INSERT INTO rt_trigger_messages(id,kind,task_id,owner_id,sender_id,workspace,prompt,digest,data,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)")
   .run(r.id,r.kind,r.task_id,r.owner_id,r.sender_id,r.workspace,r.prompt,hash(r.prompt),JSON.stringify(r.data),this.now(),this.now());}
 pending(){
  return this.c.atomic(()=>{
   const rows=this.db.prepare("SELECT * FROM rt_trigger_messages WHERE state='pending' ORDER BY last_offered_at,created_at,id").all().map(parse).filter(r=>!this.reasons(r).length);
   const unresolved=this.db.prepare("SELECT id,kind,task_id,owner_id,workspace,state,attempt_id,claimed_at,json_extract(data,'$.claimed_by_turn') sender_turn_id FROM rt_trigger_messages WHERE state IN ('claimed','uncertain') OR state='sent' AND execution_turn IS NULL ORDER BY last_offered_at,created_at,id").all();
   // An active owner must not keep later idle owners behind the same first page.
   for(const r of [...rows,...unresolved])this.db.prepare('UPDATE rt_trigger_messages SET last_offered_at=? WHERE id=?').run(this.now(),r.id);
   return{messages:rows.map(r=>({id:r.id,kind:r.kind,task_id:r.task_id,thread_id:r.owner_id,workspace:r.workspace,digest:r.digest,read_arguments:{threadId:r.owner_id,hostId:'local',turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:1200}})),unresolved,executions:this.fallback.executions(),discoveries:this.fallback.discoveries()};
  });
 }
 target(r,proof){
  const at=Date.parse(proof?.checked_at);if(!Number.isFinite(at)||this.now()-at>15000)throw Error('Immediate fresh owner state required');
  if(this.fallback.failedTarget(r,proof))return nativeReadback(proof.readback).turns[0].id;
  verifyNativeBinding(proof,{thread_id:r.owner_id,workspace:r.workspace,now:this.now()});
  const read=nativeReadback(proof.readback),t=read.turns?.[0];
  if(!['idle','notLoaded'].includes(read.thread.status.type)||(read.thread.status.activeFlags??[]).length||t?.status!=='completed'||t.error)throw Error('Owner is busy, awaiting input or failed; preserve it');
  return t.id;
 }
 prepare({id,native_proof,actor_proof}){
  return this.c.atomic(()=>{this.actor(actor_proof);const r=triggerMessage(this.db,id);if(!r||r.state!=='pending')return{send:false,reason:r?.state??'missing'};
   const reasons=this.reasons(r);if(reasons.length)return{send:false,reasons};
   const turn=this.target(r,native_proof);this.db.prepare('UPDATE rt_trigger_messages SET preflight_turn=?,preflight_at=? WHERE id=?').run(turn,Date.parse(native_proof.checked_at),id);
   return{send:false,prepared:true,id,digest:r.digest,expected_turn_id:turn};});
 }
 claim({id,digest,native_proof,actor_proof}){
  return this.c.atomic(()=>{const actor=this.actor(actor_proof);const run=this.db.prepare('SELECT started_at FROM rt_trigger_runs WHERE turn_id=?').get(actor);if(!run)throw Error('Begin the trigger run first');
   const r=triggerMessage(this.db,id);if(!r||r.state!=='pending')return{send:false,reason:r?.state??'missing'};
   const reasons=this.reasons(r);if(reasons.length)return{send:false,reasons};
   const turn=this.target(r,native_proof),at=Date.parse(native_proof.checked_at);
   if(r.digest!==digest||hash(r.prompt)!==digest||r.preflight_turn!==turn||!r.preflight_at||at<=r.preflight_at||this.now()-r.preflight_at>30000)return{send:false,reason:'owner_turn_or_preflight_changed'};
   if(this.db.prepare("SELECT 1 FROM rt_trigger_messages WHERE owner_id=? AND id<>? AND state IN ('claimed','uncertain')").get(r.owner_id,id))return{send:false,reason:'owner_send_in_flight'};
   const attempt=randomUUID();this.db.prepare("UPDATE rt_trigger_messages SET state='claimed',attempt_id=?,claimed_at=?,updated_at=?,data=? WHERE id=? AND state='pending'").run(attempt,this.now(),this.now(),JSON.stringify({...r.data,claimed_by_turn:actor}),id);
   if(r.kind==='task')this.db.prepare("UPDATE rt_wakes SET state='claimed' WHERE id=? AND state='reserved'").run(id);
   return{send:true,id,attempt_id:attempt,digest,arguments:{threadId:r.owner_id,hostId:'local',prompt:r.prompt},execution_verified:false};});
 }
 settle({id,attempt_id,native_result,evidence_ref,actor_proof}){
  return this.c.atomic(()=>{this.actor(actor_proof);const r=triggerMessage(this.db,id);if(!r||r.attempt_id!==attempt_id||!evidence_ref)throw Error('Exact claimed attempt and original native receipt required');
   if(['sent','started','finished'].includes(r.state)&&r.receipt)return{settled:false,state:r.state};
   let value=native_result?.structuredContent;if(!value)for(const c of native_result?.content??[])if(c.type==='text'){try{const p=JSON.parse(c.text);if(p.threadId){value=p;break;}}catch{}}
   const sent=native_result?.isError!==true&&value?.threadId===r.owner_id;
   const state=['started','finished'].includes(r.state)?r.state:sent?'sent':'uncertain';
   this.db.prepare('UPDATE rt_trigger_messages SET state=?,receipt=?,updated_at=? WHERE id=?').run(state,JSON.stringify({native_result,evidence_ref,execution_verified:!!r.execution_turn}),this.now(),id);
   if(r.kind==='task')this.db.prepare("UPDATE rt_wakes SET state=? WHERE id=? AND state='claimed'").run(sent?'queued':'uncertain',id);
   return{settled:true,state,execution_verified:!!r.execution_turn,automatic_retry:false};});
 }
 observe({id,native_proof,actor_proof}){
  const observed=this.c.atomic(()=>{this.actor(actor_proof);const r=triggerMessage(this.db,id);if(!r)throw Error('Unknown trigger message');
   const read=nativeReadback(native_proof.readback),terminal=['completed','failed','interrupted'].includes(read.turns?.[0]?.status);
   const proof=verifyTriggerExecution(this.db,id,native_proof,{thread_id:r.owner_id,workspace:r.workspace,now:this.now(),terminal});
   this.db.prepare("UPDATE rt_trigger_messages SET execution_turn=?,state=CASE WHEN state='finished' THEN state ELSE 'started' END,updated_at=? WHERE id=?").run(proof.turn_id,this.now(),id);
   return{execution_observed:true,turn_id:proof.turn_id,status:proof.status,owner_begin_required:r.kind==='task'&&r.state!=='finished',task_id:r.task_id,finished:r.state==='finished'};});
  const autonomy=ownerAutonomyPolicy(this.db);
  if(observed.task_id&&!observed.finished&&observed.status==='inProgress'&&autonomy?.enabled){
    const task=this.s.task(observed.task_id);
    if(task?.mode==='active'&&autonomy.allowed_kinds?.includes(task.contract.task_kind??'work')&&!task.contract.retired&&!task.contract.service_lane&&!['complete','needs_decision'].includes(task.status)){
      const began=this.s.begin({task_id:task.task_id,wake_id:id,native_proof});
      return{...observed,owner_begin_required:!began.wake,execution_bound:began.wake?.turn_id===observed.turn_id};
    }
  }
  return observed;
 }
 recoveryActor(proof){const turn=this.actor(proof);if(!this.db.prepare('SELECT 1 FROM rt_trigger_runs WHERE turn_id=?').get(turn))throw Error('Begin the trigger run before recovery');}
 watch(input){this.recoveryActor(input.actor_proof);return this.fallback.watch(input);}
 watch_discovery(input){this.recoveryActor(input.actor_proof);return this.fallback.watchDiscovery(input);}
 release_unsent(input){this.recoveryActor(input.actor_proof);return this.fallback.releaseUnsent(input);}
}
