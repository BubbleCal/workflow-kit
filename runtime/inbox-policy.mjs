import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

export function inboxAdmission({key,kind,payload,action,task,completion,ownerCreationAuthorized=false,resultDecisionVerified=false}) {
  const deny=reason=>({allowed:false,reason});
  if(!['decision','action_required','answer','important_completion'].includes(kind))return deny('routine_notification');
  if(payload?.result_followup_decision) return kind==='decision'&&resultDecisionVerified?
    {allowed:true,reason:'recorded_result_followup_needs_decision'}:deny('result_followup_decision_not_verified');
  if(payload?.catalog_candidate) return task?.state==='candidate'&&!task.data?.meeting_preparation?
    {allowed:true,reason:'unaccepted_scope_needs_human_decision'}:deny('already_authorized_or_stale_candidate');
  if(payload?.catalog_owner_needed) return task?.state==='accepted'&&!task.owner_thread_id&&!ownerCreationAuthorized?
    {allowed:true,reason:'owner_creation_authorization_needed'}:deny('owner_provisioning_is_internal');
  if(payload?.task_completed) return kind==='important_completion'&&completion?.state==='finished'&&completion.status==='complete'&&
    key===`complete:${completion.id}`&&payload.archive_request?.thread_id===completion.owner_id?
    {allowed:true,reason:'native_task_completed'}:deny('completion_not_bound_to_finished_task');
  if(!action||action.kind!=='notify'||!['prepared','queued'].includes(action.state)||key!==payload.control_action_key||
    action.task_id!==payload.task_id||action.payload.category!==kind)return deny('guarded_notification_required');
  if(kind==='answer'&&(!payload.question_message_id||payload.question_message_id!==action.payload.question_message_id))return deny('actual_user_question_required');
  return {allowed:true,reason:'guarded_human_notification'};
}
export function inspectInbox(root,input) {
  const file=join(root,'control.sqlite');if(!existsSync(file))return {allowed:false,reason:'notification_ledger_unavailable'};
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const p=input.payload??{},a=p.control_action_key&&db.prepare('SELECT * FROM actions WHERE action_key=?').get(p.control_action_key);
    const t=p.task_id&&db.prepare('SELECT * FROM work_items WHERE id=?').get(p.task_id);
    const task=t?{...t,data:JSON.parse(t.data)}:null;
    const rules=db.prepare('SELECT key,data FROM work_rules').all().map(r=>({key:r.key,...JSON.parse(r.data)}));
    const request=task&&db.prepare('SELECT state FROM work_owner_requests WHERE task_id=?').get(task.id);
    const ownerCreationAuthorized=!!request||rules.some(r=>r.enabled&&(r.key==='create_owner'&&r.allowed_kinds.includes(task?.kind)||
      r.key==='accept_calendar_preparation'&&task?.data.meeting_preparation?.calendar_id===r.calendar_id));
    const completion=p.task_completed&&db.prepare("SELECT w.id,w.state,w.owner_id,t.status FROM rt_wakes w JOIN rt_tasks t ON t.task_id=w.task_id WHERE w.id=? AND w.task_id=?").get(input.key.replace(/^complete:/,''),p.task_id);
    let resultDecisionVerified=false;
    if(p.result_followup_decision===true&&input.kind==='decision'&&input.key?.startsWith('result-decision:')&&
      db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('work_result_followups','work_reports','work_notices')").get().n===3){
      const notice=db.prepare(`SELECT n.payload FROM work_result_followups f JOIN work_reports r ON r.report_key=f.report_key AND r.task_id=f.origin_task_id
        JOIN work_notices n ON n.key=? AND n.task_id=f.origin_task_id
        WHERE f.followup_key=? AND f.origin_task_id=? AND f.state='decision'`).get(input.key,input.key.slice('result-decision:'.length),p.task_id??'');
      resultDecisionVerified=!!notice&&isDeepStrictEqual(JSON.parse(notice.payload),p);
    }
    return inboxAdmission({...input,action:a?{...a,payload:JSON.parse(a.payload)}:null,task,completion,ownerCreationAuthorized,resultDecisionVerified});
  }finally{db.close();}
}
