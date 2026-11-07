import test from 'node:test';
import assert from 'node:assert/strict';
import {workFixture,DISCOVERY} from './test-fixtures/work.mjs';
import {nativeProof} from './test-fixtures/reactive.mjs';
import {sourceReadPlan} from './discovery.mjs';

function setup(kind='slack'){
 const f=workFixture(),d=f.c.discovery,mail=[];
 d.configure({source_id:kind,enabled:true,scope:kind==='slack'?{with_user_id:'U123',professional_only:true,access:'private',private_access_authorized:true}:{project:'project'},source_message_id:'user:discovery',actual_human_verified:true,evidence_ref:'actual-user-scope'});
 const mailbox={enqueue:v=>{if(!mail.some(x=>x.key===v.key))mail.push(v);return {queued:true,key:v.key};}};
 const scan=()=>{const q=d.enqueueDue(mailbox,'/instance'),b=d.batch(q.batch_id);d.begin({batch_id:b.id,generation:b.generation,native_proof:nativeProof({thread:DISCOVERY,message:b.prompt,now:f.now()})});return d.batch(b.id);};
 const ingest=(b,index=0,patch={})=>d.ingest({batch_id:b.id,generation:b.generation,source_id:kind,request_index:index,page_key:'search-'+index,observations:[],complete:true,evidence_ref:'actual-page-'+index,...patch});
 const finish=(b,patch={})=>d.finish({batch_id:b.id,generation:b.generation,source_results:[{source_id:kind,complete:true,followups_complete:true,...patch}]});
 return {...f,d,mail,scan,ingest,finish};
}

test('mention search is independent of with-user search and both remain required within the original scope',()=>{
 const plan=sourceReadPlan({kind:'slack',scope:{with_user_id:'U123',access:'private'}},{from:'2026-11-06T07:00:00Z',to:'2026-11-07T07:00:00Z'});
 assert.equal(plan.requests.length,2);assert.equal(plan.requests[0].arguments.filters,'with:<@U123>');
 assert.equal(plan.requests[1].arguments.filters,'');assert.deepEqual(plan.requests[1].arguments.keywords,['<@U123>']);
 const f=setup();try{const b=f.scan();f.ingest(b);assert.throws(()=>f.finish(b),/all request streams/);f.ingest(b,1);assert.equal(f.finish(b).finished,true);}finally{f.c.close();}
});

test('completed search evidence stays immutable while a linked thread has its own resumable cursor and classification',()=>{
 const f=setup();try{const b=f.scan();f.ingest(b);f.ingest(b,1);const first=f.d.batch(b.id).pages[0];
  const base={entity_key:'slack:D123:1793949007.352439',item_key:'1793949007.352439',version:'actual-content',scope_key:'U123',summary:'A professional request addressed to Yang; issue already Done',url:'https://slack.com/archives/D123/p1793949007352439',channel_id:'D123',thread_ts:'1793949007.352439',relevant_user_id:'U123',professional_relevance:true};
  assert.throws(()=>f.ingest(b,0,{page_key:'late-thread',observations:[base]}),/completed search page is immutable/);
  const followup={parent_page_key:first.page_key,channel_id:'D123',thread_ts:base.thread_ts};
  assert.throws(()=>f.ingest(b,0,{followup:{...followup,parent_page_key:'foreign'},page_key:'thread',observations:[base]}),/authorized Slack thread/);
  f.ingest(b,0,{followup,page_key:'thread-1',observations:[base],complete:false,next_cursor:'reply-page-2'});
  assert.throws(()=>f.finish(b),/supplemental thread cursor/);
  assert.throws(()=>f.ingest(b,0,{followup,page_key:'thread-2',cursor:'wrong',observations:[]}),/exact saved source cursor/);
  f.ingest(b,0,{followup,page_key:'thread-2',cursor:'reply-page-2',observations:[]});
  assert.throws(()=>f.finish(b),/Classify source observations/);
  const o=f.d.pending({batch_id:b.id,source_id:'slack'}).observations?.[0]??f.d.status().observations.find(x=>!x.disposition);
  f.d.classify({observation_id:o.observation_id,disposition:'ignore',reason:'Latest issue is Done; retain source evidence, no duplicate task',evidence_ref:'current-issue-state'});
  assert.equal(f.d.plan(b.id).streams.filter(s=>s.followup).length,1);
  assert.equal(f.finish(b).finished,true);assert.deepEqual(f.d.batch(b.id).pages[0],first);
 }finally{f.c.close();}
});

test('same actual run can catch up later coverage without changing its original cutoff or bypassing incomplete streams',()=>{
 const f=setup();try{const b=f.scan(),original=structuredClone(b.snapshot.sources[0].window);f.ingest(b);f.ingest(b,1);
  f.advance(86400000);const added=f.d.appendCatchup({batch_id:b.id,generation:b.generation,source_id:'slack',evidence_ref:'verified-stale-watermark'});
  assert.deepEqual(f.d.appendCatchup({batch_id:b.id,generation:b.generation,source_id:'slack',evidence_ref:'same-run'}),added);
  assert.deepEqual(f.d.batch(b.id).snapshot.sources[0].window,original);assert.equal(added.request_indices.length,2);
  assert.throws(()=>f.finish(b),/all request streams/);
  for(const i of added.request_indices)f.ingest(b,i);
  assert.equal(f.finish(b).finished,true);assert.equal(f.d.sources().find(s=>s.source_id==='slack').last_success_at,Date.parse(added.window.to));
 }finally{f.c.close();}
});

test('repeated failures alert maintenance once and permit newer reads without crossing the retained old coverage gap',()=>{
 const f=setup('linear');try{
  let old=f.scan();f.ingest(old,0,{complete:false,next_cursor:'actual-old-cursor',observations:[{entity_key:'linear:old',item_key:'old-unclassified',version:'v1',scope_key:'project',summary:'Old observation awaiting repair',url:'https://linear.app/old'}]});
  for(let n=1;n<=3;n++){
   f.finish(old,{complete:false,reason:'same malformed old followup'});
   f.advance(f.d.sources().find(s=>s.source_id==='linear').next_at-f.now());
   if(n<3)old=f.scan();
  }
  const newer=f.scan();assert.notEqual(newer.id,old.id);assert.equal(f.mail.filter(m=>m.lane==='maintenance').length,1);
  assert.equal(f.d.batch(old.id).pages[0].data.next_cursor,'actual-old-cursor');
  f.ingest(newer);f.finish(newer);
  assert.equal(f.d.sources().find(s=>s.source_id==='linear').last_success_at,null);
  assert.equal(f.c.db.prepare("SELECT count(*) n FROM discovery_source_gaps WHERE state='open'").get().n,1);
  f.d.recovery.escalate({enqueue:v=>{if(!f.mail.some(m=>m.key===v.key))f.mail.push(v);}});assert.equal(f.mail.filter(m=>m.lane==='maintenance').length,1);
  f.advance(f.d.sources().find(s=>s.source_id==='linear').next_at-f.now());
  const newest=f.scan();assert.notEqual(newest.id,old.id);f.ingest(newest);f.finish(newest);
  f.d.recovery.requestRetry({batch_id:old.id,generation:old.generation,evidence_ref:'fixed-and-tested-parser'});
  const retry=f.scan();assert.equal(retry.id,old.id);assert.equal(retry.generation,old.generation+1);
  f.ingest(retry,0,{page_key:'old-final',cursor:'actual-old-cursor'});assert.throws(()=>f.finish(retry),/Classify source observations/);
  const oldObservation=f.d.pending({batch_id:retry.id})[0];f.d.classify({observation_id:oldObservation.observation_id,disposition:'ignore',reason:'Verified old issue already resolved',evidence_ref:'actual-current-state'});f.finish(retry);
  const s=f.d.sources().find(s=>s.source_id==='linear');assert.equal(s.last_success_at,Date.parse(newest.snapshot.sources[0].window.to));assert.equal(s.health,null);
  assert.equal(f.c.db.prepare("SELECT count(*) n FROM discovery_source_gaps WHERE state='open'").get().n,0);
 }finally{f.c.close();}
});

test('repair priority preserves the minimum actual start interval and the schedule of already-covered sources',()=>{
 const f=setup('linear');try{
  f.config.discovery={min_start_interval_ms:900000};
  f.d.configure({source_id:'slack',enabled:true,scope:{with_user_id:'U123',professional_only:true},source_message_id:'user:slack',actual_human_verified:true,evidence_ref:'scope'});
  const b=f.scan();f.ingest(b,0,{complete:false,next_cursor:'still-unread'});
  for(const index of [0,1])f.d.ingest({batch_id:b.id,generation:b.generation,source_id:'slack',request_index:index,page_key:'search-'+index,observations:[],complete:true,evidence_ref:'actual-empty-page'});
  f.d.finish({batch_id:b.id,generation:b.generation,source_results:[{source_id:'linear',complete:false,reason:'Need parser repair'},{source_id:'slack',complete:true,followups_complete:true}]});
  const next=f.d.sources().find(s=>s.source_id==='slack').next_at;
  f.d.recovery.requestRetry({batch_id:b.id,generation:b.generation,evidence_ref:'actual-tested-repair'});
  assert.equal(f.d.sources().find(s=>s.source_id==='slack').next_at,next);
  assert.equal(f.d.enqueueDue({enqueue(){assert.fail('Must not start early');}},'/instance').reason,'discovery_start_interval');
  f.advance(900000);const resumed=f.scan();assert.equal(resumed.id,b.id);assert.equal(resumed.generation,2);
  assert.throws(()=>f.d.recovery.requestRetry({batch_id:b.id,generation:1,evidence_ref:'stale'}),/Exact checkpoint generation/);
 }finally{f.c.close();}
});

test('a saved with-only legacy window returns the missing original mention request alongside current catchup requests',()=>{
 const f=setup();try{
  const b=f.scan(),snapshot=structuredClone(b.snapshot);snapshot.sources[0].plan.requests=snapshot.sources[0].plan.requests.slice(0,1);
  f.c.db.prepare('UPDATE discovery_batches SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot),b.id);
  f.ingest(b);const original=f.d.batch(b.id).pages[0];f.advance(86400000);
  const added=f.d.appendCatchup({batch_id:b.id,generation:b.generation,source_id:'slack',evidence_ref:'real-with-only-migration'});
  assert.deepEqual(added.request_indices,[1,2,3]);
  const requests=f.d.batch(b.id).snapshot.sources[0].plan.requests;assert.equal(requests[1].arguments.before,String(Date.parse(snapshot.sources[0].window.to)/1000));
  assert.deepEqual(requests[1].arguments.keywords,['<@U123>']);
  for(const index of added.request_indices)f.ingest(b,index);
  assert.equal(f.finish(b).finished,true);assert.deepEqual(f.d.batch(b.id).pages[0],original);
  assert.equal(f.d.sources().find(s=>s.source_id==='slack').last_success_at,Date.parse(added.window.to));
 }finally{f.c.close();}
});

test('real page progress resumes the original checkpoint automatically, while cyclic cursors cannot masquerade as progress',()=>{
 const f=setup('linear');try{
  let old=f.scan();f.ingest(old,0,{complete:false,next_cursor:'page-A'});
  for(let n=1;n<=3;n++){f.finish(old,{complete:false,reason:'same old blocked cursor'});f.advance(f.d.sources().find(s=>s.source_id==='linear').next_at-f.now());if(n<3)old=f.scan();}
  const fresh=f.scan();f.ingest(fresh);f.finish(fresh);
  f.d.recovery.requestRetry({batch_id:old.id,generation:old.generation,evidence_ref:'verified-cursor-parser-fix'});
  const repaired=f.scan();f.ingest(repaired,0,{page_key:'actual-new-page',cursor:'page-A',complete:false,next_cursor:'page-B'});
  assert.equal(f.c.db.prepare('SELECT state FROM discovery_source_gaps WHERE batch_id=?').get(old.id).state,'progressing');
  assert.throws(()=>f.ingest(repaired,0,{page_key:'loop',cursor:'page-B',complete:false,next_cursor:'page-B'}),/cursor did not advance/);
  assert.throws(()=>f.ingest(repaired,0,{page_key:'cycle-back',cursor:'page-B',complete:false,next_cursor:'page-A'}),/cursor did not advance/);
  f.finish(repaired,{complete:false,reason:'Bounded budget after real progress'});f.advance(f.d.sources().find(s=>s.source_id==='linear').next_at-f.now());
  const continuation=f.scan();assert.equal(continuation.id,old.id);
  f.ingest(continuation,0,{page_key:'last-actual-page',cursor:'page-B'});f.finish(continuation);
  const source=f.d.sources().find(s=>s.source_id==='linear');assert.equal(source.health,null);assert.equal(source.last_success_at,Date.parse(fresh.snapshot.sources[0].window.to));assert.equal(source.next_at,source.last_success_at+source.interval_ms);
 }finally{f.c.close();}
});
