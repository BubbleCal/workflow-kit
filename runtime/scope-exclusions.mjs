// The coordinator binds an actual user restriction to exact stages, scopes and
// PRs. Expiring external facts never revoke that instruction.
export function activeScopeExclusions(registry, taskId) {
  return Object.entries(registry?.scope_restrictions ?? {}).filter(([key,r]) =>
    (r.task_id ?? key.split(':')[0]) === taskId && r.source_message_id && r.evidence_ref && r.verbatim_text &&
    (['excluded','released'].includes(r.status) || Array.isArray(r.excluded) && r.excluded.length) &&
    !(r.status === 'released' && r.resumed_by_message_id && r.resumed_by_message_id !== r.source_message_id && r.resumption_evidence_ref))
    .map(([key,r])=>({key,...r}));
}

export function stageScopeExclusion(registry, goal, stage) {
  if (stage.state === 'complete') return null;
  if (stage.state === 'skipped') return stage.scope_exclusion;
  const matches=activeScopeExclusions(registry,stage.task_id).filter(r =>
    stage.scope_exclusion?.key === r.key || (r.targets?.stages ?? []).some(t=>t.goal_id===goal.id && t.stage_id===stage.id) ||
    (r.targets?.scope_keys ?? []).includes(stage.scope_key) ||
    // Existing blocked scope stops already have this exact source-evidence binding.
    stage.scope_excluded_by_user===true && stage.automatic_followup_allowed===false && stage.blocker?.evidence_ref===r.evidence_ref);
  if(!matches.length)return null;
  const r=matches.find(r=>r.key===stage.scope_exclusion?.key)??matches[0];
  return {key:r.key,source_message_id:r.source_message_id,evidence_ref:r.evidence_ref};
}

export function scopeActionReasons(registry, kind, taskId, payload={}, evidence={}) {
  if(!['task_wake','dispatch','create_thread','pr_ready','slack_pr','merge'].includes(kind))return [];
  const rules=activeScopeExclusions(registry,taskId);if(!rules.length)return [];
  const scopes=[...(Array.isArray(payload.scope_keys)?payload.scope_keys:[]),...(Array.isArray(evidence.scope_keys)?evidence.scope_keys:[])], url=payload.pr_url??payload.message;
  if(rules.some(r=>(Array.isArray(scopes)&&scopes.some(k=>k===r.key||(r.targets?.scope_keys??[]).includes(k))) ||
    url && (r.targets?.pr_urls??[]).includes(url)))return ['scope_excluded_by_actual_user'];
  if(['task_wake','dispatch','create_thread'].includes(kind) || !rules.every(r=>Array.isArray(r.targets?.pr_urls)))
    if(!Array.isArray(scopes)||!scopes.length||scopes.some(k=>typeof k!=='string'||!k.trim()))return ['explicit_remaining_scope_binding_required'];
  return [];
}
