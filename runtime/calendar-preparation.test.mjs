import test from 'node:test';
import assert from 'node:assert/strict';
import {workFixture} from './test-fixtures/work.mjs';
import {calendarPreparation,scheduleCalendarPreparation} from './calendar-preparation.mjs';
import {inboxAdmission} from './inbox-policy.mjs';
const policy={key:'accept_calendar_preparation',enabled:true,allowed_kinds:['work'],calendar_id:'work@example.com',self_email:'me@example.com',lead_minutes:45,timezone:'Asia/Shanghai',profiles:[{title:'One on one',series_id:'series',enabled:true}],exclusions:{titles:['Sprint planning']},source_message_id:'human:meeting-policy',verbatim_text:'Discovery may accept, create owners and schedule existing authorized meeting preparation',evidence_ref:'human-policy',actual_human_verified:true};
const meeting={id:'instance',summary:'One on one',start:'2026-11-06T09:00:00+08:00',status:'confirmed',recurring_event_id:'series',attendees:[{email:'me@example.com',is_self:true,response_status:'accepted'},{email:'manager@example.com',response_status:'accepted'}]};
const observation={source_kind:'calendar',scope_key:'work@example.com',calendar_id:'work@example.com',entity_key:'calendar:work@example.com:instance',item_key:'instance',url:'https://calendar.google.com/event?id=instance',evidence_ref:'full-event'};
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
