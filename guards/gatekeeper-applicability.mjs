import {bindings} from './instance.mjs';
import {readReviewChannels} from './pr-review-routing.mjs';
const present=v=>typeof v==='string'&&!!v.trim();
const hash=v=>createHash('sha256').update(v).digest('hex');
const identity=url=>url?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/);
const human=(r,main=bindings.threads.inbox)=>r?.record_protocol==='native_gatekeeper_applicability_v1'&&r.actual_human_verified===true&&r.source_actor_verified===true&&r.source_thread_id===main&&present(r.source_turn_id)&&present(r.source_message_id)&&present(r.verbatim_text)&&present(r.evidence_ref)&&present(r.native_source_digest)&&r.revoked!==true;

// Empty reviews cannot prove an external GitHub App is absent. A repository-owner
// declaration is authoritative until superseded or contradicted by actual activity.
export function gatekeeperExemption(kind,p,e,policy,instanceBindings=bindings){
 const id=identity(p.pr_url??p.message),g=e.gatekeeper,a=g?.applicability;if(!id||!a)return false;
 const rules=policy??readReviewChannels()?.gatekeeper_applicability;
 if(a.status==='explicit_review_exception')return ['slack_pr','review_decision'].includes(kind)&&(rules?.review_exceptions??[]).some(r=>human(r,instanceBindings.threads.inbox)&&r.source_message_id===a.policy_source_message_id&&r.repository===id[1]&&r.pr_url===(p.pr_url??p.message)&&r.head_sha===p.expected_head_sha&&r.scope==='external_review_only'&&(!e.task_id||e.task_id===r.task_id));
 if(a.status!=='not_configured')return false;
 const r=(rules?.repositories??[]).filter(r=>r.repository===id[1]).at(-1);
 if(!human(r,instanceBindings.threads.inbox)||r.status!=='not_configured'||r.source_message_id!==a.policy_source_message_id||['configured','unknown'].includes(g.configuration_status)||e.applicable_ci?.checks?.some(c=>/gatekeeper/i.test(c.name??'')))return false;
 const login=v=>String(v??'').replace(/\[bot\]$/,'').toLowerCase();
 return !g.reviews.some(review=>review.commit_id===p.expected_head_sha&&(/gatekeeper/i.test(review.user?.login??review.author?.login??'')||g.identity?.verified===true&&login(review.user?.login??review.author?.login)===login(g.identity.login)));
}

