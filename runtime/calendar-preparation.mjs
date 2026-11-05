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
