export function passedReviewGates(now,head,url,kind='slack_pr') {
  return {
    applicable_ci:{pr_url:url,head_sha:head,head_before:head,head_after:head,checked_at:new Date(now).toISOString(),evidence_ref:'fixture-provider-checks',policy_ref:'fixture-applicability',complete:true,phase:kind==='pr_ready'?'pre_ready':'pre_delivery',checks:[{id:'fixture-ci',name:'unit',head_sha:head,applicable:true,status:'completed',conclusion:'success'}]},
    gatekeeper:{pr_url:url,head_sha:head,head_before:head,head_after:head,checked_at:new Date(now).toISOString(),evidence_ref:'fixture-complete-reviews',semantic_assessment_ref:'fixture-current-review',identity:{kind:'github_app',login:'fixture-gatekeeper',app_id:123,verified:true,evidence_ref:'fixture-identity'},reviews_complete:true,reviews:[{id:1,user:{login:'fixture-gatekeeper'},state:'COMMENTED',commit_id:head,submitted_at:new Date(now-1000).toISOString(),body:'✅ **Gate recommendation: approve.**'}]},
  };
}
