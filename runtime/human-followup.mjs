import {continuationPolicy} from './owner-continuation.mjs';
import {nativeReadback,verifyExecutionProof} from './native-queue.mjs';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {bindings} from './instance.mjs';
import {humanAuthorizationSource} from './pr-authorization.mjs';

// A recorded exact-PR human grant can answer its matching delivery question
// without requiring the human to also say "continue". Execution and delivery
// still use their original independent guards.
export function recordedReviewResolvesDecision(task,decision,payload,policy){
 const request=decision?.data?.decision_request,deps=decision?.data?.progress?.dependencies?.filter(d=>d.kind==='human')??[];
 if(request?.kind!=='authority'||request.scope!=='task'||!request.blocked_requirements?.length||
  request.blocked_requirements.some(r=>r!=='delivery')||!deps.length)return false;
 return deps.every(d=>task.contract.pull_requests?.some(p=>d.pr_url===`https://github.com/${p.repository}/pull/${p.pr_number}`)&&
  policy?.personal_review?.authorizations?.some(g=>g.task_id===task.task_id&&g.pr_url===d.pr_url&&g.head_sha===d.head_sha&&
   g.record_protocol==='native_pr_authorization_v1'&&g.decision==='allow_external_review'&&g.reviewed_personally===true&&
   g.explicit_external_review_permission_verified===true&&g.scope_verified===true&&g.revoked!==true&&humanAuthorizationSource(g)&&
   g.source_message_id===payload.source_message_id&&g.source_thread_id===payload.source_thread_id&&g.source_turn_id===payload.source_turn_id&&
   g.verbatim_text===payload.verbatim_text&&Date.parse(g.source_at)>=decision.created_at));
}

export function verifyDirectDiscoveryHuman(proof,{config,source_message_id,verbatim_text,now,terminal=false}){
 if(!source_message_id||!verbatim_text?.trim()||/^\s*(?:\[workflow-|<codex_delegation>)/.test(verbatim_text))throw new Error('Actual direct human discovery instruction required');
 const result=verifyExecutionProof(proof,{thread_id:config.threads.discovery,workspace:config.thread_workspaces?.discovery??config.scope.project_root,prompt:verbatim_text,now,terminal});
 const read=nativeReadback(proof.readback),turn=read.turns[0];
 if(!proof.evidence_ref||(read.thread.status?.activeFlags??[]).length||turn.items.filter(i=>i.type==='userMessage'&&i.id===source_message_id&&(i.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')===verbatim_text).length!==1)
  throw new Error('Exact actual current human message identity required');
 return result;
}

export function verifyHumanFollowup(proof,{task,action,source_message_id,now=Date.now()}){
 if(!action||action.task_id!==task.task_id||action.kind!=='human_input'||action.state!=='sent'||!action.owner)throw new Error('A sent authorized original-task human followup is required');
 const p=JSON.parse(action.payload),receipt=JSON.parse(action.receipt??'{}'),read=nativeReadback(proof?.readback),at=Date.parse(proof?.checked_at),turn=read.turns?.[0];
 const native=receipt.native_result?.structuredContent??receipt.native_result?.content?.flatMap(c=>{try{return [JSON.parse(c.text)];}catch{return [];}}).find(c=>c.threadId);
 if(!(['steering','correction'].includes(p.intent)||task.task_id==='discovery'&&p.intent==='resume_discovery_batch')||p.source_message_id!==source_message_id||!p.verbatim_text||!p.source_thread_id||!p.source_turn_id||
  p.thread_id!==task.owner_id||receipt.outcome!=='sent'||receipt.native_result?.isError===true||native?.threadId!==task.owner_id)
  throw new Error('Followup must retain the actual human source and exact original owner receipt');
 if(proof?.source!=='codex_app.read_thread'||!Number.isFinite(at)||at>now+5000||now-at>60000||!proof.evidence_ref||
  read.thread?.id!==task.owner_id||read.thread?.kind!=='codex'||read.thread?.hostId!=='local'||read.thread?.cwd!==task.contract.workspace||!turn?.id||
  !Number.isFinite(turn.startedAt)||turn.startedAt*1000<action.created_at-1000||
  !(turn.status==='inProgress'&&read.thread.status?.type==='active'&&!turn.error||['completed','failed','interrupted'].includes(turn.status)&&['idle','notLoaded'].includes(read.thread.status?.type)))
  throw new Error('Fresh actual current native followup turn required');
 const expected=`<codex_delegation>\n  <source_thread_id>${action.owner}</source_thread_id>\n  <input>${p.prompt}</input>\n</codex_delegation>`;
 if(turn.items?.filter(i=>i.type==='functionCallOutput'&&i.namespace==='codex_app'&&i.name==='send_message_to_thread'&&i.output?.truncated===false&&i.output.text===expected).length!==1)
  throw new Error('Exact untruncated sent human followup must appear in the actual native turn');
 return {turn_id:turn.id,status:turn.status,payload:p,evidence_ref:proof.evidence_ref};
}

export function verifyFollowupAuthority(human_authorization,payload){
 const authority=nativeReadback(human_authorization?.readback),turn=authority.turns?.find(t=>t.id===payload.source_turn_id);
 if(human_authorization?.source!=='codex_app.read_thread'||authority.thread?.id!==payload.source_thread_id||authority.thread.kind!=='codex'||authority.thread.hostId!=='local'||
  turn?.items?.filter(i=>i.type==='userMessage'&&i.id===payload.source_message_id&&(i.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')===payload.verbatim_text).length!==1)
  throw new Error('Original native human message identity and exact text must corroborate the sent followup');
}

export function verifyDiscoveryExecution(db,config,batch,native_proof,now,{terminal=false}={}){
 const row=db.prepare('SELECT data FROM rt_diagnostics WHERE key=?').get(`discovery-followup:${batch.id}:${batch.generation}`);
 if(!row)return null;
 const binding=JSON.parse(row.data),action=binding.action_key?db.prepare('SELECT * FROM actions WHERE action_key=?').get(binding.action_key):null;
 if(binding.transport==='direct_human'){
  const result=verifyDirectDiscoveryHuman(native_proof,{config,source_message_id:binding.source_message_id,verbatim_text:binding.verbatim_text,now,terminal});
  if(result.turn_id!==binding.turn_id)throw new Error('Discovery batch is bound to another verified native human turn');
  return result;
 }
 const task={task_id:'discovery',owner_id:config.threads.discovery,contract:{workspace:config.thread_workspaces?.discovery??config.scope.project_root}};
 const result=verifyHumanFollowup(native_proof,{task,action,source_message_id:binding.source_message_id,now});
 if(result.turn_id!==binding.turn_id)throw new Error('Discovery batch is bound to another verified native followup');
 return result;
}

export function reconcileQueuedFollowup(control,input){
 const {task_id,expected_context_rev,expected_wake_id,expected_queue_id,action_key,source_message_id,evidence_ref,actual_human_verified,native_proof}=input;
 if(actual_human_verified!==true||!source_message_id||!evidence_ref)throw new Error('Actual human workflow-repair authority and evidence required');
 return control.atomic(()=>{
  const state=control.reactive,task=state.task(task_id),old=state.openWake(task_id),action=control.db.prepare('SELECT * FROM actions WHERE action_key=?').get(action_key);
  if(!task||task.mode!=='active'||task.status==='complete'||task.status==='needs_decision'&&input.resume_authorized_work!==true&&input.projection_only!==true||task.contract.retired||task.contract.service_lane)throw new Error('Preserve active original task, decisions and services');
  state.assertQueueOwner(task);
  const proof=verifyHumanFollowup(native_proof,{task,action,source_message_id,now:control.now()}),id=`runtime:${task_id}:followup:${action_key}`;
  verifyFollowupAuthority(input.human_authorization,proof.payload);
  let resolution;
  if(input.projection_only===true){
   const decision=control.db.prepare("SELECT id,created_at FROM rt_decisions WHERE task_id=? AND disposition='needs_decision' ORDER BY created_at DESC LIMIT 1").get(task_id);
   if(task.status!=='needs_decision'||proof.status!=='inProgress'||old&&old.id!==id||input.expected_wake_id||input.expected_queue_id||
    !continuationPolicy(control.db)?.enabled||!decision||decision.id!==input.expected_decision_id||action.created_at<=decision.created_at)
    throw Error('Projection-only binding requires actual active original execution, exact prior decision and no competing wake');
   resolution={decision_preserved:decision.id,scope:'actual_execution_projection_only',contract_and_external_holds_preserved:true};
  }else if(task.status==='needs_decision'){
   const decision=control.db.prepare("SELECT id,created_at,data FROM rt_decisions WHERE task_id=? AND disposition='needs_decision' ORDER BY created_at DESC LIMIT 1").get(task_id),number=task_id.match(/^T-0*(\d+)$/)?.[1];
   const explicitlyNamed=proof.payload.source_thread_id===task.owner_id||number&&new RegExp(`(?:^|[^0-9])(?:[Tt]-?)?0*${number}(?![0-9])`).test(proof.payload.verbatim_text);
   let explicitlyDirected=/\b(?:continue|resume|proceed)\b|继续|开始推进|恢复(?:推进|执行|工作)/i.test(proof.payload.verbatim_text);
   if(!explicitlyDirected&&decision){
    let policy;try{policy=JSON.parse(readFileSync(resolve(control.work.config.instance_root,bindings.delivery.slack_routing_file??'PR_REVIEW_CHANNELS.json'),'utf8'));}catch{}
    explicitlyDirected=recordedReviewResolvesDecision(task,{...decision,data:JSON.parse(decision.data)},proof.payload,policy);
   }
   if(!continuationPolicy(control.db)?.enabled||!decision||decision.id!==input.expected_decision_id||action.created_at<=decision.created_at||!explicitlyNamed||!explicitlyDirected||!proof.payload.prompt.includes(task_id))
    throw new Error('Exact old decision and a newer verified task-specific human continuation required');
   resolution={decision_id:decision.id,source_message_id,scope:'authorized_remaining_work_only',contract_and_external_holds_preserved:true};
  }
  const prior=control.db.prepare('SELECT * FROM rt_wakes WHERE id=?').get(id);
  if(prior){if(prior.turn_id!==proof.turn_id)throw new Error('Followup execution identity changed');return {reconciled:false,already_reconciled:true,wake_id:id,original_queue_consumed:false};}
  if(task.context_rev!==expected_context_rev||old&&(old.id!==expected_wake_id||old.queue_id!==expected_queue_id||!expected_queue_id||old.transport!=='native_queue'||old.state!=='queued'||old.turn_id||old.started_at||old.member_ids.length!==1||old.member_ids[0]!==task_id||old.owner_id!==task.owner_id)||!old&&(expected_wake_id||expected_queue_id))
   throw new Error('Exact unconsumed queued wake and unchanged current task context required');
  if(control.db.prepare("SELECT 1 FROM actions WHERE task_id=? AND state IN ('claimed','uncertain')").get(task_id))throw new Error('Reconcile in-flight effects first');
  if(old){control.db.prepare("UPDATE rt_wakes SET state='superseded',completed_at=? WHERE id=?").run(control.now(),old.id);
   state.diagnostic(`followup-superseded:${old.id}`,{task_id,source_message_id,successor_wake_id:id,turn_id:proof.turn_id,queue_id:old.queue_id,queue_consumed:false,evidence_ref});}
  if(input.projection_only!==true)state.ingestInside({event_id:`followup-execution:${task_id}:${action_key}`,task_id,source:'verified_human_followup',subject:`human-followup:${source_message_id}`,type:'authorized_followup_bound',observed_at:control.now(),payload:{source_message_id,source_thread_id:proof.payload.source_thread_id,verbatim_text:proof.payload.verbatim_text,previous_wake_id:old?.id??null,original_queue_consumed:false},evidence_ref,debounce_ms:0});
  const current=state.task(task_id),events=state.checkpoint(task_id).events.map(e=>e.event_id),running=proof.status==='inProgress';
  control.db.prepare('INSERT INTO rt_wakes(id,task_id,context_rev,plan_rev,event_ids,state,prompt,turn_id,created_at,started_at,completed_at,evidence_ref,transport,owner_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
   .run(id,task_id,current.context_rev,current.plan_rev,JSON.stringify(events),running?'running':'ended_unresolved',proof.payload.prompt,proof.turn_id,control.now(),control.now(),running?null:control.now(),evidence_ref,'native_followup',task.owner_id);
  control.db.prepare('INSERT INTO rt_wake_members VALUES (?,?,?)').run(id,task_id,current.context_rev);
  state.diagnostic(`followup-binding:${id}`,{action_key,source_message_id,evidence_ref,original_queue_consumed:false,...(resolution?{decision_resolution:resolution}:{})});
  return {reconciled:true,wake_id:id,turn_id:proof.turn_id,state:running?'running':'ended_unresolved',old_wake_state:old?'superseded':null,original_queue_consumed:false,queue_id:old?.queue_id??null,owner_unchanged:true,...(input.projection_only===true?{decision_preserved:resolution.decision_preserved,projection_only:true}:{})};
 });
}
