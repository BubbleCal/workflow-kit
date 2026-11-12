import test from 'node:test';
import assert from 'node:assert/strict';
import {workFixture,DISCOVERY} from './test-fixtures/work.mjs';
import {nativeProof,OWNER} from './test-fixtures/reactive.mjs';
import {WorkCatalog} from './work-catalog.mjs';

const definition=key=>({canonical_key:key,title:key,objective:'Deliver the accepted existing scope',requirements:[{id:'result',text:'Verify the outcome'}],workspace:'/task'});
const close=f=>f.work.setPolicy({key:'new_task_intake',enabled:false,actual_human_verified:true,source_message_id:'actual-user-existing-only',verbatim_text:'No new tasks here; continue existing tasks',evidence_ref:'native-human-proof'});

test('closed intake survives catalog reconstruction and preserves accepted execution while refusing new work',()=>{
 const f=workFixture();try{
  const accepted=f.work.create(definition('accepted')).task,candidate=f.work.create(definition('candidate')).task;
  f.accept(accepted.id);f.bind(accepted.id);close(f);
  assert.equal(f.work.create(definition('accepted')).created,false);
  assert.equal(f.accept(accepted.id).state,'accepted');
  assert.throws(()=>f.work.create(definition('new')),/intake is closed/);
  assert.throws(()=>f.accept(candidate.id),/intake is closed/);
  assert.equal(new WorkCatalog(f.c.db,{config:f.config,now:f.now}).intakeEnabled(),false);
  const wake=f.begin(accepted.id);assert.equal(wake.state,'running');
  const registry=f.c.reactive.registry;f.c.reactive.registry=()=>{const r=registry();r.task_registry.items['new-unregistered']={...r.task_registry.items[accepted.id],canonical_key:'new-unregistered'};return r;};
  assert.throws(()=>f.c.reactive.adopt({task_id:'new-unregistered',owner_thread_id:OWNER,contract:{...f.work.contract(accepted.id),canonical_key:'new-unregistered'},source_message_id:'old-human',actual_human_verified:true}),/intake is closed/);
  assert.equal(f.c.reactive.task(accepted.id).mode,'active');
  assert.equal(f.work.list().length,2);
 }finally{f.c.close();}
});

test('discovery records unmatched work as ignored but still links genuine feedback to an existing accepted owner',()=>{
 const f=workFixture();try{
  const old=f.work.create(definition('existing')).task;f.accept(old.id);f.bind(old.id);f.begin(old.id);
  const d=f.c.discovery;d.configure({source_id:'linear',enabled:true,scope:{project:'project'},source_message_id:'user-source',actual_human_verified:true,evidence_ref:'scope'});
  close(f);const q=d.enqueueDue({enqueue:v=>({queued:true,key:v.key})},'/instance');let b=d.batch(q.batch_id);
  d.begin({batch_id:b.id,generation:b.generation,native_proof:nativeProof({thread:DISCOVERY,message:b.prompt,now:f.now()})});b=d.batch(b.id);
  d.ingest({batch_id:b.id,generation:b.generation,source_id:'linear',page_key:'page',complete:true,evidence_ref:'native-source-page',observations:['new','old'].map(key=>({entity_key:'linear:'+key,item_key:key,version:'v1',scope_key:'project',summary:key,url:'https://linear.app/example/issue/'+key}))});
  const rows=d.status().observations;
  const fresh=rows.find(o=>o.entity_key==='linear:new'),existing=rows.find(o=>o.entity_key==='linear:old');
  const ignored=d.classify({observation_id:fresh.observation_id,disposition:'candidate',candidate:definition('new'),reason:'New independent finding',evidence_ref:'native-source-page'});
  assert.equal(ignored.reason,'new_task_intake_closed');assert.equal(ignored.owner_required,false);
  const linked=d.classify({observation_id:existing.observation_id,disposition:'existing',task_id:old.id,identity_verified:true,reason:'Same task feedback',evidence_ref:'native-source-page'});
  assert.equal(linked.task_id,old.id);assert.equal(f.work.list().length,1);
  assert.equal(d.status().new_task_intake_enabled,false);
  assert.equal(f.work.taskForSource('linear:old').id,old.id);
 }finally{f.c.close();}
});

test('closed intake requires real policy authority and can only be reopened by another explicit policy',()=>{
 const f=workFixture();try{
  assert.throws(()=>f.work.setPolicy({key:'new_task_intake',enabled:false,actual_human_verified:false}),/actual user/);
  close(f);assert.throws(()=>f.work.create(definition('future')),/intake is closed/);
  f.work.setPolicy({key:'new_task_intake',enabled:true,allowed_kinds:['work'],actual_human_verified:true,source_message_id:'later-explicit-human',verbatim_text:'Reopen new work here',evidence_ref:'later-proof'});
  assert.equal(f.work.create(definition('future')).created,true);
 }finally{f.c.close();}
});
