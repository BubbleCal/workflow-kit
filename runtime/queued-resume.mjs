import {nativeReadback,verifyNativeBinding} from './native-queue.mjs';
// Explicit recovery preserves the original queue receipt. An exact existing-wake
// resume is limited to one stable action key; late duplicate turns must skip begin.
export const isQueuedResume=(kind,payload)=>kind==='human_input'&&['resume_queued_owner','resume_existing_wake'].includes(payload?.intent);
export function queuedResumeReasons(task,wake,payload,evidence,now=Date.now()) {
  const reasons=[],s=evidence?.native_thread_snapshot,at=Date.parse(s?.checked_at);
  if(!task||task.mode!=='active'||task.status==='complete'||task.status==='needs_decision'||task.contract?.retired||
    task.owner_id!==payload.thread_id||task.contract?.service_lane)reasons.push('resume_owner_not_executable');
  if(!wake||wake.state!=='queued'||wake.id!==payload.existing_wake_id||wake.queue_id!==payload.existing_queue_id||
    wake.owner_id!==payload.thread_id||wake.turn_id)reasons.push('original_unconsumed_queue_receipt_required');
  if(!Number.isFinite(at)||at>now+5000||now-at>60000||s?.thread?.id!==payload.thread_id||
    !['notLoaded','idle'].includes(s.thread.status?.type)||(s.thread.status?.activeFlags??[]).length||
    !['completed','failed','interrupted'].includes(s.latestTurn?.status)||s.latestTurn.id!==evidence.actual_turn_id||
    evidence.expected_turn_id!==evidence.actual_turn_id||evidence.thread_archived!==false)
    reasons.push('fresh_unloaded_terminal_owner_required');
  if(evidence.actual_human_message_verified!==true||evidence.source_actor_verified!==true||
    evidence.explicit_resume_request_verified!==true||payload.native_resume_only!==true||
    payload.source_message_id!==evidence.source_message_id||payload.verbatim_text!==evidence.source_text)
    reasons.push('explicit_human_background_resume_required');
  if(payload.intent==='resume_existing_wake'&&payload.prompt!==wake?.prompt)
    reasons.push('resume_must_preserve_exact_existing_work');
  return reasons;
}


export function verifyQueuedRecoveryProof(proof,{task,wake,action,now=Date.now(),terminal=false}) {
  if(!action||action.kind!=='human_input'||action.state!=='sent'||action.task_id!==task.task_id||
    !['queued','running'].includes(wake.state)||!wake.queue_id)throw new Error('A sent recovery for the original queued wake is required');
  const payload=JSON.parse(action.payload),receipt=JSON.parse(action.receipt??'{}');
  if(payload.intent!=='resume_queued_owner'||payload.native_resume_only!==true||payload.thread_id!==task.owner_id||
    payload.existing_wake_id!==wake.id||payload.existing_queue_id!==wake.queue_id||
    action.action_key!==`resume-input:${task.task_id}:${wake.queue_id}`||receipt.outcome!=='sent'||receipt.native_result?.isError===true)
    throw new Error('Recovery receipt does not match this wake');
  const native=receipt.native_result?.structuredContent??(receipt.native_result?.content??[]).flatMap(c=>{try{return [JSON.parse(c.text)];}catch{return [];}}).find(c=>c.threadId);
  if(native?.threadId!==task.owner_id)throw new Error('Recovery transport must acknowledge the exact owner');
  verifyNativeBinding(proof,{thread_id:task.owner_id,workspace:task.contract.workspace,now});
  const read=nativeReadback(proof.readback),turn=read.turns?.[0];
  const expected=`<codex_delegation>\n  <source_thread_id>${action.owner}</source_thread_id>\n  <input>${payload.prompt}</input>\n</codex_delegation>`;
  const turnState=terminal?['idle','notLoaded'].includes(read.thread.status?.type)&&['completed','failed','interrupted'].includes(turn?.status):read.thread.status?.type==='active'&&turn?.status==='inProgress'&&!turn?.error;
  if(!turnState||!turn?.id||
    !Number.isFinite(turn.startedAt)||turn.startedAt*1000<action.created_at-1000||
    (turn.items??[]).filter(i=>i.type==='functionCallOutput'&&i.namespace==='codex_app'&&i.name==='send_message_to_thread'&&
      i.output?.truncated===false&&i.output.text===expected).length!==1)
    throw new Error('Current native turn must contain the exact untruncated authorized recovery hint');
  return {turn_id:turn.id,status:turn.status,evidence_ref:proof.evidence_ref??`native:${task.owner_id}:${turn.id}`,
    recovery_action_key:action.action_key,original_queue_consumed:false};
}
