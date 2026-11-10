import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {nativeReadback} from './native-queue.mjs';
import {verifyFollowupAuthority} from './human-followup.mjs';

export function recoverScheduledOccurrence(root,state,input,now=Date.now()){
 if(input.actual_human_verified!==true||!input.evidence_ref)throw new Error('Actual scoped schedule repair authority required');
 verifyFollowupAuthority(input.human_authorization,input);
 const request=JSON.parse(readFileSync(input.original_request_file,'utf8')),failure=JSON.parse(readFileSync(input.original_failure_file,'utf8'));
 if(request.op!=='schedule_event'||request.schedule_id!==input.schedule_id||(!Number.isInteger(failure.exit_code)||failure.exit_code<=0)||JSON.parse(failure.stdout??'{}').error!=='Original schedule scope changed; reconcile its binding')throw new Error('Exact original failed scope-binding occurrence required');
 const at=Date.parse(request.native_proof?.checked_at);
 if(!Number.isFinite(at)||at>now+5000)throw new Error('Original native capture time required');
 const source=JSON.parse(readFileSync(join(root,'runtime-schedules.json'),'utf8')).sources.find(s=>s.id===input.schedule_id);
 if(source?.original_prompt_sha256!==input.expected_prompt_sha256)throw new Error('Reconciled schedule scope changed');
 // Replay the immutable failed invocation at its actual capture time, not a
 // fabricated fresh producer turn. Publication retains its original timestamp.
 const result=publishScheduledOccurrence(root,state,request,at);
 state.diagnostic(`schedule-repair:${result.event_id}`,{mode:'verified_original_occurrence_replay',source_message_id:input.source_message_id,evidence_ref:input.evidence_ref,original_request_file:input.original_request_file,original_failure_file:input.original_failure_file,original_checked_at:request.native_proof.checked_at,repaired_at:now,producer_identity_unchanged:true});
 return {...result,historical_occurrence_repaired:true,original_native_capture_preserved:true};
}

// Native schedules retain their times. Their short producer turns publish one
// occurrence; only the normal owner queue performs the original scheduled work.
export function publishScheduledOccurrence(root,state,{schedule_id,native_proof},now=Date.now()) {
  const path=join(root,'runtime-schedules.json');
  const source=(existsSync(path)?JSON.parse(readFileSync(path,'utf8')).sources:[])?.find(s=>s.id===schedule_id);
  if(!source||source.enabled!==true)throw new Error('Unknown or disabled native schedule source');
  const task=state.task(source.task_id);
  if(!task||!['active','paused'].includes(task.mode)||task.owner_id!==source.owner_thread_id||!task.contract.schedule_sources?.includes(schedule_id))
    throw new Error('Schedule must bind its registered original execution owner');
  const read=nativeReadback(native_proof?.readback),at=Date.parse(native_proof?.checked_at),turn=read.turns?.[0];
  const messages=(turn?.items??[]).filter(i=>i.type==='userMessage').map(i=>(i.content??[]).filter(i=>i.type==='text').map(i=>i.text).join('\n'))
    .filter(text=>text.includes(`[workflow-schedule-source:${schedule_id}]`));
  if(native_proof?.source!=='codex_app.read_thread'||!Number.isFinite(at)||at>now+5000||now-at>60000||
    read.thread?.kind!=='codex'||read.thread?.hostId!=='local'||read.thread.status?.type!=='active'||turn?.status!=='inProgress'||
    !Number.isFinite(turn.startedAt)||!messages.length||
    source.source_thread_id&&read.thread.id!==source.source_thread_id)
    throw new Error('Fresh actual native schedule producer turn required');
  const stamp=messages.at(-1).match(/<current_time_iso>([^<]+)<\/current_time_iso>/)?.[1];
  const sourceTime=stamp?Date.parse(stamp):turn.startedAt*1000;
  if(!Number.isFinite(sourceTime)||sourceTime>now+5000)throw new Error('Actual native trigger time required');
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:source.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(sourceTime)).map(p=>[p.type,p.value]));
  const date=`${parts.year}-${parts.month}-${parts.day}`,key=`schedule:${schedule_id}:${date}`;
  const old=state.db.prepare('SELECT task_id FROM rt_events WHERE event_id=?').get(key);
  if(old){if(old.task_id!==source.task_id)throw new Error('Scheduled occurrence ownership changed');return {published:false,duplicate:true,event_id:key};}
  const bytes=readFileSync(source.original_prompt_file);
  if(createHash('sha256').update(bytes).digest('hex')!==source.original_prompt_sha256)throw new Error('Original schedule scope changed; reconcile its binding');
  const directory=join(root,'observations','schedule-sources');mkdirSync(directory,{recursive:true});
  const evidence=join(directory,`${schedule_id}-${date}.json`);writeFileSync(evidence,JSON.stringify({schedule_id,date,native_proof},null,2)+'\n',{mode:0o600});
  return {published:true,...state.ingest({event_id:key,task_id:source.task_id,source:'native_schedule',subject:`schedule:${schedule_id}`,type:'schedule_due',observed_at:sourceTime,
    payload:{schedule_id,occurrence_date:date,triggered_at:new Date(sourceTime).toISOString(),producer_thread_id:read.thread.id,producer_turn_id:turn.id,original_instruction:bytes.toString('utf8'),authorization_ref:source.authorization_ref},evidence_ref:evidence,debounce_ms:0})};
}
