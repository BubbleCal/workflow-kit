import {bindings as defaultBindings,instancePolicyReasons} from './instance.mjs';
import {dependencyReasons} from './dependency-provenance.mjs';
import {personalReviewReasons,personalReviewAllowsStage,explicitMergeAllowed} from './pr-personal-review.mjs';
import {reviewStageReasons} from './pr-review-gates.mjs';
import {reviewDestinationReasons} from './pr-review-routing.mjs';
import {retainedApprovalReasons} from './merge-approval.mjs';
import {REVIEW_WINDOW,isReviewDelivery,reviewWindowAt} from './review-window.mjs';

// Evidence-only checks shared by native T3 and the retained legacy entrypoint.
// No scheduler, queue, task state machine, RPC client or runtime store is loaded.
export function assessPrAction(kind,payload,e={},context={}){
  const {now=Date.now(),bindings=defaultBindings,reviewRule=REVIEW_WINDOW,dependencyPolicy=null,reviewChannels=null}=context;
  const reasons=instancePolicyReasons(kind,payload,e,bindings);
  const need=(v,r)=>{if(!v)reasons.push(r);};
  const prUrl=value=>typeof value==='string'&&/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(value);
  need(['slack_pr','pr_ready','merge'].includes(kind),'unknown_action_kind');
  reasons.push(...dependencyReasons(kind,payload,e,dependencyPolicy,now));
  if(isReviewDelivery(kind))need(!reviewWindowAt(now,reviewRule).blocked,'review_delivery_blackout');
  const at=Date.parse(e.verified_at);
  need(Number.isFinite(at)&&at<=now+5000&&now-at<=60000,'fresh_preflight_required');
  need(e.scope_authorized===true&&typeof e.authorization_ref==='string'&&!!e.authorization_ref,'authorization_evidence_required');
  need(typeof e.policy_version==='string'&&!!e.policy_version&&e.policy_version===e.current_policy_version,'policy_changed_or_unknown');
  need(e.stopped===false,'human_hold_or_unknown_stop_state');
  need(e.pr_owner===bindings.identity.github_login,'pr_not_owned_by_configured_user');
  need(e.pr_open===true&&e.pr_draft===(kind==='pr_ready'),'pr_not_ready');
  need((context.approvalScope?context.approvalScope.allowed:e.ordinary_change===true||personalReviewAllowsStage(kind,payload,e,reviewChannels,now,context)||
    kind==='merge'&&explicitMergeAllowed(payload,e,reviewChannels,context))&&e.material_findings_open===false,'important_or_unresolved_change');
  need(e.validation_current===true&&e.technical_review_current===true,'current_head_validation_or_review_missing');
  need(typeof payload?.expected_head_sha==='string'&&/^[a-f0-9]{40,64}$/.test(payload.expected_head_sha)&&payload.expected_head_sha===e.current_head_sha,'head_changed_or_unknown');
  if(kind==='pr_ready')need(payload.operation==='mark_ready'&&prUrl(payload.pr_url)&&payload.pr_url===e.pr_url,'verified_draft_transition_required');
  if(isReviewDelivery(kind))reasons.push(...reviewStageReasons(kind,payload,e,now,60000,reviewChannels?.gatekeeper_applicability,bindings));
  if(context.approvalScope){
    reasons.push(...context.approvalScope.reasons);
    if(kind==='merge'){
      // Keep explicit product holds, but merge is not an outbound Slack action.
      const holds={...reviewChannels,review_implies_conditional_merge:undefined};
      reasons.push(...personalReviewReasons(kind,payload,e,holds,now,context));
    }
  }else reasons.push(...personalReviewReasons(kind,payload,e,reviewChannels,now,context));
  if(kind==='slack_pr'){
    reasons.push(...reviewDestinationReasons(payload,e,reviewChannels,bindings.delivery.slack_channel_id));
    need(prUrl(payload.message)&&payload.message===e.pr_url,'slack_message_must_match_verified_PR_URL');
    need(e.already_announced===false,'already_announced_or_unknown');
  }
  if(kind==='merge'){
    need(prUrl(payload.pr_url)&&payload.pr_url===e.pr_url,'merge_PR_identity_mismatch');
    need(e.approver===bindings.delivery.approver_login&&e.approver_identity_verified===true&&e.approval_state==='APPROVED','designated_approval_missing');
    if(e.approved_head_sha!==e.current_head_sha||e.approval_verification)reasons.push(...retainedApprovalReasons(payload,e,now));
    need(e.required_checks_pass===true&&e.repository_rules_satisfied===true&&e.mergeable===true,'repository_merge_requirements_unsatisfied');
    need(e.admin_override===false,'admin_override_forbidden');
  }
  return {allowed:reasons.length===0,reasons};
}
