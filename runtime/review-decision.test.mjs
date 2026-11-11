import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,NOW} from './test-fixtures/reactive.mjs';
import {passedReviewGates} from './test-fixtures/pr-review.mjs';
import {INBOX,CHANNEL} from './control.mjs';

const url='https://github.com/example/service/pull/1',head='a'.repeat(40);
function setup(){
  const f=fixture(),task=f.s.task('T-1');
  f.s.amend({task_id:'T-1',expected_contract_rev:task.contract_rev,contract:{...task.contract,pull_requests:[{repository:'example/service',pr_number:1}]},source_message_id:'human:bind-pr',actual_human_verified:true});
  f.activate();const wake=f.begin(),decision=f.decide({wake_id:wake.id});
  const route={scope:'lancedb_functions',channel_id:'CFUNCTIONS',delivery_hold:{active:true,source_message_id:'human:hold',evidence_ref:'hold'},
    decision_delivery:{enabled:true,mode:'owner_to_main',thread_id:INBOX,source_message_id:'human:decide-here',evidence_ref:'human-instruction'}};
  f.c.reviewChannels=()=>({schema_version:1,source_message_id:'human:route',default_channel_id:CHANNEL,routes:[route]});
  const evidence={...passedReviewGates(NOW,head,url),verified_at:new Date(NOW).toISOString(),scope_authorized:true,
    authorization_ref:'human:decide-here',policy_version:'v1',current_policy_version:'v1',stopped:false,executor_thread_id:OWNER,
    pr_owner:'test-author',pr_open:true,pr_draft:false,ordinary_change:true,material_findings_open:false,validation_current:true,
    technical_review_current:true,current_head_sha:head,pr_url:url,already_notified:false,
    review_routing:{scope:'lancedb_functions',verified:true,pr_url:url,head_sha:head,evidence_ref:'actual-feature-scope'}};
  f.c.feedback.ingest({repository:'example/service',pr_number:1,head_sha:head,head_before:head,head_after:head,checked_at:evidence.verified_at,
    evidence_ref:'feedback',complete:{reviews:true,review_comments:true,issue_comments:true,review_threads:true},reviews:[],review_comments:[],issue_comments:[],review_threads:[]});
  const action={key:`review-decision:${url}:${head}`,kind:'review_decision',task_id:'T-1',
    payload:{thread_id:INBOX,source_message_id:'human:decide-here',pr_url:url,message:url,expected_head_sha:head,
      runtime_context:decision.action_context,prompt:`T-1: Ready for your decision. ${url}`},evidence};
  return {...f,route,action,evidence};
}

test('ready Functions decisions reach only the main chat with one guarded receipt while Slack stays held',()=>{
  const f=setup();try{
    assert.equal(f.c.prepare({...f.action,evidence:{...f.evidence,ordinary_change:false}}).prepared,true);
    assert.equal(f.c.claim({key:f.action.key,owner:'wrong-owner',evidence:f.evidence}).claimed,false);
    const claim=f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence});assert.equal(claim.claimed,true);
    const send=()=>f.c.authorizeReviewSend({key:f.action.key,attempt_id:claim.attempt_id,owner:OWNER,evidence:f.evidence,operation_not_started:true});
    f.route.decision_delivery.enabled=false;assert.equal(send().send,false);
    f.route.decision_delivery.enabled=true;
    const permit=send();assert.equal(permit.send,true);assert.deepEqual(permit.native_arguments,{threadId:INBOX,prompt:f.action.payload.prompt});
    assert.equal(send().send,false);
    f.c.settle({key:f.action.key,attempt_id:claim.attempt_id,outcome:'sent',evidence_ref:'native-readback'});
    assert.equal(f.c.prepare(f.action).prepared,false);
    const slack={...f.action,key:'slack-held',kind:'slack_pr',payload:{...f.action.payload,channel_id:'CFUNCTIONS'},evidence:{...f.evidence,already_announced:false}};
    assert.ok(f.c.prepare(slack).reasons.includes('review_delivery_paused_by_user'));
  }finally{f.c.close();}
});

test('decision routing preserves scope, readiness, actual owner and current feedback gates',()=>{
  const f=setup();try{
    for(const patch of [{thread_id:'another-chat'},{source_message_id:'another-instruction'},{prompt:'Routine progress without a PR'}])
      assert.equal(f.c.prepare({...f.action,payload:{...f.action.payload,...patch}}).prepared,false);
    for(const patch of [{executor_thread_id:'another-owner'},{already_notified:true},{pr_draft:true},
      {review_routing:{...f.evidence.review_routing,scope:'default'}},{validation_current:false},
      {applicable_ci:{...f.evidence.applicable_ci,complete:false}},{gatekeeper:{...f.evidence.gatekeeper,reviews:[]}}])
      assert.equal(f.c.prepare({...f.action,evidence:{...f.evidence,...patch}}).prepared,false);
    assert.equal(f.c.prepare({...f.action,key:'random-key'}).prepared,false);
    assert.equal(f.c.prepare(f.action).prepared,true);
    f.event('new-head',{head:'b'.repeat(40)});
    assert.equal(f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence}).claimed,false);
  }finally{f.c.close();}
});

function moveContext(f){f.event('fresh-observation',{state:'same reviewed PR; new evidence'});return f.decide({wake_id:f.s.openWake('T-1').id,disposition:'continue',plan:undefined}).action_context;}

test('an unsent canonical decision recovers from a context race and still sends only once',()=>{
 for(const personal of [false,true]){const f=setup();try{
  if(personal){
    const policy=f.c.reviewChannels();policy.personal_review={enabled:true,thread_id:INBOX,source_message_id:'human:personal',evidence_ref:'human:personal-policy',authorizations:[]};f.c.reviewChannels=()=>policy;
    Object.assign(f.action.payload,{decision_reason:'personal_review',source_message_id:'human:personal'});
    f.evidence.pr_impact={pr_url:url,head_sha:head,checked_at:new Date(NOW).toISOString(),owner_thread_id:OWNER,evidence_ref:'actual-impact',reason:'Broad affected query path',breaking_change:false,format_change:false,broad_impact:true,high_risk:false,labels_complete:true,labels:[]};
  }
  assert.equal(f.c.prepare(f.action).prepared,true);const original=f.c.db.prepare('SELECT * FROM actions WHERE action_key=?').get(f.action.key);
  const context=moveContext(f);assert.equal(f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence}).claimed,false);
  assert.throws(()=>f.c.prepare({...f.action,payload:{...f.action.payload,runtime_context:context}}),/different content/);
  const input={key:f.action.key,owner:OWNER,expected_context:context,evidence:f.evidence};
  assert.equal(f.c.refreshReviewDecisionContext(input).refreshed,true);
  const current=f.c.db.prepare('SELECT * FROM actions WHERE action_key=?').get(f.action.key),oldPayload=JSON.parse(original.payload),newPayload=JSON.parse(current.payload);
  delete oldPayload.runtime_context;delete newPayload.runtime_context;assert.deepEqual(newPayload,oldPayload);
  assert.equal(current.created_at,original.created_at);assert.equal(current.attempts,0);assert.equal(current.attempt_id,null);assert.equal(current.receipt,null);
  assert.equal(f.c.db.prepare('SELECT count(*) n FROM action_context_refreshes').get().n,1);
  assert.equal(f.c.refreshReviewDecisionContext(input).already_current,true);
  const claim=f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence});assert.equal(claim.claimed,true);
  assert.equal(f.c.refreshReviewDecisionContext(input).refreshed,false);
  const send={key:f.action.key,attempt_id:claim.attempt_id,owner:OWNER,evidence:f.evidence,operation_not_started:true};
  assert.equal(f.c.authorizeReviewSend(send).send,true);assert.equal(f.c.authorizeReviewSend(send).send,false);
  f.c.settle({key:f.action.key,attempt_id:claim.attempt_id,outcome:'sent',evidence_ref:'exact-native-delivery'});
  assert.equal(f.c.refreshReviewDecisionContext(input).refreshed,false);assert.equal(f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence}).claimed,false);
 }finally{f.c.close();}}
});

test('refresh cannot change intent or reuse stale gates, an old contract, paused owners or attempted effects',()=>{
 const changes=[
  (f,input)=>{input.owner='other-owner';},(f,input)=>{input.expected_context.context_rev--;},
  (f,input)=>{input.evidence={...input.evidence,current_head_sha:'b'.repeat(40)};},
  (f,input)=>{input.evidence={...input.evidence,applicable_ci:{...input.evidence.applicable_ci,complete:false}};},
  (f,input)=>{input.evidence={...input.evidence,gatekeeper:{...input.evidence.gatekeeper,reviews:[]}};},
  f=>{f.advance(61000);},f=>{f.mode('paused');},f=>{f.c.processing(false);},
  f=>{f.route.decision_delivery.enabled=false;},
  f=>{f.c.db.prepare("UPDATE actions SET attempts=1 WHERE action_key=?").run(f.action.key);},
  f=>{f.c.db.prepare("UPDATE actions SET receipt='{}' WHERE action_key=?").run(f.action.key);},
  f=>{f.c.db.prepare("UPDATE actions SET state='uncertain' WHERE action_key=?").run(f.action.key);},
  (f,input)=>{const task=f.s.task('T-1');f.s.amend({task_id:'T-1',expected_contract_rev:task.contract_rev,contract:{...task.contract,constraints:[...task.contract.constraints,'New scope']},source_message_id:'human:new-contract',actual_human_verified:true});input.expected_context=f.decide({wake_id:f.s.openWake('T-1').id}).action_context;}
 ];
 for(const change of changes){const f=setup();try{
  f.c.prepare(f.action);const input={key:f.action.key,owner:OWNER,expected_context:moveContext(f),evidence:f.evidence};change(f,input);
  const before=f.c.db.prepare('SELECT * FROM actions WHERE action_key=?').get(f.action.key);
  assert.equal(f.c.refreshReviewDecisionContext(input).refreshed,false);assert.deepEqual(f.c.db.prepare('SELECT * FROM actions WHERE action_key=?').get(f.action.key),before);
 }finally{f.c.close();}}
});

async function rejectedBeforeSendFixture(){
 const{mkdtempSync,writeFileSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const f=setup(),dir=mkdtempSync(join(tmpdir(),'review-unsent-'));f.c.prepare(f.action);const first=f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence});
 const context=moveContext(f),denial=f.c.authorizeReviewSend({key:f.action.key,attempt_id:first.attempt_id,owner:OWNER,evidence:f.evidence,operation_not_started:true});assert.equal(denial.send,false);assert(denial.reasons.includes('reactive_plan_or_evidence_changed'));
 const denyFile=join(dir,'authorize.json'),proofFile=join(dir,'not-sent.json');writeFileSync(denyFile,JSON.stringify(denial));
 writeFileSync(proofFile,JSON.stringify({checked_at:new Date(f.now()).toISOString(),task_id:'T-1',action_key:f.action.key,attempt_id:first.attempt_id,native_send_invoked:false,operation_not_started:true,authorize_ref:denyFile}));
 f.c.settle({key:f.action.key,attempt_id:first.attempt_id,outcome:'not_sent',error_class:'rejected_before_send',evidence_ref:proofFile});
 const input={key:f.action.key,owner:OWNER,expected_context:context,evidence:f.evidence,expected_attempt_id:first.attempt_id,not_sent_proof_ref:proofFile};
 return{...f,first,input,proofFile,denyFile,close(){f.c.close();rmSync(dir,{recursive:true,force:true});}};
}

test('a proven unsent claimed decision refreshes the same key while preserving prior attempt and all reauthorization gates',async()=>{
 const f=await rejectedBeforeSendFixture();try{
 const before=f.c.db.prepare('SELECT * FROM actions WHERE action_key=?').get(f.action.key);assert(f.c.refreshReviewDecisionContext(f.input).refreshed);
 const after=f.c.db.prepare('SELECT * FROM actions WHERE action_key=?').get(f.action.key);for(const k of ['attempt_id','attempts','owner','receipt','created_at'])assert.equal(after[k],before[k]);
 const prior=f.c.db.prepare('SELECT * FROM review_delivery_attempts WHERE attempt_id=?').get(f.first.attempt_id);assert.equal(prior.outcome,'not_sent');assert.equal(JSON.parse(prior.payload).runtime_context.context_rev,JSON.parse(before.payload).runtime_context.context_rev);
 f.advance(5001);const second=f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence});assert(second.claimed);assert.notEqual(second.attempt_id,f.first.attempt_id);
 assert.equal(f.c.authorizeReviewSend({key:f.action.key,attempt_id:second.attempt_id,owner:OWNER,evidence:f.evidence,operation_not_started:true}).send,true);
 f.c.settle({key:f.action.key,attempt_id:second.attempt_id,outcome:'sent',evidence_ref:'actual-native-send'});
 assert.equal(f.c.refreshReviewDecisionContext(f.input).refreshed,false);assert.equal(f.c.db.prepare('SELECT count(*) n FROM review_delivery_attempts WHERE action_key=?').get(f.action.key).n,2);
 assert.deepEqual(f.c.db.prepare('SELECT outcome FROM review_delivery_attempts WHERE action_key=? ORDER BY claimed_at').all(f.action.key).map(r=>r.outcome),['not_sent','sent']);
 }finally{f.close();}
});

test('attempted review refresh rejects permits, uncertainty, unverifiable non-delivery and any changed identity',async()=>{
 const{readFileSync,writeFileSync}=await import('node:fs');
 for(const change of ['permit','uncertain','sent','wrong-attempt','called','wrong-key','denial','receipt','head','owner']){const f=await rejectedBeforeSendFixture();try{
  if(change==='permit')f.c.db.prepare('INSERT INTO review_send_permits VALUES (?,?,?,?)').run(f.first.attempt_id,f.action.key,f.now(),f.now()+60000);
  if(['uncertain','sent'].includes(change))f.c.db.prepare('UPDATE actions SET state=? WHERE action_key=?').run(change,f.action.key);
  if(change==='wrong-attempt')f.input.expected_attempt_id='another-attempt';if(change==='owner')f.input.owner='another-owner';if(change==='head')f.input.evidence={...f.evidence,current_head_sha:'b'.repeat(40)};
  if(['called','wrong-key'].includes(change)){const p=JSON.parse(readFileSync(f.proofFile));if(change==='called')p.native_send_invoked=true;else p.action_key='another-key';writeFileSync(f.proofFile,JSON.stringify(p));}
  if(change==='denial')writeFileSync(f.denyFile,JSON.stringify({send:true}));if(change==='receipt')f.c.db.prepare("UPDATE actions SET receipt=? WHERE action_key=?").run(JSON.stringify({outcome:'not_sent',evidence_ref:f.proofFile,native_result:{threadId:INBOX}}),f.action.key);
  const before=f.c.db.prepare('SELECT * FROM actions WHERE action_key=?').get(f.action.key);assert.equal(f.c.refreshReviewDecisionContext(f.input).refreshed,false,change);assert.deepEqual(f.c.db.prepare('SELECT * FROM actions WHERE action_key=?').get(f.action.key),before);
 }finally{f.close();}}
});

test('verified repository Gatekeeper absence composes with owner delivery while feedback, CI and Functions holds remain enforced',()=>{
 const f=setup();try{
  const policy=f.c.reviewChannels();policy.gatekeeper_applicability={repositories:[{repository:'example/service',status:'not_configured',record_protocol:'native_gatekeeper_applicability_v1',actual_human_verified:true,source_actor_verified:true,source_thread_id:INBOX,source_turn_id:'source-turn',source_message_id:'no-gatekeeper',verbatim_text:'This repository has no configured Gatekeeper',evidence_ref:'actual-human',native_source_digest:'a'.repeat(64)}],review_exceptions:[]};f.c.reviewChannels=()=>policy;
  delete f.evidence.gatekeeper.identity;f.evidence.gatekeeper.reviews=[];f.evidence.gatekeeper.applicability={status:'not_configured',policy_source_message_id:'no-gatekeeper'};
  for(const patch of [{validation_current:false},{material_findings_open:true},{applicable_ci:{...f.evidence.applicable_ci,complete:false}}])assert.equal(f.c.prepare({...f.action,evidence:{...f.evidence,...patch}}).allowed,false);
  assert.equal(f.c.prepare(f.action).prepared,true);
  const slack={...f.action,key:'same-repo-still-functions-held',kind:'slack_pr',payload:{...f.action.payload,channel_id:'CFUNCTIONS'},evidence:{...f.evidence,already_announced:false}};
  assert.ok(f.c.prepare(slack).reasons.includes('review_delivery_paused_by_user'));
  f.c.feedback.ingest({repository:'example/service',pr_number:1,head_sha:head,head_before:head,head_after:head,checked_at:f.evidence.verified_at,evidence_ref:'new-feedback',complete:{reviews:true,review_comments:true,issue_comments:true,review_threads:true},reviews:[{id:900,state:'CHANGES_REQUESTED',body:'Fix the actual regression',commit_id:head,user:{login:'human-reviewer'}}],review_comments:[],issue_comments:[],review_threads:[]});
  assert.equal(f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence}).claimed,false);
 }finally{f.c.close();}
});
