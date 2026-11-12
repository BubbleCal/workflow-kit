import {bindings} from './instance.mjs';
import {reviewDestinationReasons} from './pr-review-routing.mjs';
import {reviewStageReasons} from './pr-review-gates.mjs';

const present=v=>typeof v==='string'&&!!v.trim();
export function humanAuthorizationSource(d,main=bindings.threads.inbox){
 return d?.actual_human_verified===true&&present(d.source_message_id)&&present(d.evidence_ref)&&
  (d.source_thread_id===main||d.recorded_by_thread_id===main&&d.source_actor_verified===true&&
   present(d.source_thread_id)&&present(d.source_turn_id)&&present(d.verbatim_text));
}
const verifiedSource=(d,context={})=>humanAuthorizationSource(d,context.bindings?.threads.inbox) || context.nativeAuthorization?.(d)===true;
export function reviewImpliesMergeRule(policy,context={}){
 const r=policy?.review_implies_conditional_merge;
 return r?.enabled===true&&verifiedSource(r,context)&&r.source_actor_verified===true&&present(r.source_turn_id)&&
  present(r.verbatim_text)&&Number.isFinite(Date.parse(r.effective_at))?r:null;
}
const matches=(d,p,e)=>d?.pr_url===p.pr_url&&d.head_sha===p.expected_head_sha&&d.head_sha===e.current_head_sha;
export function reviewDerivedMergeAllowed(d,p,e,policy,context={}){
 const rule=reviewImpliesMergeRule(policy,context),origin=d?.derived_from_review;
 if(!rule||!origin||origin.rule_source_message_id!==rule.source_message_id||!Number.isFinite(Date.parse(d.source_at))||Date.parse(d.source_at)<Date.parse(rule.effective_at))return false;
 const grant=(policy.personal_review?.authorizations??[]).find(a=>matches(a,p,e)&&a.task_id===d.task_id&&a.source_message_id===origin.source_message_id&&
  a.source_at===d.source_at&&a.record_protocol==='native_pr_authorization_v1'&&a.explicit_external_review_permission_verified===true&&
  a.scope_verified===true&&a.decision==='allow_external_review'&&a.revoked!==true&&a.merge_prohibited!==true&&verifiedSource(a,context));
 if(!grant)return false;
 const restack=grant.head_revalidation?.verified_restack;
 if(!restack)return true;
 const sameOrigin=a=>a.task_id===grant.task_id&&a.pr_url===grant.pr_url&&a.head_sha===restack.from_head_sha&&a.source_message_id===grant.source_message_id&&a.revoked!==true&&verifiedSource(a,context);
 return policy.personal_review.authorizations.some(a=>sameOrigin(a)&&a.reviewed_personally===true&&a.merge_prohibited!==true)&&
  (policy.merge_authorizations??[]).some(a=>sameOrigin(a)&&a.decision==='allow_merge'&&a.nonordinary_change_accepted===true);
}
export function mergeAuthorizationReasons(p,e,policy,now,context={}){
 const reasons=[],rule=reviewImpliesMergeRule(policy,context),holds=[...(policy?.merge_authorizations??[]),...(policy?.merge_holds??[])];
 if(holds.some(d=>d?.revoked!==true&&d.active!==false&&verifiedSource(d,context)&&
  ['forbid_merge','hold_merge'].includes(d.decision)&&(!d.pr_url||d.pr_url===p.pr_url)&&(!d.task_id||d.task_id===(e.task_id??p.task_id))&&
  (!d.head_sha||d.head_sha===p.expected_head_sha)&&(d.pr_url||d.task_id)))reasons.push('merge_explicitly_held_by_user');
 if(policy?.review_implies_conditional_merge===undefined||policy.review_implies_conditional_merge.enabled===false)return reasons;
 if(!rule)return [...reasons,'invalid_review_implies_merge_policy'];
 // These remain technical and destination gates, not new human permissions.
 reasons.push(...reviewStageReasons('merge',p,e,now,60000,policy.gatekeeper_applicability,context.bindings));
 const scope=e.review_routing?.scope,grant=policy.pr_authorizations?.find(a=>a.pr_url===p.pr_url&&a.scope===scope);
 const channel=grant?.channel_id??(scope==='default'?policy.default_channel_id:policy.routes?.find(r=>r.scope===scope)?.channel_id);
 reasons.push(...reviewDestinationReasons({...p,message:p.pr_url,channel_id:channel},e,policy,context.bindings?.delivery.slack_channel_id));
 return reasons;
}

