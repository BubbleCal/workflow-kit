import test from 'node:test';
import assert from 'node:assert/strict';
import {Mailbox,COORDINATOR} from './mailbox.mjs';
import {fixture,OWNER,NOW} from './test-fixtures/reactive.mjs';

function setup() {
  const f=fixture(),p={event:'pr_lifecycle_action',action:'triage_ci',task_id:'T-1',owner_thread_id:OWNER,
    pr_key:'example/project#42',head:'a'.repeat(40),lifecycle_key:'lifecycle:example/project#42:failure',lifecycle_generation:2};
  const key=p.lifecycle_key+':2',registry=()=>({task_registry:{items:{'T-1':{owner_thread_id:OWNER}}}});
  const m=new Mailbox(':memory:',{now:()=>NOW,taskRegistry:registry,lifecycleAccess:fn=>fn(f.c.lifecycle)});
  m.enqueue({key,lane:'coordinator',kind:'event',payload:p});m.db.prepare("UPDATE mail SET state='reactive' WHERE item_key=?").run(key);
  f.event(`legacy:${key}:T-1`,p,{source:'legacy_mailbox'});f.activate();const wake=f.begin();f.decide({wake_id:wake.id});
  const current=f.s.task('T-1');
  const h={event:'native_ci_triage_result',affected_task_ids:['T-1'],owner_thread_id:OWNER,repository:'example/project',pr_number:42,head:p.head,
    runtime_context:{context_rev:current.context_rev,plan_rev:current.plan_rev},evidence_ref:'triage-result'};
  m.enqueue({key:'handoff',lane:'coordinator',kind:'configuration',payload:h});
  const idle={checked_at:new Date(NOW).toISOString(),thread:{id:COORDINATOR,status:{type:'idle'}},latestTurn:{id:'old',status:'completed'}};
  const b=m.reserve('coordinator',idle).batch;m.setPrompt(b.id,'fixed');m.authorizeSend(b.id,idle);m.delivery(b.id,{outcome:'sent',receipt:{}});m.begin(b.id);
  const input={batch_id:b.id,event_key:key,handoff_event_key:'handoff',ack:false,authorization_verified:true,evidence_ref:'triage-result',goals:[{
    id:'original-goal',authorization_ref:'human:original',expected_revision:0,complete:false,stages:[
      {id:'ci',task_id:'T-1',owner_thread_id:OWNER,scope_key:'ci',state:'complete',completion_evidence_ref:'triage-result',depends_on:[]},
      {id:'acceptance',task_id:'T-1',owner_thread_id:OWNER,scope_key:'acceptance',state:'blocked',depends_on:['ci'],blocker:{reason:'released dependency missing',resume_condition:'official compatible release',evidence_ref:'pins'}}]}]};
  return {f,m,b,input,key,close(){m.close();f.c.close();}};
}
test('admitted native CI handoff records exact source progress without altering batch or replaying work',()=>{
  const x=setup();try{
    x.input.goals[0].stages[1].owner_thread_id=COORDINATOR;
    const snapshot=JSON.stringify(x.m.get(x.b.id).snapshot);
    assert.throws(()=>x.m.recordProgress({...x.input,handoff_event_key:undefined}),/current coordinator batch/);
    assert.equal(x.m.recordProgress(x.input).recorded,true);
    assert.equal(x.m.recordProgress(x.input).duplicate,true);
    assert.equal(JSON.stringify(x.m.get(x.b.id).snapshot),snapshot);
    assert.equal(x.m.db.prepare('SELECT state FROM mail WHERE item_key=?').get(x.key).state,'reactive');
    assert.equal(x.m.db.prepare('SELECT count(*) n FROM continuation_actions').get().n,0);
    assert.equal(JSON.parse(x.m.db.prepare('SELECT binding FROM progress_handoffs').get().binding).handoff_event_key,'handoff');
  }finally{x.close();}
});
test('handoff rejects mismatched episode, owner, decision, automatic ACK and completed parent',()=>{
  for(const change of ['head','owner','revision','ack','complete','batch','source','consumption','generation']){const x=setup();try{
    const batch=x.m.get(x.b.id),h=batch.snapshot.items.find(i=>i.key==='handoff').payload;
    if(change==='head')h.head='b'.repeat(40);
    if(change==='owner')h.owner_thread_id='other';
    if(change==='revision')h.runtime_context.context_rev++;
    if(['head','owner','revision'].includes(change))x.m.db.prepare('UPDATE batches SET snapshot=? WHERE id=?').run(JSON.stringify(batch.snapshot),x.b.id);
    if(change==='consumption')x.f.c.db.prepare("UPDATE rt_events SET disposition=NULL").run();
    if(change==='generation')x.f.c.db.prepare("UPDATE rt_events SET payload=json_set(payload,'$.lifecycle_generation',99)").run();
    if(change==='ack')x.input.ack=true;
    if(change==='complete')x.input.goals[0].complete=true;
    if(change==='batch')x.input.handoff_event_key='not-admitted';
    if(change==='source')x.m.db.prepare("UPDATE mail SET state='pending' WHERE item_key=?").run(x.key);
    assert.throws(()=>x.m.recordProgress(x.input),/handoff/i,change);
    assert.equal(x.m.progress.hasResolution(x.key),false);
  }finally{x.close();}}
});

function replaceHandoff(x,patch) {
  const b=x.m.get(x.b.id);Object.assign(b.snapshot.items.find(i=>i.key==='handoff').payload,patch);
  x.m.db.prepare('UPDATE batches SET snapshot=? WHERE id=?').run(JSON.stringify(b.snapshot),b.id);
}
function postMergeSetup() {
  const x=setup(),merge='c'.repeat(40),head='a'.repeat(40),p=JSON.parse(x.m.db.prepare('SELECT payload FROM mail WHERE item_key=?').get(x.key).payload);
  Object.assign(p,{action:'decide_after_merge',state:'merged',merge_sha:merge});
  x.m.db.prepare('UPDATE mail SET payload=? WHERE item_key=?').run(JSON.stringify(p),x.key);
  x.f.c.db.prepare('UPDATE rt_events SET payload=? WHERE event_id=?').run(JSON.stringify(p),`legacy:${x.key}:T-1`);
  const e=x.f.c.db.prepare('SELECT decision_id FROM rt_events WHERE event_id=?').get(`legacy:${x.key}:T-1`);
  x.f.c.db.prepare("UPDATE rt_decisions SET data=json_set(data,'$.evidence_refs',json(?)) WHERE id=?").run(JSON.stringify(['scoped-acceptance']),e.decision_id);
  replaceHandoff(x,{event:'native_post_merge_scope_disposition',head:undefined,expected_head_sha:head,expected_merge_sha:merge,
    original_source_event_key:x.key,original_lifecycle_key:p.lifecycle_key,lifecycle_generation:p.lifecycle_generation,scoped_acceptance_ref:'scoped-acceptance',project_complete:false});
  x.f.c.lifecycle.track({repository:'example/project',pr_number:42,task_id:'T-1',owner_thread_id:OWNER,authorization_ref:'human:original'});
  x.f.c.lifecycle.observe({repository:'example/project',pr_number:42,head_sha:head,state:'merged',draft:false,
    checked_at:new Date(NOW).toISOString(),updated_at:new Date(NOW).toISOString(),merged_at:new Date(NOW-1000).toISOString(),merge_sha:merge,evidence_ref:'actual-merge'});
  return x;
}
test('duplicate CI disposition binds the exact consumed failure episode',()=>{
  const x=setup();try{
    replaceHandoff(x,{event:'native_duplicate_ci_obligation_disposition'});
    x.f.c.db.prepare("UPDATE rt_decisions SET data=json_set(data,'$.evidence_refs',json(?))").run(JSON.stringify(['triage-result']));
    assert.equal(x.m.recordProgress(x.input).recorded,true);
    assert.equal(x.m.progress.goals()[0].complete,false);
  }finally{x.close();}
});
test('post-merge scope handoff records its merge identity without completing or dispatching parent work',()=>{
  const x=postMergeSetup();try{
    const snapshot=JSON.stringify(x.m.get(x.b.id).snapshot);
    assert.equal(x.m.recordProgress(x.input).recorded,true);
    const binding=JSON.parse(x.m.db.prepare('SELECT binding FROM progress_handoffs').get().binding);
    assert.equal(binding.merge_sha,'c'.repeat(40));assert.equal(x.m.progress.goals()[0].complete,false);
    assert.equal(JSON.stringify(x.m.get(x.b.id).snapshot),snapshot);
    assert.equal(x.m.db.prepare('SELECT count(*) n FROM continuation_actions').get().n,0);
    assert.equal(x.f.c.db.prepare('SELECT retired FROM lifecycle_prs').get().retired,0);
  }finally{x.close();}
});
test('post-merge handoff rejects wrong task, head, merge, generation, native decision and unbound acceptance',()=>{
  for(const change of ['task','head','merge','generation','decision','acceptance','source','watch','conflicting-alias']){
    const x=postMergeSetup();try{
      if(change==='task')replaceHandoff(x,{affected_task_ids:['other']});
      if(change==='head')replaceHandoff(x,{expected_head_sha:'b'.repeat(40)});
      if(change==='merge')replaceHandoff(x,{expected_merge_sha:'d'.repeat(40)});
      if(change==='generation')replaceHandoff(x,{lifecycle_generation:3});
      if(change==='decision')x.f.c.db.prepare('UPDATE rt_events SET decision_id=NULL').run();
      if(change==='acceptance')replaceHandoff(x,{scoped_acceptance_ref:'unverified-file'});
      if(change==='source')replaceHandoff(x,{original_source_event_key:'other-source'});
      if(change==='watch')x.f.c.db.prepare("UPDATE lifecycle_prs SET snapshot=json_set(snapshot,'$.merge_sha',?)").run('d'.repeat(40));
      if(change==='conflicting-alias')replaceHandoff(x,{head:'b'.repeat(40)});
      assert.throws(()=>x.m.recordProgress(x.input),/handoff/i,change);
      assert.equal(x.m.progress.hasResolution(x.key),false);
    }finally{x.close();}
  }
});

test('duplicate CI handoff rejects another task, head, generation or decision evidence',()=>{
  for(const change of ['task','head','generation','decision','evidence']) {
    const x=setup();try{
      replaceHandoff(x,{event:'native_duplicate_ci_obligation_disposition'});
      x.f.c.db.prepare("UPDATE rt_decisions SET data=json_set(data,'$.evidence_refs',json(?))").run(JSON.stringify(['triage-result']));
      if(change==='task')replaceHandoff(x,{affected_task_ids:['other']});
      if(change==='head')replaceHandoff(x,{head:'b'.repeat(40)});
      if(change==='generation')replaceHandoff(x,{lifecycle_generation:3});
      if(change==='decision')replaceHandoff(x,{runtime_context:{context_rev:99,plan_rev:99}});
      if(change==='evidence')x.f.c.db.prepare("UPDATE rt_decisions SET data=json_set(data,'$.evidence_refs',json('[]'))").run();
      assert.throws(()=>x.m.recordProgress(x.input),/handoff/i,change);
      assert.equal(x.m.progress.hasResolution(x.key),false);
    }finally{x.close();}
  }
});
