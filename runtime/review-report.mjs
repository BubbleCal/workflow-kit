import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {bindings,INSTANCE_ROOT} from './instance.mjs';

export function readReviewReportPolicy(root=INSTANCE_ROOT) {
  const path=join(root,'review-report-policy.json');
  return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
}

// A private, completed review result is not an external PR review submission.
// In particular, findings and a later red CI must not hide the conclusion.
export function reviewReportTaskReasons(control,kind,taskId,payload,e={},actor,key) {
  if(kind!=='review_report')return [];
  const policy=control.reviewReportPolicy(),task=control.reactive.task(taskId),item=control.work.get(taskId),reasons=[];
  if(policy?.schema_version!==1||policy.enabled!==true||policy.mode!=='owner_to_main'||
    policy.thread_id!==bindings.threads.inbox||!policy.source_message_id||!policy.evidence_ref||
    payload.thread_id!==policy.thread_id||payload.source_message_id!==policy.source_message_id)
    reasons.push('authorized_review_report_destination_required');
  if(!task||task.owner_id!==(actor??e.executor_thread_id)||task.contract.retired===true||
    task.mode!=='active'||item?.data.source?.review_only!==true||
    !task.contract.pull_requests?.some(p=>`https://github.com/${p.repository}/pull/${p.pr_number}`===payload.pr_url))
    reasons.push('original_bound_review_owner_required');
  const sha=value=>typeof value==='string'&&/^[a-f0-9]{40,64}$/.test(value);
  if(!sha(payload.reviewed_head_sha)||!sha(payload.reviewed_base_sha)||
    !/^[a-f0-9]{64}$/.test(payload.report_sha256??'')||
    typeof payload.report_ref!=='string'||!payload.report_ref.trim()||
    e.reviewed_head_sha!==payload.reviewed_head_sha||e.reviewed_base_sha!==payload.reviewed_base_sha||
    e.report_sha256!==payload.report_sha256||e.report_ref!==payload.report_ref||
    e.review_conclusion_ready!==true||e.report_saved_and_verified!==true||
    e.material_change!==true||e.already_notified!==false)
    reasons.push('verified_new_review_conclusion_required');
  if(key!==`review-report:${taskId}:${payload.reviewed_head_sha}:${payload.report_sha256}`)
    reasons.push('stable_review_report_key_required');
  const link=`codex://threads/${task?.owner_id}`;
  if(typeof payload.prompt!=='string'||payload.prompt.length>5000||
    !payload.prompt.startsWith(`[review-result:${taskId}]`)||
    !payload.prompt.includes(payload.pr_url)||!payload.prompt.includes(link)||
    !payload.prompt.includes(payload.report_ref)||
    !['current','changed','unknown'].includes(payload.pr_head_status))
    reasons.push('finished_review_card_with_report_links_required');
  return reasons;
}
