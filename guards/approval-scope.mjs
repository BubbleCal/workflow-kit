// This context is supplied only after native policy-store human proof validation.
// An impact evidence gap is owner work, not a request for blanket human approval.
export function approvalScope(kind,payload,e,policy,grant,now){
  const a=e.pr_impact,pr=payload.pr_url??payload.message,head=payload.expected_head_sha;
  const checked=Date.parse(a?.checked_at),reasons=[],flags=['breaking_change','format_change','enterprise_negative_impact'];
  if(!a||a.pr_url!==pr||pr!==e.pr_url||a.head_sha!==head||head!==e.current_head_sha||
    !a.owner_thread_id||a.owner_thread_id!==e.executor_thread_id||!a.evidence_ref||!a.reason||
    !Number.isFinite(checked)||checked>now+5000||now-checked>60000||flags.some(k=>typeof a[k]!=='boolean')||
    a.labels_complete!==true||!Array.isArray(a.labels)||a.labels.some(l=>typeof l!=='string'))
    return {allowed:false,reasons:['current_owner_impact_assessment_required'],requires_human:false,triggers:[]};
  const labels=a.labels.map(l=>l.trim().toLowerCase().replace(/[ _]+/g,'-'));
  const triggers=flags.filter(k=>a[k]);
  if(labels.some(l=>['breaking-change','breaking'].includes(l))&&!triggers.includes('breaking_change'))triggers.push('breaking_change');
  if(labels.some(l=>['format-change','file-format-change'].includes(l))&&!triggers.includes('format_change'))triggers.push('format_change');
  const exact=grant?.pr_url===pr&&grant.head_sha===head&&grant.protocol!=='t3_standing_scope_v1';
  const originals=grant?.legacy_grants??[grant];
  const riskApproved=exact&&(triggers.every(t=>grant.approved_categories?.includes(t))||
    originals.some(g=>g.reviewed_personally===true&&(kind==='merge'?g.conditional_merge:g.external_review)===true));
  if(triggers.length&&!riskApproved)reasons.push(...triggers.map(t=>`Yang_authorization_required:${t}`));
  if(kind==='slack_pr'&&!(exact&&grant.external_review===true))reasons.push('Yang_authorization_required:slack_message');
  // An explicit task-specific prohibition is different from absent routine approval.
  if(kind==='merge'&&exact&&originals.some(g=>/(?:不允许|禁止)合并/.test(g.source.text.split('\n').at(-1))))reasons.push('merge_explicitly_held_by_user');
  return {allowed:!reasons.length,reasons,requires_human:reasons.some(r=>r.startsWith('Yang_authorization_required:')),triggers,authority:policy.source};
}
