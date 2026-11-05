import test from 'node:test';
import assert from 'node:assert/strict';
import {workFixture,DISCOVERY} from './test-fixtures/work.mjs';
import {nativeProof} from './test-fixtures/reactive.mjs';

const configure=(d,scope={project:'project'},source_id='linear')=>d.configure({source_id,enabled:true,scope,
  source_message_id:'user:sources',actual_human_verified:true,evidence_ref:'actual-scope'});
const candidate={canonical_key:'improve-query',title:'Improve query',objective:'Measure then improve query behavior',requirements:[{id:'correct',text:'Preserve results'}]};
const observation={entity_key:'linear:issue-1',item_key:'issue-1',version:'v1',scope_key:'project',summary:'Investigate repeated work',url:'https://linear.app/example/issue/EX-1',assignee_id:'user-1'};
function scan(f){const d=f.c.discovery,queued=d.enqueueDue({enqueue:v=>({queued:true,key:v.key})},'/instance'),b=d.batch(queued.batch_id);
  d.begin({batch_id:b.id,generation:b.generation,native_proof:nativeProof({thread:DISCOVERY,message:b.prompt,now:f.now()})});return d.batch(b.id);}
const page=(d,b,patch={})=>d.ingest({batch_id:b.id,generation:b.generation,source_id:'linear',page_key:'page-1',observations:[observation],complete:true,evidence_ref:'connector-page',...patch});
const classify=(d,disposition='candidate',patch={})=>d.classify({observation_id:d.status().observations.find(o=>o.disposition===null).observation_id,
  disposition,reason:'Compared against task identities',evidence_ref:'source-readback',candidate,...patch});
const finish=(d,b,patch={})=>d.finish({batch_id:b.id,generation:b.generation,source_results:[{source_id:'linear',complete:true,followups_complete:true}],...patch});

test('source plans remain scoped and private Slack needs a recorded user grant',()=>{
 const f=workFixture();try{const d=f.c.discovery;
  assert.throws(()=>configure(d,{},'linear'),/specific Linear/);
  assert.throws(()=>configure(d,{channel_ids:['D123'],access:'private'},'slack'),/explicit user grant/);
  configure(d,{project:'project',issue_ids:['issue-1']});configure(d,{channel_ids:['C123']},'slack');configure(d,{page_ids:['page-1']},'notion');
  const b=scan(f);assert.equal(b.snapshot.sources.length,3);
  assert.equal(b.snapshot.sources.find(s=>s.kind==='linear').plan.requests.length,2);
  assert.equal(b.snapshot.sources.find(s=>s.kind==='slack').plan.requests[0].arguments.filters,'in:<#C123>');
  assert.deepEqual(b.snapshot.sources.find(s=>s.kind==='notion').plan.requests[0],{tool:'notion_fetch',arguments:{id:'page-1',include_discussions:true}});
  assert.throws(()=>page(d,b,{observations:[{...observation,scope_key:'other-project'}]}),/outside/);
  assert.throws(()=>finish(d,b),/all request streams/);
 }finally{f.c.close();}
});
test('complete source pages deduplicate candidates and preserve ungranted execution authority',()=>{
 const f=workFixture();try{const d=f.c.discovery;configure(d);const b=scan(f);page(d,b);
  assert.equal(page(d,b).recorded,false);assert.throws(()=>finish(d,b),/Classify/);
  const result=classify(d);assert.equal(result.execution_authorized,false);assert.equal(f.work.list().length,1);
  assert.equal(finish(d,b).finished,true);assert.equal(finish(d,b).duplicate,true);
  assert.equal(d.sources().find(s=>s.kind==='linear').last_success_at,Date.parse(b.snapshot.sources[0].window.to));
  f.advance(300000);const next=scan(f);page(d,next,{observations:[{...observation,version:'v2'}]});
  assert.equal(classify(d).task_id,result.task_id);finish(d,next);assert.equal(f.work.list().length,1);
 }finally{f.c.close();}
});
test('partial scans resume exact per-stream cursors and reject old-generation writers',()=>{
 const f=workFixture();try{const d=f.c.discovery;configure(d);const b=scan(f);
  page(d,b,{observations:[],complete:false,next_cursor:'next-2'});
  assert.throws(()=>page(d,b,{page_key:'skip',cursor:'wrong',observations:[]}),/exact saved source cursor/);
  finish(d,b,{source_results:[{source_id:'linear',complete:false,reason:'bounded scan budget'}]});
  assert.equal(d.sources()[0].last_success_at,null);f.advance(60000);const resumed=scan(f);assert.equal(resumed.id,b.id);assert.equal(resumed.generation,2);
  assert.throws(()=>page(d,b,{page_key:'stale',cursor:'next-2'}),/Stale discovery generation/);
  assert.throws(()=>finish(d,b),/Stale discovery generation/);
  page(d,resumed,{page_key:'page-2',cursor:'next-2'});classify(d);assert.equal(finish(d,resumed).finished,true);
 }finally{f.c.close();}
});
test('access failure never advances source coverage or changes a saved scan window',()=>{
 const f=workFixture();try{const d=f.c.discovery;configure(d);const b=scan(f);
  finish(d,b,{source_results:[{source_id:'linear',complete:false,reason:'connector authentication unavailable'}]});
  assert.equal(d.sources()[0].last_success_at,null);f.advance(300000);const resumed=scan(f);
  assert.deepEqual(resumed.snapshot.sources[0].window,b.snapshot.sources[0].window);
 }finally{f.c.close();}
});
test('scope invalidation retires only with native execution proof and supports the same source version in a new scope revision',()=>{
 const f=workFixture();try{const d=f.c.discovery;configure(d);const b=scan(f);page(d,b);
  configure(d);assert.throws(()=>page(d,b),/scope changed/);assert.throws(()=>finish(d,b),/actual native proof/);
  const proof=nativeProof({thread:DISCOVERY,message:b.prompt,now:f.now()});
  assert.equal(d.begin({batch_id:b.id,generation:1,native_proof:proof}).invalidated,true);
  assert.throws(()=>d.begin({batch_id:b.id,generation:1,native_proof:{...proof,source:'invented'}}),/native desktop/);
  const next=scan(f);page(d,next);classify(d);finish(d,next);assert.equal(f.work.list().length,1);
 }finally{f.c.close();}
});
test('assigned Linear policy accepts only the verified assignee and creates a durable owner-needed notice',()=>{
 const f=workFixture();try{const d=f.c.discovery;configure(d);
  f.work.setPolicy({key:'accept_assigned_linear',enabled:true,allowed_kinds:['work'],assignee_id:'user-1',
   source_message_id:'user:policy',verbatim_text:'Accept issues assigned to me in this source',evidence_ref:'actual-policy',actual_human_verified:true});
  const b=scan(f);page(d,b);const result=classify(d);assert.equal(result.execution_authorized,true);assert.equal(result.owner_required,true);
  assert.equal(f.c.db.prepare("SELECT COUNT(*) AS n FROM work_notices WHERE key LIKE 'owner-needed:%' AND state='pending'").get().n,1);
  const other=f.work.create({...candidate,canonical_key:'other'}).task;
  assert.equal(f.work.acceptAssignedInside(other,{source_kind:'linear',assignee_id:'someone-else'}).state,'candidate');
 }finally{f.c.close();}
});
test('existing source changes reach the original owner without a new task or discovery implementation work',()=>{
 const f=workFixture();try{const d=f.c.discovery,t=f.work.create({...candidate,source:{kind:'user',key:observation.entity_key}}).task;
  f.accept(t.id);f.bind(t.id);f.begin(t.id);configure(d);const b=scan(f);page(d,b);const old=f.c.reactive.task(t.id).context_rev;
  classify(d,'existing');assert.equal(f.c.reactive.task(t.id).context_rev,old+1);assert.equal(f.work.list().length,1);
  finish(d,b);
 }finally{f.c.close();}
});

test('an unavailable optional source does not freeze a healthy sources later windows',()=>{
 const f=workFixture();try{const d=f.c.discovery;configure(d);configure(d,{page_ids:['page-1']},'notion');const first=scan(f);
  page(d,first,{observations:[]});
  finish(d,first,{source_results:[{source_id:'linear',complete:true,followups_complete:true},{source_id:'notion',complete:false,reason:'access unavailable'}]});
  const initialWatermark=d.sources().find(s=>s.kind==='linear').last_success_at;
  f.advance(300000);const healthy=scan(f);assert.notEqual(healthy.id,first.id);assert.deepEqual(healthy.snapshot.sources.map(s=>s.kind),['linear']);
  page(d,healthy,{observations:[]});finish(d,healthy);
  assert.ok(d.sources().find(s=>s.kind==='linear').last_success_at>initialWatermark);
  assert.equal(d.sources().find(s=>s.kind==='notion').last_success_at,null);
 }finally{f.c.close();}
});

test('migration preserves assigned-user intake and scoped native chat discovery without widening access',()=>{
 const f=workFixture(),d=f.c.discovery;try{
  configure(d,{assignment_only:true,assignee_id:'user-1'},'linear');
  configure(d,{with_user_id:'U123',professional_only:true,access:'private',private_access_authorized:true},'slack');
  configure(d,{project_id:'project',host_id:'local'},'codex');
  const b=scan(f),plans=Object.fromEntries(b.snapshot.sources.map(s=>[s.kind,s.plan]));
  assert.equal(plans.linear.requests[0].arguments.assignee,'user-1');
  assert.equal(plans.slack.requests[0].arguments.filters,'with:<@U123>');
  assert.equal(plans.codex.requests[0].arguments.archived,false);
  assert.throws(()=>page(d,b,{observations:[{...observation,scope_key:'user-1',assignee_id:'other'}]}),/different assigned user/);
  assert.throws(()=>d.ingest({batch_id:b.id,generation:b.generation,source_id:'codex',page_key:'wrong',complete:true,evidence_ref:'native',observations:[{...observation,entity_key:'codex:other',scope_key:'project',project_id:'other'}]}),/outside/);
  assert.throws(()=>configure(d,{project_id:'other',host_id:'local'},'codex'),/exact local project/);
 }finally{f.c.close();}
});
