import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
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

test('desktop loading never resends a queue message or repeats an uncertain open across restart',async()=>{
  const f=setup();try{
    f.activate();await f.driver.deliver(f.state.task('T-1'));const wake=f.state.openWake('T-1');f.advance(60001);
    f.driver.config.desktop_loader={enabled:true,bundle_id:'com.openai.codex'};
    let opens=0;f.driver.desktopLoader={async open(){opens++;throw new Error('Unknown App open outcome');}};
    await f.driver.loadPendingDesktopChats();await f.driver.loadPendingDesktopChats();
    assert.equal(opens,1);assert.equal(f.queue.calls.length,1);
    assert.equal(f.state.openWake('T-1').queue_id,wake.queue_id);assert.equal(f.state.openWake('T-1').state,'queued');
    assert.equal(f.control.db.prepare('SELECT state FROM rt_desktop_loads').get().state,'uncertain');
    const restarted=new ReactiveDriver({root:f.root,control:f.control,queue:f.queue,config:f.driver.config,capability:{verified:true},now:f.now});
    restarted.desktopLoader=f.driver.desktopLoader;await restarted.loadPendingDesktopChats();assert.equal(opens,1);await restarted.close();
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
