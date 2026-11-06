// Only exact, known setup notices are informational. Unknown bot feedback has
// the same wake priority as human feedback, including edits to these notices.
export const claudeSetupNotice = "## Claude Code Review\n\nThis repository is configured for manual code reviews. Comment `@claude review` for a one-time review, or `@claude review always` to subscribe this PR to a review on every future push.\n\n<sub>Tip: disable this comment in your organization's [Code Review settings](https://claude.ai/admin-settings/claude-code#code-review).</sub>";
export function isSetupNotice(row) {
  return (row.author ?? row.user?.login) === 'claude[bot]' &&
    (row.review_state ?? row.state) === 'COMMENTED' && String(row.body ?? '').trim() === claudeSetupNotice;
}
const sorted = rows => rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const feedback = (rows=[]) => sorted(rows.filter(r=>!isSetupNotice(r)).map(r=>({
  id:String(r.database_id??r.id),body:r.body??'',author:r.user?.login??r.author?.login??r.author??null,
  state:r.state??null,commit:r.commit_id??r.original_commit_id??null,path:r.path??null,
  reply:r.in_reply_to_id??null,review:r.pull_request_review_id??null,
})));
const failed = new Set(['failure','error','timed_out','cancelled','action_required','stale','startup_failure']);
export function prWakeProjection(data) {
  if(!data?.pr?.head_sha)return data;
  const p=data.pr,ci=p.ci,checks=ci?.checks??[];
  const errors=sorted(checks.filter(c=>failed.has(c.conclusion)).map(c=>({id:String(c.id),kind:c.kind,name:c.name,conclusion:c.conclusion})));
  const gatekeeper=checks.filter(c=>c.name==='LanceDB Gatekeeper').map(c=>({id:c.status==='completed'?String(c.id):null,status:c.status==='completed'?'completed':'pending',conclusion:c.conclusion}));
  return {
    pr:{repository:p.repository,number:p.pr_number,head:p.head_sha,state:p.state,draft:p.draft,
      merge:p.merge_sha,approval:p.approval_state,approval_head:p.approval_head,
      required_checks:p.checks_state,required_scope:p.checks_scope,required_head:p.checks_head,
      requested_reviewers:sorted([...(p.requested_reviewers??[])]),mergeable:p.mergeable,merge_state:p.merge_state_status},
    ci:{complete:ci?.complete===true,head:ci?.head_sha,failures:errors,
      all_finished:ci?.complete===true&&checks.length>0&&checks.every(c=>c.status==='completed'),
      gatekeeper:sorted(gatekeeper)},
    reviews:feedback(data.reviews),inline:feedback(data.review_comments),comments:feedback(data.issue_comments),
    threads:sorted((data.review_threads??[]).map(t=>({id:t.id,resolved:t.isResolved??t.is_resolved,
      outdated:t.isOutdated??t.is_outdated,comments:feedback(t.comments?.nodes??t.comments??[])}))),
  };
}
export function prChangeReasons(previous,current) {
  if(!previous?.pr?.head_sha)return ['首次获取 PR 状态'];
  const a=prWakeProjection(previous),b=prWakeProjection(current),changed=k=>JSON.stringify(a[k])!==JSON.stringify(b[k]),out=[];
  if(a.pr.head!==b.pr.head)out.push('提交已更新');
  if(a.pr.state!==b.pr.state)out.push(b.pr.state==='merged'?'PR 已合并':b.pr.state==='closed'?'PR 已关闭':'PR 状态变化');
  if(a.pr.draft!==b.pr.draft)out.push(b.pr.draft?'PR 转为 draft':'PR 已 ready');
  if(a.pr.approval!==b.pr.approval||a.pr.approval_head!==b.pr.approval_head)out.push('审批状态变化');
  if(['reviews','inline','comments','threads'].some(changed))out.push('有新的或修改过的评审反馈');
  if(JSON.stringify(a.ci.failures)!==JSON.stringify(b.ci.failures))out.push(b.ci.failures.length?'CI 失败结果变化':'CI 失败已解除');
  if(a.ci.all_finished!==b.ci.all_finished&&b.ci.all_finished)out.push('CI 已全部结束');
  if(JSON.stringify(a.ci.gatekeeper)!==JSON.stringify(b.ci.gatekeeper))out.push('Gatekeeper 状态变化');
  if(!out.length&&(changed('pr')||changed('ci')))out.push('交付条件变化');
  return out;
}
export function eventWakeReason(event) {
  const subject=event.subject??'';
  if(event.wake_reasons?.length)return `${subject}：${event.wake_reasons.join('；')}`;
  const action=event.payload?.original?.action;
  if(action)return `${subject}：${action}`;
  const labels={human_command:'用户有新指令',schedule_due:'定时工作到期',wait_expired:'等待到期，需要重新判断',
    pr_changed:'PR 有新状态或反馈',source_changed:'关联来源有新变化',task_registered:'已接受任务',service_batch_ready:'维护批次到期'};
  return `${labels[event.type]??'任务有新事件'}${subject?'：'+subject:''}`;
}
