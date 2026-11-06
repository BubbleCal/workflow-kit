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
