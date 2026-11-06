import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,contract,nativeProof} from './test-fixtures/reactive.mjs';
import {OwnerHealth} from './owner-health.mjs';
import {waitDataMeaning} from './owner-wait-policy.mjs';
import {ControlStore} from './control.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function sleepOwner(f,delay=172800000){
 f.activate();f.event();const wake=f.begin();
 f.decide({wake_id:wake.id,disposition:'wait',next_action_at:new Date(f.now()+delay).toISOString(),reason:'No further useful action before the job checkpoint',plan:undefined});
 return wake;
}
const pr=(patch={})=>({pr:{repository:'example/service',pr_number:9,head_sha:'a'.repeat(40),state:'open',merge_sha:null,checked_at:'old',...patch},reviews:[],issue_comments:[],review_comments:[],review_threads:[]});
function prWait(f,fields=['state']){
 const key='example/service#9';f.s.ingest({task_id:'T-1',event_id:'pr-first',source:'github',subject:key,type:'pr_changed',observed_at:f.now(),payload:pr(),evidence_ref:'actual-pr',debounce_ms:0});
 f.decide();const wait={condition:{kind:'pr_state',pr_key:key,fields},facts:f.s.checkpoint('T-1').facts.map(({subject,version})=>({subject,version})),expires_at:f.now()+1000,resume_condition:'The blocking PR changes its relevant state'};
 f.decide({disposition:'wait',wait,plan:undefined});f.activate();return key;
}

test('owner can report a timezone-qualified action time days away; intervening events remain durable without a wake',()=>{
 const f=fixture();try{
  const wake=sleepOwner(f),until=f.now()+172800000;
  assert.equal(f.s.checkpoint('T-1').owner_next_action.not_before,until);
  const r=f.event('new-finding',{finding:'New evidence retained'});assert.equal(r.deferred_until,until);
  assert.equal(f.s.task('T-1').wake_at,null);assert.equal(f.s.task('T-1').dirty,false);
  assert.equal(f.s.checkpoint('T-1').events.filter(e=>e.event_id==='new-finding').length,1);
  f.s.finish({task_id:'T-1',wake_id:wake.id,turn_id:'native-turn',evidence_ref:'owner-window'});
  f.advance(172799999);f.s.expireWaits();assert.equal(f.s.reserveQueuedWake('T-1').reserved,false);
  f.advance(1);f.s.expireWaits();f.s.expireWaits();const w=f.s.reserveQueuedWake('T-1').wake;assert.ok(w);
  assert.ok(w.event_ids.includes('new-finding'));assert.equal(f.s.checkpoint('T-1').events.filter(e=>e.type==='next_action_due').length,1);
 }finally{f.c.close();}
});

test('owner windows survive re-opening the database and require real time/owner/CAS guards',()=>{
 const dir=mkdtempSync(join(tmpdir(),'owner-wait-')),path=join(dir,'control.sqlite'),f=fixture(path);try{
  const wake=sleepOwner(f,3600000),snapshot=f.s.checkpoint('T-1');
  const reopened=new ControlStore(path,{now:f.now});try{assert.equal(reopened.reactive.waitPolicy.blocked('T-1').not_before,snapshot.owner_next_action.not_before);}finally{reopened.close();}
  for(const value of ['2026-11-08T12:00:00','invalid',new Date(f.now()-1).toISOString()])assert.throws(()=>f.decide({wake_id:wake.id,disposition:'wait',next_action_at:value,plan:undefined}),/timezone|future/);
  assert.equal(f.s.checkpoint('T-1').owner_next_action.not_before,snapshot.owner_next_action.not_before);
  assert.throws(()=>f.s.decide({task_id:'T-1',owner_thread_id:'wrong',expected_context_rev:0,expected_plan_rev:0,disposition:'wait',reason:'fake',evidence_refs:['fake'],next_action_at:new Date(f.now()+1000).toISOString()}),/owner|context/);
  assert.equal(new OwnerHealth(f.c,{now:f.now}).targets().length,0);
  assert.deepEqual(f.s.actionReasons('task_queue','T-1',{}),['owner_next_action_not_due']);
 }finally{f.c.close();rmSync(dir,{recursive:true,force:true});}
});

test('an explicit human instruction may clear the window; ordinary events cannot',()=>{
 const f=fixture();try{const w=sleepOwner(f,3600000);f.s.finish({task_id:'T-1',wake_id:w.id,turn_id:'native-turn',evidence_ref:'wait'});
  assert.throws(()=>f.s.waitPolicy.clear({task_id:'T-1'}),/actual human/);
  f.s.waitPolicy.clear({task_id:'T-1',actual_human_verified:true,source_message_id:'actual-user-now',evidence_ref:'actual-user-command'});
  assert.equal(f.s.waitPolicy.blocked('T-1'),null);assert.equal(f.s.reserveQueuedWake('T-1').reserved,true);
 }finally{f.c.close();}
});

test('blocked PR metadata, head and review changes stay quiet when owner explicitly watches only merge/close state',()=>{
 const f=fixture();try{const key=prWait(f);f.advance(86400000);f.s.expireWaits();assert.equal(f.s.checkpoint('T-1').events.length,0);
  const publish=(id,payload)=>f.s.ingest({task_id:'T-1',event_id:id,source:'github',subject:key,type:'pr_changed',observed_at:f.now(),payload,evidence_ref:id,debounce_ms:0});
  publish('same-refresh',pr({checked_at:'new'}));assert.equal(f.s.task('T-1').wake_at,null);
  publish('new-head-still-open',pr({head_sha:'b'.repeat(40)}));assert.equal(f.s.task('T-1').wake_at,null);assert.equal(f.s.checkpoint('T-1').events.length,0);
  publish('merged',pr({head_sha:'b'.repeat(40),state:'merged',merge_sha:'c'.repeat(40)}));assert.notEqual(f.s.task('T-1').wake_at,null);assert.equal(f.s.checkpoint('T-1').events.length,1);
  publish('merged-refresh',pr({head_sha:'b'.repeat(40),state:'merged',merge_sha:'c'.repeat(40),checked_at:'again'}));assert.equal(f.s.checkpoint('T-1').events.length,1);
 }finally{f.c.close();}
});

test('default dependency waits do not turn expired source evidence into an owner notification',()=>{
 const f=fixture();try{f.event();f.decide();f.s.checkWait=()=>({valid:true});
  f.decide({disposition:'wait',plan:undefined,wait:{facts:f.s.checkpoint('T-1').facts.map(({subject,version})=>({subject,version})),condition:{kind:'dependency',fact_key:'release',subject:'release',requirement:'released SDK'},expires_at:f.now()+1000,resume_condition:'A qualified release becomes available'}});f.activate();
  f.advance(7200000);f.s.expireWaits();f.s.expireWaits();assert.equal(f.s.task('T-1').wake_at,null);assert.equal(f.s.checkpoint('T-1').events.length,0);
  assert.equal(f.c.db.prepare("SELECT COUNT(*) n FROM rt_diagnostics WHERE key LIKE 'wait-source-stale:%'").get().n,1);
  f.event('release-available',{available:true},{source:'typed_wait_source',type:'wait_fact_changed'});assert.notEqual(f.s.task('T-1').wake_at,null);
 }finally{f.c.close();}
});

test('job progress and observation metadata do not pretend that a running test has finished',()=>{
 assert.deepEqual(waitDataMeaning('job',{job_id:'test',state:'pending'}),waitDataMeaning('job',{job_id:'test',state:'running',elapsed:300,checked_at:'later'}));
 assert.notDeepEqual(waitDataMeaning('job',{job_id:'test',state:'running'}),waitDataMeaning('job',{job_id:'test',state:'complete',exit_code:0}));
 assert.deepEqual(waitDataMeaning('dependency',{available:false,requirement:'released',checked_at:'a',evidence_ref:'a'}),waitDataMeaning('dependency',{evidence_ref:'b',checked_at:'b',requirement:'released',available:false}));
});

test('events for every existing shared-owner member are coalesced once when its action time arrives',()=>{
 const f=fixture();try{
  f.s.adopt({task_id:'T-2',owner_thread_id:OWNER,contract:{...contract(),canonical_key:'second-goal'},source_message_id:'human:second',actual_human_verified:true});
  f.s.setModes({task_ids:['T-1','T-2'],mode:'active',source_message_id:'human:group',actual_human_verified:true,native_binding:f.binding(),queue_compatibility_verified:true,legacy_quiescent:true});
  f.event();f.event('second',{a:1},{task_id:'T-2'});const w=f.begin();
  f.decide({wake_id:w.id,disposition:'wait',plan:undefined,next_action_at:new Date(f.now()+10000).toISOString()});
  f.s.checkWait=()=>({valid:true});const t=f.s.task('T-2');
  f.s.decide({task_id:'T-2',owner_thread_id:OWNER,wake_id:w.id,expected_context_rev:t.context_rev,expected_plan_rev:0,disposition:'wait',reason:'Wait for the same owner checkpoint',evidence_refs:['job'],wait:{condition:{kind:'job',fact_key:'job',subject:'job',job_id:'build'},facts:f.s.checkpoint('T-2').facts.map(({subject,version})=>({subject,version})),expires_at:f.now()+20000,resume_condition:'Build result changes'}});
  f.event('late-second',{result:'new'},{task_id:'T-2'});assert.equal(f.s.task('T-2').wake_at,null);
  f.s.finish({task_id:'T-1',wake_id:w.id,turn_id:'native-turn',evidence_ref:'both-waiting'});f.advance(10000);f.s.expireWaits();
  const next=f.s.reserveQueuedWake('T-1').wake;assert.deepEqual(next.member_ids,['T-1','T-2']);assert.ok(next.event_ids.includes('late-second'));
  assert.equal(f.s.reserveQueuedWake('T-2').reserved,false);
 }finally{f.c.close();}
});

test('a reported date never resumes a human-paused task or clears an unrelated decision',()=>{
 const f=fixture();try{const w=sleepOwner(f,1000);f.s.finish({task_id:'T-1',wake_id:w.id,turn_id:'native-turn',evidence_ref:'wait'});f.mode('paused');f.advance(2000);f.s.expireWaits();
  assert.equal(f.s.task('T-1').mode,'paused');assert.equal(f.s.checkpoint('T-1').events.filter(e=>e.type==='next_action_due').length,0);
  f.s.waitPolicy.clear({task_id:'T-1',actual_human_verified:true,source_message_id:'clear-time-only',evidence_ref:'human'});assert.equal(f.s.task('T-1').mode,'paused');
 }finally{f.c.close();}
});

test('human override releases pending shared-owner members and preserves their independent decision gate',()=>{
 const f=fixture();try{
  for(const id of ['T-2','T-3'])f.s.adopt({task_id:id,owner_thread_id:OWNER,contract:{...contract(),canonical_key:id},source_message_id:`human:${id}`,actual_human_verified:true});
  f.s.setModes({task_ids:['T-1','T-2','T-3'],mode:'active',source_message_id:'human:group',actual_human_verified:true,native_binding:f.binding(),queue_compatibility_verified:true,legacy_quiescent:true});
  f.event();f.event('member-second',{job:'running'},{task_id:'T-2'});const w=f.begin();
  f.decide({wake_id:w.id,disposition:'wait',plan:undefined,next_action_at:new Date(f.now()+10000).toISOString()});
  f.s.checkWait=()=>({valid:true});
  for(const id of ['T-2','T-3']){
    const t=f.s.task(id);
    f.s.decide({task_id:id,owner_thread_id:OWNER,wake_id:w.id,expected_context_rev:t.context_rev,expected_plan_rev:0,
      disposition:id==='T-3'?'needs_decision':'wait',reason:'Member-specific checkpoint',evidence_refs:['member-proof'],
      ...(id==='T-2'?{wait:{condition:{kind:'job',fact_key:'job',subject:'job',job_id:'build'},facts:f.s.checkpoint(id).facts.map(({subject,version})=>({subject,version})),expires_at:f.now()+20000,resume_condition:'Build completes'}}:{})});
  }
  f.s.finish({task_id:'T-1',wake_id:w.id,turn_id:'native-turn',evidence_ref:'wait'});
  f.event('late-second',{new:'finding'},{task_id:'T-2'});f.event('protected-third',{new:'evidence'},{task_id:'T-3'});
  assert.equal(f.s.task('T-3').status,'needs_decision');
  f.s.waitPolicy.clear({task_id:'T-1',actual_human_verified:true,source_message_id:'user-resume',evidence_ref:'human'});
  const next=f.s.reserveQueuedWake('T-1').wake;assert.deepEqual(next.member_ids,['T-1','T-2']);assert.ok(next.event_ids.includes('late-second'));
  assert.equal(f.s.task('T-3').status,'needs_decision');assert.equal(f.s.task('T-3').wake_at,null);
 }finally{f.c.close();}
});

test('terminal source results survive a crash between source recording and owner publication',async()=>{
 const {Mailbox}=await import('./mailbox.mjs'),{publishWaitObservations}=await import('./wait-observation.mjs');
 const observeWaitSource=({mailbox,state,input})=>{mailbox.atomic(()=>mailbox.waits.observe(input));publishWaitObservations({mailbox,state});};
 const root=mkdtempSync(join(tmpdir(),'wait-source-')),f=fixture(),m=new Mailbox(join(root,'mailbox.sqlite'),{now:f.now});
 try{
  const input=(state)=>({fact_key:'long-test',kind:'job',subject:'test-job',data:{job_id:'build',state},observed_at:new Date(f.now()).toISOString(),expires_at:new Date(f.now()+60000).toISOString(),evidence_ref:`native:${state}`});
  observeWaitSource({mailbox:m,state:f.s,input:input('pending')});f.event();f.decide();f.s.checkWait=c=>m.waits.check(c);
  f.decide({disposition:'wait',plan:undefined,wait:{condition:{kind:'job',fact_key:'long-test',subject:'test-job',job_id:'build'},facts:f.s.checkpoint('T-1').facts.map(({subject,version})=>({subject,version})),expires_at:f.now()+60000,resume_condition:'Test has a result'}});f.activate();
  for(let i=0;i<3;i++){f.advance(1000);observeWaitSource({mailbox:m,state:f.s,input:input('running')});}
  assert.equal(f.s.checkpoint('T-1').events.length,0);assert.equal(f.s.task('T-1').wake_at,null);
  const actual=f.s.ingest;f.s.ingest=()=>{throw new Error('crash before publication');};const done=input('complete');
  assert.throws(()=>observeWaitSource({mailbox:m,state:f.s,input:done}),/crash/);f.s.ingest=actual;
  assert.equal(JSON.parse(m.db.prepare('SELECT data FROM wait_facts').get().data).state,'complete');
  observeWaitSource({mailbox:m,state:f.s,input:done});observeWaitSource({mailbox:m,state:f.s,input:done});
  assert.equal(f.s.checkpoint('T-1').events.length,1);assert.equal(f.s.reserveQueuedWake('T-1').reserved,true);
 }finally{m.close();f.c.close();rmSync(root,{recursive:true,force:true});}
});

test('a long owner time window never extends typed source freshness',()=>{
 const f=fixture();try{
  f.event();f.decide();f.s.checkWait=()=>({valid:true});
  f.decide({disposition:'wait',plan:undefined,next_action_at:new Date(f.now()+172800000).toISOString(),wait:{
    condition:{kind:'dependency',fact_key:'release',subject:'release',requirement:'published SDK'},
    facts:f.s.checkpoint('T-1').facts.map(({subject,version})=>({subject,version})),expires_at:f.now()+60000,resume_condition:'Release is available'}});f.activate();
  const expiry=JSON.parse(f.s.checkpoint('T-1').wait.condition).expires_at;
  assert.equal(expiry,f.now()+60000);f.advance(60001);f.s.expireWaits();
  assert.ok(f.s.waitPolicy.blocked('T-1'));assert.equal(f.s.checkpoint('T-1').events.length,0);
  assert.equal(f.c.db.prepare("SELECT COUNT(*) n FROM rt_diagnostics WHERE key LIKE 'wait-source-stale:%'").get().n,1);
 }finally{f.c.close();}
});
