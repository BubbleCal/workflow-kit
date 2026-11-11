import {createHash} from 'node:crypto';
import {ownerAutonomyPolicy} from './owner-continuation.mjs';
import {verifyNativeBinding,nativeReadback} from './native-queue.mjs';
import {canonical} from './reactive-state.mjs';
import {completionReportStatus} from './completion-report.mjs';

const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
const present=v=>typeof v==='string'&&!!v.trim();

// Owners report intent and evidence. Revisions, plan envelopes and terminal wake
// bookkeeping stay here; external operations still use their existing guards.
export class OwnerWork {
 constructor(control){this.c=control;this.s=control.reactive;this.db=control.db;
  this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS rt_work_update_identity ON rt_decisions(task_id,json_extract(data,'$.work_update.key')) WHERE json_extract(data,'$.work_update.key') IS NOT NULL");
 }
 brief(taskId){
  const cp=this.s.checkpoint(taskId),last=this.db.prepare('SELECT data FROM rt_decisions WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId);
  return{task_id:taskId,owner_thread_id:cp.task.owner_id,wake_id:cp.wake?.id??null,turn_id:cp.wake?.turn_id??null,status:cp.task.status,
   goal:cp.task.contract.objective,requirements:cp.task.contract.requirements,constraints:cp.task.contract.constraints,scope_exclusions:cp.scope_exclusions,
   frontier:JSON.parse(last?.data??'{}').progress??null,plan:cp.plan?.plan??null,
   changes:cp.events.map(e=>({id:e.event_id,subject:e.subject,type:e.type,reasons:e.wake_reasons,evidence_ref:e.evidence_ref})),
   action_context:{contract_rev:cp.task.contract_rev,context_rev:cp.task.context_rev,plan_rev:cp.task.plan_rev},
   instruction:'Work toward the whole goal. Choose technical approaches and bounded experiments yourself within existing authority/resources. A phase result or blocked external action does not stop independent work. Report progress while continuing; use wait, a real human-only question, or complete only at a genuine stopping point.'};
 }
 run(input){
  const {task_id,owner_thread_id,op}=input,task=this.s.task(task_id);
  const policy=ownerAutonomyPolicy(this.db);
  if(!policy?.enabled||!policy.allowed_kinds?.includes(task?.contract.task_kind??'work'))throw Error('Owner autonomy is not enabled for this task kind');
  if(!task||task.owner_id!==owner_thread_id)throw Error('Use the original task owner');
  if(op==='status')return this.brief(task_id);
  if(task.mode!=='active'||task.contract.retired||task.contract.service_lane)throw Error('Preserve paused/retired tasks and the fixed service-batch protocol');
  this.s.assertQueueOwner(task);
  let wake=this.s.openWake(task_id);
  const requestedWake=input.wake_id??wake?.id;
  if(op==='start'){
   if(task.status==='complete'||task.status==='needs_decision')throw Error('Preserve existing completion and task-wide human decisions');
   if(!wake||wake.id!==requestedWake)throw Error('No matching accepted work delivery');
   if(wake.state!=='running'){
    if(!input.native_proof)throw Error('Read the actual current native turn once with includeOutputs=true, then retry start with native_proof');
    const started=this.s.begin({task_id,wake_id:wake.id,native_proof:input.native_proof});if(started.skipped)return started;
    wake=this.s.openWake(task_id);
   }else if(input.native_proof){
    verifyNativeBinding(input.native_proof,{thread_id:owner_thread_id,workspace:task.contract.workspace,now:this.c.now()});
    const actual=nativeReadback(input.native_proof.readback);
    if(actual.thread.status?.type!=='active'||actual.turns?.[0]?.status!=='inProgress'||actual.turns[0].id!==wake.turn_id)throw Error('Start must match the actual acknowledged running turn');
   }
   return{started:true,...this.brief(task_id)};
  }
  if(!['progress','wait','question','complete'].includes(op))throw Error('Use start, status, progress, wait, question or complete');
  if(!present(input.wake_id))throw Error('Use the wake_id returned by start');
  const {native_proof,...intent}=input,digest=hash(intent),key=`${requestedWake}:${input.update_id??digest}`;
  const previous=this.db.prepare("SELECT * FROM rt_decisions WHERE task_id=? AND json_extract(data,'$.work_update.key')=?").get(task_id,key);
  if(previous){
   if(JSON.parse(previous.data).work_update.digest!==digest)throw Error('A recorded work update cannot change intent');
   return this.result(input,previous,true);
  }
  if(task.status==='complete'||task.status==='needs_decision'||!wake||wake.id!==requestedWake||wake.state!=='running')throw Error('Start accepted work first; preserve existing human/completion boundaries');
  const evidence=input.evidence_refs??(input.evidence_ref?[input.evidence_ref]:[]);
  if(!evidence.length)throw Error('Provide the actual result or checkpoint evidence_ref');
  const cp=this.s.checkpoint(task_id),remaining=input.remaining_requirements??task.contract.requirements.map(r=>r.id);
  let disposition=op==='progress'?'continue':op==='question'?'continue':op==='complete'?(task.contract.schedule_sources?.length?'cycle_complete':'complete'):'wait';
  const technical=op==='question'&&(!input.kind||input.kind==='technical_choice');
  let next=input.next_action??(technical?`Evaluate ${input.question} with the smallest useful bounded experiment`:'Continue independent authorized work while the action-specific question is pending');
  if(op==='progress'&&!present(input.next_action))throw Error('Describe the concrete next action');
  if(op==='question'&&(!present(input.question)||!present(input.why_owner_cannot_decide)&&!technical))throw Error('Describe the human question and the concrete missing authority or material choice');
  let decision_request;
  if(op==='question'&&!technical&&input.all_work_blocked===true&&!input.next_action){
   disposition='needs_decision';
   decision_request={kind:input.kind,scope:'task',question:input.question,why_owner_cannot_decide:input.why_owner_cannot_decide,
    blocked_requirements:input.blocked_requirements??remaining,evidence_refs:evidence,independent_authorized_work:[],...(input.options?{options:input.options}:{})};
  }
  const reason=input.reason??(op==='question'?input.question:input.next_action??input.wait?.resume_condition??'Accepted whole-goal results recorded');
  const prior=this.db.prepare('SELECT data FROM rt_decisions WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(task_id),frontier=JSON.parse(prior?.data??'{}').progress;
  const progress={remaining_requirements:remaining,next_action:next,jobs:input.jobs??frontier?.jobs??[],dependencies:input.dependencies??frontier?.dependencies??[]};
  let wait=input.wait;
  if(op==='wait'&&wait){
   const predicate=wait.condition;
   wait={...wait,facts:wait.facts??cp.facts.filter(f=>[predicate?.subject,predicate?.pr_key,predicate?.fact_key?`wait-fact:${predicate.fact_key}`:null].includes(f.subject)).map(({subject,version})=>({subject,version}))};
  }
  const plan=input.plan??(disposition==='continue'&&!cp.plan?{steps:[{id:'advance-goal',action:task.contract.objective,requirement_ids:task.contract.requirements.map(r=>r.id),depends_on:[]}],assumptions:[]}:undefined);
  const question=op==='question'&&!technical?{scope:disposition==='needs_decision'?'task':'action',kind:input.kind,question:input.question,blocked_actions:input.blocked_actions??[],why_owner_cannot_decide:input.why_owner_cannot_decide}:undefined;
  try{this.s.decide({task_id,owner_thread_id,wake_id:wake.id,expected_context_rev:cp.task.context_rev,expected_plan_rev:cp.task.plan_rev,
   disposition,reason,evidence_refs:evidence,plan,wait,next_action_at:input.next_action_at,acceptance:input.acceptance,progress,decision_request,
   work_update:{key,digest,wake_id:wake.id,contract_rev:cp.task.contract_rev,...(question?{question}:{}),technical_choice_owned:technical}});}
  catch(error){
   const concurrent=this.db.prepare("SELECT * FROM rt_decisions WHERE task_id=? AND json_extract(data,'$.work_update.key')=?").get(task_id,key);
   if(!concurrent||JSON.parse(concurrent.data).work_update.digest!==digest)throw error;
   return this.result(input,concurrent,true);
  }
  const recorded=this.db.prepare("SELECT * FROM rt_decisions WHERE task_id=? AND json_extract(data,'$.work_update.key')=?").get(task_id,key);
  return this.result(input,recorded,false);
 }
 result(input,decision,replayed){
  const task=this.s.task(input.task_id),data=JSON.parse(decision.data),terminal=['wait','needs_decision','complete','cycle_complete'].includes(decision.disposition);
  const id=data.work_update.wake_id;
  const wake=this.s.openWake(input.task_id);
  let finished=this.db.prepare("SELECT state FROM rt_wakes WHERE id=?").get(id)?.state==='finished',new_information=false;
  if(terminal&&wake?.id===id&&wake.state==='running'){
   const last=this.db.prepare('SELECT id FROM rt_decisions WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(input.task_id);
   new_information=last?.id!==decision.id||wake.member_ids.some(member=>{const t=this.s.task(member);return t.dirty||t.status==='ready';});
   if(!new_information){
    try{this.s.finish({task_id:input.task_id,wake_id:id,turn_id:wake.turn_id,evidence_ref:data.evidence_refs[0]});finished=true;}
    catch(error){if(!wake.member_ids.some(id=>{const t=this.s.task(id);return t.dirty||t.status==='ready';}))throw error;new_information=true;}
   }
  }
  return{recorded:!replayed,replayed,decision_id:decision.id,disposition:decision.disposition,finished,new_information,
   action_context:{contract_rev:data.work_update.contract_rev,context_rev:decision.context_rev,plan_rev:decision.plan_rev},
   question:data.work_update.question??null,technical_choice_owned:data.work_update.technical_choice_owned,
   next:finished?(task.status==='complete'?'Deliver the completed result under TASK_COMPLETION_DELIVERY.md':'Wait for the recorded condition'):
    new_information?'New facts or another owner-member remain: assess them and continue':'Keep working in this turn; choose the next useful step',
   ...(finished&&task.status==='complete'?{completion_delivery:completionReportStatus(this.c,input.task_id)}:{})};
 }
}
