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
