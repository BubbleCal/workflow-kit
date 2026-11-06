import test from 'node:test';
import assert from 'node:assert/strict';
import {personalReviewState,personalReviewReasons} from './pr-personal-review.mjs';
import {fixture,OWNER,NOW} from './test-fixtures/reactive.mjs';
import {passedReviewGates} from './test-fixtures/pr-review.mjs';
import {INBOX,CHANNEL,assess} from './control.mjs';

const url='https://github.com/example/service/pull/1',head='a'.repeat(40);
const impact=()=>({pr_url:url,head_sha:head,checked_at:new Date(NOW).toISOString(),owner_thread_id:OWNER,
  evidence_ref:'actual-head-diff-and-labels',reason:'Reviewed public API and persisted representation',
  breaking_change:false,format_change:false,broad_impact:false,high_risk:false,labels_complete:true,labels:[]});
const rule=()=>({enabled:true,thread_id:INBOX,source_message_id:'human:risk-policy',evidence_ref:'actual-human-policy',authorizations:[]});
const authorization=()=>({pr_url:url,head_sha:head,decision:'allow_external_review',actual_human_verified:true,
  reviewed_personally:true,source_thread_id:INBOX,source_message_id:'human:reviewed-and-release',evidence_ref:'actual-human-reply'});
function setup(){
  const f=fixture(),task=f.s.task('T-1');
  f.s.amend({task_id:'T-1',expected_contract_rev:task.contract_rev,contract:{...task.contract,pull_requests:[{repository:'example/service',pr_number:1}]},source_message_id:'human:bind',actual_human_verified:true});
  f.activate();const wake=f.begin(),decision=f.decide({wake_id:wake.id});
  const policy={schema_version:1,source_message_id:'human:route',default_channel_id:CHANNEL,routes:[],personal_review:rule()};
  f.c.reviewChannels=()=>policy;
  const evidence={...passedReviewGates(NOW,head,url),verified_at:new Date(NOW).toISOString(),scope_authorized:true,
    authorization_ref:'human:risk-policy',policy_version:'v1',current_policy_version:'v1',stopped:false,executor_thread_id:OWNER,
    pr_owner:'test-author',pr_open:true,pr_draft:false,ordinary_change:true,material_findings_open:false,validation_current:true,
    technical_review_current:true,current_head_sha:head,pr_url:url,already_notified:false,already_announced:false,pr_impact:impact(),
    review_routing:{scope:'default',verified:true,pr_url:url,head_sha:head,evidence_ref:'actual-feature-scope'}};
  f.c.feedback.ingest({repository:'example/service',pr_number:1,head_sha:head,head_before:head,head_after:head,checked_at:evidence.verified_at,
    evidence_ref:'feedback',complete:{reviews:true,review_comments:true,issue_comments:true,review_threads:true},reviews:[],review_comments:[],issue_comments:[],review_threads:[]});
  const action={key:'personal-review-slack',kind:'slack_pr',task_id:'T-1',payload:{channel_id:CHANNEL,pr_url:url,message:url,expected_head_sha:head,runtime_context:decision.action_context},evidence};
  return {...f,policy,evidence,action};
}

test('every trigger holds external delivery; missing, stale or mismatched assessment fails closed',()=>{
  const f=setup();try{
    assert.equal(f.c.prepare(f.action).prepared,true);
    for(const flag of ['breaking_change','format_change','broad_impact','high_risk']) {
      const e={...f.evidence,pr_impact:{...impact(),[flag]:true}};
      assert.ok(personalReviewReasons('slack_pr',f.action.payload,e,f.policy,NOW).includes('Yang_personal_review_required_before_external_delivery'));
    }
    for(const patch of [{head_sha:'b'.repeat(40)},{labels_complete:false},{reason:''},{owner_thread_id:'wrong'},
      {checked_at:new Date(NOW-60001).toISOString()},{breaking_change:undefined}])
      assert.ok(personalReviewReasons('slack_pr',f.action.payload,{...f.evidence,pr_impact:{...impact(),...patch}},f.policy,NOW).length);
    assert.ok(personalReviewReasons('slack_pr',f.action.payload,{...f.evidence,pr_impact:undefined},f.policy,NOW).length);
    for(const label of ['breaking-change','format change'])
      assert.equal(personalReviewState(f.action.payload,{...f.evidence,pr_impact:{...impact(),labels:[label]}},f.policy,NOW).required,true);
  }finally{f.c.close();}
});

test('only an explicit personally reviewed current-PR decision releases the hold',()=>{
  const f=setup();try{
    f.evidence.pr_impact.high_risk=true;
    f.policy.personal_review.authorizations=[authorization()];
    assert.deepEqual(personalReviewReasons('slack_pr',f.action.payload,f.evidence,f.policy,NOW),[]);
    for(const patch of [{head_sha:'b'.repeat(40)},{pr_url:url+'2'},{decision:'notified'},{reviewed_personally:false},
      {actual_human_verified:false},{source_thread_id:'gatekeeper'},{revoked:true},{evidence_ref:''}]) {
      f.policy.personal_review.authorizations=[{...authorization(),...patch}];
      assert.ok(personalReviewReasons('slack_pr',f.action.payload,f.evidence,f.policy,NOW).length);
    }
    f.policy.personal_review.authorizations=[];
    f.evidence.personal_review_approved=true; // A caller boolean is not human evidence.
    assert.ok(personalReviewReasons('slack_pr',f.action.payload,f.evidence,f.policy,NOW).length);
  }finally{f.c.close();}
});

test('important PR can reach Yang privately without granting Slack or merge permission',()=>{
  const f=setup();try{
    f.evidence.pr_impact.breaking_change=true;f.evidence.ordinary_change=false;
    const a={...f.action,key:`review-decision:${url}:${head}`,kind:'review_decision',payload:{...f.action.payload,
      decision_reason:'personal_review',thread_id:INBOX,source_message_id:'human:risk-policy',prompt:`T-1: Breaking API change; validation passed. Please inspect before external review: ${url}`}};
    assert.equal(f.c.prepare(a).prepared,true);
    const c=f.c.claim({key:a.key,owner:OWNER,evidence:f.evidence});assert.equal(c.claimed,true);
    const send=f.c.authorizeReviewSend({key:a.key,attempt_id:c.attempt_id,owner:OWNER,evidence:f.evidence,operation_not_started:true});
    assert.equal(send.send,true);assert.equal(send.native_arguments.threadId,INBOX);
    f.c.settle({key:a.key,attempt_id:c.attempt_id,outcome:'sent',evidence_ref:'native-card-readback'});
    assert.equal(f.c.prepare(f.action).prepared,false); // Notification is not consent.
    f.policy.personal_review.authorizations=[authorization()];
    assert.equal(f.c.prepare(f.action).prepared,true);
    const merge=assess('merge',f.action.payload,f.evidence,NOW,undefined,undefined,null,null,f.policy);
    assert.ok(merge.reasons.includes('important_or_unresolved_change')); // No new merge authority.
  }finally{f.c.close();}
});

test('prepare, claim and last send gate all recheck current policy and authorization',()=>{
  const f=setup();try{
    assert.equal(f.c.prepare(f.action).prepared,true);
    f.evidence.pr_impact.format_change=true;
    assert.equal(f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence}).claimed,false);
    f.policy.personal_review.authorizations=[authorization()];
    const c=f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence});assert.equal(c.claimed,true);
    f.policy.personal_review.authorizations[0].revoked=true;
    const send=()=>f.c.authorizeReviewSend({key:f.action.key,attempt_id:c.attempt_id,owner:OWNER,evidence:f.evidence,operation_not_started:true});
    assert.equal(send().send,false);
    f.policy.personal_review.authorizations[0].revoked=false;
    assert.equal(send().send,true);
  }finally{f.c.close();}
});

test('personal clearance does not release an independent Functions hold',()=>{
  const f=setup();try{
    f.evidence.pr_impact.broad_impact=true;
    f.policy.personal_review.authorizations=[authorization()];
    f.policy.routes=[{scope:'lancedb_functions',channel_id:'CFUNCTIONS',delivery_hold:{active:true,source_message_id:'human:functions-hold',evidence_ref:'hold'}}];
    f.evidence.review_routing.scope='lancedb_functions';f.action.payload.channel_id='CFUNCTIONS';
    assert.ok(f.c.prepare(f.action).reasons.includes('review_delivery_paused_by_user'));
  }finally{f.c.close();}
});

test('ordinary no-trigger PRs cannot use the proactive personal decision exception',()=>{
  const f=setup();try{
    const a={...f.action,key:`review-decision:${url}:${head}`,kind:'review_decision',payload:{...f.action.payload,
      decision_reason:'personal_review',thread_id:INBOX,source_message_id:'human:risk-policy',prompt:`Routine status ${url}`}};
    assert.ok(f.c.prepare(a).reasons.includes('explicit_personal_review_decision_required'));
  }finally{f.c.close();}
});
