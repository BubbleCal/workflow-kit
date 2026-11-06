import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,nativeProof} from './test-fixtures/reactive.mjs';
import {reconcileCatalogResume} from './catalog-resume.mjs';

function setup(){
 const f=fixture();f.c.work.config.scope={...f.c.work.config.scope,project_id:'project'};
 const c=f.s.task('T-1').contract;
 f.c.work.create({id:'T-1',canonical_key:c.canonical_key,kind:'work',title:'Original design',objective:'Design only',workspace:'/old-workspace',requirements:[{id:'old',text:'Design'}],source:{kind:'legacy_reference',key:'legacy:T-1',evidence_ref:'original-import'}});
 const item=f.c.work.get('T-1');
 f.c.db.prepare("UPDATE work_items SET state='completed',updated_at=?,data=? WHERE id='T-1'").run(f.now()-1,JSON.stringify({...item.data,legacy_owner_thread_id:OWNER,legacy_record:{state:'design_complete',merge_hold:true}}));
 f.activate();f.event();const wake=f.begin();
 const request={task_id:'T-1',expected_revision:0,expected_contract_rev:1,source_message_id:'human:migrate',evidence_ref:'human:original',actual_human_verified:true,native_binding:nativeProof({message:wake.prompt,now:f.now()})};
 return {...f,wake,request};
}

test('an explicitly resumed legacy owner can register its result without reopening execution or losing history',()=>{
 const f=setup();try{
  const report={task_id:'T-1',owner_thread_id:OWNER,report_key:'original-result',outcome:'no_actionable_findings',summary:'Completed bounded measurement',evidence_refs:['actual-measurement']};
  assert.throws(()=>f.c.work.recordReport(report),/accepted task owner/);
  const original=f.s.task('T-1'),wakes=f.c.db.prepare('SELECT * FROM rt_wakes').all();
  const result=reconcileCatalogResume(f.c,f.request);assert.equal(result.reconciled,true);assert.equal(result.execution_started,false);
  assert.deepEqual(f.s.task('T-1'),original);assert.deepEqual(f.c.db.prepare('SELECT * FROM rt_wakes').all(),wakes);
  const task=f.c.work.get('T-1');assert.equal(task.owner_thread_id,OWNER);assert.equal(task.data.workspace,original.contract.workspace);
  assert.deepEqual(task.data.legacy_record,{state:'design_complete',merge_hold:true});assert.equal(task.data.catalog_runtime_resume.previous.fields.workspace,'/old-workspace');
  assert.equal(task.data.catalog_runtime_resume.previous.state,'completed');assert.equal(task.authorization.source_message_id,'human:migrate');
  assert.equal(f.c.work.recordReport(report).recorded,true);
  assert.equal(reconcileCatalogResume(f.c,f.request).already_reconciled,true);assert.equal(f.c.work.get('T-1').revision,1);
 }finally{f.c.close();}
});

test('catalog reconciliation preserves human decisions, pauses and all original queue receipts',()=>{
 for(const paused of [false,true]){const f=setup();try{
  f.decide({wake_id:f.wake.id,disposition:'needs_decision',plan:undefined});
  f.s.finish({task_id:'T-1',wake_id:f.wake.id,turn_id:'native-turn',evidence_ref:'decision'});
  if(paused)f.mode('paused');const before=f.s.task('T-1'),wake=f.c.db.prepare('SELECT * FROM rt_wakes').get();
  f.request.native_binding=nativeProof({message:f.wake.prompt,status:'completed',now:f.now()});
  reconcileCatalogResume(f.c,f.request);assert.deepEqual(f.s.task('T-1'),before);assert.deepEqual(f.c.db.prepare('SELECT * FROM rt_wakes').get(),wake);
  assert.equal(f.s.reserveQueuedWake('T-1').reserved,false);
 }finally{f.c.close();}}
});

test('unrelated authority, owners, contracts, expired proofs and later catalog completion cannot be used as a resume',()=>{
 const cases=[
  f=>{f.request.actual_human_verified=false;},f=>{f.request.source_message_id='unrelated-user';},f=>{f.request.evidence_ref='other-scope';},
  f=>{f.request.expected_revision=9;},f=>{f.request.expected_contract_rev=2;},
  f=>{f.request.native_binding=nativeProof({thread:'other-owner',now:f.now()});},
  f=>{f.request.native_binding=nativeProof({workspace:'/different',now:f.now()});},
  f=>{f.advance(61000);},
  f=>{f.c.db.prepare("UPDATE work_items SET updated_at=? WHERE id='T-1'").run(f.now()+1);},
  f=>{f.c.db.prepare("UPDATE rt_tasks SET status='complete' WHERE task_id='T-1'").run();},
  f=>{f.c.db.prepare("UPDATE rt_wakes SET turn_id='different' WHERE id=?").run(f.wake.id);},
  f=>{const item=f.c.work.get('T-1');f.c.db.prepare("UPDATE work_items SET data=? WHERE id='T-1'").run(JSON.stringify({...item.data,legacy_owner_thread_id:'someone-else'}));}
 ];
 for(const mutate of cases){const f=setup();try{mutate(f);assert.throws(()=>reconcileCatalogResume(f.c,f.request));assert.equal(f.c.work.get('T-1').state,'completed');}finally{f.c.close();}}
});
