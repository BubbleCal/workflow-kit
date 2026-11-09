import {nativeReadback} from './native-queue.mjs';

export function verifyHumanFollowup(proof,{task,action,source_message_id,now=Date.now()}){
 if(!action||action.task_id!==task.task_id||action.kind!=='human_input'||action.state!=='sent'||!action.owner)throw new Error('A sent authorized original-task human followup is required');
 const p=JSON.parse(action.payload),receipt=JSON.parse(action.receipt??'{}'),read=nativeReadback(proof?.readback),at=Date.parse(proof?.checked_at),turn=read.turns?.[0];
 const native=receipt.native_result?.structuredContent??receipt.native_result?.content?.flatMap(c=>{try{return [JSON.parse(c.text)];}catch{return [];}}).find(c=>c.threadId);
 if(!['steering','correction'].includes(p.intent)||p.source_message_id!==source_message_id||!p.verbatim_text||!p.source_thread_id||!p.source_turn_id||
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

export function verifyDiscoveryExecution(db,config,batch,native_proof,now){
 const row=db.prepare('SELECT data FROM rt_diagnostics WHERE key=?').get(`discovery-followup:${batch.id}:${batch.generation}`);
 if(!row)return null;
 const binding=JSON.parse(row.data),action=db.prepare('SELECT * FROM actions WHERE action_key=?').get(binding.action_key);
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
  if(!task||task.mode!=='active'||['complete','needs_decision'].includes(task.status)||task.contract.retired||task.contract.service_lane)throw new Error('Preserve active original task, decisions and services');
  state.assertQueueOwner(task);
  const proof=verifyHumanFollowup(native_proof,{task,action,source_message_id,now:control.now()}),id=`runtime:${task_id}:followup:${action_key}`;
  verifyFollowupAuthority(input.human_authorization,proof.payload);
  const prior=control.db.prepare('SELECT * FROM rt_wakes WHERE id=?').get(id);
  if(prior){if(prior.turn_id!==proof.turn_id)throw new Error('Followup execution identity changed');return {reconciled:false,already_reconciled:true,wake_id:id,original_queue_consumed:false};}
  if(task.context_rev!==expected_context_rev||old&&(old.id!==expected_wake_id||old.queue_id!==expected_queue_id||!expected_queue_id||old.transport!=='native_queue'||old.state!=='queued'||old.turn_id||old.started_at||old.member_ids.length!==1||old.member_ids[0]!==task_id||old.owner_id!==task.owner_id)||!old&&(expected_wake_id||expected_queue_id))
   throw new Error('Exact unconsumed queued wake and unchanged current task context required');
  if(control.db.prepare("SELECT 1 FROM actions WHERE task_id=? AND state IN ('claimed','uncertain')").get(task_id))throw new Error('Reconcile in-flight effects first');
  if(old){control.db.prepare("UPDATE rt_wakes SET state='superseded',completed_at=? WHERE id=?").run(control.now(),old.id);
   state.diagnostic(`followup-superseded:${old.id}`,{task_id,source_message_id,successor_wake_id:id,turn_id:proof.turn_id,queue_id:old.queue_id,queue_consumed:false,evidence_ref});}
  state.ingestInside({event_id:`followup-execution:${task_id}:${action_key}`,task_id,source:'verified_human_followup',subject:`human-followup:${source_message_id}`,type:'authorized_followup_bound',observed_at:control.now(),payload:{source_message_id,source_thread_id:proof.payload.source_thread_id,verbatim_text:proof.payload.verbatim_text,previous_wake_id:old?.id??null,original_queue_consumed:false},evidence_ref,debounce_ms:0});
  const current=state.task(task_id),events=state.checkpoint(task_id).events.map(e=>e.event_id),running=proof.status==='inProgress';
  control.db.prepare('INSERT INTO rt_wakes(id,task_id,context_rev,plan_rev,event_ids,state,prompt,turn_id,created_at,started_at,completed_at,evidence_ref,transport,owner_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
   .run(id,task_id,current.context_rev,current.plan_rev,JSON.stringify(events),running?'running':'ended_unresolved',proof.payload.prompt,proof.turn_id,control.now(),control.now(),running?null:control.now(),evidence_ref,'native_followup',task.owner_id);
  control.db.prepare('INSERT INTO rt_wake_members VALUES (?,?,?)').run(id,task_id,current.context_rev);
  state.diagnostic(`followup-binding:${id}`,{action_key,source_message_id,evidence_ref,original_queue_consumed:false});
  return {reconciled:true,wake_id:id,turn_id:proof.turn_id,state:running?'running':'ended_unresolved',old_wake_state:old?'superseded':null,original_queue_consumed:false,queue_id:old?.queue_id??null,owner_unchanged:true};
 });
}
