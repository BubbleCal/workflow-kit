import {nativeReadback,verifyNativeBinding} from './native-queue.mjs';
import {verifyFollowupAuthority} from './human-followup.mjs';
import {triggerMessage} from './trigger-proof.mjs';

// A missing receipt alone cannot release a claim. The complete sender turn must
// end at the successful claim command, before any native send could run.
export function reconcileUnsentTrigger(control,config,input){
 if(input.actual_human_verified!==true||!input.evidence_ref)throw Error('Actual human recovery authority required');
 verifyFollowupAuthority(input.human_authorization,input);
 return control.atomic(()=>{
  const db=control.db,r=triggerMessage(db,input.id),s=control.reactive;
  db.exec('CREATE TABLE IF NOT EXISTS rt_trigger_claim_recovery (attempt_id TEXT PRIMARY KEY,message_id TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL)');
  const prior=db.prepare('SELECT message_id FROM rt_trigger_claim_recovery WHERE attempt_id=?').get(input.attempt_id);
  if(prior){if(prior.message_id!==input.id)throw Error('Recovery attempt identity changed');return{reconciled:false,already_reconciled:true,id:input.id};}
  const wake=r?.task_id?s.openWake(r.task_id):null,task=r?.task_id?s.task(r.task_id):null;
  if(!r||!['task','discovery'].includes(r.kind)||r.state!=='claimed'||r.attempt_id!==input.attempt_id||r.receipt||r.execution_turn||r.sender_id!==config.message_trigger?.thread_id)
   throw Error('Exact unsent original trigger claim and active original owner required');
  if(r.kind==='task'){
   if(!task||task.owner_id!==r.owner_id||task.mode!=='active'||['complete','needs_decision'].includes(task.status)||wake?.id!==r.id||wake.state!=='claimed'||wake.transport!=='native_trigger'||wake.queue_id||wake.turn_id||wake.started_at||wake.owner_id!==r.owner_id)
    throw Error('Preserve original owner, decisions and execution');
   s.assertQueueOwner(task);
  }else{
   const b=control.discovery.batch(r.data.batch_id);
   if(b?.state!=='pending'||b.generation!==r.data.generation||b.mail_key!==r.id||control.work.config.threads.discovery!==r.owner_id||
    db.prepare('SELECT 1 FROM work_creation_runs WHERE batch_id=? AND generation=?').get(b.id,b.generation))throw Error('Preserve an acknowledged discovery execution');
  }
  const proof=input.sender_native_proof;
  verifyNativeBinding(proof,{thread_id:r.sender_id,workspace:config.message_trigger.workspace,now:control.now()});
  const sender=nativeReadback(proof.readback),turn=sender.turns?.[0],last=turn?.items?.at(-1);
  if(!turn||turn.id!==input.sender_turn_id||!['completed','failed','interrupted'].includes(turn.status)||
   !Number.isFinite(turn.startedAt)||!Number.isFinite(turn.completedAt)||turn.startedAt*1000>r.claimed_at+1000||turn.completedAt*1000<r.claimed_at-1000||
   last?.type!=='commandExecution'||last.exitCode!==0||last.status!=='completed'||last.output?.truncated!==false||
   !last.command?.includes('workflow.mjs runtime trigger --file '))throw Error('Complete terminal sender proof must end at the original claim command');
  let claim;try{claim=JSON.parse(last.output.text.slice(last.output.text.indexOf('{')));}catch{throw Error('Untruncated original claim result required');}
  if(claim.send!==true||claim.id!==r.id||claim.attempt_id!==r.attempt_id||claim.digest!==r.digest||
   claim.arguments?.threadId!==r.owner_id||claim.arguments?.hostId!=='local'||claim.arguments?.prompt!==r.prompt)
   throw Error('Original native claim result must match the immutable attempt');
  verifyNativeBinding(input.owner_native_proof,{thread_id:r.owner_id,workspace:r.workspace,now:control.now()});
  const owner=nativeReadback(input.owner_native_proof.readback),target=owner.turns?.[0];
  if(!['idle','notLoaded'].includes(owner.thread.status?.type)||(owner.thread.status.activeFlags??[]).length||
   target?.id!==r.preflight_turn||!['completed','failed','interrupted'].includes(target.status))throw Error('Original owner must still be quiescent at the exact preflight turn');
  if(db.prepare("SELECT 1 FROM actions WHERE (task_id=? OR owner=?) AND state IN ('claimed','uncertain')").get(r.task_id,r.owner_id))throw Error('Reconcile external effects first');
  const audit={original:r,sender_turn_id:turn.id,source_message_id:input.source_message_id,evidence_ref:input.evidence_ref,
   sender_proof:proof,owner_proof:input.owner_native_proof,native_send_invoked:false};
  db.prepare('INSERT INTO rt_trigger_claim_recovery VALUES (?,?,?,?)').run(r.attempt_id,r.id,JSON.stringify(audit),control.now());
  db.prepare("UPDATE rt_trigger_messages SET state='pending',attempt_id=NULL,preflight_turn=NULL,preflight_at=NULL,claimed_at=NULL,updated_at=? WHERE id=?").run(control.now(),r.id);
  if(r.kind==='task')db.prepare("UPDATE rt_wakes SET state='reserved' WHERE id=?").run(r.id);
  return{reconciled:true,id:r.id,state:'pending',original_attempt_preserved:true,native_send_invoked:false,execution_verified:false};
 });
}
