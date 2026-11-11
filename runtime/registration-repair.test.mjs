import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,nativeProof,OWNER,QUEUE_ID} from './test-fixtures/reactive.mjs';
import {reconcileArtifactBinding} from './registration-repair.mjs';
import {reconcileQueuedFollowup,recordedReviewResolvesDecision,verifyFollowupTerminal} from './human-followup.mjs';
import {reviewDecisionTaskReasons} from './review-decision.mjs';
import {MessageTrigger} from './message-trigger.mjs';

function artifact(){
 const f=fixture();f.c.work.config.scope={...f.c.work.config.scope,project_id:'project',repositories:['example/service']};
 const t=f.c.work.create({id:'T-1',canonical_key:'query-work',title:'Original work',objective:f.s.task('T-1').contract.objective,requirements:f.s.task('T-1').contract.requirements,workspace:'/task',source:{kind:'user'}}).task;
 f.c.work.accept({task_id:t.id,source_message_id:'human:original',actual_human_verified:true,evidence_ref:'human:original'});
 f.c.work.bindOwner({task_id:t.id,owner_thread_id:OWNER,native_binding:nativeProof({status:'completed',now:f.now()}),evidence_ref:'original-native',existing_owner_authorized:true,actual_human_verified:true,source_message_id:'human:owner'});
 f.activate();f.event();const wake=f.begin();
 f.c.lifecycle.track({repository:'example/service',pr_number:9,task_id:'T-1',owner_thread_id:OWNER,authorization_ref:'original-artifact-authority'});
 const input={task_id:'T-1',repository:'example/service',pr_number:9,owner_thread_id:OWNER,expected_contract_rev:1,expected_revision:1,source_message_id:'human:repair',actual_human_verified:true,evidence_ref:'actual-repair-authority',native_proof:nativeProof({message:wake.prompt,now:f.now()})};
 // Binding itself does not change catalog revision.
 input.expected_revision=f.c.work.get('T-1').revision;
 return {...f,wake,input};
}

test('existing original lifecycle PR is registered without changing the goal, owner, holds or approval',()=>{
 const f=artifact();try{const before=f.s.task('T-1'),oldCatalog=f.c.work.get('T-1');
  const url='https://github.com/example/service/pull/9',head='a'.repeat(40),payload={pr_url:url,expected_head_sha:head},key=`review-decision:${url}:${head}`;
  assert.deepEqual(reviewDecisionTaskReasons(f.c,'review_decision','T-1',payload,{executor_thread_id:OWNER},OWNER,key),['review_decision_PR_not_bound_to_task']);
  const result=reconcileArtifactBinding(f.c,f.input);assert(result.reconciled);assert.equal(result.delivery_authorized,false);
  assert.deepEqual(reviewDecisionTaskReasons(f.c,'review_decision','T-1',payload,{executor_thread_id:OWNER},OWNER,key),[]);
  assert.deepEqual(f.s.task('T-1').contract,{...before.contract,pull_requests:[{repository:'example/service',pr_number:9}]});
  assert.equal(f.s.task('T-1').owner_id,OWNER);assert.deepEqual(f.c.work.get('T-1').authorization,oldCatalog.authorization);
  assert.equal(reconcileArtifactBinding(f.c,f.input).already_bound,true);assert.equal(f.s.task('T-1').contract_rev,2);
  assert.equal(f.c.db.prepare('SELECT COUNT(*) n FROM rt_events WHERE type=?').get('artifact_binding_reconciled').n,1);
 }finally{f.c.close();}
});

test('artifact registration rejects a foreign owner, unknown PR, stale revision/proof, service or uncertain effects',()=>{
 const changes=[f=>{f.input.owner_thread_id='another-owner';},f=>{f.input.pr_number=10;},f=>{f.input.expected_contract_rev=8;},f=>{f.input.actual_human_verified=false;},f=>{f.advance(61000);},f=>{f.input.native_proof=nativeProof({workspace:'/wrong',now:f.now()});},f=>{f.c.db.prepare("INSERT INTO actions(action_key,kind,task_id,scope_key,digest,payload,state,due,created_at,updated_at) VALUES ('unknown','merge','T-1','scope','digest','{}','uncertain',0,0,0)").run();}];
 for(const change of changes){const f=artifact();try{change(f);assert.throws(()=>reconcileArtifactBinding(f.c,f.input));assert.equal(f.s.task('T-1').contract_rev,1);}finally{f.c.close();}}
});

function followup(status='inProgress'){
 const f=fixture();f.activate();f.event();const w=f.s.reserveQueuedWake('T-1').wake;
 f.c.db.prepare("UPDATE rt_wakes SET state='queued',queue_id=?,prompt='old deployment' WHERE id=?").run(QUEUE_ID,w.id);
 const key='actual-human-followup',p={intent:'correction',thread_id:OWNER,source_message_id:'human:new-scope',source_thread_id:'main',source_turn_id:'human-turn',verbatim_text:'Continue the remaining work; do not repeat deployment',prompt:'Authorized current work, retaining the original writer'};
 const receipt={outcome:'sent',native_result:{structuredContent:{threadId:OWNER},isError:false}};
 f.c.db.prepare("INSERT INTO actions(action_key,kind,task_id,scope_key,digest,payload,state,owner,receipt,due,created_at,updated_at) VALUES (?,'human_input','T-1','scope','digest',?,'sent','main',?,0,?,?)").run(key,JSON.stringify(p),JSON.stringify(receipt),f.now(),f.now());
 const proof=nativeProof({turn:'new-native-turn',now:f.now(),status}),read=proof.readback;
 read.turns[0].items=[{type:'functionCallOutput',namespace:'codex_app',name:'send_message_to_thread',output:{truncated:false,text:`<codex_delegation>\n  <source_thread_id>main</source_thread_id>\n  <input>${p.prompt}</input>\n</codex_delegation>`}}];
 const human=nativeProof({thread:'main',message:p.verbatim_text,turn:p.source_turn_id,now:f.now()});human.readback.turns[0].items[0].id=p.source_message_id;
 return {...f,w,key,input:{task_id:'T-1',expected_context_rev:f.s.task('T-1').context_rev,expected_wake_id:w.id,expected_queue_id:QUEUE_ID,action_key:key,source_message_id:p.source_message_id,evidence_ref:'actual-repair',actual_human_verified:true,native_proof:proof,human_authorization:human}};
}

test('a recorded exact-PR review grant answers only its matching delivery decision',()=>{
 const pr='https://github.com/example/service/pull/9',head='a'.repeat(40),source={source_thread_id:'main',source_turn_id:'turn',source_message_id:'human',verbatim_text:'t1送审'};
 const task={task_id:'T-1',contract:{pull_requests:[{repository:'example/service',pr_number:9}]}};
 const decision={created_at:1,data:{decision_request:{kind:'authority',scope:'task',blocked_requirements:['delivery']},progress:{dependencies:[{kind:'human',pr_url:pr,head_sha:head}]}}};
 const grant={...source,task_id:'T-1',pr_url:pr,head_sha:head,record_protocol:'native_pr_authorization_v1',decision:'allow_external_review',reviewed_personally:true,explicit_external_review_permission_verified:true,scope_verified:true,actual_human_verified:true,source_actor_verified:true,recorded_by_thread_id:'fixture-inbox',evidence_ref:'native-human',source_at:new Date(2).toISOString()};
 const policy={personal_review:{authorizations:[grant]}};
 assert.equal(recordedReviewResolvesDecision(task,decision,source,policy),true);
 for(const patch of [{revoked:true},{head_sha:'b'.repeat(40)},{pr_url:pr+'0'},{task_id:'T-2'},{source_message_id:'other'},{source_at:new Date(0).toISOString()},{reviewed_personally:false},{record_protocol:'notification'}])
  assert.equal(recordedReviewResolvesDecision(task,decision,source,{personal_review:{authorizations:[{...grant,...patch}]}}),false);
 assert.equal(recordedReviewResolvesDecision(task,decision,source,{}),false);
 const unrelated=structuredClone(decision);unrelated.data.decision_request.blocked_requirements.push('implementation');assert.equal(recordedReviewResolvesDecision(task,unrelated,source,policy),false);
 const multiple=structuredClone(decision);multiple.data.progress.dependencies.push({kind:'human',pr_url:pr+'0',head_sha:head});assert.equal(recordedReviewResolvesDecision(task,multiple,source,policy),false);
});

test('sent real human followup supersedes execution without claiming the old queue was consumed or replaying deployment',()=>{
 const f=followup();try{const contract=f.s.task('T-1').contract,old=f.c.db.prepare('SELECT * FROM rt_wakes WHERE id=?').get(f.w.id);
  const r=reconcileQueuedFollowup(f.c,f.input);assert.equal(r.state,'running');assert.equal(r.original_queue_consumed,false);
  const retired=f.c.db.prepare('SELECT * FROM rt_wakes WHERE id=?').get(f.w.id);assert.equal(retired.state,'superseded');assert.equal(retired.queue_id,old.queue_id);assert.equal(retired.turn_id,null);assert.equal(retired.started_at,null);assert.equal(retired.prompt,'old deployment');
  assert.deepEqual(f.s.task('T-1').contract,contract);assert.equal(f.s.openWake('T-1').turn_id,'new-native-turn');
  assert.equal(f.s.begin({task_id:'T-1',wake_id:f.w.id,native_proof:f.input.native_proof}).reason,'superseded_by_verified_followup');
  assert.equal(f.s.begin({task_id:'T-1',wake_id:r.wake_id,native_proof:f.input.native_proof}).wake.id,r.wake_id);
  assert(reconcileQueuedFollowup(f.c,f.input).already_reconciled);assert.equal(f.c.db.prepare('SELECT COUNT(*) n FROM rt_wakes').get().n,2);
 }finally{f.c.close();}
});

test('only a newer verified task-specific human continuation resolves a stale decision projection, without releasing external holds',()=>{
 for(const variant of ['valid','wrong-decision','older-source','wrong-task','status-only','paused']){
  const f=followup();try{
   f.c.work.setPolicy({key:'continuous_authorized_work',enabled:true,allowed_kinds:['work'],actual_human_verified:true,source_message_id:'human:continuous',verbatim_text:'Continue authorized work without routine pause questions',evidence_ref:'actual-rule'});
   f.c.db.prepare("INSERT INTO rt_decisions VALUES ('old-decision','T-1',0,0,'needs_decision','{}',?)").run(f.now()-1);
   f.c.db.prepare("UPDATE rt_tasks SET status='needs_decision' WHERE task_id='T-1'").run();
   const action=f.c.db.prepare('SELECT payload FROM actions WHERE action_key=?').get(f.key),p=JSON.parse(action.payload);p.verbatim_text=variant==='wrong-task'?'Continue T-2 optimization':'Continue T-1 optimization; personal external review hold remains';if(variant==='status-only')p.verbatim_text='What is the status of T-1?';p.prompt='Continue T-1 accepted engineering scope; do not perform held external delivery';
   f.c.db.prepare('UPDATE actions SET payload=? WHERE action_key=?').run(JSON.stringify(p),f.key);
   f.input.native_proof.readback.turns[0].items[0].output.text=`<codex_delegation>\n  <source_thread_id>main</source_thread_id>\n  <input>${p.prompt}</input>\n</codex_delegation>`;
   f.input.human_authorization.readback.turns[0].items[0].content[0].text=p.verbatim_text;
   f.input.resume_authorized_work=true;f.input.expected_decision_id=variant==='wrong-decision'?'another-decision':'old-decision';
   if(variant==='older-source')f.c.db.prepare('UPDATE actions SET created_at=? WHERE action_key=?').run(f.now()-2,f.key);
   if(variant==='paused')f.c.db.prepare("UPDATE rt_tasks SET mode='paused' WHERE task_id='T-1'").run();
   const contract=f.s.task('T-1').contract;
   if(variant!=='valid'){assert.throws(()=>reconcileQueuedFollowup(f.c,f.input));assert.equal(f.s.task('T-1').status,'needs_decision');continue;}
   const result=reconcileQueuedFollowup(f.c,f.input);assert.equal(result.state,'running');assert.equal(result.original_queue_consumed,false);assert.equal(f.s.task('T-1').status,'ready');assert.deepEqual(f.s.task('T-1').contract,contract);
   const binding=JSON.parse(f.c.db.prepare('SELECT data FROM rt_diagnostics WHERE key=?').get(`followup-binding:${result.wake_id}`).data);assert.equal(binding.decision_resolution.scope,'authorized_remaining_work_only');
  }finally{f.c.close();}
 }
});

test('a completed followup leaves truthful ended-unresolved evidence and allows one normal continuation',()=>{
 const f=followup('completed');try{const r=reconcileQueuedFollowup(f.c,f.input);assert.equal(r.state,'ended_unresolved');assert.equal(f.s.openWake('T-1'),null);assert.equal(f.s.reserveQueuedWake('T-1').reserved,true);}finally{f.c.close();}
});

test('queued followup reconciliation rejects mismatched or truncated native evidence, stale scope, unknown effects and a different writer',()=>{
 for(const mutate of[f=>{f.input.expected_queue_id='other';},f=>{f.input.expected_context_rev++;},f=>{f.input.source_message_id='other-human';},f=>{f.input.native_proof.readback.turns[0].items[0].output.truncated=true;},f=>{f.input.native_proof.readback.thread.id='other-owner';},f=>{f.advance(61000);},f=>{f.c.db.prepare("UPDATE actions SET state='uncertain' WHERE action_key=?").run(f.key);}]){
  const f=followup();try{mutate(f);assert.throws(()=>reconcileQueuedFollowup(f.c,f.input));assert.equal(f.c.db.prepare('SELECT state FROM rt_wakes WHERE id=?').get(f.w.id).state,'queued');}finally{f.c.close();}
 }
});

test('a verified human relay without an old queue can register the ongoing original-owner execution and report normally',()=>{
 const f=followup();try{
  f.c.db.prepare("UPDATE rt_wakes SET state='finished' WHERE id=?").run(f.w.id);f.input.expected_wake_id=null;f.input.expected_queue_id=null;
  const result=reconcileQueuedFollowup(f.c,f.input);assert.equal(result.old_wake_state,null);assert.equal(result.state,'running');assert.equal(result.queue_id,null);
  assert.equal(f.s.openWake('T-1').turn_id,'new-native-turn');assert.equal(f.c.db.prepare('SELECT state FROM rt_wakes WHERE id=?').get(f.w.id).state,'finished');
 }finally{f.c.close();}
});

test('a relay-bound accepted original owner can submit its result through the unchanged report guard',()=>{
 const f=followup();try{
  f.c.work.config.scope={...f.c.work.config.scope,project_id:'project'};
  f.c.work.create({id:'T-1',canonical_key:'query-work',title:'Accepted work',objective:'Report the original scope',requirements:[{id:'report',text:'Evidence'}],workspace:'/task'});
  f.c.work.accept({task_id:'T-1',source_message_id:'human:original',actual_human_verified:true,evidence_ref:'actual-scope'});
  f.c.work.bindOwner({task_id:'T-1',owner_thread_id:OWNER,native_binding:nativeProof({status:'completed',now:f.now()}),evidence_ref:'actual-owner',source_message_id:'human:owner',existing_owner_authorized:true,actual_human_verified:true});
  const report={task_id:'T-1',owner_thread_id:OWNER,report_key:'existing-result',outcome:'no_actionable_findings',summary:'Actual bounded result',evidence_refs:['existing-evidence']};
  assert.throws(()=>f.c.work.recordReport(report),/actual ordinary task execution/);
  reconcileQueuedFollowup(f.c,f.input);assert.equal(f.c.work.recordReport(report).recorded,true);
  assert.equal(f.c.work.recordReport(report).duplicate,true);
 }finally{f.c.close();}
});

test('projection-only binding observes an already-active authorized correction without clearing a decision or touching the task',()=>{
 for(const variant of ['valid','ended','wrong-decision','old-instruction','paused']){const f=followup(variant==='ended'?'completed':'inProgress');try{
  f.c.work.setPolicy({key:'continuous_authorized_work',enabled:true,allowed_kinds:['work'],actual_human_verified:true,source_message_id:'human:continuous',verbatim_text:'Continue authorized work without routine pause questions',evidence_ref:'actual-rule'});
  f.c.db.prepare("UPDATE rt_wakes SET state='finished' WHERE id=?").run(f.w.id);
  f.c.db.prepare("INSERT INTO rt_decisions VALUES ('old-decision','T-1',0,0,'needs_decision','{}',?)").run(f.now()-1);
  f.c.db.prepare("UPDATE rt_tasks SET status='needs_decision' WHERE task_id='T-1'").run();
  Object.assign(f.input,{projection_only:true,expected_wake_id:null,expected_queue_id:null,expected_decision_id:variant==='wrong-decision'?'wrong':'old-decision'});
  if(variant==='old-instruction')f.c.db.prepare('UPDATE actions SET created_at=? WHERE action_key=?').run(f.now()-2,f.key);if(variant==='paused')f.mode('paused');
  const before=f.s.task('T-1');if(variant!=='valid'){assert.throws(()=>reconcileQueuedFollowup(f.c,f.input));assert.deepEqual(f.s.task('T-1'),before);continue;}
  const result=reconcileQueuedFollowup(f.c,f.input);assert(result.projection_only);assert.equal(result.decision_preserved,'old-decision');assert.deepEqual(f.s.task('T-1'),before);assert.equal(f.s.openWake('T-1').turn_id,'new-native-turn');assert.equal(f.s.openWake('T-1').state,'running');assert(reconcileQueuedFollowup(f.c,f.input).already_reconciled);
 }finally{f.c.close();}}
});

test('a genuine manual followup supersedes only an unclaimed unsent trigger without manufacturing a queue receipt',()=>{
 for(const variant of ['pending','claimed','sent','uncertain']){const f=followup();try{
  f.c.db.prepare("UPDATE rt_wakes SET state='reserved',queue_id=NULL WHERE id=?").run(f.w.id);
  const q=new MessageTrigger(f.c,{message_trigger:{enabled:true,thread_id:'44444444-4444-4444-8444-444444444444',workspace:'/trigger',interval_ms:60000,authorization_ref:'human:trigger',source_message_id:'human:trigger'}});
  q.registerTask(f.s.task('T-1'),f.s.openWake('T-1'),'old deployment');f.input.expected_queue_id=null;
  if(variant!=='pending')f.c.db.prepare('UPDATE rt_trigger_messages SET state=?,attempt_id=? WHERE id=?').run(variant,'old-attempt',f.w.id);
  if(variant==='pending'){
   const result=reconcileQueuedFollowup(f.c,f.input);assert.equal(result.state,'running');assert.equal(result.original_queue_consumed,false);assert.equal(f.s.openWake('T-1').turn_id,'new-native-turn');
   assert.equal(f.c.db.prepare('SELECT state FROM rt_trigger_messages WHERE id=?').get(f.w.id).state,'cancelled');assert.equal(f.c.db.prepare('SELECT queue_id FROM rt_wakes WHERE id=?').get(f.w.id).queue_id,null);
  }else{assert.throws(()=>reconcileQueuedFollowup(f.c,f.input));assert.equal(f.c.db.prepare('SELECT state FROM rt_trigger_messages WHERE id=?').get(f.w.id).state,variant);}
 }finally{f.c.close();}}
});


test('terminal manual-followup proof reconciles the exact failed bound turn including native systemError',()=>{
 for(const variant of ['valid','active','wrong-turn','truncated','unknown-action']){const f=followup();try{
  const bound=reconcileQueuedFollowup(f.c,f.input),proof=structuredClone(f.input.native_proof);
  proof.readback.thread.status.type='systemError';proof.readback.turns[0].status='failed';proof.readback.turns[0].error={message:'Codex: Bad Request'};
  if(variant==='active'){proof.readback.thread.status.type='active';proof.readback.turns[0].status='inProgress';proof.readback.turns[0].error=null;}
  if(variant==='wrong-turn')proof.readback.turns[0].id='another-real-turn';
  if(variant==='truncated')proof.readback.turns[0].items[0].output.truncated=true;
  if(variant==='unknown-action')f.c.db.prepare("UPDATE actions SET state='uncertain' WHERE action_key=?").run(f.key);
  if(variant==='valid'){const result=verifyFollowupTerminal(f.c,f.s.task('T-1'),f.s.openWake('T-1'),proof);assert.equal(result.status,'failed');assert.equal(result.original_queue_consumed,false);}
  else assert.throws(()=>verifyFollowupTerminal(f.c,f.s.task('T-1'),f.s.openWake('T-1'),proof));
  assert.equal(f.s.openWake('T-1').id,bound.wake_id);assert.equal(f.s.openWake('T-1').state,'running');
 }finally{f.c.close();}}
});
