import {verifyExecutionProof} from './native-queue.mjs';
import {verifyTriggerExecution} from './trigger-proof.mjs';
import {verifyFollowupTerminal} from './human-followup.mjs';
import {verifyQueuedRecoveryProof} from './queued-resume.mjs';

export function recoverNativeWake(control,input){
 const state=control.reactive,task=state.task(input.task_id),wake=state.openWake(input.task_id);
 if(!task||!wake)throw Error('No wake to reconcile');
 let proof;
 try{
  proof=wake.transport==='native_followup'?verifyFollowupTerminal(control,task,wake,input.native_proof):
   wake.transport==='native_trigger'?verifyTriggerExecution(control.db,wake.id,input.native_proof,{thread_id:task.owner_id,workspace:task.contract.workspace,now:control.now(),terminal:true}):
   verifyExecutionProof(input.native_proof,{thread_id:task.owner_id,workspace:task.contract.workspace,prompt:wake.prompt,now:control.now(),terminal:true});
  if(!proof)throw Error('Original delivery registration required');
 }catch(error){
  const action=control.db.prepare('SELECT * FROM actions WHERE action_key=?').get(`resume-input:${input.task_id}:${wake.queue_id}`);
  if(!action)throw error;
  proof=verifyQueuedRecoveryProof(input.native_proof,{task,wake,action,now:control.now(),terminal:true});
 }
 if(!input.evidence_ref)throw Error('Inspect actual results before recovery');
 if(wake.turn_id&&wake.turn_id!==proof.turn_id)throw Error('Preserve a different acknowledged native turn');
 if(input.settle_outcome===true&&wake.state==='running'&&wake.member_ids.every(id=>{const t=state.task(id);return !t.dirty&&['waiting','complete','needs_decision'].includes(t.status);})){
  const result=state.finish({task_id:task.task_id,wake_id:wake.id,turn_id:proof.turn_id,evidence_ref:input.evidence_ref});
  return{...result,outcome_preserved:true,turn_id:proof.turn_id};
 }
 return control.atomic(()=>{
  const current=state.openWake(task.task_id);
  if(current?.id!==wake.id||current.state!==wake.state||current.turn_id!==wake.turn_id)throw Error('Execution changed during terminal reconciliation');
  if(wake.member_ids.some(id=>control.db.prepare("SELECT 1 FROM actions WHERE task_id=? AND action_key<>? AND state IN ('claimed','uncertain')").get(id,wake.id)))
   throw Error('Reconcile uncertain external effects first');
  control.db.prepare("UPDATE actions SET state='sent',receipt=?,updated_at=? WHERE action_key=? AND state IN ('claimed','uncertain')")
   .run(JSON.stringify({outcome:'sent',evidence_ref:proof.evidence_ref,native_turn:proof.turn_id}),control.now(),wake.id);
  control.db.prepare("UPDATE rt_wakes SET state='ended_unresolved',turn_id=?,completed_at=?,evidence_ref=? WHERE id=?")
   .run(proof.turn_id,control.now(),input.evidence_ref,wake.id);
  if(wake.transport==='native_trigger')control.db.prepare("UPDATE rt_trigger_messages SET state='ended_unresolved',execution_turn=?,updated_at=? WHERE id=?").run(proof.turn_id,control.now(),wake.id);
  for(const id of wake.member_ids)state.ingestInside({event_id:`recover:${wake.id}:${id}`,task_id:id,source:'native_desktop_observation',subject:`turn:${proof.turn_id}`,type:'owner_ended',
   observed_at:control.now(),payload:{previous_wake:wake.id,actual_turn:proof.turn_id,status:proof.status},evidence_ref:input.evidence_ref,debounce_ms:0});
  return{recovered:true,task_complete:false,turn_id:proof.turn_id};
 });
}
