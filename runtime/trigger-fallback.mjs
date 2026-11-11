import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {nativeReadback,verifyNativeBinding} from './native-queue.mjs';
import {verifyFollowupAuthority} from './human-followup.mjs';
import {recoverNativeWake} from './execution-recovery.mjs';
import {reconcileUnsentTrigger} from './trigger-recovery.mjs';
import {Mailbox} from './mailbox.mjs';
import {settleDiscoveryDelivery} from './discovery-followup.mjs';

const parse=r=>r?{...r,data:JSON.parse(r.data)}:null;
export const badRequest=t=>t?.status==='failed'&&/Bad Request/.test(t.error?.message??'')&&/invalid_request_error/.test(t.error?.message??'');

export class TriggerFallback {
 constructor(control,config){this.c=control;this.s=control.reactive;this.db=control.db;this.config=config;this.now=control.now;
  this.db.exec(`CREATE TABLE IF NOT EXISTS rt_trigger_recoveries (
   origin_id TEXT PRIMARY KEY,kind TEXT NOT NULL,task_id TEXT,owner_id TEXT NOT NULL,turn_id TEXT NOT NULL,
   attempt INTEGER NOT NULL,not_before INTEGER NOT NULL,successor_id TEXT,data TEXT NOT NULL,created_at INTEGER NOT NULL)`);
 }
 authority(){
  const ref=this.config.message_trigger?.recovery_authorization_ref;if(!ref)return null;
  const a=JSON.parse(readFileSync(resolve(this.c.work.config.instance_root??'.',ref),'utf8'));
  if(a.enabled!==true||a.allow_existing_owner_recovery!==true)throw Error('Existing-owner recovery authorization required');
  verifyFollowupAuthority(a.human_authorization,a);return a;
 }
 executions(){
  if(!this.authority())return[];
  const rows=this.db.prepare("SELECT w.id,w.task_id,w.owner_id thread_id,w.turn_id,w.transport,t.contract FROM rt_wakes w JOIN rt_tasks t ON t.task_id=w.task_id WHERE w.state='running' AND t.mode='active' ORDER BY w.created_at,w.id").all();
  return rows.map(({contract,...r})=>({...r,kind:'task',workspace:JSON.parse(contract).workspace,read_arguments:{threadId:r.thread_id,hostId:'local',turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:1200}}));
 }
 discoveries(){
  if(!this.authority())return[];
  return this.db.prepare("SELECT b.id batch_id,b.generation,r.turn_id FROM discovery_batches b JOIN work_creation_runs r ON r.batch_id=b.id AND r.generation=b.generation WHERE b.state='running'").all()
   .map(r=>({...r,kind:'discovery',read_arguments:{threadId:this.c.work.config.threads.discovery,hostId:'local',turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:1200}}));
 }
 identity(proof,owner,workspace){
  const read=nativeReadback(proof?.readback),at=Date.parse(proof?.checked_at);
  if(proof?.source!=='codex_app.read_thread'||!proof.evidence_ref||!Number.isFinite(at)||at>this.now()+5000||this.now()-at>60000||
   read.thread?.id!==owner||read.thread.kind!=='codex'||read.thread.hostId!=='local'||read.thread.cwd!==workspace||!read.turns?.[0]?.id)
   throw Error('Fresh exact native owner identity required');
  return read;
 }
 record({origin_id,kind,task_id=null,owner_id,turn,proof}){
  const previous=this.db.prepare('SELECT * FROM rt_trigger_recoveries WHERE successor_id=?').get(origin_id);
  const decision=task_id?this.db.prepare('SELECT created_at FROM rt_decisions WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(task_id):null;
  const attempt=previous&&!(decision&&decision.created_at>previous.created_at)?previous.attempt+1:1;
  const delay=attempt===1?0:Math.min(3600000,this.config.message_trigger.interval_ms*2**Math.min(attempt-2,6));
  const data={bad_request:badRequest(turn),native_status:turn.status,evidence_ref:proof.evidence_ref,source_message_id:this.authority().source_message_id,
   instruction:'Read the saved result and existing jobs first; preserve healthy jobs, edits and completed experiments, then continue only the accepted goal.'};
  this.db.prepare('INSERT OR IGNORE INTO rt_trigger_recoveries VALUES (?,?,?,?,?,?,?,NULL,?,?)')
   .run(origin_id,kind,task_id,owner_id,turn.id,attempt,this.now()+delay,JSON.stringify(data),this.now());
  return parse(this.db.prepare('SELECT * FROM rt_trigger_recoveries WHERE origin_id=?').get(origin_id));
 }
 next(kind,owner,taskId=null){
  return parse(this.db.prepare('SELECT * FROM rt_trigger_recoveries WHERE kind=? AND owner_id=? AND task_id IS ? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(kind,owner,taskId));
 }
 registration(kind,owner,taskId,id){
  const row=this.next(kind,owner,taskId);if(!row||!this.authority())return null;
  if(row.successor_id&&row.successor_id!==id){
   const prior=this.db.prepare('SELECT state FROM rt_trigger_messages WHERE id=?').get(row.successor_id);
   if(!prior||prior.state!=='cancelled')return null;
  }
  if(this.now()<row.not_before)return{deferred:true,next_at:row.not_before};
  return row;
 }
 attach(r){
  const row=this.registration(r.kind,r.owner_id,r.task_id??null,r.id);if(!row||row.deferred)return row;
  this.db.prepare('UPDATE rt_trigger_recoveries SET successor_id=? WHERE origin_id=?').run(r.id,row.origin_id);
  r.data.recovery_id=row.origin_id;
  const saved=this.db.prepare('SELECT state FROM rt_trigger_messages WHERE id=?').get(r.id);
  if(saved?.state==='pending')this.db.prepare('UPDATE rt_trigger_messages SET data=? WHERE id=?').run(JSON.stringify(r.data),r.id);
  return row;
 }
 reasons(r){
  if(!r.data.recovery_id)return[];
  if(!this.authority())return['recovery_authorization_disabled'];
  const row=this.db.prepare('SELECT successor_id,not_before FROM rt_trigger_recoveries WHERE origin_id=?').get(r.data.recovery_id);
  return !row||row.successor_id!==r.id?['recovery_delivery_changed']:row.not_before>this.now()?['recovery_backoff']:[];
 }
 failedTarget(r,proof){
  if(!r.data.recovery_id||this.reasons(r).length)return false;
  const row=parse(this.db.prepare('SELECT * FROM rt_trigger_recoveries WHERE origin_id=?').get(r.data.recovery_id));
  if(!row?.data.bad_request)return false;
  const read=this.identity(proof,r.owner_id,r.workspace),turn=read.turns[0];
  if(turn.id!==row.turn_id||!badRequest(turn)||(read.thread.status.activeFlags??[]).length||!['systemError','idle','notLoaded'].includes(read.thread.status.type))return false;
  if(read.thread.status.type!=='systemError')verifyNativeBinding(proof,{thread_id:r.owner_id,workspace:r.workspace,now:this.now()});
  return true;
 }
 watch({wake_id,native_proof}){
  if(!this.authority())throw Error('Trigger recovery is not authorized');
  const w=this.db.prepare('SELECT task_id FROM rt_wakes WHERE id=?').get(wake_id),task=w?this.s.task(w.task_id):null,wake=task?this.s.openWake(task.task_id):null;
  if(!wake||wake.id!==wake_id)return{preserved:true,reason:'execution_already_closed'};
  if(task.mode!=='active'||task.contract.retired)return{preserved:true,reason:'owner_paused_or_retired'};
  const read=this.identity(native_proof,task.owner_id,task.contract.workspace),turn=read.turns[0];
  if(wake.turn_id&&wake.turn_id!==turn.id)return{preserved:true,reason:'different_native_turn'};
  if(turn.status==='inProgress'||(read.thread.status.activeFlags??[]).length)return{preserved:true,reason:'owner_still_active'};
  if(!['completed','failed','interrupted'].includes(turn.status))return{preserved:true,reason:'native_state_unknown'};
  if(task.contract.service_lane&&wake.member_ids.some(id=>{const t=this.s.task(id);return t.dirty||t.status==='ready';})){
   this.s.diagnostic(`trigger-service-recovery:${wake.id}`,{turn_id:turn.id,status:turn.status,evidence_ref:native_proof.evidence_ref,reason:'Preserve the original fixed service batch; specialized batch recovery required'});
   return{preserved:true,reason:'fixed_service_batch_recovery_required'};
  }
  // The same verification used by manual recovery proves exact delivery; an
  // idle badge or missing receipt alone is never enough to release execution.
  const result=recoverNativeWake(this.c,{task_id:task.task_id,native_proof,evidence_ref:native_proof.evidence_ref,settle_outcome:true});
  if(result.finished)return result;
  if(task.contract.service_lane||['complete','needs_decision'].includes(this.s.task(task.task_id).status)||!(badRequest(turn)||turn.status==='completed')){
   this.s.diagnostic(`trigger-recovery-blocked:${wake.id}`,{turn_id:turn.id,status:turn.status,evidence_ref:native_proof.evidence_ref});
   return{...result,resume:false,reason:'preserve_service_or_human_boundary'};
  }
  const recovery=this.record({origin_id:wake.id,kind:'task',task_id:task.task_id,owner_id:task.owner_id,turn,proof:native_proof});
  return{...result,resume:true,not_before:recovery.not_before,attempt:recovery.attempt};
 }
 watchDiscovery({batch_id,generation,native_proof}){
  if(!this.authority())throw Error('Trigger recovery is not authorized');
  const b=this.c.discovery.batch(batch_id);if(!b||b.generation!==generation||b.state!=='running')return{preserved:true,reason:'discovery_already_closed_or_changed'};
  const owner=this.c.work.config.threads.discovery,workspace=this.c.work.config.thread_workspaces?.discovery??this.c.work.config.scope.project_root;
  const read=this.identity(native_proof,owner,workspace),turn=read.turns[0],run=this.db.prepare('SELECT turn_id FROM work_creation_runs WHERE batch_id=? AND generation=?').get(batch_id,generation);
  if(turn.status==='inProgress'||turn.id!==run?.turn_id||(read.thread.status.activeFlags??[]).length)return{preserved:true,reason:'discovery_active_or_different_turn'};
  const result=this.c.discovery.recover({batch_id,generation,native_proof,effects_reconciled:true,evidence_ref:native_proof.evidence_ref});
  const mailbox=new Mailbox(join(this.c.work.config.instance_root,'mailbox.sqlite'),{now:this.now});
  try{settleDiscoveryDelivery(this.c,mailbox,b,result);}finally{mailbox.close();}
  if(badRequest(turn)||turn.status==='completed')this.record({origin_id:b.mail_key,kind:'discovery',owner_id:owner,turn,proof:native_proof});
  return{...result,coverage_advanced:false};
 }
 releaseUnsent(input){
  const authority=this.authority();if(!authority)throw Error('Trigger recovery is not authorized');
  return reconcileUnsentTrigger(this.c,this.config,{...input,...authority,actual_human_verified:true,evidence_ref:input.evidence_ref});
 }
}
