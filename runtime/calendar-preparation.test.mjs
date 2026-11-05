import test from 'node:test';
import assert from 'node:assert/strict';
import {workFixture} from './test-fixtures/work.mjs';
import {calendarPreparation,scheduleCalendarPreparation} from './calendar-preparation.mjs';
import {inboxAdmission} from './inbox-policy.mjs';
import {nativeProof} from './test-fixtures/reactive.mjs';
const policy={key:'accept_calendar_preparation',enabled:true,allowed_kinds:['work'],calendar_id:'work@example.com',self_email:'me@example.com',lead_minutes:45,timezone:'Asia/Shanghai',profiles:[{title:'One on one',series_id:'series',enabled:true}],exclusions:{titles:['Sprint planning']},source_message_id:'human:meeting-policy',verbatim_text:'Discovery may accept, create owners and schedule existing authorized meeting preparation',evidence_ref:'human-policy',actual_human_verified:true};
const meeting={id:'instance',summary:'One on one',start:'2026-11-06T09:00:00+08:00',status:'confirmed',recurring_event_id:'series',attendees:[{email:'me@example.com',is_self:true,response_status:'accepted'},{email:'manager@example.com',response_status:'accepted'}]};
const observation={source_kind:'calendar',scope_key:'work@example.com',calendar_id:'work@example.com',entity_key:'calendar:work@example.com:instance',item_key:'instance',url:'https://calendar.google.com/event?id=instance',evidence_ref:'full-event'};
function unified(f){
 const t=f.work.create({canonical_key:'service:meeting-preparation',title:'Meeting preparation',objective:'Prepare authorized meetings',meeting_service:true,
   requirements:[{id:'brief',text:'Prepare each due occurrence'}],schedule_sources:[],trigger_only:true}).task;
 f.accept(t.id);f.bind(t.id,'66666666-6666-4666-8666-666666666666');f.work.start(f.c.reactive,{task_id:t.id,queue_compatibility_verified:true});
 f.work.setPolicy({...policy,lead_minutes:90,service_task_id:t.id});return t;
}
test('one meeting service schedules distinct occurrences ninety minutes early without new owners or early work',()=>{
 const f=workFixture();try{const service=unified(f);
  const a=f.work.atomic(()=>f.work.prepareCalendarInside(observation,meeting));
  const b=f.work.atomic(()=>f.work.prepareCalendarInside({...observation,item_key:'second',entity_key:'calendar:work@example.com:second'},{...meeting,id:'second',start:'2026-11-06T09:30:00+08:00'}));
  assert.equal(a.task.id,service.id);assert.equal(b.task.id,service.id);assert.equal(f.work.list().length,1);
  const result=scheduleCalendarPreparation(f.c,service.id);assert.equal(result.schedules.length,2);
  assert.deepEqual(result.schedules.map(s=>new Date(s.schedule.start_at).toISOString()),['2026-11-05T23:30:00.000Z','2026-11-06T00:00:00.000Z']);
  assert.equal(f.c.reactive.task(service.id).status,'waiting');assert.equal(f.c.reactive.task(service.id).dirty,false);assert.equal(f.c.reactive.openWake(service.id),null);
  scheduleCalendarPreparation(f.c,service.id);assert.equal(f.c.scheduler.list().length,2);
  assert.equal(f.c.db.prepare('SELECT count(*) n FROM work_owner_requests').get().n,0);
 }finally{f.c.close();}
});
test('meeting moves and cancellations preserve old evidence and replace only pending timers',()=>{
 const f=workFixture();try{const service=unified(f);f.work.atomic(()=>f.work.prepareCalendarInside(observation,meeting));
  const first=scheduleCalendarPreparation(f.c,service.id).schedules[0].schedule;
  f.work.atomic(()=>f.work.prepareCalendarInside(observation,{...meeting,start:'2026-11-06T10:00:00+08:00'}));scheduleCalendarPreparation(f.c,service.id);
  assert.equal(f.c.scheduler.get(first.id).status,'cancelled');assert.equal(f.c.scheduler.list().filter(s=>s.status==='enabled').length,1);
  assert.equal(f.work.meetingOccurrences(service.id).length,2);
  f.work.atomic(()=>f.work.prepareCalendarInside(observation,{...meeting,status:'cancelled'}));scheduleCalendarPreparation(f.c,service.id);
  assert.equal(f.c.scheduler.list().filter(s=>s.status==='enabled').length,0);assert.equal(f.work.list().length,1);
 }finally{f.c.close();}
});
test('a changed authorized lead time gets a new schedule generation and preserves exclusions',()=>{
 const f=workFixture();try{const service=unified(f);const a=f.work.atomic(()=>f.work.prepareCalendarInside(observation,meeting));scheduleCalendarPreparation(f.c,service.id);
  assert.throws(()=>f.work.setPolicy({...policy,lead_minutes:120,service_task_id:service.id,actual_human_verified:false}),/actual user/);
  f.work.setPolicy({...policy,lead_minutes:120,service_task_id:service.id});const b=f.work.atomic(()=>f.work.prepareCalendarInside(observation,meeting));
  assert.notEqual(a.preparation.generation,b.preparation.generation);scheduleCalendarPreparation(f.c,service.id);
  assert.equal(f.c.scheduler.list().filter(s=>s.status==='enabled').length,1);
  const excluded=f.work.atomic(()=>f.work.prepareCalendarInside({...observation,item_key:'excluded'},{...meeting,id:'excluded',summary:'Sprint planning'}));
  assert.equal(excluded.excluded,true);assert.equal(f.work.meetingOccurrences(service.id).length,2);
 }finally{f.c.close();}
});
test('reconciling a cancelled meeting preserves a due run already accepted by the service',()=>{
 const f=workFixture();try{const service=unified(f);
  assert.throws(()=>f.work.reconcileMeeting({task_id:service.id,calendar_id:'wrong',meeting,evidence_ref:'actual',identity_verified:true}),/configured unified/);
  f.work.reconcileMeeting({task_id:service.id,calendar_id:policy.calendar_id,meeting,evidence_ref:'actual',identity_verified:true});
  const timer=scheduleCalendarPreparation(f.c,service.id).schedules[0].schedule;f.advance(timer.start_at-f.now());assert.equal(f.c.scheduler.tick().admitted,1);
  f.work.reconcileMeeting({task_id:service.id,calendar_id:policy.calendar_id,meeting:{...meeting,status:'cancelled'},evidence_ref:'actual-cancellation',identity_verified:true});
  scheduleCalendarPreparation(f.c,service.id);assert.equal(f.c.scheduler.get(timer.id).status,'cancelled');assert.equal(f.c.scheduler.runs(timer.id)[0].state,'admitted');
 }finally{f.c.close();}
});
test('meeting consolidation preserves original scope without falsely marking preparation complete',()=>{
 const f=workFixture();try{const service=unified(f),old=f.work.create({canonical_key:'meeting_prep:work@example.com:old',title:'Old meeting',objective:'Prepare old occurrence',requirements:[{id:'brief',text:'Prepare brief'}],schedule_sources:['runtime:old-meeting'],trigger_only:true}).task;
  f.accept(old.id);f.bind(old.id);f.work.start(f.c.reactive,{task_id:old.id,queue_compatibility_verified:true});
  const oldRuntime=f.c.reactive.task(old.id),binding=nativeProof({thread:oldRuntime.owner_id,status:'completed',now:f.now()});
  const req={task_ids:[old.id],into_task_id:service.id,source_message_id:'user:merge-meetings',actual_human_verified:true,evidence_ref:'saved-handoff',native_bindings:{[old.id]:binding},native_sources_disabled:{}};
  assert.throws(()=>f.work.consolidateMeetings(f.c.reactive,req),/paused/);
  f.c.reactive.setMode({task_id:old.id,mode:'paused',source_message_id:req.source_message_id,actual_human_verified:true,native_binding:binding,legacy_quiescent:true});
  const busy=nativeProof({thread:oldRuntime.owner_id,now:f.now()});assert.throws(()=>f.work.consolidateMeetings(f.c.reactive,{...req,native_bindings:{[old.id]:busy}}),/quiescent/);
  assert.equal(f.work.consolidateMeetings(f.c.reactive,req).preparation_completed,false);
  const retired=f.c.reactive.task(old.id);assert.equal(retired.status,'superseded');assert.equal(f.work.get(old.id).state,'superseded');assert.equal(retired.contract.requirements[0].text,'Prepare brief');
  assert.equal(f.work.archivableConsolidation(old.id),true);
  const payload={purpose:'task_consolidation',runtime_context:{contract_rev:retired.contract_rev,context_rev:retired.context_rev,plan_rev:retired.plan_rev}};
  assert.deepEqual(f.c.reactive.actionReasons('archive',old.id,payload),[]);
  assert.ok(f.c.reactive.actionReasons('archive',old.id,{...payload,purpose:undefined}).length);
  assert.equal(f.c.reactive.task(service.id).status,'waiting');
 }finally{f.c.close();}
});
test('authorized calendar intake accepts once and provisions an owner without a human decision',()=>{
 const f=workFixture();try{f.work.setPolicy(policy);const first=f.work.atomic(()=>f.work.prepareCalendarInside(observation,meeting));const second=f.work.atomic(()=>f.work.prepareCalendarInside(observation,meeting));
 assert.equal(first.task.id,second.task.id);assert.equal(second.task.state,'accepted');assert.equal(f.c.db.prepare("SELECT count(*) n FROM work_notices WHERE state='pending'").get().n,0);
 const request=f.work.requestOwner({task_id:first.task.id});assert.equal(request.request.source_message_id,policy.source_message_id);
 f.bind(first.task.id);f.work.start(f.c.reactive,{task_id:first.task.id,queue_compatibility_verified:true});const s=scheduleCalendarPreparation(f.c,first.task.id);
 assert.equal(new Date(s.schedule.start_at).toISOString(),'2026-11-06T00:15:00.000Z');assert.equal(f.c.reactive.openWake(first.task.id),null);
 assert.equal(scheduleCalendarPreparation(f.c,first.task.id).created,false);
 }finally{f.c.close();}
});
test('meeting policy cannot authorize another calendar, unknown scope, declined or excluded meetings',()=>{
 assert.equal(calendarPreparation(policy,{...observation,scope_key:'personal'},meeting).authorized,false);
 assert.equal(calendarPreparation(policy,observation,{...meeting,summary:'Unapproved seminar',recurring_event_id:'unknown'},Date.parse('2026-11-04T00:00Z')).authorized,false);
 assert.equal(calendarPreparation(policy,observation,{...meeting,summary:'Sprint planning'},Date.parse('2026-11-04T00:00Z')).excluded,true);
 assert.equal(calendarPreparation(policy,observation,{...meeting,attendees:[{email:'me@example.com',is_self:true,response_status:'declined'}]},Date.parse('2026-11-04T00:00Z')).excluded,true);
 assert.equal(calendarPreparation(policy,observation,{...meeting,attendees:undefined},Date.parse('2026-11-04T00:00Z')).authorized,false);
});
test('changing an existing meeting never silently replaces its executing contract or schedule',()=>{
 const f=workFixture();try{f.work.setPolicy(policy);const first=f.work.atomic(()=>f.work.prepareCalendarInside(observation,meeting));f.bind(first.task.id);f.work.start(f.c.reactive,{task_id:first.task.id,queue_compatibility_verified:true});scheduleCalendarPreparation(f.c,first.task.id);
 const moved=f.work.atomic(()=>f.work.prepareCalendarInside(observation,{...meeting,start:'2026-11-06T10:00:00+08:00'}));assert.equal(moved.requires_reschedule,true);assert.equal(f.c.scheduler.list().length,1);assert.equal(moved.task.data.meeting_preparation.prep_at,'2026-11-06T00:15:00.000Z');
 }finally{f.c.close();}
});
test('raw inbox labels do not turn progress or an unrequested answer into a notification',()=>{
 for(const kind of ['answer','important_completion','decision','action_required'])assert.equal(inboxAdmission({key:'raw',kind,payload:{task_id:'T-1',text:'waiting for CI'}}).allowed,false);
 assert.equal(inboxAdmission({key:'candidate:T-1',kind:'decision',payload:{catalog_candidate:true},task:{state:'accepted',data:{meeting_preparation:{}}}}).allowed,false);
 assert.equal(inboxAdmission({key:'owner:T-1',kind:'decision',payload:{catalog_owner_needed:true},task:{state:'accepted'},ownerCreationAuthorized:true}).allowed,false);
});
test('actual guarded answers, real decisions and native completion remain deliverable',()=>{
 const base={key:'answer',kind:'answer',payload:{task_id:'T-1',control_action_key:'answer',question_message_id:'human:q'},action:{kind:'notify',state:'queued',task_id:'T-1',payload:{category:'answer',question_message_id:'human:q'}}};
 assert.equal(inboxAdmission(base).allowed,true);assert.equal(inboxAdmission({...base,payload:{...base.payload,question_message_id:'different'}}).allowed,false);
 assert.equal(inboxAdmission({key:'candidate:T-1',kind:'decision',payload:{catalog_candidate:true},task:{state:'candidate',data:{}}}).allowed,true);
 assert.equal(inboxAdmission({key:'complete:wake',kind:'important_completion',payload:{task_completed:true,archive_request:{thread_id:'owner'}},completion:{id:'wake',state:'finished',status:'complete',owner_id:'owner'}}).allowed,true);
});

test('the shared mailbox blocks raw inbox writes and suppresses earlier unguarded pending messages',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {fixture}=await import('./test-fixtures/reactive.mjs'),{Mailbox}=await import('./mailbox.mjs'),{bindings}=await import('./instance.mjs');
 const root=mkdtempSync(join(tmpdir(),'inbox-entry-')),f=fixture(join(root,'control.sqlite'),root),m=new Mailbox(join(root,'mailbox.sqlite'));
 const before={layout:bindings.layout,strict:bindings.delivery.main_inbox_strict};
 try{
  bindings.layout='native';bindings.delivery.main_inbox_strict=false;
  m.enqueue({key:'old-raw',lane:'inbox',kind:'answer',payload:{task_id:'T-1',text:'CI still running'}});
  bindings.delivery.main_inbox_strict=true;
  const result=m.enqueue({key:'new-raw',lane:'inbox',kind:'important_completion',payload:{task_id:'T-1',text:'Owner assigned'}});
  assert.equal(result.state,'suppressed');assert.equal(m.db.prepare("SELECT count(*) n FROM mail WHERE item_key='new-raw'").get().n,0);
  assert.equal(m.reconcileInbox().suppressed,1);assert.equal(m.db.prepare("SELECT state FROM mail WHERE item_key='old-raw'").get().state,'suppressed');
 }finally{bindings.layout=before.layout;bindings.delivery.main_inbox_strict=before.strict;m.close();f.c.close();rmSync(root,{recursive:true,force:true});}
});

test('meeting owner preparation supplies real catalog guard fields and preserves a single creation key',async()=>{
 const {prepareMeetingOwner}=await import('./calendar-preparation.mjs');
 const f=workFixture();try{f.work.setPolicy(policy);const accepted=f.work.atomic(()=>f.work.prepareCalendarInside(observation,meeting));
 const input={task_id:accepted.task.id,projects:[{hostId:'local',projectId:'project',label:'Project'}],project_catalog_ref:'native-projects',checked_at:new Date(f.now()).toISOString()};
 const first=await prepareMeetingOwner(f.c,input);assert.equal(first.preparation.prepared,true,JSON.stringify(first.preparation));assert.equal(first.evidence.duplicate_task_exists,false);assert.equal(first.evidence.underlying_job_for_scope_running,false);
 const second=await prepareMeetingOwner(f.c,input);assert.equal(second.key,first.key);assert.equal(second.preparation.state,'prepared');
 assert.equal(f.c.db.prepare("SELECT count(*) n FROM actions WHERE kind='create_thread'").get().n,1);
 }finally{f.c.close();}
});
