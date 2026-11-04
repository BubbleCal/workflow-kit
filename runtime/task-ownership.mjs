import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export function readTaskRegistry(databasePath) {
  if (databasePath === ':memory:') return null;
  const path = resolve(dirname(databasePath), 'registry.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { task_registry: { items: {} } };
}
export function ownershipReasons(kind, taskId, payload, evidence, registry, db, actionKey) {
  if (!registry || !['dispatch', 'human_input'].includes(kind)) return [];
  const dispatcher = registry.queue_transport?.dispatcher_thread_id;
  if (kind === 'human_input' && payload.thread_id === dispatcher && payload.intent === 'invoke_dispatcher') {
    const rule = registry.queue_transport?.immediate_human_trigger;
    const expectedKey = `human-trigger:${payload.source_message_id}:dispatcher`;
    const authenticated = rule?.enabled === true && evidence.trigger_rule_source_id === rule.source_message_id &&
      evidence.service_invocation_authorized === true && evidence.actual_human_message_verified === true &&
      evidence.source_actor_verified === true && payload.source_message_id === evidence.source_message_id &&
      payload.trigger_action_key === expectedKey && actionKey === expectedKey;
    const idle = evidence.thread_status === 'idle' && evidence.queued_input === false &&
      evidence.pending_dispatch === false && evidence.underlying_job_running === false;
    return authenticated && idle ? [] : ['authenticated_idle_dispatcher_invocation_required'];
  }
  const controls = [registry.coordinator_thread_id,registry.hub_thread_id,registry.decision_inbox_thread_id,registry.setup_thread_id];
  if (controls.includes(payload.thread_id)) return [];
  const tasks=registry.task_registry?.items??{},task=tasks[taskId];
  if (!task?.canonical_key || task.owner_thread_id!==payload.thread_id) return ['registered_task_owner_identity_required'];
  // A native creation receipt predates later erroneous registry reassignment.
  const created=db.prepare(`SELECT a.payload FROM thread_setups s JOIN actions a ON a.action_key=s.creation_key
    WHERE s.thread_id=? AND a.kind='create_thread' AND a.state='sent' ORDER BY a.created_at LIMIT 1`).get(payload.thread_id);
  const declared=registry.task_chat_bindings?.[payload.thread_id];
  const keys=created ? [JSON.parse(created.payload).canonical_task_key] : declared?.canonical_task_key && declared.evidence_ref ?
    [declared.canonical_task_key] : [...new Set(Object.values(tasks).filter(t=>t.owner_thread_id===payload.thread_id).map(t=>t.canonical_key))];
  if(keys.length===1 && keys[0]===task.canonical_key)return [];
  // Only an actual scoped release instruction may address the mixed old writer;
  // it cannot start further implementation of the unrelated task.
  if(kind==='human_input' && payload.intent==='scope_handoff_checkpoint' && evidence.actual_human_message_verified===true &&
      evidence.scope_release_only===true && evidence.explicit_scope_split_verified===true &&
      payload.handoff_task_id===taskId && payload.handoff_canonical_task_key===task.canonical_key)return [];
  return ['chat_canonical_task_mismatch'];
}
export function scopedHandoffReasons(taskId,payload,evidence) {
  const h=payload.scope_handoff;if(!h)return [];
  const reasons=[];
  if(h.task_id!==taskId || h.canonical_task_key!==payload.canonical_task_key || !h.from_thread_id ||
      !h.checkpoint_path || !/^[a-f0-9]{64}$/.test(h.checkpoint_sha256??'') ||
      evidence.explicit_scope_split_verified!==true || evidence.old_scope_writer_quiescent!==true ||
      evidence.scope_write_ownership_released!==true || evidence.healthy_jobs_preserved!==true ||
      evidence.job_ownership_handoff_verified!==true || evidence.duplicate_execution_owner_exists!==false)
    reasons.push('verified_same_task_scope_handoff_required');
  try {
    if(createHash('sha256').update(readFileSync(h.checkpoint_path)).digest('hex')!==h.checkpoint_sha256)
      reasons.push('scope_handoff_checkpoint_changed');
  } catch { reasons.push('scope_handoff_checkpoint_unavailable'); }
  return reasons;
}
