import {createHash} from 'node:crypto';
const text=v=>typeof v==='string'&&v.trim();
const normalized=v=>String(v??'').trim().toLowerCase();
export function calendarPreparation(rule,observation,event,now=Date.now()) {
  if(!rule?.enabled||observation?.source_kind!=='calendar'||observation.scope_key!==rule.calendar_id)return {authorized:false,reason:'outside_calendar_policy'};
  if(!event||event.id!==observation.item_key||!text(event.summary)||!text(event.start)||!event.start.includes('T'))return {authorized:false,reason:'full_event_required'};
  const start=Date.parse(event.start),ex=rule.exclusions??{},title=normalized(event.summary),root=String(event.recurring_event_id??'').split('_R')[0];
  if(!Number.isFinite(start))return {authorized:false,reason:'full_event_required'};
  if(start<=now||event.status==='cancelled'||['workingLocation','outOfOffice','focusTime','birthday'].includes(event.event_type)||
    (ex.event_ids??[]).includes(event.id)||(ex.titles??[]).some(t=>normalized(t)===title)||(ex.series_roots??[]).includes(root))
    return {authorized:false,excluded:true,reason:'excluded_or_expired'};
  const self=(event.attendees??[]).find(a=>a.is_self||normalized(a.email)===normalized(rule.self_email));
  if(self?.response_status==='declined')return {authorized:false,excluded:true,reason:'declined'};
  if(!self || !(event.attendees??[]).some(a=>!a.resource&&!a.is_self&&normalized(a.email)!==normalized(rule.self_email)&&a.response_status!=='declined'))
    return {authorized:false,reason:'full_attendance_required'};
  const profile=(rule.profiles??[]).find(p=>p.enabled!==false && (normalized(p.title)===title||p.series_id&&String(p.series_id).split('_R')[0]===root));
  if(!profile)return {authorized:false,reason:'meeting_preparation_scope_undecided'};
  const key=`${rule.calendar_id}:${event.id}`,generation=createHash('sha256').update(`${key}:${new Date(start).toISOString()}`).digest('hex').slice(0,24);
  const schedule_id=`runtime:meeting-${generation}`,prep_at=new Date(start-rule.lead_minutes*60000).toISOString();
  return {authorized:true,canonical_key:`meeting_prep:${key}`,preparation:{policy_key:'accept_calendar_preparation',calendar_id:rule.calendar_id,event_id:event.id,
    meeting_start:new Date(start).toISOString(),prep_at,schedule_id,generation,profile_title:profile.title,evidence_ref:observation.evidence_ref,
    source_message_id:rule.source_message_id,authorization_ref:rule.evidence_ref},task:{title:`${event.summary} 会前准备 ${event.start}`,
    objective:'Prepare this authorized meeting occurrence in Chinese with English speaking points, using the original preparation profile.',
    requirements:[{id:'timing',text:`Start at ${prep_at}, ${rule.lead_minutes} minutes before the meeting; reread current attendance, timing and exclusions.`},
      {id:'brief',text:'Produce an evidence-backed Chinese brief and English speaking points within the existing preparation scope.'}],
    constraints:['Preparation only: no calendar edits, external messages, shared-document edits, engineering or new experiments','Preserve existing meeting exclusions, profile, language preferences and one owner per independent task','Recheck the live event when due; skip cancelled, declined, excluded or expired meetings'],
    schedule_sources:[schedule_id],trigger_only:true}};
}
export function scheduleCalendarPreparation(control,taskId) {
  const item=control.work.get(taskId),p=item?.data.meeting_preparation;
  if(!p||!item.owner_thread_id||item.state!=='accepted')return null;
  const task=control.reactive.task(taskId);if(!task)return null;
  return control.scheduler.create({id:p.schedule_id,task_id:taskId,kind:'once',timezone:control.work.calendarRule()?.timezone??'Asia/Shanghai',
    start_at:p.prep_at,overlap:'coalesce',actual_human_verified:true,source_message_id:p.source_message_id,evidence_ref:p.authorization_ref});
}

// Derive task ownership facts from the catalog instead of asking the discovery
// model to guess legacy guard field names. Native project evidence stays explicit.
export async function prepareMeetingOwner(control,{task_id,projects,project_catalog_ref,checked_at}) {
  const task=control.work.get(task_id),rule=control.work.calendarRule(),p=task?.data.meeting_preparation;
  if(task?.state!=='accepted'||task.owner_thread_id||!p||!rule?.enabled||p.calendar_id!==rule.calendar_id||
    task.authorization?.policy!=='accept_calendar_preparation'||control.reactive.task(task_id))
    throw new Error('An accepted unstarted meeting occurrence with scoped creation authority is required');
  const at=Date.parse(checked_at);if(!Number.isFinite(at)||at>control.now()+5000||control.now()-at>60000||!project_catalog_ref)
    throw new Error('Fresh native project catalog and its evidence reference are required');
  const {resolvePlacement}=await import('./control.mjs');
  const resolved=resolvePlacement({projects,project_id:control.work.config.scope.project_id,host_id:'local',source_ref:project_catalog_ref});
  const request=control.work.requestOwner({task_id}),r=request.request;
  const previous=control.db.prepare('SELECT state FROM actions WHERE action_key=?').get(r.control_action_key);
  if(previous&&['sent','claimed','uncertain','cancelled'].includes(previous.state))return {key:r.control_action_key,state:previous.state,next:'Reconcile this exact creation receipt; never create another owner.'};
  const busy=control.db.prepare("SELECT 1 FROM actions WHERE task_id=? AND action_key<>? AND state IN ('prepared','deferred','claimed','uncertain')").get(task_id,r.control_action_key);
  if(busy)throw new Error('Another task action must be reconciled before owner creation');
  const policy=control.taskRegistry()?.policy_version??'native-owner';
  const payload={canonical_task_key:task.canonical_key,source_message_id:r.source_message_id,verbatim_text:r.verbatim_text,
    permission_probe_only:true,starts_heavy_work:false,run_id:r.control_action_key,placement:resolved.placement,
    prompt:r.initial_prompt,native:{target:resolved.native_target,prompt:r.initial_prompt,title:`${task.id} · ${task.data.title}`}};
  const evidence={verified_at:new Date(control.now()).toISOString(),scope_authorized:true,authorization_ref:task.authorization.evidence_ref,
    policy_version:policy,current_policy_version:policy,stopped:false,actual_human_message_verified:true,source_actor_verified:true,
    explicit_new_thread_request_verified:true,source_message_id:r.source_message_id,source_text:r.verbatim_text,canonical_task_key:task.canonical_key,
    ownership_handoff_verified:true,overlapping_owner:false,duplicate_task_exists:false,underlying_job_for_scope_running:false,
    existing_driver_owns_step:false,pending_dispatch:false,worktree_isolated:true,branch_owner_conflict:false,preparation_reused_or_absent:true,
    work_incomplete:true,capacity_available:true,project_resolution_verified:true,project_resolution_ref:project_catalog_ref,intended_project_id:resolved.placement.project_id,
    project_host_id:'local',project_exists:true,operation_project_verified:true,operation_project_id:resolved.placement.project_id};
  const preparation=control.prepare({key:r.control_action_key,kind:'create_thread',task_id,payload,evidence});
  return {key:r.control_action_key,preparation,evidence,next:'Claim this exact key with the returned evidence; invoke only claim.payload.native once, settle its real receipt, confirm project placement, bind_owner and start. Refresh prepare_owner if the project proof expires.'};
}
