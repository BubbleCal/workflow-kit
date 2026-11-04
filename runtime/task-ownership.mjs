import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

export function readTaskRegistry(databasePath) {
  if (databasePath === ':memory:') return null;
  const path = resolve(dirname(databasePath), 'registry.json');
  const legacy=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{task_registry:{items:{}}};
  const configPath=resolve(dirname(databasePath),'instance.json');
  const config=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):null;
  if(config?.layout!=='native')return legacy;
  const items={...legacy.task_registry?.items};
  const catalogPath=resolve(dirname(databasePath),'control.sqlite');
  if(existsSync(catalogPath)) {
    const db=new DatabaseSync(catalogPath,{readOnly:true});
    try{if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='work_items'").get())for(const t of db.prepare('SELECT * FROM work_items').all()){
      const data=JSON.parse(t.data),authorization=t.authorization?JSON.parse(t.authorization):null;
      items[t.id]={id:t.id,canonical_key:t.canonical_key,owner_thread_id:t.owner_thread_id,status:t.state,
        authorization_message_id:authorization?.source_message_id,source_user_message_id:authorization?.source_message_id,
        kind:t.kind,workspace:data.workspace,hold:t.state==='paused'};
    }}finally{db.close();}
  }
  return {...legacy,instance_id:config.instance_id,scope:config.scope,policy_version:'native-0.5',
    hub_thread_id:config.threads.main,decision_inbox_thread_id:config.threads.main,discovery_thread_id:config.threads.discovery??null,
    coordinator_thread_id:null,setup_thread_id:null,state_writer_thread_id:null,task_registry:{items}};
}
export function ownershipReasons(kind, taskId, payload, evidence, registry, db, actionKey) {
  if (!registry || !['task_queue','task_wake', 'dispatch', 'human_input'].includes(kind)) return [];
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
  const controls = [registry.coordinator_thread_id,registry.hub_thread_id,registry.decision_inbox_thread_id,registry.setup_thread_id,registry.discovery_thread_id].filter(Boolean);
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
