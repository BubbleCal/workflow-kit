import {humanAuthorizationSource,reviewDerivedMergeAllowed,mergeAuthorizationReasons} from './pr-authorization.mjs';
import {bindings} from './instance.mjs';

const flags=['breaking_change','format_change','broad_impact','high_risk'];
const present=value=>typeof value==='string'&&!!value.trim();

export function explicitMergeAllowed(payload,e,policy) {
  const main=bindings.threads.inbox,pr=payload?.pr_url,head=payload?.expected_head_sha;
  return pr===e.pr_url&&head===e.current_head_sha&&
    Array.isArray(policy?.merge_authorizations)&&policy.merge_authorizations.some(d=>
      d.pr_url===pr&&d.head_sha===head&&(!d.task_id||d.task_id===(e.task_id??payload.task_id))&&d.decision==='allow_merge'&&
      d.nonordinary_change_accepted===true&&d.revoked!==true&&humanAuthorizationSource(d,main)&&
      (!d.derived_from_review||reviewDerivedMergeAllowed(d,payload,e,policy)));
}

// Owner assessment is required even when a PR has no risk labels. Labels can
// add a trigger, never remove an owner's assessment of the actual diff.
export function personalReviewState(payload,e,policy,now=Date.now()) {
  const rule=policy?.personal_review;
  if(rule===undefined)return {enabled:false,reasons:[],required:false,authorized:false};
  if(rule?.enabled!==true||!present(rule.source_message_id)||!present(rule.evidence_ref)||
    rule.thread_id!==bindings.threads.inbox||!Array.isArray(rule.authorizations))
    return {enabled:true,reasons:['invalid_personal_review_policy'],required:true,authorized:false};
  const a=e.pr_impact,pr=payload.pr_url??payload.message,head=payload.expected_head_sha;
  const time=Date.parse(a?.checked_at);
  if(!a||a.pr_url!==pr||pr!==e.pr_url||a.head_sha!==head||head!==e.current_head_sha||
    !present(a.owner_thread_id)||a.owner_thread_id!==e.executor_thread_id||
    !present(a.evidence_ref)||!present(a.reason)||!Number.isFinite(time)||time>now+5000||now-time>60000||
    flags.some(k=>typeof a[k]!=='boolean')||a.labels_complete!==true||
    !Array.isArray(a.labels)||a.labels.some(l=>typeof l!=='string'))
    return {enabled:true,reasons:['current_owner_PR_impact_assessment_required'],required:true,authorized:false};
  const labels=a.labels.map(l=>l.trim().toLowerCase().replace(/[ _]+/g,'-'));
  const triggers=flags.filter(k=>a[k]);
  if(labels.some(l=>['breaking-change','breaking'].includes(l))&&!triggers.includes('breaking_change'))triggers.push('breaking_change');
  if(labels.some(l=>['format-change','file-format-change'].includes(l))&&!triggers.includes('format_change'))triggers.push('format_change');
  if(e.ordinary_change===false&&!triggers.length)triggers.push('nonordinary_change');
  const authorized=rule.authorizations.some(d=>d?.pr_url===pr&&d.head_sha===head&&
    d.decision==='allow_external_review'&&humanAuthorizationSource(d,rule.thread_id)&&
    d.reviewed_personally===true&&d.revoked!==true);
  return {enabled:true,reasons:[],required:triggers.length>0,authorized,triggers,rule};
}

export function personalReviewReasons(kind,payload,e,policy,now) {
  if(!['pr_ready','slack_pr','review_decision','merge'].includes(kind))return [];
  if(kind==='merge'&&policy?.review_implies_conditional_merge===undefined)return mergeAuthorizationReasons(payload,e,policy,now);
  const s=personalReviewState(payload,e,policy,now);
  const merge=kind==='merge'?mergeAuthorizationReasons(payload,e,policy,now):[];
  if(!s.enabled)return merge;
  if(s.reasons.length)return [...merge,...s.reasons];
  if(kind==='merge'&&s.required&&!s.authorized)return [...merge,'Yang_personal_review_required_before_merge'];
  if(kind==='slack_pr'&&s.required&&!s.authorized)
    return ['Yang_personal_review_required_before_external_delivery'];
  return merge;
}

// A risky PR may become Ready for the existing automatic technical gate, then
// reach Yang privately. System readiness alone never grants human merge authority.
export function personalReviewAllowsStage(kind,payload,e,policy,now) {
  const s=personalReviewState(payload,e,policy,now);
  return s.enabled&&!s.reasons.length&&
    (kind==='pr_ready'||kind==='slack_pr'&&s.required&&s.authorized);
}
