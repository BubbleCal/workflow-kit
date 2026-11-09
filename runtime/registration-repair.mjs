import {verifyExecutionProof,nativeReadback} from './native-queue.mjs';

// Restore an already owned artifact's registration. This does not amend the
// product goal, transfer ownership or make any delivery/approval decision.
export function reconcileArtifactBinding(control,input){
 const {task_id,repository,pr_number,owner_thread_id,expected_contract_rev,expected_revision,source_message_id,evidence_ref,native_proof,actual_human_verified}=input;
 if(actual_human_verified!==true||!source_message_id||!evidence_ref)throw new Error('Actual workflow-repair authority and evidence required');
 return control.atomic(()=>{
  const task=control.reactive.task(task_id),item=control.work.get(task_id),key=`${repository}#${pr_number}`;
  const artifact=control.db.prepare('SELECT * FROM lifecycle_prs WHERE pr_key=? AND retired=0').get(key);
  if(!task||!item||task.owner_id!==owner_thread_id||item.owner_thread_id!==owner_thread_id||item.state!=='accepted'||task.status==='complete'||task.mode!=='active'||
   task.contract.canonical_key!==item.canonical_key||task.contract.service_lane||item.data.source?.review_only===true||
   !artifact||artifact.task_id!==task_id||artifact.owner_id!==owner_thread_id||!artifact.authorization_ref)
   throw new Error('Existing active original implementation owner and authorized lifecycle artifact required');
  if(!control.work.config.scope.repositories?.includes(repository))throw new Error('Artifact repository is outside instance scope');
  const read=nativeReadback(native_proof?.readback),turn=read.turns?.[0];
  const wake=control.db.prepare('SELECT * FROM rt_wakes WHERE task_id=? AND owner_id=? AND turn_id=?').get(task_id,owner_thread_id,turn?.id??'');
  if(!wake||!['running','finished','ended_unresolved'].includes(wake.state))throw new Error('Actual acknowledged original-owner turn required');
  verifyExecutionProof(native_proof,{thread_id:owner_thread_id,workspace:task.contract.workspace,prompt:wake.prompt,terminal:turn.status!=='inProgress',now:control.now()});
  const bound=prs=>prs?.some(p=>p.repository===repository&&p.pr_number===pr_number);
  if(bound(task.contract.pull_requests)&&bound(item.data.pull_requests))return {reconciled:false,already_bound:true,task_id,pr_key:key};
  if(task.contract_rev!==expected_contract_rev||item.revision!==expected_revision)throw new Error('Registration changed; reread contract and catalog revisions');
  if(control.db.prepare("SELECT 1 FROM actions WHERE task_id=? AND state IN ('claimed','uncertain')").get(task_id))throw new Error('Reconcile in-flight effects before registration repair');
  const add=prs=>bound(prs)?prs:[...(prs??[]),{repository,pr_number}];
  const contract={...task.contract,pull_requests:add(task.contract.pull_requests)},data={...item.data,pull_requests:add(item.data.pull_requests)},revision=task.contract_rev+1;
  control.db.exec('CREATE TABLE IF NOT EXISTS artifact_binding_repairs (task_id TEXT,pr_key TEXT,data TEXT,created_at INTEGER,PRIMARY KEY(task_id,pr_key))');
  const audit={source_message_id,evidence_ref,artifact_authorization_ref:artifact.authorization_ref,native_evidence_ref:native_proof.evidence_ref,owner_thread_id,old_contract_rev:task.contract_rev,new_contract_rev:revision,previous_contract_prs:task.contract.pull_requests,previous_catalog_prs:item.data.pull_requests,goal_unchanged:true};
  control.db.prepare('INSERT OR REPLACE INTO artifact_binding_repairs VALUES (?,?,?,?)').run(task_id,key,JSON.stringify(audit),control.now());
  control.db.prepare('INSERT INTO rt_contracts VALUES (?,?,?,?,?)').run(task_id,revision,JSON.stringify(contract),source_message_id,control.now());
  control.db.prepare('UPDATE rt_tasks SET contract=?,contract_rev=? WHERE task_id=?').run(JSON.stringify(contract),revision,task_id);
  control.db.prepare('UPDATE work_items SET data=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(data),control.now(),task_id);
  control.reactive.ingestInside({event_id:`artifact-binding-repaired:${task_id}:${key}`,task_id,source:'workflow_reconciliation',subject:`artifact:${key}`,type:'artifact_binding_reconciled',observed_at:control.now(),payload:{pr_key:key,owner_thread_id,source_message_id,goal_unchanged:true},evidence_ref,debounce_ms:0});
  return {reconciled:true,task_id,pr_key:key,contract_rev:revision,catalog_revision:item.revision+1,owner_unchanged:true,goal_unchanged:true,delivery_authorized:false};
 });
}
