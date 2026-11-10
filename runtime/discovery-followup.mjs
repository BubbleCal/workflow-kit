import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {verifyHumanFollowup,verifyFollowupAuthority,verifyDirectDiscoveryHuman} from './human-followup.mjs';

export function beginDiscoveryInteractive(control,input){
 const {batch_id,generation,expected_mail_key,source_message_id,verbatim_text,evidence_ref,native_proof}=input;
 if(input.actual_human_verified!==true||!evidence_ref)throw new Error('Actual direct human discovery request required');
 const result=control.atomic(()=>{
  const d=control.discovery;let b=d.batch(batch_id);
  if(!b||!['pending','running','checkpointed'].includes(b.state))throw new Error('Original pending or checkpointed discovery batch required');
  if(b.generation!==generation||b.mail_key!==expected_mail_key)throw new Error('Exact original discovery batch/generation/mail identity required');
  const proof=verifyDirectDiscoveryHuman(native_proof,{config:control.work.config,source_message_id,verbatim_text,now:control.now()});
  for(const source of b.snapshot.sources){const current=d.sources().find(s=>s.source_id===source.source_id);if(!current?.enabled||current.revision!==source.revision)throw new Error('Discovery source scope changed');}
  if(control.db.prepare("SELECT 1 FROM work_creation_runs r JOIN discovery_batches b ON b.id=r.batch_id AND b.generation=r.generation WHERE b.state='running' AND r.turn_id<>?").get(proof.turn_id))throw new Error('Preserve another acknowledged discovery writer');
  const resumed=b.state==='checkpointed';
  if(resumed){
   if(control.db.prepare("SELECT 1 FROM discovery_batches WHERE id<>? AND state='pending'").get(batch_id))throw new Error('Checkpoint resume requires first acknowledging and checkpointing the existing pending batch with its original scope and real blockers');
   const next=b.generation+1,prompt=b.prompt.replace(`[workflow-discovery:${b.id}:${b.generation}]`,`[workflow-discovery:${b.id}:${next}]`).replace(`generation=${b.generation}`,`generation=${next}`);
   control.db.prepare("UPDATE discovery_batches SET state='pending',generation=?,mail_key=?,prompt=?,started_at=NULL WHERE id=?").run(next,`discovery:${b.id}:${next}`,prompt,b.id);b=d.batch(b.id);
  }
  const previous=control.db.prepare('SELECT turn_id FROM work_creation_runs WHERE batch_id=? AND generation=?').get(batch_id,b.generation);
  if(previous&&previous.turn_id!==proof.turn_id)throw new Error('Preserve an already acknowledged discovery writer');
  control.reactive.diagnostic(`discovery-followup:${batch_id}:${b.generation}`,{transport:'direct_human',source_message_id,verbatim_text,evidence_ref,turn_id:proof.turn_id,mail_key:b.mail_key,original_queue_consumed:false});
  d.selectHealth(b);control.work.creation.recordRun(b,proof);
  control.db.prepare("UPDATE discovery_batches SET state='running',started_at=COALESCE(started_at,?) WHERE id=?").run(control.now(),batch_id);
  return {batch_id,generation:b.generation,resumed_checkpoint:resumed,turn_id:proof.turn_id,mail_key:b.mail_key,original_queue_consumed:false};
 });
 const mailbox=new DatabaseSync(join(control.work.config.instance_root,'mailbox.sqlite'));
 try{mailbox.exec('PRAGMA busy_timeout=5000');mailbox.prepare("UPDATE mail SET state='superseded' WHERE item_key=? AND state='pending' AND batch_id IS NULL").run(result.mail_key);}finally{mailbox.close();}
 return {...result,batch:control.discovery.plan(batch_id)};
}

export function beginDiscoveryFollowup(control,input){
 const {batch_id,generation,action_key,source_message_id,expected_mail_key,evidence_ref,native_proof,human_authorization,actual_human_verified}=input;
 if(actual_human_verified!==true||!source_message_id||!evidence_ref)throw new Error('Actual scoped human recovery authorization required');
 const discovery=control.discovery,config=control.work.config;
 const result=control.atomic(()=>{
  let b=discovery.batch(batch_id);
  if(!b||!['pending','running','checkpointed'].includes(b.state))throw new Error('Original pending or checkpointed discovery batch required');
  if(b.generation!==generation||b.mail_key!==expected_mail_key)throw new Error('Exact existing discovery batch/generation/delivery identity required');
  const action=control.db.prepare('SELECT * FROM actions WHERE action_key=?').get(action_key),task={task_id:'discovery',owner_id:config.threads.discovery,contract:{workspace:config.thread_workspaces?.discovery??config.scope.project_root}};
  const proof=verifyHumanFollowup(native_proof,{task,action,source_message_id,now:control.now()});verifyFollowupAuthority(human_authorization,proof.payload);
  if(proof.status!=='inProgress')throw new Error('Only the actual active discovery followup can begin setup');
  if(control.db.prepare("SELECT 1 FROM work_creation_runs r JOIN discovery_batches b ON b.id=r.batch_id AND b.generation=r.generation WHERE b.state='running' AND r.turn_id<>?").get(proof.turn_id))throw new Error('Preserve another acknowledged discovery writer');
  const resumed=b.state==='checkpointed';
  if(resumed){
   for(const source of b.snapshot.sources){const current=discovery.sources().find(s=>s.source_id===source.source_id);if(!current?.enabled||current.revision!==source.revision)throw new Error('Discovery source scope changed');}
   if(control.db.prepare("SELECT 1 FROM discovery_batches WHERE id<>? AND state='pending'").get(batch_id))throw new Error('Checkpoint resume requires first acknowledging and checkpointing the existing pending batch with its original scope and real blockers');
   const next=b.generation+1,prompt=b.prompt.replace(`[workflow-discovery:${b.id}:${b.generation}]`,`[workflow-discovery:${b.id}:${next}]`).replace(`generation=${b.generation}`,`generation=${next}`);
   control.db.prepare("UPDATE discovery_batches SET state='pending',generation=?,mail_key=?,prompt=?,started_at=NULL WHERE id=?").run(next,`discovery:${b.id}:${next}`,prompt,b.id);
   b=discovery.batch(b.id);
  }
  discovery.checkBatch(batch_id);
  const previous=control.db.prepare('SELECT * FROM work_creation_runs WHERE batch_id=? AND generation=?').get(batch_id,b.generation);
  if(previous&&previous.turn_id!==proof.turn_id)throw new Error('Preserve an already acknowledged discovery writer');
  control.reactive.diagnostic(`discovery-followup:${batch_id}:${b.generation}`,{action_key,source_message_id,evidence_ref,turn_id:proof.turn_id,original_queue_consumed:false,mail_key:b.mail_key});
  discovery.selectHealth(b);control.work.creation.recordRun(b,proof);
  control.db.prepare("UPDATE discovery_batches SET state='running',started_at=COALESCE(started_at,?) WHERE id=?").run(control.now(),batch_id);
  return {batch_id,generation:b.generation,resumed_checkpoint:resumed,turn_id:proof.turn_id,original_queue_consumed:false,owner_unchanged:true,mail_key:b.mail_key};
 });
 // A human relay may arrive before the normal queue sends the pending batch.
 // Retire only a still-unsent delivery, retaining its immutable input. If the
 // daemon raced ahead, leave its receipt untouched; a late begin is skipped.
 const mailbox=new DatabaseSync(join(config.instance_root,'mailbox.sqlite'));
 try{mailbox.exec('PRAGMA busy_timeout=5000');const update=mailbox.prepare("UPDATE mail SET state='superseded' WHERE item_key=? AND state='pending' AND batch_id IS NULL").run(result.mail_key);
  return {...result,unsent_delivery_superseded:!!update.changes,batch:discovery.plan(batch_id)};
 }finally{mailbox.close();}
}

// An authenticated relay can retire a never-sent mailbox item. Its durable
// source checkpoint still needs a truthful local settlement, not a fake ACK.
export function settleDiscoveryDelivery(control,mailbox,batch,result){
 const mail=mailbox.db.prepare('SELECT state,batch_id FROM mail WHERE item_key=?').get(batch.mail_key);
 const current=control.discovery.batch(batch.id),row=control.db.prepare('SELECT data FROM rt_diagnostics WHERE key=?').get(`discovery-followup:${batch.id}:${batch.generation}`),binding=row&&JSON.parse(row.data);
 if(mail?.batch_id&&!binding){mailbox.finish(mail.batch_id,{processed_keys:[batch.mail_key],note:result.finished?'source scan completed':'source scan checkpointed'});return null;}
 const action=binding?.action_key?control.db.prepare('SELECT * FROM actions WHERE action_key=?').get(binding.action_key):null,payload=JSON.parse(action?.payload??'{}'),receipt=JSON.parse(action?.receipt??'{}');
 const native=receipt.native_result?.structuredContent??receipt.native_result?.content?.flatMap(c=>{try{return [JSON.parse(c.text)];}catch{return [];}}).find(c=>c.threadId);
 const run=control.db.prepare('SELECT thread_id,turn_id FROM work_creation_runs WHERE batch_id=? AND generation=?').get(batch.id,batch.generation);
 const direct=binding?.transport==='direct_human'&&binding.source_message_id&&binding.verbatim_text&&run?.thread_id===control.work.config.threads.discovery&&run.turn_id===binding.turn_id;
 const relay=action?.kind==='human_input'&&action.task_id==='discovery'&&action.state==='sent'&&payload.thread_id===control.work.config.threads.discovery&&receipt.outcome==='sent'&&receipt.native_result?.isError!==true&&native?.threadId===payload.thread_id&&run?.thread_id===control.work.config.threads.discovery&&run.turn_id===binding?.turn_id;
 if(!mail&&!direct&&!relay||mail&&!mail.batch_id&&mail.state!=='superseded'||!current||current.generation!==batch.generation||!['finished','checkpointed'].includes(current.state)||
  !binding?.turn_id||binding.mail_key!==batch.mail_key||binding.original_queue_consumed!==false||!direct&&!relay)
  throw new Error('Discovery queue receipt or exact authenticated superseded unsent relay required');
 if(mail?.batch_id)control.discovery.retireMailboxDelivery(mailbox,current,{reason:'authenticated_alternate_execution',queue_consumption_verified:false,turn_id:binding.turn_id});
 const key=`discovery-relay-finish:${batch.id}:${batch.generation}`,prior=control.db.prepare('SELECT data FROM rt_diagnostics WHERE key=?').get(key);
 if(prior)return JSON.parse(prior.data);
 const settlement={settled:true,transport:direct?'direct_human':'native_followup',batch_id:batch.id,generation:batch.generation,mail_key:batch.mail_key,action_key:binding.action_key,turn_id:binding.turn_id,state:current.state,original_queue_consumed:false,original_delivery_preserved:true};
 control.reactive.diagnostic(key,settlement);return settlement;
}
