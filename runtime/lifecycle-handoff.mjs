// Bind an admitted coordinator handoff to the original native-consumed CI event.
// Batch membership belongs to the handoff; it is never fabricated for the source.
export function bindLifecycleHandoff({ source, handoff, input, db, registry }) {
  const p=source?.payload, h=handoff?.payload;
  const fail=()=>{throw new Error('Exact native CI handoff binding required');};
  if(source?.state!=='reactive' || p?.event!=='pr_lifecycle_action' || p.action!=='triage_ci' ||
    source.key!==`${p.lifecycle_key}:${p.lifecycle_generation}` || input.ack!==false || input.artifacts?.length ||
    handoff?.kind!=='configuration' || !['native_ci_triage_result','resolve_exact_completed_ci_triage_notice'].includes(h?.event) ||
    !h.evidence_ref || input.evidence_ref!==h.evidence_ref ||
    h.owner_thread_id!==p.owner_thread_id || !h.affected_task_ids?.includes(p.task_id) ||
    `${h.repository}#${h.pr_number}`!==p.pr_key || (h.expected_head??h.head)!==p.head ||
    h.progress_event_key && h.progress_event_key!==source.key ||
    h.lifecycle_key && (h.lifecycle_key!==p.lifecycle_key || h.lifecycle_generation!==p.lifecycle_generation)) fail();
  const owner=registry?.task_registry?.items?.[p.task_id]?.owner_thread_id;
  if(owner!==p.owner_thread_id || !input.goals?.some(g=>g.stages?.some(s=>s.task_id===p.task_id && s.owner_thread_id===owner)) ||
    !input.goals?.some(g=>!g.complete && g.stages?.some(s=>s.task_id===p.task_id && s.state!=='complete'))) fail();
  const task=db.prepare('SELECT owner_id FROM rt_tasks WHERE task_id=?').get(p.task_id);
  const event=db.prepare('SELECT * FROM rt_events WHERE event_id=?').get(`legacy:${source.key}:${p.task_id}`);
  const consumed=event && JSON.parse(event.payload);
  if(!consumed || ['task_id','owner_thread_id','pr_key','head','lifecycle_key','lifecycle_generation','action'].some(k=>consumed[k]!==p[k])) fail();
  const decision=event?.decision_id && db.prepare('SELECT * FROM rt_decisions WHERE id=?').get(event.decision_id);
  if(task?.owner_id!==owner || event?.task_id!==p.task_id || event.source!=='legacy_mailbox' || event.disposition!=='handled' ||
    !decision || decision.task_id!==p.task_id || !['wait','continue','revise','needs_decision'].includes(decision.disposition) ||
    decision.context_rev!==h.runtime_context?.context_rev || decision.plan_rev!==h.runtime_context?.plan_rev) fail();
  return {source_event_key:source.key,handoff_event_key:handoff.key,decision_id:decision.id,
    batch_id:input.batch_id,task_id:p.task_id,owner_thread_id:owner,head:p.head,evidence_ref:h.evidence_ref};
}
