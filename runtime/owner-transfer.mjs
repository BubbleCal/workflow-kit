import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {verifyNativeBinding,nativeReadback} from './native-queue.mjs';
import {canonical} from './reactive-state.mjs';

export function transferPausedOwner(control,input) {
  const {task_id,from_thread_id,to_thread_id,creation_action_key,source_message_id,checkpoint_path,checkpoint_sha256}=input;
  if(input.actual_human_verified!==true||input.scope_release_verified!==true||!source_message_id||
    createHash('sha256').update(readFileSync(checkpoint_path)).digest('hex')!==checkpoint_sha256)
    throw new Error('Actual user split and unchanged released-scope checkpoint required');
  return control.atomic(()=>{
    const db=control.db,t=control.reactive.task(task_id);
    db.exec('CREATE TABLE IF NOT EXISTS rt_owner_transfers (task_id TEXT PRIMARY KEY,source_message_id TEXT NOT NULL,from_owner TEXT NOT NULL,to_owner TEXT NOT NULL,checkpoint TEXT NOT NULL,old_task TEXT NOT NULL,created_at INTEGER NOT NULL)');
    const prior=db.prepare('SELECT * FROM rt_owner_transfers WHERE task_id=?').get(task_id);
    if(prior){if(prior.to_owner!==to_thread_id||prior.source_message_id!==source_message_id)throw new Error('Owner transfer already has another identity');return {transferred:false,duplicate:true,task:control.reactive.task(task_id)};}
    if(!t||t.mode!=='paused'||t.status==='complete'||t.owner_id!==from_thread_id||from_thread_id===to_thread_id)
      throw new Error('Only an unfinished paused original task can change owner');
    if(control.reactive.openWake(task_id)||db.prepare("SELECT 1 FROM actions WHERE task_id=? AND state IN ('claimed','uncertain')").get(task_id))
      throw new Error('Reconcile task wake and action receipts before owner transfer');
    if(db.prepare("SELECT 1 FROM rt_tasks WHERE owner_id=? AND status<>'complete'").get(to_thread_id))
      throw new Error('New owner already has an unfinished task');
    const action=db.prepare("SELECT * FROM actions WHERE action_key=? AND kind='create_thread' AND state='sent'").get(creation_action_key);
    const setup=db.prepare('SELECT * FROM thread_setups WHERE creation_key=?').get(creation_action_key);
    const payload=action&&JSON.parse(action.payload),h=payload?.scope_handoff;
    if(action?.task_id!==task_id||setup?.state!=='complete'||setup.thread_id!==to_thread_id||
      payload?.canonical_task_key!==t.contract.canonical_key||payload.source_message_id!==source_message_id||
      h?.from_thread_id!==from_thread_id||h.checkpoint_sha256!==checkpoint_sha256||h.checkpoint_path!==checkpoint_path)
      throw new Error('Verified creation and exact original-task handoff receipts required');
    const old=verifyNativeBinding(input.old_native_binding,{thread_id:from_thread_id,workspace:t.contract.workspace,now:control.now()});
    const oldRead=nativeReadback(input.old_native_binding.readback);
    if(!['idle','notLoaded'].includes(oldRead.thread.status?.type)||oldRead.turns?.[0]?.status!=='completed')throw new Error('Old writer must finish its scope release');
    const nextRead=nativeReadback(input.native_binding?.readback);
    const binding=verifyNativeBinding(input.native_binding,{thread_id:to_thread_id,workspace:nextRead.thread?.cwd,now:control.now()});
    if(nextRead.turns?.[0]?.status!=='completed')throw new Error('New owner setup must finish before transfer');
    const contract={...t.contract,workspace:binding.workspace,ownership_handoff:{from_thread_id,checkpoint_path,checkpoint_sha256,source_message_id,previous_workspace:old.workspace}};
    db.prepare('INSERT INTO rt_owner_transfers VALUES (?,?,?,?,?,?,?)').run(task_id,source_message_id,from_thread_id,to_thread_id,checkpoint_path,canonical(t),control.now());
    db.prepare('INSERT INTO rt_contracts VALUES (?,?,?,?,?)').run(task_id,t.contract_rev+1,canonical(contract),source_message_id,control.now());
    db.prepare("UPDATE rt_tasks SET owner_id=?,contract=?,contract_rev=contract_rev+1,dirty=1,status='ready',wake_at=NULL,updated_at=? WHERE task_id=?")
      .run(to_thread_id,canonical(contract),control.now(),task_id);
    db.prepare('UPDATE lifecycle_prs SET owner_id=? WHERE task_id=? AND owner_id=?').run(to_thread_id,task_id,from_thread_id);
    return {transferred:true,task:control.reactive.task(task_id),receipts_preserved:true,execution_started:false};
  });
}
