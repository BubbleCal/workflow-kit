import {OwnerHealth} from './owner-health.mjs';
import {DesktopLoader} from './desktop-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReactiveDriver} from './reactive-driver.mjs';
import {Mailbox,COORDINATOR,INBOX} from './mailbox.mjs';
import {fixture,NOW,OWNER,receipt,nativeProof} from './test-fixtures/reactive.mjs';

const head='a'.repeat(40);
function setup() {
  const root=mkdtempSync(join(tmpdir(),'native-driver-')),f=fixture(join(root,'control.sqlite'),root),{c:control,s:state}=f;
  const t=state.task('T-1');control.db.prepare('UPDATE rt_tasks SET contract=? WHERE task_id=?').run(JSON.stringify({...t.contract,pull_requests:[{repository:'example/service',pr_number:1}]}),'T-1');
  const queue={calls:[],validate(){},async enqueue(thread,prompt){this.calls.push({thread,prompt});if(this.failure)throw new Error('Unknown enqueue result');return receipt(thread,prompt,f.now());}};
  let body='Please handle empty input';
  const collector=async()=>{
    const at=new Date(f.now()).toISOString(),pr={repository:'example/service',pr_number:1,head_sha:head,state:'open',draft:false,updated_at:at,checked_at:at,evidence_ref:'pr-source',
      ci:{head_sha:head,checked_at:at,evidence_ref:'ci-source',complete:true,scope:'observed',checks:[]}};
    const reviews=[{id:10,state:'CHANGES_REQUESTED',body,commit_id:head,user:{login:'reviewer'}}];
    return {pr,feedback:{repository:'example/service',pr_number:1,head_sha:head,head_before:head,head_after:head,checked_at:at,evidence_ref:'feedback-source',
      complete:{reviews:true,review_comments:true,issue_comments:true,review_threads:true},reviews,review_comments:[],issue_comments:[],review_threads:[],pr},
      observed_at:f.now(),data:{head,review:body},evidence_ref:'feedback-source'};
  };
  const driver=new ReactiveDriver({root,control,queue,config:{repositories:['example/service'],poll_min_ms:30000,poll_max_ms:300000},
    capability:{verified:true,evidence_digest:'fixture-native-proof'},now:f.now,collector,log:()=>{}});
  return {...f,root,control,state,queue,driver,setReview:value=>{body=value;},close:async()=>{await driver.close();control.close();rmSync(root,{recursive:true,force:true});}};
}

test('shadow mode records changes without a queue submission or legacy feedback mutation',async()=>{
  const f=setup();try{
    await f.driver.tick({wait:true});assert.equal(f.state.task('T-1').dirty,true);assert.equal(f.queue.calls.length,0);
    assert.equal(f.control.feedback.status('example/service',1).snapshot,null);
    const revision=f.state.task('T-1').context_rev;f.advance(30000);await f.driver.tick({wait:true});assert.equal(f.state.task('T-1').context_rev,revision);
  }finally{await f.close();}
});

test('shared PR observations fan out while the owner receives one queue message',async()=>{
  const f=setup();try{
    const original=f.state.task('T-1').contract;
    f.state.adopt({task_id:'T-2',owner_thread_id:OWNER,contract:{...original,canonical_key:'second'},source_message_id:'human',actual_human_verified:true});
    f.state.setModes({task_ids:['T-1','T-2'],mode:'active',source_message_id:'human',actual_human_verified:true,native_binding:f.binding(),queue_compatibility_verified:true,legacy_quiescent:true});
    let collections=0;const collect=f.driver.collector;f.driver.collector=async(...args)=>{collections++;return collect(...args);};
    await f.driver.tick({wait:true});f.advance(1001);await f.driver.tick({wait:true});
    assert.equal(collections,1);assert.equal(f.queue.calls.length,1);
    assert.equal(f.state.checkpoint('T-2').facts[0].data.review,'Please handle empty input');
    assert.deepEqual(f.state.openWake('T-1').member_ids,['T-1','T-2']);
    await Promise.all(['T-1','T-2'].map(id=>f.driver.deliver(f.state.task(id))));assert.equal(f.queue.calls.length,1);
  }finally{await f.close();}
});

test('native control lanes preserve uncertain batches and do not spin on unchanged work',async()=>{
  const f=setup();let m;try{
    f.driver.config.control_lanes={coordinator:{thread_id:COORDINATOR,workspace:f.root}};
    m=new Mailbox(join(f.root,'mailbox.sqlite'),{now:f.now});
    m.enqueue({key:'control-work',lane:'coordinator',kind:'configuration',payload:{text:'Reconcile the existing binding'}});
    await f.driver.deliverControls();assert.equal(f.queue.calls.length,1);
    const batch=m.db.prepare("SELECT id FROM batches WHERE lane='coordinator'").get();
    m.begin(batch.id);m.finish(batch.id,{processed_keys:[],note:'Remaining source work is retained'});
    await f.driver.deliverControls();assert.equal(f.queue.calls.length,1);
    m.enqueue({key:'new-human',lane:'coordinator',kind:'human_command',payload:{text:'Actual new authorized request'}});
    f.queue.failure=true;await f.driver.deliverControls();assert.equal(f.queue.calls.length,2);
    f.advance(600000);await f.driver.deliverControls();assert.equal(f.queue.calls.length,2);
    assert.equal(m.db.prepare("SELECT COUNT(*) AS n FROM batches WHERE state='uncertain'").get().n,1);
  }finally{m?.close();await f.close();}
});

test('an earlier-sorting late task cannot starve its owners already reserved message',async()=>{
  const f=setup();try{
    const original={...f.state.task('T-1').contract,pull_requests:[]};
    f.state.amend({task_id:'T-1',expected_contract_rev:1,contract:original,source_message_id:'human',actual_human_verified:true});
    f.decide({disposition:'needs_decision',plan:undefined});f.activate();
    f.state.adopt({task_id:'T-2',owner_thread_id:OWNER,contract:{...original,canonical_key:'second'},source_message_id:'human',actual_human_verified:true});
    f.state.setMode({task_id:'T-2',mode:'active',source_message_id:'human',actual_human_verified:true,native_binding:f.binding(),queue_compatibility_verified:true,legacy_quiescent:true});
    const reserved=f.state.reserveQueuedWake('T-2').wake;
    f.event('late-first',{new:'source'});await f.driver.tick({wait:true});
    assert.equal(f.queue.calls.length,1);assert.equal(f.state.openWake('T-2').id,reserved.id);
    assert.equal(f.state.openWake('T-1'),null);
  }finally{await f.close();}
});

test('an unconsumed queue receipt gets one native loading check without another dispatch',async()=>{
  const f=setup();let m;try{
    f.activate();await f.driver.deliver(f.state.task('T-1'));const queueId=f.state.openWake('T-1').queue_id;f.advance(60001);
    m=new Mailbox(join(f.root,'mailbox.sqlite'),{now:f.now});
    f.driver.requestNativeQueueChecks(m);f.driver.requestNativeQueueChecks(m);
    assert.equal(m.db.prepare("SELECT COUNT(*) AS n FROM mail WHERE item_key LIKE 'native-queue-check:%'").get().n,1);
    assert.equal(f.queue.calls.length,1);assert.equal(f.state.openWake('T-1').state,'queued');
    assert.equal(f.state.openWake('T-1').queue_id,queueId);
  }finally{m?.close();await f.close();}
});

test('automatic wakeups never open UI even with a legacy loader enabled',async()=>{
  const f=setup();try{
    f.activate();await f.driver.deliver(f.state.task('T-1'));const wake=f.state.openWake('T-1');f.advance(60001);
    f.driver.config.desktop_loader={enabled:true,bundle_id:'com.openai.codex'};
    let opens=0;f.driver.desktopLoader={async open(){opens++;}};
    const first=await f.driver.loadPendingDesktopChats();await f.driver.loadPendingDesktopChats();
    assert.equal(first.reason,'automatic_desktop_navigation_disabled');assert.equal(opens,0);assert.equal(f.queue.calls.length,1);
    assert.equal(f.state.openWake('T-1').queue_id,wake.queue_id);assert.equal(f.state.openWake('T-1').state,'queued');
  }finally{await f.close();}
});

test('rate-limit backoff preserves task delivery and resumes source reads after the provider reset',async()=>{
  const f=setup();try{
    let reads=0;const collect=f.driver.collector;
    f.driver.rate.readQuota=async()=>({core:{remaining:0,reset:(f.now()+60000)/1000}});
    f.driver.collector=async()=>{reads++;throw new Error('API rate limit exceeded');};
    f.activate();await f.driver.tick({wait:true});assert.equal(reads,1);assert.equal(f.queue.calls.length,1);assert.equal(f.state.task('T-1').mode,'active');
    f.advance(30000);await f.driver.tick({wait:true});assert.equal(reads,1);
    f.driver.collector=async(...args)=>{reads++;return collect(...args);};f.advance(31001);await f.driver.tick({wait:true});
    assert.equal(reads,2);assert.equal(f.control.db.prepare('SELECT failures FROM rt_polls').get().failures,0);assert.equal(f.queue.calls.length,1);
  }finally{await f.close();}
});

test('explicitly excluded PRs stop source polling without deleting historical evidence',async()=>{
  const f=setup();try{
    f.driver.configurePolls();
    f.control.taskRegistry=()=>({scope_restrictions:{skip:{task_id:'T-1',source_message_id:'human',evidence_ref:'actual-source',verbatim_text:'Stop this branch',status:'excluded',targets:{pr_urls:['https://github.com/example/service/pull/1']}}}});
    f.driver.configurePolls();assert.equal(f.control.db.prepare('SELECT enabled FROM rt_polls').get().enabled,0);
    assert.equal(f.control.db.prepare('SELECT COUNT(*) AS n FROM rt_polls').get().n,1);
  }finally{await f.close();}
});
test('active events submit one native queue message without reading or controlling a desktop session',async()=>{
  const f=setup();try{
    f.activate();await f.driver.tick({wait:true});f.advance(1001);await f.driver.deliver(f.state.task('T-1'));
    assert.equal(f.queue.calls.length,1);assert.equal(f.queue.calls[0].thread,OWNER);
    const w=f.state.openWake('T-1');assert.equal(w.state,'queued');assert.equal(w.turn_id,null);assert.equal(w.started_at,null);
    assert.equal(f.control.lifecycle.inspect('example/service#1').action,'assess_feedback');
    await f.driver.deliver(f.state.task('T-1'));assert.equal(f.queue.calls.length,1);
    f.state.begin({task_id:'T-1',wake_id:w.id,native_proof:nativeProof({workspace:f.root,message:f.queue.calls[0].prompt,now:f.now()})});
    assert.equal(f.state.openWake('T-1').state,'running');
    f.advance(30000);f.setReview('Also preserve null values');await f.driver.tick({wait:true});
    assert.equal(f.queue.calls.length,1);assert.equal(f.state.task('T-1').dirty,true);
  }finally{await f.close();}
});
test('failed compatibility verification prevents all native queue delivery',async()=>{
  const f=setup();try{
    f.activate();f.driver.capability=null;await f.driver.tick({wait:true});f.advance(1001);await f.driver.deliver(f.state.task('T-1'));
    assert.equal(f.queue.calls.length,0);assert.equal(f.control.db.prepare('SELECT COUNT(*) AS n FROM actions').get().n,0);
  }finally{await f.close();}
});
test('unknown enqueue outcomes stay uncertain and do not resubmit after later ticks',async()=>{
  const f=setup();try{
    f.activate();f.queue.failure=true;await f.driver.tick({wait:true});f.advance(1001);await f.driver.deliver(f.state.task('T-1'));
    const w=f.state.openWake('T-1');assert.equal(w.state,'uncertain');
    f.advance(60000);await f.driver.deliver(f.state.task('T-1'));assert.equal(f.queue.calls.length,1);assert.equal(f.state.openWake('T-1').id,w.id);
  }finally{await f.close();}
});
test('native consumption before CLI acknowledgement preserves the actual running turn',async()=>{
  const f=setup();try{
    f.activate();f.queue.enqueue=async(thread,prompt)=>{
      const w=f.state.openWake('T-1');f.state.begin({task_id:'T-1',wake_id:w.id,native_proof:nativeProof({workspace:f.root,message:prompt,now:f.now()})});
      return receipt(thread,prompt,f.now());
    };
    await f.driver.deliver(f.state.task('T-1'));
    const w=f.state.openWake('T-1');assert.equal(w.state,'running');assert.equal(w.turn_id,'native-turn');assert.ok(w.queue_id);
    assert.equal(f.control.db.prepare('SELECT state FROM actions WHERE action_key=?').get(w.id).state,'sent');
  }finally{await f.close();}
});
test('collection errors retain source evidence instead of inventing clear feedback',async()=>{
  const f=setup();try{
    await f.driver.tick({wait:true});const before=f.state.checkpoint('T-1').facts;f.advance(30000);
    f.driver.collector=async()=>{throw new Error('Unavailable source');};await f.driver.tick({wait:true});assert.deepEqual(f.state.checkpoint('T-1').facts,before);
    assert.equal(f.control.db.prepare('SELECT failures FROM rt_polls').get().failures,1);
  }finally{await f.close();}
});
test('legacy transfer is durable and the old coordinator does not claim active task inputs',async()=>{
  const f=setup();let m;try{
    f.activate();m=new Mailbox(join(f.root,'mailbox.sqlite'),{now:f.now});
    m.enqueue({key:'old-result',lane:'coordinator',kind:'worker_result',payload:{task_id:'T-1',owner_thread_id:OWNER,evidence_ref:'result'}});
    if(COORDINATOR)assert.equal(m.reserve('coordinator',{checked_at:new Date(NOW).toISOString(),thread:{id:COORDINATOR,status:{type:'idle'}},latestTurn:{id:'old',status:'completed'}}).reserved,false);
    f.driver.bridgeLegacy();f.driver.bridgeLegacy();assert.equal(f.state.checkpoint('T-1').events.filter(e=>e.source==='legacy_mailbox').length,1);
    assert.equal(m.db.prepare("SELECT state FROM mail WHERE item_key='old-result'").get().state,'reactive');
  }finally{m?.close();await f.close();}
});
test('important notifications use a native queue batch, never the legacy direct-send authorization',async()=>{
  const f=setup();let m;try{
    f.activate();m=new Mailbox(join(f.root,'mailbox.sqlite'),{now:f.now});
    m.enqueue({key:'answer',lane:'inbox',kind:'answer',payload:{task_id:'T-1',text:'Verified result'}});
    f.driver.config.inbox={thread_id:INBOX};await f.driver.deliverInbox();await f.driver.deliverInbox();assert.equal(f.queue.calls.length,1);
    const batch=m.db.prepare("SELECT id,state FROM batches WHERE lane='inbox'").get();assert.equal(batch.state,'sent');
    assert.equal(m.authorizeSend(batch.id,{}).reason,'native_queue_transport_only');
    assert.match(f.queue.calls[0].prompt,/Verified result/);
  }finally{m?.close();await f.close();}
});
test('the upstream immediate-human trigger is retained for legacy tasks without adding an active-task relay',async()=>{
  const f=setup();let m;try{
    f.activate();m=new Mailbox(join(f.root,'mailbox.sqlite'),{now:f.now,taskRegistry:()=>({queue_transport:{dispatcher_thread_id:'dispatcher',immediate_human_trigger:{enabled:true,source_message_id:'user:rule'}}})});
    const enqueue=(key,task)=>m.enqueue({key,lane:'coordinator',kind:'human_command',payload:{task_id:task,source_message_id:key,source_thread_id:'inbox',text:'Continue',authorization_ref:key},
      human_trigger:{actual_human_message_verified:true,source_actor_verified:true,source_message_id:key}});
    assert.equal(enqueue('active','T-1').immediate_trigger,undefined);assert.equal(enqueue('legacy','T-2').immediate_trigger.length,1);
  }finally{m?.close();await f.close();}
});
test('native review requests can justify waiting without Slack but never hide new material feedback',async()=>{
  const f=setup();try{
    f.activate();f.driver.configurePolls();await f.driver.poll(f.control.db.prepare('SELECT * FROM rt_polls').get());
    const condition={kind:'review_request',pr_key:'example/service#1',head,reviewer:'reviewer',next_check_at:new Date(NOW+60000).toISOString()};
    const snapshot=JSON.parse(f.control.db.prepare('SELECT snapshot FROM lifecycle_prs').get().snapshot);
    f.control.lifecycle.observe({...snapshot,requested_reviewers:['reviewer']},{feedbackCollected:true});assert.equal(f.control.checkReactiveWait(condition).valid,false);
    const item=f.control.feedback.status('example/service',1).items[0];f.control.feedback.assess({repository:'example/service',pr_number:1,head,
      decisions:[{key:item.key,digest:item.digest,disposition:'addressed',reason:'Validated current fix',current_code_relevance_verified:true,evidence_ref:'code',validation_ref:'test'}]});
    assert.equal(f.control.checkReactiveWait(condition).valid,true);
    f.advance(1000);f.setReview('New unhandled problem');await f.driver.poll(f.control.db.prepare('SELECT * FROM rt_polls').get());
    assert.equal(f.control.checkReactiveWait(condition).valid,false);
  }finally{await f.close();}
});

test('registered owner artifacts join native polling without amending contracts or duplicating a source',async()=>{
  const f=setup();try{
    const t=f.state.task('T-1');f.control.db.prepare('UPDATE rt_tasks SET contract=? WHERE task_id=?').run(JSON.stringify({...t.contract,pull_requests:[]}),'T-1');
    const before=f.state.task('T-1');
    f.control.lifecycle.track({repository:'example/service',pr_number:1,task_id:'T-1',owner_thread_id:OWNER,authorization_ref:'original-deliverable'});
    f.driver.configurePolls();f.driver.configurePolls();
    const rows=f.control.db.prepare('SELECT * FROM rt_polls WHERE enabled=1').all();
    assert.equal(rows.length,1);assert.deepEqual(JSON.parse(rows[0].config).task_ids,['T-1']);
    assert.deepEqual(f.state.task('T-1'),before);assert.equal(f.queue.calls.length,0);
    f.activate();await f.driver.deliver(f.state.task('T-1'));
    await f.driver.poll(rows[0]);const observed=f.state.task('T-1').context_rev;
    f.advance(300000);await f.driver.poll(f.control.db.prepare('SELECT * FROM rt_polls').get());
    await f.driver.deliver(f.state.task('T-1'));
    assert.equal(f.queue.calls.length,1);assert.equal(f.state.task('T-1').context_rev,observed);
    assert.equal(f.state.task('T-1').contract_rev,before.contract_rev);
    f.control.db.prepare('UPDATE rt_tasks SET contract=? WHERE task_id=?').run(JSON.stringify(t.contract),'T-1');
    f.driver.configurePolls();assert.deepEqual(JSON.parse(f.control.db.prepare('SELECT config FROM rt_polls').get().config).task_ids,['T-1']);
    f.control.db.prepare('UPDATE lifecycle_prs SET retired=1').run();
    f.control.db.prepare('UPDATE rt_tasks SET contract=? WHERE task_id=?').run(JSON.stringify({...t.contract,pull_requests:[]}),'T-1');
    f.driver.configurePolls();assert.equal(f.control.db.prepare('SELECT enabled FROM rt_polls').get().enabled,0);
  }finally{await f.close();}
});

test('artifact polling preserves owner, scope, paused-task and completed-task boundaries',async()=>{
  const f=setup();try{
    const t=f.state.task('T-1');f.control.db.prepare('UPDATE rt_tasks SET contract=? WHERE task_id=?').run(JSON.stringify({...t.contract,pull_requests:[]}),'T-1');
    for(const [number,task,owner,repository] of [[2,'T-1','wrong','example/service'],[3,'missing',OWNER,'example/service'],[4,'T-1',OWNER,'outside/repo']])
      f.control.lifecycle.track({repository,pr_number:number,task_id:task,owner_thread_id:owner,authorization_ref:'original'});
    f.driver.configurePolls();assert.equal(f.control.db.prepare('SELECT count(*) n FROM rt_polls WHERE enabled=1').get().n,0);
    f.control.lifecycle.track({repository:'example/service',pr_number:1,task_id:'T-1',owner_thread_id:OWNER,authorization_ref:'original'});
    f.control.taskRegistry=()=>({scope_restrictions:{skip:{task_id:'T-1',source_message_id:'human',evidence_ref:'actual-source',verbatim_text:'Stop this PR',status:'excluded',targets:{pr_urls:['https://github.com/example/service/pull/1']}}}});
    f.driver.configurePolls();assert.equal(f.control.db.prepare('SELECT count(*) n FROM rt_polls WHERE enabled=1').get().n,0);
    f.control.taskRegistry=()=>null;
    for(const patch of ["mode='paused'","mode='active',status='complete'"]){f.control.db.exec('UPDATE rt_tasks SET '+patch);f.driver.configurePolls();assert.equal(f.control.db.prepare('SELECT count(*) n FROM rt_polls WHERE enabled=1').get().n,0);}
  }finally{await f.close();}
});


test('native service layout retains receipt reconciliation without a legacy control sender',async()=>{
 const f=setup();let m;try{
  f.activate();await f.driver.deliver(f.state.task('T-1'));f.advance(60001);
  f.driver.config.inbox={thread_id:INBOX};f.driver.config.service_tasks={coordinator:'T-delivery'};
  await f.driver.deliverInbox();await f.driver.deliverInbox();
  m=new Mailbox(join(f.root,'mailbox.sqlite'),{now:f.now});
  assert.equal(m.db.prepare("SELECT count(*) n FROM mail WHERE item_key LIKE 'native-queue-check:%'").get().n,1);
  assert.equal(f.queue.calls.length,1);
 }finally{m?.close();await f.close();}
});

test('maintenance wakes contain only the maintenance role and its fixed-batch protocol',async()=>{
 const {wakePrompt}=await import('./reactive-driver.mjs');
 const task={task_id:'T-maintenance',owner_id:OWNER,context_rev:1,contract:{service_lane:'maintenance'}};
 const prompt=wakePrompt('/instance',task,{id:'wake',member_ids:['T-maintenance']},{events:[{type:'service_batch_ready',payload:{batch_id:'actual-batch'}}]});
 assert.match(prompt,/工作流维护/);assert.match(prompt,/actual-batch/);assert.match(prompt,/daily-review\/config.json/);
 assert.doesNotMatch(prompt,/多个任务|PR 反馈|implements|产品实现/);assert.ok(prompt.length<1400);
});


test('on-request main retains notifications without reserving batches while owners continue',async()=>{
  const f=setup();let m;try{
    f.activate();m=new Mailbox(join(f.root,'mailbox.sqlite'),{now:f.now});
    m.enqueue({key:'on-request-answer',lane:'inbox',kind:'answer',payload:{task_id:'T-1',text:'Verified result'}});
    f.driver.config.inbox={thread_id:INBOX,delivery_mode:'on_request'};
    await f.driver.deliverInbox();await f.driver.deliverInbox();
    assert.equal(f.queue.calls.length,0);assert.equal(m.db.prepare("SELECT COUNT(*) AS n FROM batches WHERE lane='inbox'").get().n,0);
    assert.equal(m.readInbox().items[0].state,'pending');
    await f.driver.tick({wait:true});
    assert.equal(f.queue.calls.length,1);assert.equal(f.queue.calls[0].thread,OWNER);
    assert.equal(m.readInbox().items[0].state,'pending');
  }finally{m?.close();await f.close();}
});

const idlePolicy=()=>({enabled:true,mode:'idle_only',authorization_ref:'human:idle-only',bundle_id:'com.openai.codex',min_idle_ms:600000,check_interval_ms:15000,open_interval_ms:30000,retry_interval_ms:300000,queue_grace_ms:30000});
function enableIdleLoader(f,read){
 let calls=0;f.driver.config.desktop_loader=idlePolicy();f.driver.readActivity=read??(async()=>({source:'macos_hid_and_power_assertions',checked_at:f.now(),idle_ms:600000,user_active:false,display_busy:false}));
 f.driver.desktopLoader=new DesktopLoader({bundle_id:'com.openai.codex',now:f.now,read_activity:()=>f.driver.readActivity(),run:async()=>{calls++;}});
 return ()=>calls;
}

test('an active user keeps the existing queue untouched; idle later loads once with durable backoff',async()=>{
 const f=setup();try{
  f.activate();await f.driver.deliver(f.state.task('T-1'));const original=f.state.openWake('T-1'),calls=enableIdleLoader(f);f.advance(30000);
  const idle=f.driver.readActivity;f.driver.readActivity=async()=>({...await idle(),idle_ms:599999});
  assert.equal((await f.driver.loadPendingDesktopChats()).opened,false);assert.equal(calls(),0);
  assert.equal(JSON.parse(f.control.db.prepare("SELECT data FROM rt_diagnostics WHERE key='desktop-activity'").get().data).reason,'user_active_or_idle_unconfirmed');
  f.advance(15000);f.driver.readActivity=idle;assert.equal((await f.driver.loadPendingDesktopChats()).opened,true);assert.equal(calls(),1);
  assert.equal(f.queue.calls.length,1);assert.equal(f.state.openWake('T-1').queue_id,original.queue_id);assert.equal(f.state.openWake('T-1').state,'queued');
  // Restarting the driver does not erase the exact-wake cooldown.
  f.driver.desktopCheckAt=undefined;f.advance(30001);assert.equal((await f.driver.loadPendingDesktopChats()).opened,false);assert.equal(calls(),1);
  f.advance(270000);assert.equal((await f.driver.loadPendingDesktopChats()).opened,true);assert.equal(calls(),2);
 }finally{await f.close();}
});

test('user input between candidate selection and the final activity check prevents open',async()=>{
 const f=setup();try{
  f.activate();await f.driver.deliver(f.state.task('T-1'));f.advance(30000);let reads=0;
  const calls=enableIdleLoader(f,async()=>({source:'macos_hid_and_power_assertions',checked_at:f.now(),idle_ms:++reads===1?600000:0,user_active:false,display_busy:false}));
  assert.equal((await f.driver.loadPendingDesktopChats()).opened,false);assert.equal(calls(),0);assert.equal(f.queue.calls.length,1);
 }finally{await f.close();}
});

for(const protection of ['paused','hold','excluded','needs_decision','main','uncertain','running','native_failed'])test(`idle loading preserves ${protection}`,async()=>{
 const f=setup();try{
  f.activate();await f.driver.deliver(f.state.task('T-1'));f.advance(30000);const calls=enableIdleLoader(f),task=f.state.task('T-1');
  if(protection==='native_failed'){new OwnerHealth(f.control);f.control.db.prepare('INSERT INTO rt_owner_health VALUES (?,?,?,?,?,?,?,?,?,?)').run('T-1',OWNER,'turn_failed','failed-turn',f.state.openWake('T-1').id,f.now(),f.now()+60000,0,'native-failure','{}');}
  if(protection==='paused')f.state.setMode({task_id:'T-1',mode:'paused',source_message_id:'human:pause',actual_human_verified:true});
  if(protection==='hold')f.control.db.prepare('UPDATE rt_tasks SET contract=? WHERE task_id=?').run(JSON.stringify({...task.contract,execution_hold:'Human hold'}),'T-1');
  if(protection==='excluded')f.driver.config.desktop_loader.excluded_task_ids=['T-1'];
  if(protection==='needs_decision')f.control.db.prepare("UPDATE rt_tasks SET status='needs_decision' WHERE task_id='T-1'").run();
  if(protection==='main')f.driver.config.inbox={thread_id:OWNER,delivery_mode:'on_request'};
  if(['uncertain','running'].includes(protection))f.control.db.prepare('UPDATE rt_wakes SET state=? WHERE task_id=?').run(protection,'T-1');
  assert.equal((await f.driver.loadPendingDesktopChats()).opened,false);assert.equal(calls(),0);assert.equal(f.queue.calls.length,1);
 }finally{await f.close();}
});

test('queue consumption while activity is checked prevents loading and never changes its native turn',async()=>{
 const f=setup();try{
  f.activate();await f.driver.deliver(f.state.task('T-1'));f.advance(30000);const w=f.state.openWake('T-1');
  const calls=enableIdleLoader(f,async()=>{
   f.state.begin({task_id:'T-1',wake_id:w.id,native_proof:nativeProof({workspace:f.root,message:w.prompt,turn:'already-consumed',now:f.now()})});
   return {source:'macos_hid_and_power_assertions',checked_at:f.now(),idle_ms:600000,user_active:false,display_busy:false};
  });
  assert.equal((await f.driver.loadPendingDesktopChats()).opened,false);assert.equal(calls(),0);assert.equal(f.state.openWake('T-1').turn_id,'already-consumed');
 }finally{await f.close();}
});

test('ten-minute input-idle threshold reloads from runtime.json without restarting',async()=>{
 const f=setup();try{
  f.activate();await f.driver.deliver(f.state.task('T-1'));f.advance(30000);const calls=enableIdleLoader(f);
  writeFileSync(join(f.root,'runtime.json'),JSON.stringify({desktop_loader:{...idlePolicy(),min_idle_ms:900000}}));
  assert.equal((await f.driver.loadPendingDesktopChats()).opened,false);assert.equal(calls(),0);
  assert.equal(JSON.parse(f.control.db.prepare("SELECT data FROM rt_diagnostics WHERE key='desktop-activity'").get().data).reason,'user_active_or_idle_unconfirmed');
  f.advance(15000);writeFileSync(join(f.root,'runtime.json'),JSON.stringify({desktop_loader:idlePolicy()}));
  assert.equal((await f.driver.loadPendingDesktopChats()).opened,true);assert.equal(calls(),1);
 }finally{await f.close();}
});

test('idle loader keeps old loader receipts intact and treats open failure as bounded uncertainty',async()=>{
 const f=setup();try{
  f.activate();await f.driver.deliver(f.state.task('T-1'));f.advance(30000);enableIdleLoader(f);
  f.control.db.exec("CREATE TABLE rt_desktop_loads (key TEXT PRIMARY KEY,owner_id TEXT,state TEXT,receipt TEXT,created_at INTEGER); INSERT INTO rt_desktop_loads VALUES ('historical','owner','requested','old receipt',1)");
  let calls=0;f.driver.desktopLoader=new DesktopLoader({bundle_id:'com.openai.codex',now:f.now,read_activity:f.driver.readActivity,run:async()=>{calls++;throw new Error('open result unknown');}});
  assert.equal((await f.driver.loadPendingDesktopChats()).reason,'desktop_open_failed');f.advance(30001);assert.equal((await f.driver.loadPendingDesktopChats()).opened,false);
  assert.equal(calls,1);assert.equal(f.control.db.prepare('SELECT receipt FROM rt_desktop_loads').get().receipt,'old receipt');assert.equal(f.queue.calls.length,1);
 }finally{await f.close();}
});

test('idle loading also activates the existing queued discovery batch without another source message',async()=>{
 const f=setup();let m;try{
  const discovery='55555555-5555-4555-8555-555555555555';
  f.control.discovery.config={...f.control.discovery.config,threads:{...f.control.discovery.config.threads,discovery}};
  f.control.discovery.configure({source_id:'linear',enabled:true,scope:{project:'project'},source_message_id:'human:source',actual_human_verified:true,evidence_ref:'source-grant'});
  m=new Mailbox(join(f.root,'mailbox.sqlite'),{now:f.now});f.control.discovery.enqueueDue(m,f.root);
  const b=m.reserveQueuedInbox(null,'discovery').batch;assert.ok(b);
  m.setPrompt(b.id,'fixed source batch');assert.equal(m.authorizeQueueSend(b.id).send,true);
  m.delivery(b.id,{outcome:'sent',receipt:{queue_receipt:receipt(discovery,'fixed source batch',f.now()),execution_verified:false}});
  f.advance(30000);const calls=enableIdleLoader(f);
  assert.equal((await f.driver.loadPendingDesktopChats()).opened,true);assert.equal(calls(),1);assert.equal(f.queue.calls.length,0);
  assert.equal(m.get(b.id).state,'sent');assert.equal(f.control.discovery.batch(b.snapshot.items[0].payload.batch_id).state,'pending');
  f.advance(300001);m.begin(b.id);
  assert.equal((await f.driver.loadPendingDesktopChats()).opened,false);assert.equal(calls(),1);
 }finally{m?.close();await f.close();}
});

test('disabling idle navigation during the activity read cancels the already selected open',async()=>{
 const f=setup();try{
  f.activate();await f.driver.deliver(f.state.task('T-1'));f.advance(30000);
  writeFileSync(join(f.root,'runtime.json'),JSON.stringify({desktop_loader:idlePolicy()}));
  let reads=0;const calls=enableIdleLoader(f,async()=>{
   if(++reads===2)writeFileSync(join(f.root,'runtime.json'),JSON.stringify({desktop_loader:{...idlePolicy(),enabled:false}}));
   return {source:'macos_hid_and_power_assertions',checked_at:f.now(),idle_ms:600000,user_active:false,display_busy:false};
  });
  assert.equal((await f.driver.loadPendingDesktopChats()).opened,false);assert.equal(calls(),0);assert.equal(f.queue.calls.length,1);
 }finally{await f.close();}
});

test('an owner-reported next action time blocks native queue submission, recovery and idle UI loading',async()=>{
 const f=setup();try{
  f.activate();f.event();await f.driver.deliver(f.state.task('T-1'));const w=f.state.openWake('T-1');
  f.state.begin({task_id:'T-1',wake_id:w.id,native_proof:nativeProof({workspace:f.root,message:w.prompt,now:f.now()})});
  f.decide({wake_id:w.id,disposition:'wait',plan:undefined,next_action_at:new Date(f.now()+172800000).toISOString()});
  f.state.finish({task_id:'T-1',wake_id:w.id,turn_id:'native-turn',evidence_ref:'long-test'});
  const calls=enableIdleLoader(f);f.event('during-long-test',{report:'retained'});f.advance(86400000);
  f.state.expireWaits();await f.driver.deliver(f.state.task('T-1'));assert.equal(f.queue.calls.length,1);assert.equal((await f.driver.loadPendingDesktopChats()).opened,false);assert.equal(calls(),0);
  f.advance(86400000);f.state.expireWaits();await f.driver.deliver(f.state.task('T-1'));assert.equal(f.queue.calls.length,2);assert.ok(f.state.openWake('T-1').event_ids.includes('during-long-test'));
 }finally{await f.close();}
});

test('a blocking dependency PR is polled once without stealing its implementation ownership',async()=>{
 const f=setup();try{
  const task=f.state.task('T-1');f.control.db.prepare('UPDATE rt_tasks SET contract=? WHERE task_id=?').run(JSON.stringify({...task.contract,pull_requests:[]}),'T-1');
  f.state.ingest({task_id:'T-1',event_id:'dependency-before',source:'github',subject:'example/service#1',type:'pr_changed',observed_at:f.now(),payload:{pr:{head_sha:head,state:'open'}},evidence_ref:'dependency-proof',debounce_ms:0});
  f.decide();f.decide({disposition:'wait',plan:undefined,wait:{condition:{kind:'pr_state',pr_key:'example/service#1',fields:['state']},facts:f.state.checkpoint('T-1').facts.map(({subject,version})=>({subject,version})),expires_at:f.now()+1000,resume_condition:'Producer PR merge or close'}});f.activate();
  f.driver.configurePolls();const poll=f.control.db.prepare('SELECT * FROM rt_polls WHERE enabled=1').get();assert.ok(poll);assert.deepEqual(JSON.parse(poll.config).observer_task_ids,['T-1']);
  f.driver.collector=async()=>({pr:{head_sha:head,state:'open'},data:{pr:{head_sha:head,state:'open'}},observed_at:f.now(),evidence_ref:'actual-still-open'});
  await f.driver.poll(poll);f.advance(7200000);f.state.expireWaits();await f.driver.deliver(f.state.task('T-1'));
  assert.equal(f.queue.calls.length,0);assert.equal(f.control.db.prepare('SELECT COUNT(*) n FROM lifecycle_prs').get().n,0);
  f.driver.collector=async()=>({pr:{head_sha:head,state:'merged'},data:{pr:{head_sha:head,state:'merged',merge_sha:'b'.repeat(40)}},observed_at:f.now(),evidence_ref:'actual-merge'});
  await f.driver.poll(f.control.db.prepare('SELECT * FROM rt_polls WHERE enabled=1').get());f.advance(1001);await f.driver.deliver(f.state.task('T-1'));assert.equal(f.queue.calls.length,1);
 }finally{await f.close();}
});

test('legacy typed-source producers publish real completion through the same durable runtime outbox',async()=>{
 const f=setup();let m;try{
  f.driver.config.owner_delivery=true;m=new Mailbox(join(f.root,'mailbox.sqlite'),{now:f.now});
  const observe=state=>m.atomic(()=>m.waits.observe({fact_key:'build',kind:'job',subject:'build-job',data:{job_id:'owned-build',state},
    observed_at:new Date(f.now()).toISOString(),expires_at:new Date(f.now()+60000).toISOString(),evidence_ref:`native-build:${state}`}));
  observe('running');f.event();f.decide();f.state.checkWait=c=>m.waits.check(c);
  f.decide({disposition:'wait',plan:undefined,wait:{condition:{kind:'job',fact_key:'build',subject:'build-job',job_id:'owned-build'},
    facts:f.state.checkpoint('T-1').facts.map(({subject,version})=>({subject,version})),expires_at:f.now()+60000,resume_condition:'Build completed'}});f.activate();
  f.driver.bridgeLegacy();await f.driver.deliver(f.state.task('T-1'));assert.equal(f.queue.calls.length,0);
  f.advance(1000);observe('complete');f.driver.bridgeLegacy();f.driver.bridgeLegacy();await f.driver.deliver(f.state.task('T-1'));assert.equal(f.queue.calls.length,1);
  assert.equal(f.state.checkpoint('T-1').events.filter(e=>e.type==='wait_fact_changed').length,1);
 }finally{m?.close();await f.close();}
});


test('idle loading a finished owner does not suppress its next actual queued cycle',async()=>{
 const f=setup();try{
  f.activate();await f.driver.deliver(f.state.task('T-1'));const first=f.state.openWake('T-1'),calls=enableIdleLoader(f);f.advance(30000);
  assert.equal((await f.driver.loadPendingDesktopChats()).opened,true);
  f.state.begin({task_id:'T-1',wake_id:first.id,native_proof:nativeProof({workspace:f.root,message:first.prompt,now:f.now()})});
  f.decide({wake_id:first.id,disposition:'wait',plan:undefined,next_action_at:new Date(f.now()+1000).toISOString()});f.state.finish({task_id:'T-1',wake_id:first.id,turn_id:'native-turn',evidence_ref:'first-cycle-result'});
  f.advance(30001);f.state.expireWaits();f.event('next-real-event',{review:'new actionable feedback'});await f.driver.deliver(f.state.task('T-1'));const next=f.state.openWake('T-1');
  assert.notEqual(next.id,first.id);f.advance(30001);
  assert.equal((await f.driver.loadPendingDesktopChats()).opened,true);assert.equal(calls(),2);assert.equal(f.queue.calls.length,2);
  assert.equal(f.control.db.prepare('SELECT count(*) n FROM rt_idle_desktop_loads').get().n,2);
 }finally{await f.close();}
});
