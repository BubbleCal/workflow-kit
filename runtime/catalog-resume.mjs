import {nativeReadback,verifyNativeBinding} from './native-queue.mjs';

// A native contract may have been explicitly resumed after a legacy catalog
// snapshot was imported. Reconcile registration only; never start/resume work.
export function reconcileCatalogResume(control,input){
  const {task_id,expected_revision,expected_contract_rev,source_message_id,evidence_ref,native_binding,actual_human_verified}=input;
  if(actual_human_verified!==true||!source_message_id||!evidence_ref)throw new Error('Verify the original human resume authorization');
  return control.atomic(()=>{
    const work=control.work,task=work.get(task_id),runtime=control.reactive.task(task_id);
    const contract=control.db.prepare('SELECT * FROM rt_contracts WHERE task_id=? AND revision=?').get(task_id,expected_contract_rev);
    if(!task||!runtime||!contract||runtime.contract_rev!==expected_contract_rev||runtime.contract.canonical_key!==task.canonical_key||
       contract.source_message_id!==source_message_id||runtime.contract.authorization_ref!==evidence_ref)
      throw new Error('Current matching runtime contract and original human source required');
    const c=runtime.contract;
    if(!['active','paused'].includes(runtime.mode)||runtime.status==='complete'||c.service_lane||c.project_id!==work.config.scope?.project_id||
       (task.data.parent_id&&work.get(task.data.parent_id)?.state==='completed'))throw new Error('Preserve runtime driver, completion and parent protections');
    if(task.data.source?.kind!=='legacy_reference'||task.data.legacy_owner_thread_id!==runtime.owner_id)
      throw new Error('Only the same original owner of an imported legacy reference can be reconciled');
    const protectedOwners=[work.config.threads?.main,work.config.threads?.discovery,...Object.values(work.config.control_lanes??{}).map(x=>x.thread_id)];
    if(protectedOwners.includes(runtime.owner_id))throw new Error('Control/discovery owners cannot own resumed product work');
    verifyNativeBinding(native_binding,{thread_id:runtime.owner_id,workspace:c.workspace,now:work.now()});
    const turn=nativeReadback(native_binding.readback).turns?.[0];
    const wake=control.db.prepare(`SELECT w.id FROM rt_wakes w JOIN rt_wake_members m ON m.wake_id=w.id
      WHERE m.task_id=? AND w.owner_id=? AND w.turn_id=? AND w.started_at>=? AND w.state IN ('running','finished')`).get(task_id,runtime.owner_id,turn?.id??'',contract.created_at);
    if(!wake)throw new Error('A genuine acknowledged owner turn under the resumed contract is required');
    const prior=task.data.catalog_runtime_resume;
    if(task.state==='accepted'&&task.owner_thread_id===runtime.owner_id&&prior?.source_message_id===source_message_id&&prior.contract_rev===expected_contract_rev)
      return {reconciled:false,already_reconciled:true,task,execution_started:false};
    if(task.revision!==expected_revision||task.state!=='completed'||task.owner_thread_id||task.binding||contract.created_at<=task.updated_at)
      throw new Error('Only a stale completed unowned catalog snapshot predating the runtime resume can be reconciled');
    const fields=['objective','requirements','constraints','workspace','pull_requests','job_sources','schedule_sources','trigger_only'];
    const previous={state:task.state,revision:task.revision,authorization:task.authorization,binding:task.binding,
      fields:Object.fromEntries(fields.filter(k=>task.data[k]!==undefined).map(k=>[k,task.data[k]]))};
    const data={...task.data};
    for(const field of fields){if(c[field]===undefined)delete data[field];else data[field]=c[field];}
    data.catalog_runtime_resume={source_message_id,evidence_ref,contract_rev:expected_contract_rev,owner_id:runtime.owner_id,
      acknowledged_wake_id:wake.id,native_evidence_ref:native_binding.evidence_ref,recorded_at:work.now(),previous};
    const authorization={source_message_id,evidence_ref,actual_human_verified:true,provenance:'existing_resumed_runtime_contract'};
    const binding={source_message_id,evidence_ref:native_binding.evidence_ref,native_binding,existing_owner_authorized:true};
    control.db.prepare("UPDATE work_items SET state='accepted',owner_thread_id=?,authorization=?,binding=?,data=?,revision=revision+1,updated_at=? WHERE id=?")
      .run(runtime.owner_id,JSON.stringify(authorization),JSON.stringify(binding),JSON.stringify(data),work.now(),task_id);
    return {reconciled:true,task:work.get(task_id),execution_started:false,runtime_status_preserved:runtime.status};
  });
}
