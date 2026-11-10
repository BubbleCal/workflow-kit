import {verifyNativeBinding,nativeReadback} from './native-queue.mjs';

export function reconcileCompletedProjection(control,input){return control.atomic(()=>{
 const {task_id,expected_context_rev,completion_id,source_message_id,evidence_ref,native_proof,resolutions=[]}=input;
 if(input.actual_human_verified!==true||!source_message_id||!evidence_ref)throw new Error('Actual scoped maintenance authority required');
 const s=control.reactive,t=s.task(task_id),d=control.db.prepare('SELECT * FROM rt_decisions WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(task_id);
 if(!t||t.mode!=='active'||t.status!=='needs_decision'||t.context_rev!==expected_context_rev||d?.disposition!=='complete'||d.id!==completion_id||t.contract.service_lane||t.contract.retired)
  throw new Error('Exact historical completion and unchanged reopened projection required');
 const revision=control.db.prepare('SELECT created_at FROM rt_contracts WHERE task_id=? AND revision=?').get(task_id,t.contract_rev),data=JSON.parse(d.data);
 if(revision.created_at>d.created_at||!t.contract.requirements.every(r=>data.acceptance?.some(a=>a.requirement_id===r.id&&a.passed&&a.evidence_ref)))throw new Error('Current whole-scope acceptance must still match the original completion');
 verifyNativeBinding(native_proof,{thread_id:t.owner_id,workspace:t.contract.workspace,now:control.now()});
 const read=nativeReadback(native_proof.readback);
 if(!['idle','notLoaded'].includes(read.thread.status?.type)||read.turns?.[0]?.status!=='completed'||read.turns[0].error||input.no_pending_jobs_verified!==true||input.resource_cleanup_verified!==true||control.db.prepare("SELECT 1 FROM actions WHERE task_id=? AND state IN ('claimed','uncertain')").get(task_id))throw new Error('Original completed owner must be quiescent with reconciled jobs and effects');
 const events=s.checkpoint(task_id).events,w=s.openWake(task_id);
 if(!events.length||resolutions.length!==events.length||events.some(e=>e.type!=='source_changed'||!resolutions.some(r=>r.event_id===e.event_id&&['already_answered','context_only','outside_accepted_scope'].includes(r.disposition)&&r.reason?.trim()&&r.evidence_refs?.length)))throw new Error('Every post-completion source event needs its exact evidenced disposition; new human commands cannot be discarded');
 if(w&&(w.state!=='queued'||w.queue_id!==input.expected_queue_id||w.id!==input.expected_wake_id||w.turn_id||w.started_at||w.owner_id!==t.owner_id||w.transport!=='native_queue'||w.member_ids.length!==1||w.member_ids[0]!==task_id))throw new Error('Preserve consumed, active or uncertain executions');
 if(!w&&(input.expected_wake_id||input.expected_queue_id))throw new Error('Original queue identity changed');
 if(w)control.db.prepare("UPDATE rt_wakes SET state='superseded',completed_at=? WHERE id=?").run(control.now(),w.id);
 for(const r of resolutions)control.db.prepare('UPDATE rt_events SET disposition=?,decision_id=? WHERE event_id=? AND task_id=? AND disposition IS NULL').run(r.disposition,d.id,r.event_id,task_id);
 control.db.prepare("UPDATE rt_tasks SET status='complete',dirty=0,wake_at=NULL,first_pending_at=NULL,updated_at=? WHERE task_id=?").run(control.now(),task_id);
 s.diagnostic(`completion-projection:${task_id}:${d.id}`,{source_message_id,evidence_ref,resolutions,original_queue_id:w?.queue_id??null,original_queue_consumed:false,original_completion_preserved:true});
 return {reconciled:true,task_id,completion_id:d.id,queue_superseded:!!w,original_queue_consumed:false,owner_unchanged:true};
});}

export function reconcileReviewWorkspace(control,input){return control.atomic(()=>{
 const {task_id,expected_contract_rev,expected_revision,owner_thread_id,workspace,source_message_id,evidence_ref,native_proof}=input;
 if(input.actual_human_verified!==true||!source_message_id||!evidence_ref)throw new Error('Actual workflow repair authority required');
 const t=control.reactive.task(task_id),item=control.work.get(task_id);
 if(!t||t.mode!=='active'||t.contract.retired||t.status==='complete'||item?.state!=='accepted'||t.owner_id!==owner_thread_id||item?.owner_thread_id!==owner_thread_id||item.data.source?.review_only!==true||workspace!==control.work.config.scope.project_root||t.contract_rev!==expected_contract_rev||item.revision!==expected_revision)throw new Error('Exact accepted original read-only review and verified project root required');
 verifyNativeBinding(native_proof,{thread_id:owner_thread_id,workspace,now:control.now()});
 const native=nativeReadback(native_proof.readback);
 if(!['idle','notLoaded'].includes(native.thread.status?.type)||native.turns[0]?.status!=='completed'||native.turns[0]?.error||['running','uncertain','reserved'].includes(control.reactive.openWake(task_id)?.state)||control.db.prepare("SELECT 1 FROM actions WHERE task_id=? AND state IN ('claimed','uncertain')").get(task_id))throw new Error('Preserve active review work and unknown effects');
 const contract={...t.contract,workspace},data={...item.data,workspace};
 control.db.prepare('INSERT INTO rt_contracts VALUES (?,?,?,?,?)').run(task_id,t.contract_rev+1,JSON.stringify(contract),source_message_id,control.now());
 control.db.prepare('UPDATE rt_tasks SET contract=?,contract_rev=contract_rev+1 WHERE task_id=?').run(JSON.stringify(contract),task_id);
 control.db.prepare('UPDATE work_items SET data=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(data),control.now(),task_id);
 control.reactive.diagnostic(`review-workspace:${task_id}`,{source_message_id,evidence_ref,old_workspace:t.contract.workspace,new_workspace:workspace,owner_unchanged:true,scope_unchanged:true,native_evidence_ref:native_proof.evidence_ref});
 return {reconciled:true,task_id,contract_rev:t.contract_rev+1,catalog_revision:item.revision+1,owner_unchanged:true,scope_unchanged:true};
});}
