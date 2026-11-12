import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,OWNER,plan} from './test-fixtures/reactive.mjs';
import {Mailbox} from './mailbox.mjs';
import {routeOwnerInputs,nativeLifecycleProgress,ownerActionReasons,queueOwnerHealth} from './owner-delivery.mjs';

function setup(){const root=mkdtempSync(join(tmpdir(),'owner-delivery-')),f=fixture(join(root,'control.sqlite'),root),m=new Mailbox(join(root,'mailbox.sqlite'),{now:f.now});return {...f,root,m,route:()=>routeOwnerInputs({root,control:f.c,mailbox:m,now:f.now}),close(){m.close();f.c.close();rmSync(root,{recursive:true,force:true});}};}
test('delivery handoffs reach the original owner once without creating a service batch',()=>{
 const f=setup();try{f.activate();f.m.enqueue({key:'ready',lane:'coordinator',kind:'configuration',payload:{affected_task_ids:['T-1'],event:'ready_handoff'}});f.route();f.route();
 assert.equal(f.s.checkpoint('T-1').events.filter(e=>e.source==='owner_delivery').length,1);
 assert.equal(f.m.db.prepare('SELECT count(*) n FROM batches').get().n,0);
 assert.equal(f.m.db.prepare('SELECT state FROM mail WHERE item_key=?').get('ready').state,'owner_routed');
 }finally{f.close();}
});
test('paused owners receive durable input without being resumed or dispatched',()=>{
 const f=setup();try{f.mode('paused');f.m.enqueue({key:'paused-ready',lane:'coordinator',kind:'event',payload:{task_id:'T-1'}});f.route();assert.equal(f.s.task('T-1').mode,'paused');assert.equal(f.s.reserveQueuedWake('T-1').reserved,false);assert.equal(f.s.checkpoint('T-1').events.length,1);}finally{f.close();}
});
test('completed owners are not reopened by historical projections',()=>{
 const f=setup();try{f.c.db.prepare("UPDATE rt_tasks SET status='complete' WHERE task_id='T-1'").run();f.m.enqueue({key:'old',lane:'coordinator',kind:'event',payload:{affected_task_ids:['T-1'],event:'outcome_projection'}});f.route();assert.equal(f.s.task('T-1').status,'complete');assert.equal(f.s.checkpoint('T-1').events.length,0);}finally{f.close();}
});
test('a different delivery actor cannot publish on behalf of the original owner',()=>{
 const f=setup();try{assert.deepEqual(ownerActionReasons(f.c,'merge','T-1',{}, {},OWNER),[]);assert.deepEqual(ownerActionReasons(f.c,'merge','T-1',{}, {},'former-coordinator'),['original_task_owner_must_execute_delivery']);}finally{f.close();}
});
test('main can reconcile only the configured shared decision page with verified sources',()=>{
 const main='main',page='decisions';
 const c={work:{config:{threads:{main},delivery:{notion_enabled:true,notion_page_id:page}}},reactive:{task:()=>null}};
 const p={projection_kind:'shared_decisions',operation:'update_page',page_id:page,native_request:{page_id:page,command:'update_content'}};
 const e={manual_content_preserved:true,decision_sources_verified:true,shared_decision_evidence_ref:'saved-current-decisions'};
 assert.deepEqual(ownerActionReasons(c,'notion_sync','shared-decisions',p,e,main),[]);
 for(const [payload,evidence,actor] of [
  [{...p,page_id:'other'},e,main],
  [{...p,native_request:{...p.native_request,page_id:'other'}},e,main],
  [{...p,native_request:{...p.native_request,command:'replace_content'}},e,main],
  [p,{...e,decision_sources_verified:false},main],
  [p,e,'worker'],
 ])assert.notDeepEqual(ownerActionReasons(c,'notion_sync','shared-decisions',payload,evidence,actor),[]);
 assert.notDeepEqual(ownerActionReasons(c,'merge','shared-decisions',p,e,main),[]);
});
test('native lifecycle progress binds the actual handled source generation',()=>{
 const f=setup();try{const key='lifecycle:repo#1:ci',source=key+':1';f.c.db.prepare("INSERT INTO lifecycle_intents(intent_key,pr_key,action,revision,payload,state,due_at,created_at) VALUES (?,?,?,?,?,?,?,?)").run(key,'repo#1','triage_ci','r',JSON.stringify({task_id:'T-1',lifecycle_generation:1}),'pending',f.now(),f.now());
 f.m.enqueue({key:source,lane:'coordinator',kind:'event',payload:{task_id:'T-1',event:'pr_lifecycle_action',lifecycle_key:key,lifecycle_generation:1}});f.route();
 const d=f.decide({disposition:'revise',plan:plan('fix')});
 assert.equal(nativeLifecycleProgress(f.c,{key,generation:1,native_decision_id:d.decision_id,owner_thread_id:OWNER,evidence_ref:'triage'}).task_complete,false);
 assert.throws(()=>nativeLifecycleProgress(f.c,{key,generation:2,native_decision_id:d.decision_id,owner_thread_id:OWNER,evidence_ref:'triage'}),/exact lifecycle/);
 }finally{f.close();}
});

test('same lifecycle facts keep a clean publication plan while the new generation remains pending',()=>{
 const f=setup();try{
  const original={event:'pr_lifecycle_action',task_id:'T-1',lifecycle_key:'lifecycle:repo#1:same',lifecycle_generation:1,detected_at:'first',snapshot_ref:'first-file',action:'deliver_review',head:'a'.repeat(40)};
  const input=(n,patch={})=>({event_id:`owner-input:lifecycle:repo#1:same:${n}:T-1`,task_id:'T-1',source:'owner_delivery',subject:'lifecycle:lifecycle:repo#1:same',type:'owned_followthrough',observed_at:f.now(),payload:{source_event_key:`lifecycle:repo#1:same:${n}`,source_kind:'event',original:{...original,lifecycle_generation:n,detected_at:`time-${n}`,snapshot_ref:`file-${n}`,...patch},instruction:'same original scope'},evidence_ref:`mail:${n}`,debounce_ms:0});
  f.s.ingest(input(1));f.decide({disposition:'continue',plan:plan('deliver')});const before=f.s.task('T-1');f.advance(600001);
  const repeat=f.s.ingest(input(2));assert.equal(repeat.obligation_queued,true);assert.equal(f.s.task('T-1').context_rev,before.context_rev);assert.equal(f.s.task('T-1').dirty,false);assert.equal(f.s.checkpoint('T-1').events[0].payload.original.lifecycle_generation,2);
  const result=f.decide({disposition:'continue',plan:undefined});assert.equal(f.c.db.prepare('SELECT decision_id FROM rt_events WHERE event_id=?').get(input(2).event_id).decision_id,result.decision_id);
  f.advance(1);f.s.ingest(input(3,{head:'b'.repeat(40)}));assert.equal(f.s.task('T-1').dirty,true);assert.equal(f.s.task('T-1').context_rev,before.context_rev+1);
 }finally{f.close();}
});

test('a repeated lifecycle obligation never clears a dirty source update',()=>{
 const f=setup();try{const payload={source_event_key:'intent:1',original:{event:'pr_lifecycle_action',task_id:'T-1',lifecycle_key:'intent',lifecycle_generation:1,action:'deliver_review',head:'a'.repeat(40)}};
 const base={task_id:'T-1',source:'owner_delivery',subject:'lifecycle:intent',type:'owned_followthrough',observed_at:f.now(),evidence_ref:'original'};
 f.s.ingest({...base,event_id:'first',payload});f.decide({disposition:'continue',plan:plan('deliver')});f.event('real-finding',{review:'request changes'});const revision=f.s.task('T-1').context_rev;
 f.s.ingest({...base,event_id:'second',payload:{...payload,source_event_key:'intent:2',original:{...payload.original,lifecycle_generation:2}}});assert.equal(f.s.task('T-1').dirty,true);assert.equal(f.s.task('T-1').context_rev,revision);
 }finally{f.close();}
});

test('unchanged lifecycle reminders preserve an actual pending human decision',()=>{
 const f=setup();try{const original={event:'pr_lifecycle_action',task_id:'T-1',lifecycle_key:'held',lifecycle_generation:1,action:'deliver_review'};
 const input=n=>({event_id:`held-${n}`,task_id:'T-1',source:'owner_delivery',subject:'lifecycle:held',type:'owned_followthrough',observed_at:f.now(),payload:{source_event_key:`held:${n}`,original:{...original,lifecycle_generation:n}},evidence_ref:`held:${n}`,debounce_ms:0});
 f.s.ingest(input(1));f.decide({disposition:'needs_decision',plan:undefined});f.s.ingest(input(2));assert.equal(f.s.task('T-1').status,'needs_decision');assert.equal(f.s.task('T-1').wake_at,null);
 }finally{f.close();}
});

function dependencyReminderFixture({separateWait=false}={}) {
 const f=setup(),intent='lifecycle:repo#1:waiting',payload=n=>({event:'pr_lifecycle_action',task_id:'T-1',lifecycle_key:intent,lifecycle_generation:n,action:'obtain_readiness',head:'a'.repeat(40),detected_at:`generation-${n}`,snapshot_ref:`read-${n}`});
 f.c.db.prepare("INSERT INTO lifecycle_intents(intent_key,pr_key,action,revision,payload,state,due_at,created_at) VALUES (?,?,?,?,?,?,?,?)").run(intent,'repo#1','obtain_readiness','same',JSON.stringify(payload(1)),'pending',f.now(),f.now());
 const enqueue=n=>{f.c.db.prepare('UPDATE lifecycle_intents SET payload=? WHERE intent_key=?').run(JSON.stringify(payload(n)),intent);f.m.enqueue({key:`${intent}:${n}`,lane:'coordinator',kind:'event',payload:payload(n)});};
 enqueue(1);f.route();f.m.waits.observe({fact_key:'dependency',kind:'dependency',subject:'required-release',data:{available:false,requirement:'published release'},observed_at:new Date(f.now()).toISOString(),expires_at:new Date(f.now()+3600000).toISOString(),evidence_ref:'actual-release-source'});
 f.s.checkWait=c=>f.m.waits.check(c);const fact=f.s.checkpoint('T-1').facts[0];
 if(separateWait)f.decide({disposition:'continue',plan:plan('wait for release')});
 f.decide({disposition:'wait',plan:separateWait?undefined:plan('wait for release'),wait:{facts:[{subject:fact.subject,version:fact.version}],expires_at:f.now()+3600000,resume_condition:'Required release becomes available',condition:{kind:'dependency',fact_key:'dependency',subject:'required-release',requirement:'published release'}}});
 f.mode('active');enqueue(2);return {...f,intent,payload,enqueue};
}
test('same reminder stays pending after dependency evidence expires without a state change',()=>{
 const f=dependencyReminderFixture();try{const rev=f.s.task('T-1').context_rev;f.route();f.route();assert.equal(f.s.task('T-1').wake_at,null);assert.equal(f.s.task('T-1').context_rev,rev);assert.equal(f.m.db.prepare('SELECT state FROM mail WHERE item_key=?').get(f.intent+':2').state,'pending');
 f.advance(3600001);f.route();assert.equal(f.s.task('T-1').wake_at,null);assert.equal(f.s.checkpoint('T-1').events.length,0);assert.equal(f.m.db.prepare('SELECT state FROM mail WHERE item_key=?').get(f.intent+':2').state,'pending');
 }finally{f.close();}
});
test('dependency availability and genuinely changed obligations immediately release work',()=>{
 for(const change of ['available','head','dirty','replan']){const f=dependencyReminderFixture();try{f.route();
  if(change==='available')f.m.waits.observe({fact_key:'dependency',kind:'dependency',subject:'required-release',data:{available:true,requirement:'published release'},observed_at:new Date(f.now()).toISOString(),expires_at:new Date(f.now()+3600000).toISOString(),evidence_ref:'new-release'});
  if(change==='head'){const p={...f.payload(3),head:'b'.repeat(40)};f.c.db.prepare('UPDATE lifecycle_intents SET payload=? WHERE intent_key=?').run(JSON.stringify(p),f.intent);f.m.enqueue({key:f.intent+':3',lane:'coordinator',kind:'event',payload:p});}
  if(change==='dirty')f.event('material-feedback',{review:'request changes'});
  if(change==='replan'){const wait=JSON.parse(f.c.db.prepare("SELECT condition FROM rt_waits WHERE task_id='T-1'").get().condition);f.event('actual-replan',{priority:'new independent step'});const wake=f.begin();f.decide({wake_id:wake.id,disposition:'wait',plan:plan('new independent step'),wait});}
  f.route();assert.notEqual(f.s.task('T-1').wake_at,null);
 }finally{f.close();}}
});

test('a freshly reverified dependency wait also holds the existing lifecycle reminder',async()=>{
 const {renewVerifiedWaits}=await import('./wait-renewal.mjs');
 const f=dependencyReminderFixture();try{f.route();f.advance(3600001);
  f.m.waits.observe({fact_key:'dependency',kind:'dependency',subject:'required-release',data:{available:false,requirement:'published release'},observed_at:new Date(f.now()).toISOString(),expires_at:new Date(f.now()+15000).toISOString(),evidence_ref:'new-actual-release-source'});
  assert.deepEqual(renewVerifiedWaits({root:f.root,control:f.c,now:f.now}),['T-1']);
  assert.equal(JSON.parse(f.s.checkpoint('T-1').wait.condition).expires_at,f.now()+15000);
  f.route();f.s.expireWaits();assert.equal(f.s.task('T-1').wake_at,null);
  assert.equal(f.m.db.prepare('SELECT state FROM mail WHERE item_key=?').get(f.intent+':2').state,'pending');
  f.advance(15001);assert.deepEqual(renewVerifiedWaits({root:f.root,control:f.c,now:f.now}),[]);
  f.route();assert.equal(f.s.task('T-1').wake_at,null);
 }finally{f.close();}
});

test('a legacy evidence-expiry reconciliation stays inside runtime while the unchanged dependency is blocked',()=>{
 const f=dependencyReminderFixture();try{
  f.advance(3600001);f.m.enqueue({key:'old-source-expired',lane:'coordinator',kind:'event',payload:{event:'wait_reconciliation',task_id:'T-1',wait_reason:'evidence_expired'}});
  f.route();f.route();assert.equal(f.s.task('T-1').wake_at,null);assert.equal(f.s.checkpoint('T-1').events.length,0);
  assert.equal(f.c.db.prepare("SELECT COUNT(*) n FROM rt_diagnostics WHERE key='wait-source-stale:old-source-expired'").get().n,1);
 }finally{f.close();}
});

test('an obligation handled by continue followed by a separate wait stays quiet across freshness generations',()=>{
 const f=dependencyReminderFixture({separateWait:true});try{
  f.route();assert.equal(f.s.task('T-1').wake_at,null);assert.equal(f.s.checkpoint('T-1').events.length,0);
  f.advance(3600001);f.route();assert.equal(f.s.task('T-1').wake_at,null);
  const p={...f.payload(3),head:'b'.repeat(40)};f.c.db.prepare('UPDATE lifecycle_intents SET payload=? WHERE intent_key=?').run(JSON.stringify(p),f.intent);
  f.m.enqueue({key:f.intent+':3',lane:'coordinator',kind:'event',payload:p});f.route();assert.notEqual(f.s.task('T-1').wake_at,null);
 }finally{f.close();}
});

test('the first freshness-only verification stays quiet during a deliberate blocker wait, without hiding new source facts',()=>{
 const f=setup();try{
  const key='example/service#1',head='a'.repeat(40),intent='lifecycle:'+key+':freshness';
  f.event('initial-pr',{pr:{head_sha:head,state:'open'}},{subject:key});f.decide({disposition:'continue',plan:plan('assessed source')});
  f.s.checkWait=()=>({valid:true});f.decide({disposition:'wait',plan:undefined,wait:{facts:f.s.checkpoint('T-1').facts.map(({subject,version})=>({subject,version})),expires_at:f.now()+60000,resume_condition:'Workflow repair is available',condition:{kind:'dependency',fact_key:'repair',subject:'repair',requirement:'safe unsent recovery'}}});f.activate();
  const payload={event:'pr_lifecycle_action',task_id:'T-1',pr_key:key,head,action:'verify_review_ci',lifecycle_key:intent,lifecycle_generation:1,gate_reasons:['fresh_complete_applicable_CI_evidence_required','fresh_verified_Gatekeeper_surface_required']};
  f.c.db.prepare("INSERT INTO lifecycle_intents(intent_key,pr_key,action,revision,payload,state,due_at,created_at) VALUES (?,?,?,?,?,'pending',?,?)").run(intent,key,payload.action,'same',JSON.stringify(payload),f.now(),f.now());
  f.m.enqueue({key:intent+':1',lane:'coordinator',kind:'event',payload});f.route();assert.equal(f.s.task('T-1').wake_at,null);assert.equal(f.s.checkpoint('T-1').events.length,0);
  f.event('real-new-feedback',{pr:{head_sha:head,state:'open'},issue_comments:[{id:1,body:'New substantive finding',user:{login:'reviewer'}}]},{subject:key});f.route();assert.notEqual(f.s.task('T-1').wake_at,null);
 }finally{f.close();}
});
