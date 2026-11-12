import {verifyRestackRevalidation} from './reviewed-restack.mjs';
import {readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {bindings} from './instance.mjs';
import {nativeReadback} from './native-queue.mjs';
import {reviewDestinationReasons} from './pr-review-routing.mjs';
import {reviewStageReasons} from './pr-review-gates.mjs';

import {humanAuthorizationSource,reviewImpliesMergeRule} from '../guards/pr-authorization.mjs';
export * from '../guards/pr-authorization.mjs';
const present=v=>typeof v==='string'&&!!v.trim();

// Main resolves human language and scope; native history verifies that it was
// actually a human grant. No ready/notification/automatic review event can enter.
export function recordPrReviewAuthorization(control,input,{policyPath}={}){
 const {task_id,pr_url,head_sha,native_proof,source_message_id,source_turn_id,source_thread_id,verbatim_text,evidence_ref}=input;
 const revalidationOnly=input.revalidation_only===true;
 if((!revalidationOnly&&input.recorded_by_thread_id!==bindings.threads.inbox)||input.explicit_external_review_permission_verified!==true||input.scope_verified!==true||
  !present(evidence_ref)||input.authorized_scope?.task_id!==task_id||input.authorized_scope?.pr_urls?.length!==1||input.authorized_scope.pr_urls[0]!==pr_url)
  throw new Error('Main-verified explicit human review grant for exactly one task/PR required');
 const path=policyPath??resolve(control.work.config.instance_root,bindings.delivery.slack_routing_file??'PR_REVIEW_CHANNELS.json'),bytes=readFileSync(path),digest=createHash('sha256').update(bytes).digest('hex');
 if(input.expected_policy_digest!==digest)throw new Error('Review policy changed; reread without overwriting concurrent grants');
 const policy=JSON.parse(bytes),now=control.now();
 const revalidation=revalidationOnly?verifyRestackRevalidation(control,input,policy,now,humanAuthorizationSource):null;
 const read=nativeReadback(native_proof?.readback),at=Date.parse(native_proof?.checked_at),turn=read.turns?.find(t=>t.id===source_turn_id);
 if(native_proof?.source!=='codex_app.read_thread'||!Number.isFinite(at)||at>now+5000||!revalidationOnly&&now-at>60000||read.thread.id!==source_thread_id||read.thread.hostId!=='local'||read.thread.kind!=='codex'||
  !Number.isFinite(turn?.startedAt)||turn.startedAt*1000>now+5000||turn.items?.filter(i=>i.type==='userMessage'&&i.id===source_message_id&&(i.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')===verbatim_text).length!==1)
  throw new Error('Actual native human message identity, text and source time required');
 const task=control.work.get(task_id),execution=control.reactive.task(task_id),identity=pr_url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)$/);
 if(task?.state!=='accepted'||!task.owner_thread_id||execution?.owner_id!==task.owner_thread_id||task.data.source?.review_only===true||!identity||
  !/^[a-f0-9]{40,64}$/.test(head_sha??'')||!execution.contract.pull_requests?.some(p=>p.repository===identity[1]&&p.pr_number===Number(identity[2])))
  throw new Error('Exact original implementation owner and bound PR/head required');
 const source_at=new Date(turn.startedAt*1000).toISOString();
 const grant={task_id,pr_url,head_sha,decision:'allow_external_review',reviewed_personally:input.reviewed_personally===true,
  explicit_external_review_permission_verified:true,scope_verified:true,record_protocol:'native_pr_authorization_v1',source_thread_id,source_turn_id,source_message_id,verbatim_text,
  actual_human_verified:true,source_actor_verified:true,recorded_by_thread_id:input.recorded_by_thread_id,evidence_ref,source_at,recorded_at:new Date(now).toISOString(),...(input.merge_prohibited===true?{merge_prohibited:true}:{})};
 const authorizations=policy.personal_review?.authorizations;
 if(!Array.isArray(authorizations))throw new Error('Existing personal-review policy required');
 const existing=authorizations.find(a=>a.pr_url===pr_url&&a.head_sha===head_sha&&a.source_message_id===source_message_id);
 if(existing)return {recorded:false,already_recorded:true,task_id,pr_url,head_sha,scope_unchanged:true};
 const priorHeads=authorizations.filter(a=>a.pr_url===pr_url&&a.source_message_id===source_message_id&&a.head_sha!==head_sha);
 if(priorHeads.length){
  const check=input.head_revalidation,time=Date.parse(check?.checked_at);
  if(check?.within_authorized_scope!==true||check.source_message_id!==source_message_id||check.to_head_sha!==head_sha||
   !priorHeads.some(a=>a.head_sha===check.from_head_sha)||!present(check.evidence_ref)||!Number.isFinite(time)||time>now+5000||now-time>60000)
   throw new Error('Changed head requires fresh source-backed validation within the actual human scope');
  grant.head_revalidation=check;
 }
 if(revalidation){grant.reviewed_personally=revalidation.original.reviewed_personally;grant.head_revalidation={...grant.head_revalidation,verified_restack:revalidation.evidence};}
 authorizations.push(grant);
 const rule=reviewImpliesMergeRule(policy),derive=!!rule&&Date.parse(source_at)>=Date.parse(rule.effective_at)&&!grant.merge_prohibited;
 policy.merge_authorizations??=[];
 if(grant.merge_prohibited)policy.merge_authorizations.push({...grant,decision:'forbid_merge',head_sha:null});
 else if(derive&&!policy.merge_authorizations.some(d=>d.pr_url===pr_url&&d.head_sha===head_sha&&d.decision==='allow_merge'&&d.revoked!==true&&humanAuthorizationSource(d)))
  policy.merge_authorizations.push({...grant,decision:'allow_merge',nonordinary_change_accepted:true,derived_from_review:{rule_source_message_id:rule.source_message_id,source_message_id}});
 const temporary=path+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify(policy,null,2)+'\n',{mode:0o600});
 if(createHash('sha256').update(readFileSync(path)).digest('hex')!==digest){unlinkSync(temporary);throw new Error('Review policy changed before commit; preserve concurrent grants');}
 renameSync(temporary,path);
 return {recorded:true,task_id,pr_url,head_sha,conditional_merge_recorded:derive,source_at,scope_unchanged:true};
}
