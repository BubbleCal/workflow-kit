import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ControlStore} from './control.mjs';
import {ReactiveDriver} from './reactive-driver.mjs';
import {Mailbox,COORDINATOR,INBOX} from './mailbox.mjs';

const NOW=Date.parse('2026-11-04T06:00:00Z'),head='a'.repeat(40);
function setup() {
  const root=mkdtempSync(join(tmpdir(),'reactive-driver-'));let clock=NOW;
  const control=new ControlStore(join(root,'control.sqlite'),{now:()=>clock,taskRegistry:()=>null}),state=control.reactive;
  state.adopt({task_id:'T-1',owner_thread_id:'owner',source_message_id:'user:migrate',actual_human_verified:true,
    contract:{objective:'Resolve the PR',authorization_ref:'user:task',project_id:'p',workspace:root,canonical_key:'pr-1',constraints:[],job_sources:['native'],
      requirements:[{id:'acceptance',text:'Resolve feedback and verify the change'}],pull_requests:[{repository:'example/service',pr_number:1}]}});
  class FakeAdapter extends EventEmitter {
    constructor(){super();this.sent=[];this.turn='original';this.busy=false;this.throwAfterSend=false;this.found=false;this.status='completed';}
    async observe(){return {thread_id:'owner',project_id:'p',workspace:root,status:this.busy?'active':'idle',turn_id:this.turn,turn_status:this.status,
      queued_input:false,background_job_running:false,approval_pending:false,permissions_preserved:true,checked_at:clock};}
    async start(task,wake,prompt){this.sent.push({task,wake,prompt});if(this.throwAfterSend)throw new Error('Socket closed after write');this.turn='new-turn';this.status='inProgress';this.busy=true;return {turn:{id:this.turn,status:this.status}};}
    async findDelivery(){return this.found?{found:true,turn:{id:this.turn,status:this.status}}:{found:false};}
    async request(){return {data:[{id:this.turn,status:this.status,items:[]}]};}
    close(){}
  }
  const adapter=new FakeAdapter();
  let reviewBody='Please handle the empty input case';
  const collector=async()=>{
    const at=new Date(clock).toISOString();
    const pr={repository:'example/service',pr_number:1,head_sha:head,state:'open',draft:false,updated_at:at,checked_at:at,evidence_ref:'pr-source',
      ci:{head_sha:head,checked_at:at,evidence_ref:'ci-source',complete:true,scope:'observed',checks:[]}};
    const reviews=[{id:10,state:'CHANGES_REQUESTED',body:reviewBody,commit_id:head,user:{login:'reviewer'}}];
    const feedback={repository:'example/service',pr_number:1,head_sha:head,head_before:head,head_after:head,checked_at:at,evidence_ref:'review-source',
      complete:{reviews:true,review_comments:true,issue_comments:true,review_threads:true},reviews,review_comments:[],issue_comments:[],review_threads:[],pr};
    return {pr,feedback,observed_at:clock,data:{head,review:reviewBody},evidence_ref:'review-source'};
  };
  const config={repositories:['example/service'],poll_min_ms:30000,poll_max_ms:300000,owner_check_ms:1000};
  const driver=new ReactiveDriver({root,control,adapter,config,now:()=>clock,collector,log:()=>{}});
  return {root,control,state,adapter,driver,advance:n=>{clock+=n;},setReview:b=>{reviewBody=b;},
    activate:async()=>state.setMode({task_id:'T-1',mode:'active',source_message_id:'user:activate',actual_human_verified:true,legacy_quiescent:true,observation:await adapter.observe()}),
    close:async()=>{await driver.close();control.close();rmSync(root,{recursive:true,force:true});}};
}

test('shadow polling records new facts without waking a model or changing the legacy feedback ledger',async()=>{
  const f=setup();try{
    await f.driver.tick({wait:true});assert.equal(f.state.task('T-1').dirty,true);assert.equal(f.adapter.sent.length,0);
    assert.equal(f.control.feedback.status('example/service',1).snapshot,null);
    assert.equal(f.control.db.prepare('SELECT COUNT(*) AS n FROM actions').get().n,0);
    const before=f.state.task('T-1').context_rev;f.advance(30000);await f.driver.tick({wait:true});
    assert.equal(f.state.task('T-1').context_rev,before);
  }finally{await f.close();}
});

test('active PR feedback goes straight to the original owner with one durable guarded wake',async()=>{
  const f=setup();try{
    await f.activate();await f.driver.tick({wait:true});f.advance(1001);await f.driver.deliver(f.state.task('T-1'));
    assert.equal(f.adapter.sent.length,1);assert.equal(f.adapter.sent[0].task.owner_id,'owner');
    assert.match(f.adapter.sent[0].prompt,/不是新的人类指令/);
    assert.equal(f.control.feedback.status('example/service',1).items[0].review_state,'CHANGES_REQUESTED');
    assert.equal(f.control.lifecycle.inspect('example/service#1').action,'assess_feedback');
    const wake=f.state.openWake('T-1');assert.equal(wake.state,'sent');assert.equal(wake.started_at,null);
    await f.driver.deliver(f.state.task('T-1'));assert.equal(f.adapter.sent.length,1);
    f.state.begin({task_id:'T-1',wake_id:wake.id,owner_thread_id:'owner',turn_id:'new-turn',evidence_ref:'actual analysis'});
    assert.equal(f.state.openWake('T-1').state,'running');
    f.advance(30000);f.setReview('Also preserve null values');await f.driver.tick({wait:true});
    assert.equal(f.state.task('T-1').dirty,true);assert.equal(f.adapter.sent.length,1);
  }finally{await f.close();}
});

test('uncertain delivery holds the original action and never creates a second wake',async()=>{
  const f=setup();try{
    await f.activate();f.adapter.throwAfterSend=true;await f.driver.tick({wait:true});f.advance(1001);await f.driver.deliver(f.state.task('T-1'));
    const first=f.state.openWake('T-1');assert.equal(first.state,'uncertain');
    f.advance(30000);await f.driver.deliver(f.state.task('T-1'));
    assert.equal(f.adapter.sent.length,1);assert.equal(f.state.openWake('T-1').id,first.id);
    assert.equal(f.control.db.prepare('SELECT state FROM actions WHERE action_key=?').get(first.id).state,'uncertain');
  }finally{await f.close();}
});

test('collector failure keeps last known evidence and backs off without inventing an empty review',async()=>{
  const f=setup();try{
    await f.driver.tick({wait:true});const before=f.state.checkpoint('T-1').facts;
    f.advance(30000);f.driver.collector=async()=>{throw new Error('GitHub unavailable');};await f.driver.tick({wait:true});
    assert.deepEqual(f.state.checkpoint('T-1').facts,before);
    const poll=f.control.db.prepare('SELECT * FROM rt_polls').get();assert.equal(poll.failures,1);assert.match(poll.last_error,/unavailable/);
    assert.equal(f.adapter.sent.length,0);
  }finally{await f.close();}
});

test('a terminal owner result is reconciled without claiming completion or replaying its actions',async()=>{
  const f=setup();try{
    await f.activate();await f.driver.tick({wait:true});f.advance(1001);await f.driver.deliver(f.state.task('T-1'));
    const old=f.state.openWake('T-1');f.adapter.busy=false;f.adapter.status='completed';
    await f.driver.deliver(f.state.task('T-1'));
    assert.equal(f.state.openWake('T-1'),null);assert.notEqual(f.state.task('T-1').status,'complete');
    assert.ok(f.state.checkpoint('T-1').events.some(e=>e.type==='owner_ended'));
    assert.equal(f.control.db.prepare('SELECT state FROM rt_wakes WHERE id=?').get(old.id).state,'ended_unresolved');
    assert.equal(f.control.db.prepare('SELECT state FROM actions WHERE action_key=?').get(old.id).state,'sent');
  }finally{await f.close();}
});

test('legacy source transfer is restart-idempotent and active tasks cannot enter legacy batches',async()=>{
  const f=setup();let m;try{
    await f.activate();m=new Mailbox(join(f.root,'mailbox.sqlite'),{now:()=>NOW});
    m.enqueue({key:'old-result',lane:'coordinator',kind:'worker_result',payload:{task_id:'T-1',owner_thread_id:'owner',evidence_ref:'actual-result'}});
    if(COORDINATOR) {
      const selected=m.reserve('coordinator',{checked_at:new Date(NOW).toISOString(),thread:{id:COORDINATOR,status:{type:'idle'}},latestTurn:{id:'old',status:'completed'}});
      assert.equal(selected.reserved,false);
    }
    f.driver.bridgeLegacy();f.driver.bridgeLegacy();
    assert.equal(m.db.prepare('SELECT state FROM mail WHERE item_key=?').get('old-result').state,'reactive');
    assert.equal(f.state.checkpoint('T-1').events.filter(e=>e.source==='legacy_mailbox').length,1);
  }finally{m?.close();await f.close();}
});

test('native requested review can justify waiting without Slack, but new unassessed feedback cannot',async()=>{
  const f=setup();try{
    await f.activate();f.driver.configurePolls();await f.driver.poll(f.control.db.prepare('SELECT * FROM rt_polls').get());
    const condition={kind:'review_request',pr_key:'example/service#1',head,reviewer:'reviewer',next_check_at:new Date(NOW+60000).toISOString()};
    const snapshot=JSON.parse(f.control.db.prepare('SELECT snapshot FROM lifecycle_prs').get().snapshot);
    f.control.lifecycle.observe({...snapshot,requested_reviewers:['reviewer']},{feedbackCollected:true});
    assert.equal(f.control.checkReactiveWait(condition).valid,false);
    const item=f.control.feedback.status('example/service',1).items[0];
    f.control.feedback.assess({repository:'example/service',pr_number:1,head,decisions:[{key:item.key,digest:item.digest,
      disposition:'addressed',reason:'The current code already covers this case',current_code_relevance_verified:true,evidence_ref:'actual-code',validation_ref:'actual-regression-test'}]});
    assert.equal(f.control.checkReactiveWait(condition).valid,true);
    f.advance(1000);f.setReview('A different unhandled issue');await f.driver.poll(f.control.db.prepare('SELECT * FROM rt_polls').get());
    assert.equal(f.control.checkReactiveWait(condition).valid,false);
    const older={...snapshot,checked_at:new Date(NOW-1000).toISOString()};
    assert.throws(()=>f.control.feedback.ingest({repository:'example/service',pr_number:1,head_sha:head,head_before:head,head_after:head,
      checked_at:older.checked_at,evidence_ref:'old-snapshot',complete:{reviews:true,review_comments:true,issue_comments:true,review_threads:true},
      reviews:[],review_comments:[],issue_comments:[],review_threads:[]}),/Out-of-order/);
  }finally{await f.close();}
});

test('returning to legacy persists a handoff before the old driver resumes',async()=>{
  const f=setup();let m;try{
    await f.activate();
    f.state.setMode({task_id:'T-1',mode:'legacy',source_message_id:'user:return',actual_human_verified:true,legacy_quiescent:true,observation:await f.adapter.observe()});
    assert.equal(f.state.status().pending_handoffs.length,1);
    f.driver.bridgeLegacy();f.driver.bridgeLegacy();
    assert.equal(f.state.status().pending_handoffs.length,0);
    m=new Mailbox(join(f.root,'mailbox.sqlite'));
    assert.equal(m.db.prepare("SELECT COUNT(*) AS n FROM mail WHERE json_extract(payload,'$.event')='reactive_handoff'").get().n,1);
  }finally{m?.close();await f.close();}
});

test('native result notifications are durable and duplicates cannot create a self-wake loop',async()=>{
  const f=setup();try{
    await f.activate();
    const event={method:'turn/completed',params:{threadId:'owner',turn:{id:'manual-turn',status:'completed',items:[]}}};
    f.adapter.emit('notification',event);f.adapter.emit('notification',event);
    assert.equal(f.state.checkpoint('T-1').events.filter(e=>e.source==='native_turn').length,1);
    f.control.db.prepare("INSERT INTO rt_wakes(id,task_id,context_rev,plan_rev,event_ids,state,turn_id,created_at) VALUES ('finished','T-1',1,0,'[]','finished','our-finished-turn',?)").run(NOW);
    f.adapter.emit('notification',{method:'turn/completed',params:{threadId:'owner',turn:{id:'our-finished-turn',status:'completed'}}});
    assert.equal(f.state.checkpoint('T-1').events.filter(e=>e.source==='native_turn').length,1);
    f.adapter.emit('serverRequest',{id:'approval-1',method:'item/commandExecution/requestApproval',params:{threadId:'owner'}});
    assert.equal(f.state.status().diagnostics.find(d=>d.key==='native-request:approval-1').data.requires_native_user_action,true);
  }finally{await f.close();}
});

test('task wake claims bind the exact stored prompt and new evidence fences prepared wakeups',async()=>{
  const f=setup();try{
    await f.activate();const o=await f.adapter.observe(),wake=f.state.reserveWake('T-1',o).wake;
    f.control.db.prepare('UPDATE rt_wakes SET prompt=? WHERE id=?').run('Recorded event prompt',wake.id);
    const action={key:wake.id,kind:'task_wake',task_id:'T-1',payload:{thread_id:'owner',wake_id:wake.id,starts_heavy_work:false,prompt:'Changed prompt'},evidence:f.driver.evidence(f.state.task('T-1'),o)};
    assert.equal(f.control.prepare(action).allowed,false);
    action.payload.prompt='Recorded event prompt';assert.equal(f.control.prepare(action).prepared,true);
    f.state.ingest({event_id:'changed-before-claim',task_id:'T-1',source:'github',subject:'repo#1',type:'pr_changed',observed_at:NOW,payload:{review:'changes_requested'},evidence_ref:'new-review',debounce_ms:0});
    assert.equal(f.control.claim({key:wake.id,owner:'runtime',evidence:action.evidence}).claimed,false);
    assert.equal(f.adapter.sent.length,0);
  }finally{await f.close();}
});

test('important inbox delivery uses the existing receipt path immediately and preserves busy-user input',async()=>{
  const f=setup();let m;try{
    await f.activate();m=new Mailbox(join(f.root,'mailbox.sqlite'),{now:()=>NOW});
    m.enqueue({key:'answer-1',lane:'inbox',kind:'answer',payload:{task_id:'T-1',text:'The result is ready.'}});
    f.driver.config.inbox={thread_id:INBOX,project_id:'p',workspace:f.root};
    let queued=true;
    f.adapter.observe=async task=>({thread_id:task.owner_id,project_id:'p',workspace:f.root,status:'idle',turn_id:'inbox-old',turn_status:'completed',
      queued_input:queued,background_job_running:false,approval_pending:false,permissions_preserved:true,checked_at:NOW,
      native_thread_snapshot:{thread:{id:INBOX,status:{type:'idle'}},latestTurn:{id:'inbox-old',status:'completed'},checked_at:new Date(NOW).toISOString()}});
    await f.driver.deliverInbox();assert.equal(f.adapter.sent.length,0);
    queued=false;await f.driver.deliverInbox();await f.driver.deliverInbox();
    assert.equal(f.adapter.sent.length,1);assert.match(f.adapter.sent[0].prompt,/The result is ready/);
    assert.equal(m.db.prepare("SELECT state FROM batches WHERE lane='inbox'").get().state,'sent');
    assert.equal(m.db.prepare("SELECT state FROM mail WHERE item_key='answer-1'").get().state,'in_batch');
  }finally{m?.close();await f.close();}
});

test('native job disappearance invalidates its wait without pretending the job passed',async()=>{
  const f=setup();try{
    f.state.ingest({event_id:'job-start',task_id:'T-1',source:'native',subject:'job-1',type:'job_state',observed_at:NOW,payload:{state:'running'},evidence_ref:'actual-job'});
    f.state.checkWait=()=>({valid:true});
    f.state.decide({task_id:'T-1',owner_thread_id:'owner',expected_context_rev:1,expected_plan_rev:0,disposition:'wait',reason:'Wait for the real background job',evidence_refs:['actual-job'],
      wait:{facts:f.state.checkpoint('T-1').facts.map(({subject,version})=>({subject,version})),expires_at:NOW+60000,resume_condition:'Read the exit result',condition:{kind:'job',job_id:'job-1',native_thread_id:'owner'}}});
    await f.activate();await f.driver.checkNativeWait(f.state.task('T-1'));
    assert.equal(f.state.checkpoint('T-1').wait.state,'invalidated');
    const event=f.state.checkpoint('T-1').events.find(e=>e.type==='job_recheck');assert.equal(event.payload.completion_verified,false);
    assert.notEqual(f.state.task('T-1').status,'complete');
  }finally{await f.close();}
});

test('the upstream immediate human trigger remains available for legacy tasks but does not add a relay for active tasks',async()=>{
  const f=setup();let m;try{
    await f.activate();
    m=new Mailbox(join(f.root,'mailbox.sqlite'),{now:()=>NOW,taskRegistry:()=>({queue_transport:{dispatcher_thread_id:'dispatcher',immediate_human_trigger:{enabled:true,source_message_id:'user:rule'}}})});
    const enqueue=(key,taskId)=>m.enqueue({key,lane:'coordinator',kind:'human_command',payload:{task_id:taskId,source_message_id:key,source_thread_id:'inbox',text:'Continue the task',authorization_ref:key},
      human_trigger:{actual_human_message_verified:true,source_actor_verified:true,source_message_id:key}});
    assert.equal(enqueue('active-human','T-1').immediate_trigger,undefined);
    assert.equal(enqueue('legacy-human','T-2').immediate_trigger.length,1);
    assert.equal(m.immediate.status().length,1);
  }finally{m?.close();await f.close();}
});
