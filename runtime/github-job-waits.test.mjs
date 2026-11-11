import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,OWNER,contract} from './test-fixtures/reactive.mjs';
import {ReactiveDriver} from './reactive-driver.mjs';
import {Mailbox} from './mailbox.mjs';
import {collectGitHubJob} from './github-job-waits.mjs';
import {publishWaitObservations} from './wait-observation.mjs';
import {ControlStore} from './control.mjs';

function setup(){
 const root=mkdtempSync(join(tmpdir(),'job-waits-')),f=fixture(join(root,'control.sqlite'),root),m=new Mailbox(join(root,'mailbox.sqlite'),{now:f.now});
 const config={repositories:['example/service'],poll_min_ms:30000,poll_max_ms:300000,poll_connections:1,github_read_budget_per_hour:1800};
 let state='running',calls=0,error;
 const queue={calls:0,validate(){},async enqueue(){this.calls++;throw Error('No native sending in this source test');}};
 const driver=new ReactiveDriver({root,control:f.c,config,queue,capability:{verified:true},now:f.now,jobCollector:async(_root,s)=>{
  calls++;if(error)throw error;return{observed_at:f.now(),evidence_ref:'actual-github-job',data:{repository:s.repository,job_id:s.job_id,state,conclusion:state==='complete'?'success':null}};
 },log:()=>{}});
 f.s.checkWait=c=>m.waits.check(c);
 const fact=(id='9',subject=`github:example/service:job${id}`,fact_key=subject)=>({fact_key,kind:'job',subject,data:{job_id:id,state:'running'},observed_at:new Date(f.now()).toISOString(),expires_at:new Date(f.now()+60000).toISOString(),evidence_ref:'source-initial'});
 function wait({task_id='T-1',ids=['9'],next_action_at}={}){
  for(const id of ids){const input=fact(id);m.waits.observe(input);f.event(`initial:${task_id}:${id}`,input.data,{task_id,subject:input.subject,source:'typed_wait_source',type:'wait_fact_changed'});}
  const t=f.s.task(task_id),first=fact(ids[0]);f.s.decide({task_id,owner_thread_id:OWNER,expected_context_rev:t.context_rev,expected_plan_rev:t.plan_rev,disposition:'wait',reason:'Only the exact job result enables further action',evidence_refs:['source-initial'],
   wait:{condition:{kind:'job',fact_key:first.fact_key,subject:first.subject,job_id:ids[0]},facts:f.s.checkpoint(task_id).facts.map(({subject,version})=>({subject,version})),expires_at:f.now()+60000,resume_condition:'Actual job terminal'},...(next_action_at?{next_action_at}:{})});
 }
 const collect=async()=>{driver.configurePolls();for(const row of f.c.db.prepare("SELECT * FROM rt_polls WHERE enabled=1 AND next_at<=?").all(f.now()))await driver.poll(row);};
 return{...f,root,m,driver,queue,config,fact,wait,collect,setState:s=>{state=s;},setError:e=>{error=e;},calls:()=>calls,async close(){await driver.close();m.close();f.c.close();rmSync(root,{recursive:true,force:true});}};
}

test('driver automatically shares one registered job read, keeps running refresh quiet and durably publishes one terminal event per waiter',async()=>{
 const f=setup();try{
  f.s.adopt({task_id:'T-2',owner_thread_id:OWNER,contract:{...contract(f.root),canonical_key:'another-job-user'},source_message_id:'human:second',actual_human_verified:true});
  f.wait();f.wait({task_id:'T-2'});f.s.setModes({task_ids:['T-1','T-2'],mode:'active',source_message_id:'human',actual_human_verified:true,native_binding:f.binding(),queue_compatibility_verified:true,legacy_quiescent:true});
  await f.collect();assert.equal(f.calls(),1);assert.equal(f.s.checkpoint('T-1').events.length,0);assert.equal(f.queue.calls,0);
  f.advance(60000);await f.collect();assert.equal(f.calls(),2);assert.equal(f.s.task('T-1').wake_at,null);
  f.setState('complete');f.advance(60000);await f.collect();
  for(const id of ['T-1','T-2'])assert.equal(f.s.checkpoint(id).events.filter(e=>e.type==='wait_fact_changed').length,1);
  assert.equal(JSON.parse(f.m.db.prepare('SELECT data FROM wait_facts WHERE fact_key=?').get(f.fact().fact_key).data).state,'complete');
  assert.equal(f.m.db.prepare("SELECT COUNT(*) n FROM wait_observation_outbox WHERE state='delivered'").get().n,1);
  f.advance(60000);await f.collect();publishWaitObservations({mailbox:f.m,state:f.s});assert.equal(f.calls(),3);assert.equal(f.s.checkpoint('T-1').events.filter(e=>e.type==='wait_fact_changed').length,1);
 }finally{await f.close();}
});

test('a secondary registered job fact in the same wait independently resumes it and an altered job identity cannot overwrite its source',async()=>{
 const f=setup();try{f.wait({ids:['9','10']});f.activate();f.driver.jobWaits.collector=async(_r,s)=>({observed_at:f.now(),evidence_ref:'actual-secondary-job',data:{job_id:s.job_id,repository:s.repository,state:s.job_id==='10'?'failed':'running',conclusion:s.job_id==='10'?'cancelled':null}});
  await f.collect();assert.equal(f.s.checkpoint('T-1').events.filter(e=>e.type==='wait_fact_changed').length,1);assert.notEqual(f.s.task('T-1').wake_at,null);
  assert.throws(()=>f.m.waits.observe({...f.fact(),data:{job_id:'another',state:'complete'}}),/identity cannot change/);
 }finally{await f.close();}
});

test('ordinary runtime ticks collect exact job waits within the existing shared connection limit',async()=>{
 const f=setup();try{f.wait({ids:['9','10']});f.activate();
  await f.driver.tick({wait:true});assert.equal(f.calls(),1);assert.equal(f.queue.calls,0);
  await f.driver.tick({wait:true});assert.equal(f.calls(),2);assert.equal(f.queue.calls,0);
  assert.equal(f.s.checkpoint('T-1').events.length,0);
  f.setState('complete');f.advance(60000);await f.driver.tick({wait:true});assert.equal(f.calls(),3);assert.notEqual(f.s.task('T-1').wake_at,null);
 }finally{await f.close();}
});

test('a restarted runtime replays a persisted terminal observation before disabling its completed job poll',async()=>{
 const f=setup();let reopened;try{f.wait();f.activate();await f.collect();
  f.advance(1000);f.m.waits.observe({...f.fact(),data:{job_id:'9',state:'complete',conclusion:'success'}});
  assert.equal(f.s.task('T-1').wake_at,null);
  reopened=new ControlStore(join(f.root,'control.sqlite'),{now:f.now,taskRegistry:()=>null});
  const replacement=new ReactiveDriver({root:f.root,control:reopened,config:f.config,queue:f.queue,now:f.now,capability:{verified:true}});
  replacement.configurePolls();replacement.configurePolls();assert.equal(reopened.reactive.checkpoint('T-1').events.filter(e=>e.type==='wait_fact_changed').length,1);
  assert.equal(reopened.db.prepare("SELECT COUNT(*) n FROM rt_polls WHERE enabled=1 AND json_extract(config,'$.kind')='github_job'").get().n,0);
 }finally{reopened?.close();await f.close();}
});

test('a pause or repository revocation during the read prevents adoption of its result',async()=>{
 for(const revoke of [false,true]){const f=setup();try{f.wait();f.activate();f.driver.jobWaits.collector=async(_r,s)=>{
   if(revoke)f.config.repositories=[];else f.mode('paused');
   return{observed_at:f.now(),evidence_ref:'source-returned-after-change',data:{job_id:s.job_id,repository:s.repository,state:'complete',conclusion:'success'}};
  };await f.collect();assert.equal(f.s.checkpoint('T-1').events.length,0);assert.equal(JSON.parse(f.m.db.prepare('SELECT data FROM wait_facts WHERE fact_key=?').get(f.fact().fact_key).data).state,'running');
 }finally{await f.close();}}
});

test('source collection obeys shared quota, preserves a future owner time and does not poll a paused owner',async()=>{
 const f=setup();try{f.wait({next_action_at:new Date(f.now()+3600000).toISOString()});f.activate();
  f.c.db.prepare("INSERT INTO rt_source_rate VALUES ('github',?,1,'{}')").run(f.now()+60000);await f.collect();assert.equal(f.calls(),0);
  f.advance(60001);f.setState('complete');await f.collect();assert.equal(f.calls(),1);assert.equal(f.s.task('T-1').wake_at,null);assert.ok(f.s.waitPolicy.blocked('T-1'));
  f.s.expireWaits();assert.equal(f.s.task('T-1').wake_at,null);assert.equal(f.queue.calls,0);
 }finally{await f.close();}
 const paused=setup();try{paused.wait();paused.activate();paused.mode('paused');await paused.collect();assert.equal(paused.calls(),0);}finally{await paused.close();}
});

test('unsupported or unauthorized stale job sources get one actionable maintenance input without waking the held task',async()=>{
 const f=setup();try{f.wait();f.activate();f.config.repositories=[];f.advance(120000);await f.collect();await f.collect();
  assert.equal(f.calls(),0);assert.equal(f.s.task('T-1').wake_at,null);
  const rows=f.m.db.prepare("SELECT payload FROM mail WHERE lane='maintenance' AND json_extract(payload,'$.event')='job_wait_source_stale'").all();assert.equal(rows.length,1);assert.match(JSON.parse(rows[0].payload).recovery,/wait_observe/);
 }finally{await f.close();}
});

test('repeated provider failures back off through existing polls and escalate stale evidence once without a false terminal',async()=>{
 const f=setup();try{f.wait();f.activate();f.setError(Error('HTTP 404 job unavailable'));
  for(let i=0;i<5;i++){f.advance(600000);await f.collect();}
  assert.equal(f.m.db.prepare("SELECT COUNT(*) n FROM mail WHERE lane='maintenance'").get().n,1);assert.equal(f.s.task('T-1').wake_at,null);
  assert.equal(JSON.parse(f.m.db.prepare('SELECT data FROM wait_facts WHERE fact_key=?').get(f.fact().fact_key).data).state,'running');
 }finally{await f.close();}
});

test('collector validates exact API identity and preserves success, cancellation, failure and skipped conclusions',async()=>{
 const root=mkdtempSync(join(tmpdir(),'job-api-'));try{
  for(const [status,conclusion,state]of [['queued',null,'pending'],['in_progress',null,'running'],['completed','success','complete'],['completed','failure','failed'],['completed','cancelled','failed'],['completed','skipped','complete']]){
   const r=await collectGitHubJob(root,{repository:'example/service',job_id:'9'},{run:async(cmd,args)=>{assert.equal(cmd,'gh');assert.deepEqual(args,['api','repos/example/service/actions/jobs/9']);return{stdout:JSON.stringify({id:9,url:'https://api.github.com/repos/example/service/actions/jobs/9',status,conclusion})};}});
   assert.equal(r.data.state,state);assert.equal(r.data.conclusion,conclusion);assert.equal(JSON.parse(readFileSync(r.evidence_ref)).job.id,9);
  }
  for(const bad of [{id:10,url:'https://api.github.com/repos/example/service/actions/jobs/9',status:'completed',conclusion:'success'},{id:9,url:'https://api.github.com/repos/other/repo/actions/jobs/9',status:'completed',conclusion:'success'},{id:9,url:'https://api.github.com/repos/example/service/actions/jobs/9',status:'completed',conclusion:null}])await assert.rejects(()=>collectGitHubJob(root,{repository:'example/service',job_id:'9'},{run:async()=>({stdout:JSON.stringify(bad)})}),/identity|conclusion/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('source-to-persistence delay cannot reject a genuine terminal result at the one-hour freshness boundary',async()=>{
 const f=setup();try{f.wait();f.activate();f.driver.jobWaits.collector=async(_r,s)=>{
  const observed_at=f.now();f.advance(750);return{observed_at,evidence_ref:'job-observed-before-persistence',data:{job_id:s.job_id,repository:s.repository,state:'complete',conclusion:'success'}};
 };await f.collect();
 const fact=f.m.db.prepare('SELECT data,observed_at,expires_at FROM wait_facts WHERE fact_key=?').get(f.fact().fact_key);
 assert.equal(JSON.parse(fact.data).state,'complete');assert.ok(fact.expires_at<=fact.observed_at+3600000);
 assert.equal(f.s.checkpoint('T-1').events.filter(e=>e.type==='wait_fact_changed').length,1);
 }finally{await f.close();}
});
