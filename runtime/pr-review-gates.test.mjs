import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewStageReasons } from './pr-review-gates.mjs';
const NOW=Date.parse('2026-11-04T04:00:00Z'),head='a'.repeat(40),url='https://github.com/example/project/pull/1';
const payload={pr_url:url,expected_head_sha:head};
function proof(kind='slack_pr') { return {
  applicable_ci:{pr_url:url,head_sha:head,head_before:head,head_after:head,checked_at:new Date(NOW).toISOString(),evidence_ref:'provider-checks',policy_ref:'actual-applicability',complete:true,phase:kind==='pr_ready'?'pre_ready':'pre_delivery',checks:[{id:'ci1',name:'unit',head_sha:head,applicable:true,status:'completed',conclusion:'success'}]},
  gatekeeper:{pr_url:url,head_sha:head,head_before:head,head_after:head,checked_at:new Date(NOW).toISOString(),evidence_ref:'complete-reviews',semantic_assessment_ref:'current-feedback-disposition',identity:{kind:'github_app',login:'example-reviewer',app_id:123,verified:true,evidence_ref:'actual-app-surface'},reviews_complete:true,reviews:[{id:1,user:{login:'example-reviewer[bot]'},state:'COMMENTED',commit_id:head,submitted_at:new Date(NOW-1000).toISOString(),body:'✅ **Gate recommendation: approve.**\nReviewed current code.'}]},
}; }
function noCI(kind='pr_ready') {
  const e=proof(kind),ci=e.applicable_ci,base='b'.repeat(40);ci.checks=[];ci.mode='verified_no_hosted_ci';
  ci.local_validation={head_sha:head,passed:true,evidence_ref:'actual-local-validation'};
  ci.no_hosted_ci={repository:'example/project',pr_number:1,head_sha:head,checked_at:new Date(NOW).toISOString(),evidence_ref:'complete-source-absence',complete:true,
    base_ref:'main',base_before:base,base_after:base,base_ref_before:'main',base_ref_after:'main',
    check_runs:{complete:true,count:0},statuses:{complete:true,count:0},workflows:{complete:true,count:0},
    workflow_files:{complete:true,head:[],base:[]},branch_policy:{complete:true,protected:false,effective_rules:[]}};
  return e;
}
test('verified no-hosted-CI permits Ready without inventing a passing check',()=>{
  const e=noCI();delete e.gatekeeper;assert.deepEqual(reviewStageReasons('pr_ready',payload,e,NOW),[]);
  assert.deepEqual(e.applicable_ci.checks,[]);
  const delivery=noCI('slack_pr');delete delivery.gatekeeper;
  assert.ok(reviewStageReasons('slack_pr',payload,delivery,NOW).includes('fresh_verified_Gatekeeper_surface_required'));
  assert.deepEqual(reviewStageReasons('slack_pr',payload,noCI('slack_pr'),NOW),[]);
});
test('unknown, incomplete, required, stale or mismatched CI absence never qualifies',()=>{
  const changes=[e=>delete e.applicable_ci.no_hosted_ci,e=>delete e.applicable_ci.policy_ref,e=>e.applicable_ci.no_hosted_ci.complete=false,
    e=>e.applicable_ci.no_hosted_ci.repository='other/project',e=>e.applicable_ci.no_hosted_ci.pr_number=2,
    e=>e.applicable_ci.no_hosted_ci.head_sha='c'.repeat(40),e=>e.applicable_ci.no_hosted_ci.base_after='c'.repeat(40),
    e=>e.applicable_ci.no_hosted_ci.base_ref_after='release',e=>e.applicable_ci.no_hosted_ci.checked_at=new Date(NOW-61000).toISOString(),
    e=>e.applicable_ci.no_hosted_ci.branch_policy.protected=true,e=>e.applicable_ci.no_hosted_ci.branch_policy.effective_rules=[{type:'required_status_checks'}],
    e=>e.applicable_ci.no_hosted_ci.branch_policy.complete=false,e=>e.applicable_ci.no_hosted_ci.workflow_files.head=['ci.yml'],
    e=>e.applicable_ci.no_hosted_ci.workflow_files.base=['ci.yml'],e=>e.applicable_ci.local_validation.passed=false,
    e=>e.applicable_ci.local_validation.head_sha='c'.repeat(40),e=>delete e.applicable_ci.local_validation.evidence_ref];
  for(const source of ['check_runs','statuses','workflows'])changes.push(e=>e.applicable_ci.no_hosted_ci[source].count=1,e=>e.applicable_ci.no_hosted_ci[source].complete=false);
  for(const mutate of changes){const e=noCI();mutate(e);assert.ok(reviewStageReasons('pr_ready',payload,e,NOW).length);}
  for(const conclusion of ['failure',null,'success']){const e=noCI();e.applicable_ci.checks=[{id:'actual-check',name:'test',head_sha:head,applicable:true,status:conclusion?'completed':'in_progress',conclusion}];assert.ok(reviewStageReasons('pr_ready',payload,e,NOW).length);}
  const e=proof('pr_ready');e.applicable_ci.checks=[];assert.ok(reviewStageReasons('pr_ready',payload,e,NOW).length);
});
test('CI permits first ready without requiring the Gatekeeper review it triggers',()=>{
  const e=proof('pr_ready');delete e.gatekeeper;assert.deepEqual(reviewStageReasons('pr_ready',payload,e,NOW),[]);
  e.applicable_ci.checks.push({id:'gk',name:'Gatekeeper',head_sha:head,applicable:false,status:'completed',conclusion:'skipped',exclusion_reason:'Starts only after ready',applicability_ref:'actual-trigger'});
  assert.deepEqual(reviewStageReasons('pr_ready',payload,e,NOW),[]);
});
test('pending, failed, unexpectedly skipped or missing ordinary CI cannot pass',()=>{
  for(const patch of [{status:'in_progress',conclusion:null},{conclusion:'failure'},{conclusion:'skipped'}]) {
    const e=proof('pr_ready');Object.assign(e.applicable_ci.checks[0],patch);assert.ok(reviewStageReasons('pr_ready',payload,e,NOW).length);
  }
  assert.ok(reviewStageReasons('pr_ready',payload,{},NOW).length);
});
test('delivery requires an actual current-head Gatekeeper approval, including COMMENTED protocol',()=>{
  assert.deepEqual(reviewStageReasons('slack_pr',payload,proof(),NOW),[]);
  const risk=proof();risk.gatekeeper.reviews[0].body='⚠️ **Gate recommendation: approve with a non-blocking risk.**\nThe reviewer could not independently exercise this platform.';
  assert.deepEqual(reviewStageReasons('slack_pr',payload,risk,NOW),[]);
  for(const patch of [{body:'❌ **Gate recommendation: request changes.**'},{state:'DISMISSED'},{commit_id:'b'.repeat(40)},{body:'Looks green'}]) {
    for(const base of [proof(),risk]) {
      const e=structuredClone(base);Object.assign(e.gatekeeper.reviews[0],patch);assert.ok(reviewStageReasons('slack_pr',payload,e,NOW).includes('current_head_Gatekeeper_approval_required'));
    }
  }
  const e=proof();delete e.gatekeeper;assert.ok(reviewStageReasons('slack_pr',payload,e,NOW).length);
});
test('only the exact observed risk approval header is supported, not quotes or conditional language',()=>{
  for(const body of ['⚠️ **Gate recommendation: approve with a blocking risk.**','⚠️ **Gate recommendation: approve after fixing the risk.**',
    '> ⚠️ **Gate recommendation: approve with a non-blocking risk.**','Review pending\n⚠️ **Gate recommendation: approve with a non-blocking risk.**',
    '⚠️ **Gate recommendation: approve with a non-blocking risk.** except for the required fix']) {
    const e=proof();e.gatekeeper.reviews[0].body=body;assert.ok(reviewStageReasons('slack_pr',payload,e,NOW).includes('current_head_Gatekeeper_approval_required'));
  }
});
test('new-head, stale evidence and a later negative review invalidate delivery',()=>{
  assert.ok(reviewStageReasons('slack_pr',{...payload,expected_head_sha:'b'.repeat(40)},proof(),NOW).length);
  assert.ok(reviewStageReasons('slack_pr',payload,proof(),NOW+61000).length);
  for(const header of ['✅ **Gate recommendation: approve.**','⚠️ **Gate recommendation: approve with a non-blocking risk.**']) {
    const e=proof();e.gatekeeper.reviews[0].body=header;
    assert.ok(reviewStageReasons('slack_pr',{...payload,expected_head_sha:'b'.repeat(40)},e,NOW).length);
    assert.ok(reviewStageReasons('slack_pr',payload,e,NOW+61000).length);
    e.gatekeeper.head_after='b'.repeat(40);assert.ok(reviewStageReasons('slack_pr',payload,e,NOW).length);e.gatekeeper.head_after=head;
    e.gatekeeper.reviews.push({...e.gatekeeper.reviews[0],id:2,submitted_at:new Date(NOW).toISOString(),body:'❌ **Gate recommendation: request changes.**'});
    assert.ok(reviewStageReasons('slack_pr',payload,e,NOW).length);
    e.gatekeeper.reviews[1].body='No verdict yet';assert.ok(reviewStageReasons('slack_pr',payload,e,NOW).length);
  }
});
