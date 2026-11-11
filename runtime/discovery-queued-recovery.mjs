import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {verifyNativeBinding,nativeReadback,messageDigest} from './native-queue.mjs';
import {verifyFollowupAuthority} from './human-followup.mjs';

export const isDiscoveryResume=(kind,p)=>kind==='human_input'&&p?.intent==='resume_discovery_batch';
// A distinct authorized recovery hint never claims consumption of the old queue.
export function discoveryResumeReasons(control,p,e,key){
 try{
  const config=control.work.config,b=control.discovery.batch(p.batch_id);
  if(!b||b.state!=='pending'||b.generation!==p.generation||b.mail_key!==p.expected_mail_key||p.thread_id!==config.threads.discovery||p.native_resume_only!==true||
    key!==`resume-discovery:${b.id}:${b.generation}:${p.existing_queue_id}`)return['exact_original_discovery_queue_required'];
  verifyFollowupAuthority(e.human_authorization,p);
  const workspace=config.thread_workspaces?.discovery??config.scope.project_root;
  verifyNativeBinding(e.native_proof,{thread_id:p.thread_id,workspace,now:control.now()});
  const native=nativeReadback(e.native_proof.readback),turn=native.turns?.[0];
  if(!['idle','notLoaded'].includes(native.thread.status.type)||turn?.status!=='completed'||turn.error||(native.thread.status.activeFlags??[]).length)return['discovery_owner_busy_or_failed'];
  if(control.db.prepare('SELECT 1 FROM work_creation_runs WHERE batch_id=? AND generation=?').get(b.id,b.generation)||
    control.db.prepare("SELECT 1 FROM discovery_batches WHERE state='running'").get()||control.db.prepare("SELECT 1 FROM actions WHERE owner=? AND state IN ('claimed','uncertain') AND action_key<>?").get(p.thread_id,key))return['discovery_already_executing_or_effect_uncertain'];
  control.discovery.checkBatch(b.id);
  const last=control.db.prepare('SELECT MAX(started_at) at FROM discovery_batches').get().at,min=config.discovery?.min_start_interval_ms??900000;
  if(last!==null&&control.now()-last<min)return['discovery_start_interval'];
  const mailbox=new DatabaseSync(join(config.instance_root,'mailbox.sqlite'),{readOnly:true});
  try{
   const batch=mailbox.prepare('SELECT * FROM batches WHERE id=?').get(p.mailbox_batch_id),mail=mailbox.prepare('SELECT * FROM mail WHERE item_key=?').get(b.mail_key);
   const receipt=batch&&JSON.parse(batch.receipt??'{}'),snapshot=batch&&JSON.parse(batch.snapshot),q=receipt?.queue_receipt;
   if(!batch||batch.lane!=='discovery'||batch.state!=='sent'||batch.turn_id||snapshot?.delivery_transport!=='native_queue'||batch.prompt!==b.prompt||
     q?.queued!==true||q.execution_verified!==false||q.message_digest!==messageDigest(b.prompt)||!Number.isFinite(q.submitted_at)||!Number.isFinite(q.accepted_at)||q.accepted_at<q.submitted_at||q.thread_id!==p.thread_id||q.queue_id!==p.existing_queue_id||mail?.batch_id!==batch.id||mail.state!=='in_batch'||!snapshot.items?.some(i=>i.key===b.mail_key&&i.payload?.batch_id===b.id))return['original_discovery_transport_receipt_changed'];
  }finally{mailbox.close();}
  return[];
 }catch{return['fresh_original_discovery_human_and_native_evidence_required'];}
}
