import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,NOW} from './test-fixtures/reactive.mjs';
import {INBOX} from './control.mjs';

const url='https://github.com/example/service/pull/1',head='a'.repeat(40),base='b'.repeat(40),digest='c'.repeat(64);
function setup(){
  const f=fixture();
  f.c.work.create({id:'T-1',canonical_key:'review:example/service#1',title:'Review',objective:'Review only',
    source:{kind:'user',review_only:true},pull_requests:[{repository:'example/service',pr_number:1}]});
  const task=f.s.task('T-1');
  f.s.amend({task_id:'T-1',expected_contract_rev:task.contract_rev,contract:{...task.contract,pull_requests:[{repository:'example/service',pr_number:1}]},
    source_message_id:'human:review',actual_human_verified:true});
  f.activate();
  const policy={schema_version:1,enabled:true,mode:'owner_to_main',thread_id:INBOX,source_message_id:'human:notify-review',evidence_ref:'actual-instruction'};
  f.c.reviewReportPolicy=()=>policy;
  const payload={thread_id:INBOX,source_message_id:policy.source_message_id,pr_url:url,reviewed_head_sha:head,
    reviewed_base_sha:base,report_ref:'/results/review.txt',report_sha256:digest,pr_head_status:'changed',
    prompt:`[review-result:T-1] Completed review: two correctness findings. ${url} Reviewed ${head}. Current head changed. [Review](codex://threads/${OWNER}) [Report](/results/review.txt)`};
  const evidence={verified_at:new Date(NOW).toISOString(),scope_authorized:true,authorization_ref:'actual-instruction',
    policy_version:'v1',current_policy_version:'v1',stopped:false,executor_thread_id:OWNER,reviewed_head_sha:head,
    reviewed_base_sha:base,report_ref:payload.report_ref,report_sha256:digest,review_conclusion_ready:true,
    report_saved_and_verified:true,material_change:true,already_notified:false};
  return {...f,policy,payload,evidence,action:{key:`review-report:T-1:${head}:${digest}`,kind:'review_report',task_id:'T-1',payload,evidence}};
}

test('finished review with findings reaches only main without PR approval or CI gates and deduplicates retries',()=>{
  const f=setup();try{
    // Private result delivery remains allowed during the external review blackout.
    f.advance(16*3600000);f.evidence.verified_at=new Date(f.now()).toISOString();
    assert.equal(f.c.prepare(f.action).prepared,true);
    const claim=f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence});
    assert.equal(claim.claimed,true);assert.deepEqual(claim.native_arguments,{threadId:INBOX,prompt:f.payload.prompt});
    assert.equal(claim.requires_review_send_authorization,undefined);
    f.c.settle({key:f.action.key,attempt_id:claim.attempt_id,outcome:'sent',evidence_ref:'actual-main-readback'});
    assert.equal(f.c.prepare(f.action).state,'sent');
    assert.equal(f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence}).claimed,false);
    assert.equal(f.c.prepare({...f.action,key:'fresh-key-to-resend'}).allowed,false);
    assert.equal(f.c.prepare({...f.action,key:'external-review',kind:'slack_pr'}).prepared,false);
  }finally{f.c.close();}
});

test('review result requires saved substantive evidence, bound PR, original reviewer and authorized destination',()=>{
  const f=setup();try{
    for(const patch of [{thread_id:'another-chat'},{source_message_id:'wrong-source'},{pr_url:'https://github.com/example/service/pull/2'},
      {report_sha256:'x'},{reviewed_head_sha:'bad'},{prompt:'routine progress'},{pr_head_status:'passed'}])
      assert.equal(f.c.prepare({...f.action,payload:{...f.payload,...patch}}).prepared,false);
    for(const patch of [{executor_thread_id:'wrong-owner'},{review_conclusion_ready:false},{report_saved_and_verified:false},
      {material_change:false},{already_notified:true},{reviewed_base_sha:'d'.repeat(40)},{report_ref:'/another-file'},
      {report_sha256:'e'.repeat(64)},{stopped:true}])
      assert.equal(f.c.prepare({...f.action,evidence:{...f.evidence,...patch}}).prepared,false);
    f.policy.enabled=false;assert.equal(f.c.prepare(f.action).prepared,false);
    f.policy.enabled=true;assert.equal(f.c.prepare(f.action).prepared,true);
    assert.equal(f.c.claim({key:f.action.key,owner:'wrong-owner',evidence:f.evidence}).claimed,false);
    f.policy.enabled=false;assert.equal(f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence}).claimed,false);
  }finally{f.c.close();}
});

test('unknown review identity and paused owner cannot use the completed-review exception',()=>{
  const f=setup();try{
    assert.equal(f.c.prepare({...f.action,task_id:'missing'}).prepared,false);
    f.mode('paused');assert.equal(f.c.prepare(f.action).prepared,false);
  }finally{f.c.close();}
});
