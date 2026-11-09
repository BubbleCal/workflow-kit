import {isDeepStrictEqual} from 'node:util';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {bindings,INSTANCE_ROOT} from './instance.mjs';
import {nativeReadback} from './native-queue.mjs';

const digest=text=>createHash('sha256').update(text).digest('hex');
const fields=['completed_work','result','effect','impact'];
const fresh=(at,now)=>Number.isFinite(Date.parse(at))&&Date.parse(at)<=now+5000&&now-Date.parse(at)<=300000;
export function readCompletionReportPolicy(root=INSTANCE_ROOT){
  const p=join(root,'completion-report-policy.json');
  return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):null;
}
export function initCompletionNotices(db){
  db.exec(`CREATE TABLE IF NOT EXISTS task_completion_notices (
    task_id TEXT,completion_id TEXT,action_key TEXT,main_message_id TEXT,
    text_digest TEXT,evidence_ref TEXT,confirmed_at INTEGER,
    PRIMARY KEY(task_id,completion_id));`);
}
export function completionIdentity(control,id){
  const task=control.reactive.task(id);
  if(!task||task.status!=='complete'||task.contract.service_lane||task.contract.meeting_service||
    task.contract.trigger_only||task.contract.schedule_sources?.length)return null;
  const decision=control.db.prepare("SELECT id FROM rt_decisions WHERE task_id=? AND disposition='complete' ORDER BY rowid DESC LIMIT 1").get(id);
  return decision?{task,id:decision.id}:null;
}
export function completionReportStatus(control,id){
  const x=completionIdentity(control,id),policy=control.completionReportPolicy();
  const notice=x&&control.db.prepare('SELECT * FROM task_completion_notices WHERE task_id=? AND completion_id=?').get(id,x.id);
  return {task_id:id,completion_id:x?.id??null,owner_thread_id:x?.task.owner_id??null,
    policy,delivered:!!notice,notice:notice??null};
}
const policyValid=p=>p?.schema_version===1&&p.enabled===true&&p.mode==='owner_to_main'&&
  p.thread_id===bindings.threads.inbox&&!!p.source_message_id&&!!p.evidence_ref;
const summaryValid=s=>fields.every(f=>typeof s?.[f]==='string'&&s[f].trim()&&s[f].length<=2000);
function allowedActor(control,x,actor){
  // Review Queue retains its already-authorized terminal-review closure role.
  const closure=control.work.get(x.task.task_id)?.data.review_closure;
  return actor===x.task.owner_id||closure?.executor_thread_id===actor;
}
export function completionReportReasons(control,kind,id,payload,e={},actor,key){
  if(kind!=='completion_report')return [];
  const p=control.completionReportPolicy(),x=completionIdentity(control,id),reasons=[];
  if(!policyValid(p)||payload.thread_id!==p.thread_id||payload.source_message_id!==p.source_message_id)
    reasons.push('authorized_completion_report_destination_required');
  if(!x||!allowedActor(control,x,actor??e.executor_thread_id)||payload.completion_id!==x.id)
    reasons.push('completed_original_task_and_reporter_required');
  if(!summaryValid(payload.summary)||typeof payload.report_ref!=='string'||!payload.report_ref.trim()||
    e.result_saved_and_verified!==true||e.summary_verified!==true||e.report_ref!==payload.report_ref)
    reasons.push('completion_work_result_effect_impact_required');
  if(key!==`completion-report:${id}:${x?.id}`)reasons.push('stable_completion_report_key_required');
  const prompt=payload.prompt;
  if(typeof prompt!=='string'||prompt.length>10000||!prompt.startsWith(`[task-completed:${id}]`)||
    !prompt.includes(`codex://threads/${x?.task.owner_id}`)||!prompt.includes(payload.report_ref)||
    !fields.every(f=>prompt.includes(payload.summary?.[f]??'\0')))
    reasons.push('finished_completion_card_required');
  if(x&&control.db.prepare('SELECT 1 FROM task_completion_notices WHERE task_id=? AND completion_id=?').get(id,x.id))
    reasons.push('completion_already_delivered');
  return reasons;
}
// Decode the XML transport layer exactly once, without reparsing result markup.
const xmlText=value=>value.replace(/&(amp|lt|gt|quot|apos);/g,(_,entity)=>({amp:'&',lt:'<',gt:'>',quot:'\"',apos:"'"})[entity]);
function verifyMainMessage(control,proof,{text,actor,assistantOnly=false,historical=false}){
  const p=control.completionReportPolicy();let read;
  try{read=nativeReadback(proof?.readback);}catch{throw new Error('Actual fresh main-chat readback is required');}
  if(!policyValid(p)||proof?.source!=='codex_app.read_thread'||!proof.evidence_ref||
    !(fresh(proof.checked_at,control.now())||historical)||read?.thread?.id!==p.thread_id)
    throw new Error('Actual fresh main-chat readback is required');
  for(const turn of read.turns??[])for(const item of turn.items??[]){
    if(item.type==='agentMessage'&&item.phase==='final_answer'&&item.text===text&&item.id)return item.id;
    if(assistantOnly)continue;
    if(item.type==='functionCallOutput'&&item.name==='send_message_to_thread'&&item.namespace==='codex_app'&&
      item.output?.truncated!==true&&item.id){
      const delegated=item.output?.text?.match(/^\s*<codex_delegation>\s*<source_thread_id>([^<]+)<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/);
      if(delegated?.[1]===actor&&xmlText(delegated[2])===text)return item.id;
    }
  }
  throw new Error('Main readback must contain the exact delivered completion, not a queue or send acknowledgement');
}
export function confirmCompletionReport(control,row,nativeResult){
  const payload=JSON.parse(row.payload),completion=control.db.prepare("SELECT id,created_at FROM rt_decisions WHERE id=? AND task_id=? AND disposition='complete'").get(payload.completion_id,row.task_id);
  if(!completion||row.created_at<completion.created_at)throw new Error('Original accepted completion required before notification confirmation');
  const proof=nativeResult?.main_readback,cached=JSON.parse(row.receipt??'{}').native_result;
  const send=cached?.send;
  let acknowledged=send?.structuredContent?.threadId;
  for(const item of send?.content??[])if(item.type==='text'){try{acknowledged=JSON.parse(item.text).threadId;}catch{}}
  // A later event may reopen the task. Confirm only its old delivery fact; this
  // never completes the new scope or makes its archival notice current.
  const historical=row.state==='uncertain'&&send?.isError!==true&&acknowledged===control.completionReportPolicy()?.thread_id&&
    isDeepStrictEqual(cached?.main_readback,proof)&&Number.isFinite(Date.parse(proof?.checked_at))&&
    Date.parse(proof.checked_at)>=row.created_at&&Date.parse(proof.checked_at)<=control.now()+5000;
  const message=verifyMainMessage(control,proof,{text:payload.prompt,actor:row.owner,historical});
  control.db.prepare('INSERT OR IGNORE INTO task_completion_notices VALUES (?,?,?,?,?,?,?)')
    .run(row.task_id,completion.id,row.action_key,message,digest(payload.prompt),proof.evidence_ref,control.now());
}
// Reuse a result already presented in main, without waking a completed owner or
// notifying twice. Only main may register its own actual final-answer evidence.
export function recordPresentedCompletion(control,input){return control.atomic(()=>{
  const x=completionIdentity(control,input.task_id),p=control.completionReportPolicy();
  if(!x||!policyValid(p)||input.executor_thread_id!==p.thread_id||input.completion_id!==x.id||
    !summaryValid(input.summary)||typeof input.text!=='string'||!input.text.includes(input.task_id)||
    !fields.every(f=>input.text.includes(input.summary[f])))throw new Error('Main must register the current completed task and substantive result');
  const message=verifyMainMessage(control,input.native_proof,{text:input.text,assistantOnly:true});
  const old=control.db.prepare('SELECT * FROM task_completion_notices WHERE task_id=? AND completion_id=?').get(input.task_id,x.id);
  if(old)return {recorded:true,replayed:true,task_id:input.task_id};
  control.db.prepare('INSERT INTO task_completion_notices VALUES (?,?,?,?,?,?,?)')
    .run(input.task_id,x.id,null,message,digest(input.text),input.native_proof.evidence_ref,control.now());
  return {recorded:true,task_id:input.task_id,main_message_id:message};
});}
export function completionArchiveReasons(control,kind,id,payload,key){
  if(kind!=='archive'||!policyValid(control.completionReportPolicy())||
    ['explicit_owner_replacement','task_consolidation'].includes(payload?.purpose))return [];
  // Preserve historical verified archive receipts; never replay the operation.
  if(control.db.prepare("SELECT 1 FROM actions WHERE action_key=? AND kind='archive' AND state='sent'").get(key))return [];
  const x=completionIdentity(control,id);
  return x&&control.db.prepare('SELECT 1 FROM task_completion_notices WHERE task_id=? AND completion_id=?').get(id,x.id)?[]:
    ['completion_result_not_presented_in_main'];
}
