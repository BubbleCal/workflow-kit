import {OwnerHealth} from './owner-health.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {workFixture,DISCOVERY} from './test-fixtures/work.mjs';
import {nativeProof} from './test-fixtures/reactive.mjs';
import {DiscoveryStore} from './discovery.mjs';

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

test('discovery start interval spans fresh scans, repeated begin and store restart',()=>{
 const f=workFixture();try{let d=f.c.discovery;f.config.discovery={min_start_interval_ms:900000};configure(d);
  const started=f.now(),b=scan(f);f.advance(120000);
  d.begin({batch_id:b.id,generation:b.generation,native_proof:nativeProof({thread:DISCOVERY,message:b.prompt,now:f.now()})});
  page(d,b,{observations:[]});finish(d,b);f.advance(180000);
  let calls=0;const mailbox={enqueue:()=>{calls++;return {queued:true};}};
  assert.deepEqual(d.enqueueDue(mailbox,'/instance'),{queued:false,reason:'discovery_start_interval',eligible_at:started+900000});
  d=new DiscoveryStore(f.c.db,{config:f.config,work:f.work,reactive:f.c.reactive,now:f.now});f.c.discovery=d;
  f.advance(599999);assert.equal(d.enqueueDue(mailbox,'/instance').queued,false);assert.equal(calls,0);
  f.advance(1);const next=scan(f);assert.notEqual(next.id,b.id);
  assert.equal(Date.parse(next.snapshot.sources[0].window.from),Date.parse(b.snapshot.sources[0].window.to)-120000);
 }finally{f.c.close();}
});

test('discovery start interval holds checkpoint retries without losing source cursors',()=>{
 const f=workFixture();try{const d=f.c.discovery;f.config.discovery={min_start_interval_ms:900000};configure(d);
  const b=scan(f);page(d,b,{observations:[],complete:false,next_cursor:'next-2'});
  finish(d,b,{source_results:[{source_id:'linear',complete:false,reason:'bounded scan budget'}]});
  f.advance(60000);
  assert.equal(d.enqueueDue({enqueue(){assert.fail('Checkpoint must remain deferred');}},'/instance').reason,'discovery_start_interval');
  assert.equal(d.batch(b.id).generation,1);assert.equal(d.batch(b.id).pages[0].data.next_cursor,'next-2');
  f.advance(840000);const resumed=scan(f);assert.equal(resumed.id,b.id);assert.equal(resumed.generation,2);
  assert.deepEqual(resumed.snapshot.sources[0].window,b.snapshot.sources[0].window);
  page(d,resumed,{page_key:'page-2',cursor:'next-2',observations:[]});assert.equal(finish(d,resumed).finished,true);
 }finally{f.c.close();}
});

test('enabling a discovery start interval honors native starts recorded before the upgrade',()=>{
 const f=workFixture();try{const d=f.c.discovery;
  f.config.discovery={owner_health_interval_ms:1800000};configure(d);const b=scan(f);
  page(d,b,{observations:[]});finish(d,b);
  f.c.db.prepare('UPDATE discovery_batches SET started_at=NULL').run();
  f.config.discovery.min_start_interval_ms=900000;f.advance(300000);
  assert.equal(d.enqueueDue({enqueue(){assert.fail('Recent pre-upgrade start must be retained');}},'/instance').reason,'discovery_start_interval');
 }finally{f.c.close();}
});

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

test('finishing an old window immediately catches up without skipping its coverage',()=>{
 const f=workFixture();try{const d=f.c.discovery;configure(d);const old=scan(f);
  f.advance(3600000);page(d,old,{observations:[]});finish(d,old);
  const source=d.sources().find(s=>s.source_id==='linear');assert.equal(source.last_success_at,Date.parse(old.snapshot.sources[0].window.to));
  assert.ok(source.next_at<=f.now());const fresh=scan(f);assert.notEqual(fresh.id,old.id);
  assert.equal(Date.parse(fresh.snapshot.sources[0].window.from),source.last_success_at-120000);
  assert.equal(Date.parse(fresh.snapshot.sources[0].window.to),f.now());
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

test('saved professional Slack evidence survives legacy field names without weakening scope',()=>{
 const f=workFixture();try{const d=f.c.discovery;
  configure(d,{with_user_id:'U123',professional_only:true},'slack');const b=scan(f);
  const saved={entity_key:'slack:C123:1793723567.440139',item_key:'C123:1793882898.958309',version:'v1',scope_key:'U123',
    with_user_id:'U123',professional:true,summary:'A colleague asks whether the accepted feature is deployed.',url:'https://slack.com/archives/C123/p1793882898958309'};
  const ingest=o=>d.ingest({batch_id:b.id,generation:b.generation,source_id:'slack',page_key:'final',observations:[o],complete:true,evidence_ref:'saved-full-thread'});
  assert.throws(()=>ingest({...saved,with_user_id:'U456'}),/scope|configured user/);
  assert.throws(()=>ingest({...saved,professional:false}),/scope|professional_relevance/);
  assert.throws(()=>ingest({...saved,relevant_user_id:'U456'}),/scope|Conflicting/);
  assert.equal(ingest(saved).recorded,true);
  const o=d.status().observations[0];assert.equal(o.data.relevant_user_id,'U123');assert.equal(o.data.professional_relevance,true);
  assert.equal(d.sources().find(s=>s.source_id==='slack').last_success_at,null);
 }finally{f.c.close();}
});

test('a watched reply without a new mention reaches the original owner while historical search is checkpointed',()=>{
 const f=workFixture();try{const d=f.c.discovery,t=f.work.create(candidate).task;f.accept(t.id);f.bind(t.id);f.begin(t.id);
  configure(d,{with_user_id:'U123',professional_only:true},'slack');const historical=scan(f);
  d.ingest({batch_id:historical.id,generation:1,source_id:'slack',page_key:'history1',observations:[],complete:false,next_cursor:'history2',evidence_ref:'historical-page'});
  d.finish({batch_id:historical.id,generation:1,source_results:[{source_id:'slack',complete:false,reason:'Historical pagination incomplete'}]});
  const request={task_id:t.id,channel_id:'C123',thread_ts:'1793723567.440139',relevant_user_id:'U123',professional_relevance:true,identity_verified:true,evidence_ref:'user-participation-and-task-proof'};
  const watch=d.watchThread(request),revision=d.sources().find(s=>s.source_id===watch.source_id).revision;
  assert.equal(d.watchThread(request).source_id,watch.source_id);assert.equal(d.sources().find(s=>s.source_id===watch.source_id).revision,revision);
  const next=scan(f);assert.deepEqual(next.snapshot.sources.map(s=>s.source_id),[watch.source_id]);
  const plan=next.snapshot.sources[0].plan;
  assert.equal(plan.requests[0].tool,'slack_read_thread');assert.equal(plan.requests[0].arguments.message_ts,request.thread_ts);
  const o={entity_key:watch.entity_key,item_key:'1793882898.958309',version:'content-v1',scope_key:'U123',channel_id:'C123',thread_ts:request.thread_ts,
    relevant_user_id:'U123',professional_relevance:true,summary:'is it in today’s deployment',url:'https://slack.com/archives/C123/p1793882898958309'};
  const input={batch_id:next.id,generation:next.generation,source_id:watch.source_id,page_key:'thread1',observations:[o],complete:true,evidence_ref:'actual-full-thread'};
  assert.throws(()=>d.ingest({...input,observations:[{...o,thread_ts:'999.1'}]}),/outside the watched/);
  d.ingest(input);const obs=d.status().observations[0],before=f.c.reactive.task(t.id).context_rev;
  assert.equal(d.classify({observation_id:obs.observation_id,disposition:'existing',reason:'Existing feature deployment question',evidence_ref:'actual-task-and-thread'}).task_id,t.id);
  assert.equal(f.c.reactive.task(t.id).context_rev,before+1);assert.equal(f.work.list().length,1);
  assert.equal(d.classify({observation_id:obs.observation_id,disposition:'existing',reason:'Repeated observation',evidence_ref:'actual-task-and-thread'}).classified,false);
  assert.equal(d.finish({batch_id:next.id,generation:next.generation,source_results:[{source_id:watch.source_id,complete:true,followups_complete:true}]}).finished,true);
  assert.equal(d.sources().find(s=>s.source_id==='slack').last_success_at,null);
  assert.equal(d.batch(historical.id).pages[0].data.next_cursor,'history2');
 }finally{f.c.close();}
});

test('classifying a real thread for an existing owner automatically retains future reply coverage',()=>{
 const f=workFixture();try{const d=f.c.discovery,t=f.work.create(candidate).task;f.accept(t.id);f.bind(t.id);f.begin(t.id);
  configure(d,{with_user_id:'U123',professional_only:true},'slack');const b=scan(f);
  d.ingest({batch_id:b.id,generation:b.generation,source_id:'slack',page_key:'thread-source',complete:true,evidence_ref:'thread-readback',observations:[{
    entity_key:'slack:C123:1793723567.440139',item_key:'1793882898.958309',version:'v1',scope_key:'U123',channel_id:'C123',thread_ts:'1793723567.440139',
    relevant_user_id:'U123',professional_relevance:true,summary:'Deployment follow-up',url:'https://slack.com/archives/C123/p1793882898958309'}]});
  const result=d.classify({observation_id:d.status().observations[0].observation_id,disposition:'existing',task_id:t.id,identity_verified:true,reason:'Existing task',evidence_ref:'task-thread-identity'});
  assert.equal(result.thread_watch.watching,true);assert.equal(d.sources().find(s=>s.source_id===result.thread_watch.source_id).interval_ms,d.sources().find(s=>s.source_id==='slack').interval_ms);
  assert.equal(d.batch(b.id).state,'running');assert.equal(f.work.list().length,1);
 }finally{f.c.close();}
});

test('thread watches preserve access, original owners and stop with completed work',()=>{
 const f=workFixture();try{const d=f.c.discovery,t=f.work.create(candidate).task;f.accept(t.id);f.bind(t.id);f.begin(t.id);
  configure(d,{channel_ids:['C123'],with_user_id:'U123',professional_only:true},'slack');
  const req={task_id:t.id,channel_id:'C123',thread_ts:'1793723567.440139',relevant_user_id:'U123',professional_relevance:true,identity_verified:true,evidence_ref:'actual-thread'};
  assert.throws(()=>d.watchThread({...req,channel_id:'C456'}),/outside/);
  assert.throws(()=>d.watchThread({...req,relevant_user_id:'U456'}),/professional/);
  assert.throws(()=>d.watchThread({...req,identity_verified:false}),/verified original owner/);
  const w=d.watchThread(req);
  f.c.db.prepare("UPDATE rt_tasks SET status='complete' WHERE task_id=?").run(t.id);
  d.enqueueDue({enqueue:v=>({queued:true,key:v.key})},'/instance');
  assert.equal(d.sources().find(s=>s.source_id===w.source_id).enabled,0);
 }finally{f.c.close();}
});

test('source changes only invalidate affected scans and revoke child thread watches',()=>{
 const f=workFixture();try{const d=f.c.discovery;configure(d);const linear=scan(f);
  configure(d,{with_user_id:'U123',professional_only:true},'slack');assert.equal(d.batch(linear.id).state,'running');
  const t=f.work.create(candidate).task;f.accept(t.id);f.bind(t.id);f.begin(t.id);
  const w=d.watchThread({task_id:t.id,channel_id:'C123',thread_ts:'1793723567.440139',relevant_user_id:'U123',professional_relevance:true,identity_verified:true,evidence_ref:'actual-thread'});
  configure(d,{with_user_id:'U456',professional_only:true},'slack');
  assert.equal(d.sources().find(s=>s.source_id===w.source_id).enabled,0);assert.equal(d.batch(linear.id).state,'running');
 }finally{f.c.close();}
});

test('verified migrated source identity binds to the existing task without a duplicate',()=>{
 const f=workFixture();try{const d=f.c.discovery,t=f.work.create(candidate).task;f.accept(t.id);f.bind(t.id);f.begin(t.id);configure(d);const b=scan(f);page(d,b);
  const observation_id=d.status().observations[0].observation_id;
  const req={observation_id,disposition:'existing',task_id:t.id,reason:'Same issue ID in original task evidence',evidence_ref:'actual-issue-task-binding'};
  assert.throws(()=>d.classify(req),/verified identity/);
  assert.equal(d.classify({...req,identity_verified:true}).task_id,t.id);
  assert.equal(f.work.taskForSource(observation.entity_key).id,t.id);assert.equal(f.work.list().length,1);
 }finally{f.c.close();}
});

test('a discovery turn that ended without finish resumes its preserved pages only after native proof',()=>{
 const f=workFixture();try{const d=f.c.discovery;configure(d);const b=scan(f);
  page(d,b,{observations:[],complete:false,next_cursor:'page2'});
  const req={batch_id:b.id,generation:b.generation,effects_reconciled:true,evidence_ref:'actual-ended-scan',
    native_proof:nativeProof({thread:DISCOVERY,message:b.prompt,status:'completed',now:f.now()})};
  assert.throws(()=>d.recover({...req,native_proof:nativeProof({thread:DISCOVERY,message:b.prompt,now:f.now()})}),/not terminal/);
  assert.throws(()=>d.recover({...req,effects_reconciled:false}),/Reconcile/);
  assert.throws(()=>d.recover({...req,native_proof:nativeProof({thread:DISCOVERY,message:'different scan',status:'completed',now:f.now()})}),/exact queued prompt/);
  assert.equal(d.recover(req).pages_preserved,1);
  assert.equal(d.sources().find(s=>s.source_id==='linear').last_success_at,null);
  const resumed=scan(f);assert.equal(resumed.id,b.id);assert.equal(resumed.generation,b.generation+1);
  assert.equal(resumed.pages[0].data.next_cursor,'page2');
  assert.throws(()=>d.recover(req),/Stale/);
 }finally{f.c.close();}
});

test('cadence changes preserve active scan evidence and finish with the current aligned interval',()=>{
 const f=workFixture();try{const d=f.c.discovery;f.config.discovery={align_poll_slots:true};configure(d);const b=scan(f);
  page(d,b,{observations:[]});const rev=d.sources().find(s=>s.source_id==='linear').revision;
  d.setCadences({intervals:{linear:900000},source_message_id:'user:cadence',actual_human_verified:true,evidence_ref:'source'});
  assert.equal(d.batch(b.id).state,'running');assert.equal(d.batch(b.id).pages.length,1);
  assert.equal(d.sources().find(s=>s.source_id==='linear').revision,rev);finish(d,b);
  const current=d.sources().find(s=>s.source_id==='linear');
  assert.equal(current.next_at,(Math.floor(Date.parse(b.snapshot.sources[0].window.to)/900000)+1)*900000);
  assert.equal(current.last_success_at,Date.parse(b.snapshot.sources[0].window.to));
 }finally{f.c.close();}
});

test('compact discovery retains the latest cursor and explicit access to unclassified raw evidence',()=>{
 const f=workFixture();try{const d=f.c.discovery;configure(d);const b=scan(f);
  page(d,b,{complete:false,next_cursor:'next-2'});
  const compact=d.plan(b.id);assert.equal(compact.pages,undefined);assert.equal(compact.stored_page_count,1);
  assert.equal(compact.streams[0].next_cursor,'next-2');assert.equal(compact.prompt,undefined);
  assert.deepEqual(d.page({batch_id:b.id,page_key:compact.streams[0].last_page_key}).data.observations,[observation]);
  assert.equal(d.pending({source_id:'linear'}).length,1);
  assert.equal(d.plan(b.id,{full:true}).pages.length,1);
 }finally{f.c.close();}
});

test('unchanged blocked-source retries back off without advancing coverage or replaying pages',()=>{
 const f=workFixture();try{const d=f.c.discovery;f.config.discovery={failure_backoff_max_ms:{linear:28800000}};configure(d);const b=scan(f);
  const fail=b=>finish(d,b,{source_results:[{source_id:'linear',complete:false,reason:'unchanged capability unavailable'}]});
  fail(b);f.advance(300000);const resumed=scan(f);fail(resumed);
  const s=d.sources().find(s=>s.source_id==='linear');assert.equal(s.next_at,f.now()+600000);assert.equal(s.last_success_at,null);
  assert.equal(JSON.parse(s.health).failure_streak,2);assert.equal(d.batch(b.id).state,'checkpointed');
 }finally{f.c.close();}
});


test('blocked source history cannot skip due owner recovery or turn it into repeated scans',()=>{
 const f=workFixture();try{
  f.config.discovery={owner_health_interval_ms:1800000};
  const d=f.c.discovery,t=f.work.create(candidate).task;f.accept(t.id);f.bind(t.id);f.begin(t.id);configure(d);
  const b=scan(f),targets=d.plan(b.id).owner_health.targets;
  assert.equal(targets.length,1);assert.equal(targets[0].task_id,t.id);
  const failed={source_results:[{source_id:'linear',complete:false,reason:'Provider history unavailable'}]};
  assert.throws(()=>finish(d,b,failed),/Observe owner health/);
  const h=new OwnerHealth(f.c,{now:f.now});h.observe({task_id:t.id,native_proof:nativeProof({now:f.now()})});
  assert.equal(finish(d,b,failed).checkpointed,true);
  assert.equal(d.sources()[0].last_success_at,null);
  f.advance(300000);const resumed=scan(f);assert.equal(d.plan(resumed.id).owner_health.targets.length,0);
  assert.equal(finish(d,resumed,failed).checkpointed,true);
 }finally{f.c.close();}
});

test('fresh result work cannot starve an overdue immutable source checkpoint',()=>{
 const f=workFixture();try{f.config.discovery={min_start_interval_ms:900000};const d=f.c.discovery;configure(d);const b=scan(f);page(d,b,{observations:[],complete:false,next_cursor:'saved-real-cursor'});finish(d,b,{source_results:[{source_id:'linear',complete:false,reason:'bounded source page'}]});const before=d.batch(b.id);
 f.work.setPolicy({key:'accept_result_followups',enabled:true,allowed_kinds:['work'],source_message_id:'human:results',verbatim_text:'Review substantive task results',actual_human_verified:true,evidence_ref:'actual-rule'});const t=f.work.create({canonical_key:'existing-result',title:'Existing result',objective:'Original accepted work',workspace:'/task',requirements:[{id:'done',text:'Evidence'}]}).task;f.accept(t.id);f.bind(t.id);f.work.followthrough.reviewInside(t.id,{key:'actual-terminal-result',turn_id:'original-result-turn',evidence_ref:'original-result'});
 f.advance(1800000);const next=d.enqueueDue({enqueue:()=>({queued:true})},'/instance'),resumed=d.batch(next.batch_id);assert.equal(resumed.id,b.id);assert.equal(resumed.generation,b.generation+1);assert.deepEqual(resumed.snapshot.sources,before.snapshot.sources);assert.deepEqual(resumed.pages,before.pages);assert.equal(f.work.followthrough.pending().reviews.length,1);
 }finally{f.c.close();}
});
