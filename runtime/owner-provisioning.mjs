import {verifyDiscoveryExecution} from './human-followup.mjs';
import {verifyExecutionProof} from './native-queue.mjs';
import {readReviewIntake,reviewCreationReasons} from './review-intake.mjs';

// Creation authority comes from the human task/policy; the native actor only
// executes that authority. Keeping these separate prevents discovery prompts
// from becoming new scope or permission grants.
export class OwnerProvisioning {
 constructor(work){
  this.work=work;this.db=work.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS work_creation_triggers (
   trigger_key TEXT PRIMARY KEY,task_id TEXT NOT NULL,source_message_id TEXT NOT NULL,evidence_ref TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS work_creation_runs (
   batch_id TEXT,generation INTEGER,thread_id TEXT,turn_id TEXT,PRIMARY KEY(batch_id,generation));`);
 }
 policy(){const row=this.db.prepare("SELECT data FROM work_rules WHERE key='discovery_owns_creation'").get();return row?JSON.parse(row.data):null;}
 enabled(){return this.policy()?.enabled===true;}
 executed(task){return task?.owner_thread_id&&this.db.prepare('SELECT id,turn_id FROM rt_wakes WHERE owner_id=? AND started_at IS NOT NULL AND turn_id IS NOT NULL AND id IN (SELECT wake_id FROM rt_wake_members WHERE task_id=?) ORDER BY started_at DESC LIMIT 1').get(task.owner_thread_id,task.id);}
 actor(taskId,actor,{owner,payload}={}){
  if(!this.enabled())return null;
  const task=this.work.get(taskId),config=this.work.config;
  if(!task||task.state!=='accepted'||task.authorization?.actual_human_verified!==true)throw new Error('owner_creation_accepted_authority_required');
  if(!actor?.thread_id||actor.thread_id===config.threads.main||owner&&owner!==actor.thread_id)throw new Error('owner_creation_discovery_actor_required');
  if(actor.thread_id===config.threads.discovery){
   const run=this.db.prepare('SELECT * FROM work_creation_runs WHERE batch_id=? AND generation=?').get(actor.batch_id??'',actor.generation??-1);
   const batch=this.db.prepare('SELECT id,state,generation,prompt FROM discovery_batches WHERE id=?').get(actor.batch_id??'');
   if(!run||run.thread_id!==actor.thread_id||batch?.state!=='running'||batch.generation!==actor.generation)throw new Error('owner_creation_running_discovery_required');
   const proof=verifyDiscoveryExecution(this.db,config,batch,actor.native_proof,this.work.now())??verifyExecutionProof(actor.native_proof,{thread_id:actor.thread_id,workspace:config.thread_workspaces?.discovery??config.scope.project_root,prompt:batch.prompt,now:this.work.now()});
   if(proof.turn_id!==run.turn_id)throw new Error('owner_creation_native_turn_changed');
   return {thread_id:actor.thread_id,turn_id:proof.turn_id,batch_id:actor.batch_id,generation:actor.generation};
  }
  const review=readReviewIntake(config.instance_root),row=review&&this.db.prepare('SELECT * FROM rt_tasks WHERE task_id=?').get(review.task_id),service=row&&{...row,contract:JSON.parse(row.contract)};
  const key=task.canonical_key,selection=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='review_queue_selections'").get()&&this.db.prepare('SELECT 1 FROM review_queue_selections WHERE pr_key=?').get(key);
  const scope={canonical_task_key:key,review_queue_admission_key:payload?.review_queue_admission_key??key};
  if(!review?.enabled||actor.thread_id!==review.owner_thread_id||service?.owner_id!==actor.thread_id||service.mode!=='active'||!selection||
   task.data.source?.review_only!==true||task.data.source?.review_queue_service_task_id!==review.task_id||reviewCreationReasons({work:this.work,db:this.db},{kind:'create_thread',task_id:taskId,payload:scope,evidence:{executor_thread_id:actor.thread_id}}).length)
   throw new Error('owner_creation_discovery_or_authorized_review_actor_required');
  const wake=this.db.prepare("SELECT * FROM rt_wakes WHERE task_id=? AND owner_id=? AND state='running'").get(review.task_id,actor.thread_id);
  if(!wake)throw new Error('owner_creation_running_review_required');
  const proof=verifyExecutionProof(actor.native_proof,{thread_id:actor.thread_id,workspace:service.contract.workspace,prompt:wake.prompt,now:this.work.now()});
  if(proof.turn_id!==wake.turn_id)throw new Error('owner_creation_native_turn_changed');
  return {thread_id:actor.thread_id,turn_id:proof.turn_id,review_service:review.task_id};
 }
 reasons(kind,taskId,payload,evidence,owner){
  if(!['create_thread','assign_project'].includes(kind)||!this.enabled())return [];
  try{this.actor(taskId,evidence?.creation_actor,{owner,payload});return [];}catch(e){return [e.message];}
 }
 pending(){
  if(!this.enabled())return [];
  return this.work.list().filter(t=>t.state==='accepted'&&t.authorization?.actual_human_verified===true&&this.policy().allowed_kinds.includes(t.kind)).flatMap(t=>{
   // Specialized, separately authorized Review Queue keeps its existing lane.
   if(t.data.source?.review_queue_service_task_id)return [];
   const execution=this.work.execution(t.id);
   if(execution&&(execution.mode==='paused'||['complete','needs_decision','superseded'].includes(execution.status)))return [];
   if(t.owner_thread_id&&!t.binding?.creation_actor)return [];
   const started=this.executed(t);
   if(started)return [];
   const action=this.db.prepare("SELECT action_key,state FROM actions WHERE task_id=? AND kind='create_thread' ORDER BY created_at DESC LIMIT 1").get(t.id);
   return [{task_id:t.id,canonical_key:t.canonical_key,title:t.data.title,owner_thread_id:t.owner_thread_id,source_message_id:t.authorization.source_message_id,authorization_ref:t.authorization.evidence_ref,
    state:!t.owner_thread_id?(action?.state??'needs_owner'):execution?'queued':'owner_bound',creation_action_key:action?.action_key??null,blockers:this.work.blockers(t.id).filter(r=>r!=='owner_not_bound')}];
  });
 }
 requestStartInside(task,{source_message_id,actual_human_verified,evidence_ref}){
  if(!this.enabled())throw new Error('Discovery-owned creation policy is not enabled');
  if(actual_human_verified!==true||!source_message_id||!evidence_ref||task?.state!=='accepted')throw new Error('Actual human start request for an accepted task required');
  if(task.owner_thread_id)return {requested:false,reason:'existing_owner_preserved'};
  const key=`creation-start:${task.id}:${source_message_id}`;
  const r=this.db.prepare("INSERT OR IGNORE INTO work_creation_triggers VALUES (?,?,?,?,'pending',?)").run(key,task.id,source_message_id,evidence_ref,this.work.now());
  return {requested:!!r.changes,trigger_key:key};
 }
 requestStart(input){return this.work.atomic(()=>this.requestStartInside(this.work.get(input.task_id),input));}
 triggers(){return this.db.prepare("SELECT * FROM work_creation_triggers WHERE state='pending' ORDER BY created_at").all().filter(r=>this.pending().some(t=>t.task_id===r.task_id));}
 recordRun(batch,proof){
  const prior=this.db.prepare('SELECT turn_id FROM work_creation_runs WHERE batch_id=? AND generation=?').get(batch.id,batch.generation);
  if(prior&&prior.turn_id!==proof.turn_id)throw new Error('owner_creation_native_turn_changed');
  this.db.prepare('INSERT OR IGNORE INTO work_creation_runs VALUES (?,?,?,?)').run(batch.id,batch.generation,this.work.config.threads.discovery,proof.turn_id);
  for(const key of batch.snapshot.creation_work?.trigger_keys??[])this.db.prepare("UPDATE work_creation_triggers SET state='consumed' WHERE trigger_key=?").run(key);
 }
}
