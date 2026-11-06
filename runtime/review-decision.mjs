import {bindings} from './instance.mjs';

// An explicitly authorized, product-scoped exception to an on-request main inbox.
// This is a private decision card, never permission to send to Slack or merge.
export const deliveryGuardKind=kind=>kind==='review_decision'?'slack_pr':kind;

export function reviewDecisionReasons(payload,e,policy) {
  const route=policy?.routes?.find(r=>r.scope==='lancedb_functions');
  const decision=route?.decision_delivery,scope=e.review_routing;
  const reasons=[];
  if(policy?.schema_version!==1||decision?.enabled!==true||decision.mode!=='owner_to_main'||
    !decision.source_message_id||!decision.evidence_ref||decision.thread_id!==bindings.threads.inbox||
    payload.thread_id!==decision.thread_id||payload.source_message_id!==decision.source_message_id)
    reasons.push('explicit_functions_decision_destination_required');
  if(scope?.scope!=='lancedb_functions'||scope.verified!==true||!scope.evidence_ref||
    scope.pr_url!==payload.pr_url||scope.pr_url!==e.pr_url||scope.head_sha!==payload.expected_head_sha||
    scope.head_sha!==e.current_head_sha||payload.message!==payload.pr_url)
    reasons.push('current_functions_PR_scope_required');
  const repo=payload.pr_url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/[1-9]\d*$/)?.[1];
  if(!repo||!bindings.scope.repositories.includes(repo))reasons.push('repository_outside_instance_scope');
  if(typeof payload.prompt!=='string'||!payload.prompt.includes(payload.pr_url)||
    !payload.prompt.trim()||payload.prompt.length>6000||e.already_notified!==false)
    reasons.push('new_review_decision_card_required');
  return reasons;
}

export function reviewDecisionTaskReasons(control,kind,taskId,payload,e={},actor,key) {
  if(kind!=='review_decision')return [];
  const task=control.reactive.task(taskId),item=control.work.get(taskId);
  if(!task||task.owner_id!==(actor??e.executor_thread_id)||task.contract.retired===true||
    item?.data.source?.review_only===true)return ['original_implementation_owner_required'];
  if(key!==`review-decision:${payload.pr_url}:${payload.expected_head_sha}`)
    return ['stable_review_decision_key_required'];
  if(!task.contract.pull_requests?.some(p=>`https://github.com/${p.repository}/pull/${p.pr_number}`===payload.pr_url))
    return ['review_decision_PR_not_bound_to_task'];
  return [];
}
