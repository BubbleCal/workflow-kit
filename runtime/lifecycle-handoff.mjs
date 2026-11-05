// Bind an admitted handoff to an exact event consumed by the original owner.
// Batch membership belongs to the handoff, never to a fabricated source entry.
export function bindLifecycleHandoff({ source, handoff, input, db, registry }) {
  const p=source?.payload, h=handoff?.payload;
  const fail=()=>{throw new Error('Exact native lifecycle handoff binding required');};
  const aliases=(names,value,required=false)=>{
    const present=names.filter(k=>h?.[k]!==undefined);
    return (!required || present.length>0) && present.every(k=>h[k]===value);
  };
  const ci=p?.action==='triage_ci' && ['native_ci_triage_result','resolve_exact_completed_ci_triage_notice',
    'native_duplicate_ci_obligation_disposition'].includes(h?.event);
  const merged=p?.action==='decide_after_merge' && h?.event==='native_post_merge_scope_disposition';
  if(source?.state!=='reactive' || p?.event!=='pr_lifecycle_action' || (!ci && !merged) ||
    source.key!==`${p.lifecycle_key}:${p.lifecycle_generation}` || input.ack!==false || input.artifacts?.length ||
    handoff?.kind!=='configuration' || !h.evidence_ref || input.evidence_ref!==h.evidence_ref ||
    h.owner_thread_id!==p.owner_thread_id || !h.affected_task_ids?.includes(p.task_id) ||
    `${h.repository}#${h.pr_number}`!==p.pr_key || !aliases(['expected_head','head','expected_head_sha'],p.head,true) ||
    !aliases(['progress_event_key','original_source_event_key'],source.key,merged) ||
    !aliases(['lifecycle_key','original_lifecycle_key'],p.lifecycle_key,merged) ||
    !aliases(['lifecycle_generation'],p.lifecycle_generation,merged || h.lifecycle_key!==undefined || h.original_lifecycle_key!==undefined)) fail();
  const owner=registry?.task_registry?.items?.[p.task_id]?.owner_thread_id;
  if(owner!==p.owner_thread_id || !input.goals?.some(g=>g.stages?.some(s=>s.task_id===p.task_id && s.owner_thread_id===owner)) ||
    !input.goals?.some(g=>!g.complete && g.stages?.some(s=>s.task_id===p.task_id && s.state!=='complete'))) fail();
  const task=db.prepare('SELECT owner_id FROM rt_tasks WHERE task_id=?').get(p.task_id);
  const event=db.prepare('SELECT * FROM rt_events WHERE event_id=?').get(`legacy:${source.key}:${p.task_id}`);
  const consumed=event && JSON.parse(event.payload);
  if(!consumed || ['task_id','owner_thread_id','pr_key','head','lifecycle_key','lifecycle_generation','action','state','merge_sha'].some(k=>consumed[k]!==p[k])) fail();
  const decision=event?.decision_id && db.prepare('SELECT * FROM rt_decisions WHERE id=?').get(event.decision_id);
  if(task?.owner_id!==owner || event?.task_id!==p.task_id || event.source!=='legacy_mailbox' || event.disposition!=='handled' ||
    !decision || decision.task_id!==p.task_id || !['wait','continue','revise','needs_decision'].includes(decision.disposition) ||
    decision.context_rev!==h.runtime_context?.context_rev || decision.plan_rev!==h.runtime_context?.plan_rev) fail();
  const decisionEvidence=JSON.parse(decision.data).evidence_refs ?? [];
  if(h.event==='native_duplicate_ci_obligation_disposition' && !decisionEvidence.includes(h.evidence_ref)) fail();
  if(merged) {
    const watch=db.prepare('SELECT * FROM lifecycle_prs WHERE pr_key=?').get(p.pr_key);
    const snapshot=watch?.snapshot && JSON.parse(watch.snapshot);
    if(p.state!=='merged' || !/^[a-f0-9]{40,64}$/.test(p.merge_sha??'') ||
      !aliases(['expected_merge_sha'],p.merge_sha,true) || !h.scoped_acceptance_ref ||
      !decisionEvidence.includes(h.scoped_acceptance_ref) || watch?.task_id!==p.task_id || watch.owner_id!==owner ||
      snapshot?.state!=='merged' || snapshot.head_sha!==p.head || snapshot.merge_sha!==p.merge_sha ||
      !Number.isFinite(Date.parse(snapshot.merged_at))) fail();
  }
  return {source_event_key:source.key,handoff_event_key:handoff.key,decision_id:decision.id,
    batch_id:input.batch_id,task_id:p.task_id,owner_thread_id:owner,head:p.head,evidence_ref:h.evidence_ref,
    ...(merged?{merge_sha:p.merge_sha}: {})};
}
