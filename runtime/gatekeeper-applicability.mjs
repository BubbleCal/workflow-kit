import {readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {bindings} from './instance.mjs';
import {nativeReadback} from './native-queue.mjs';
import {readReviewChannels} from './pr-review-routing.mjs';
const present=v=>typeof v==='string'&&!!v.trim();
const hash=v=>createHash('sha256').update(v).digest('hex');
const identity=url=>url?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/);
const waiverText=text=>{
 const match=text?.match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/);
 if(!match)return text;
 try{return JSON.parse(match[1]).map(r=>r.answer).join('\n');}catch{return '';}
};
const human=r=>r?.record_protocol==='native_gatekeeper_applicability_v1'&&r.actual_human_verified===true&&r.source_actor_verified===true&&r.source_thread_id===bindings.threads.inbox&&present(r.source_turn_id)&&present(r.source_message_id)&&present(r.verbatim_text)&&present(r.evidence_ref)&&present(r.native_source_digest)&&r.revoked!==true;

// Empty reviews cannot prove an external GitHub App is absent. A repository-owner
// declaration is authoritative until superseded or contradicted by actual activity.
export function gatekeeperExemption(kind,p,e,policy){
 const id=identity(p.pr_url??p.message),g=e.gatekeeper,a=g?.applicability;if(!id||!a)return false;
 const rules=policy??readReviewChannels()?.gatekeeper_applicability;
 if(a.status==='explicit_review_exception')return ['slack_pr','review_decision'].includes(kind)&&(rules?.review_exceptions??[]).some(r=>human(r)&&r.source_message_id===a.policy_source_message_id&&r.repository===id[1]&&r.pr_url===(p.pr_url??p.message)&&r.head_sha===p.expected_head_sha&&r.scope==='external_review_only'&&(!e.task_id||e.task_id===r.task_id));
 if(a.status!=='not_configured')return false;
 const r=(rules?.repositories??[]).filter(r=>r.repository===id[1]).at(-1);
 if(!human(r)||r.status!=='not_configured'||r.source_message_id!==a.policy_source_message_id||['configured','unknown'].includes(g.configuration_status)||e.applicable_ci?.checks?.some(c=>/gatekeeper/i.test(c.name??'')))return false;
 const login=v=>String(v??'').replace(/\[bot\]$/,'').toLowerCase();
 return !g.reviews.some(review=>review.commit_id===p.expected_head_sha&&(/gatekeeper/i.test(review.user?.login??review.author?.login??'')||g.identity?.verified===true&&login(review.user?.login??review.author?.login)===login(g.identity.login)));
}

// This changes applicability only, never feedback, CI, channel or merge authority.
export function recordGatekeeperApplicability(control,input,{policyPath}={}){
 const {task_id,repository,pr_url,head_sha,status,source_thread_id,source_turn_id,source_message_id,verbatim_text,native_proof,evidence_ref}=input;
 const now=control.now(),id=identity(pr_url),t=control.reactive.task(task_id),catalog=control.work.get(task_id);
 const path=policyPath??resolve(control.work.config.instance_root,bindings.delivery.slack_routing_file??'PR_REVIEW_CHANNELS.json'),bytes=readFileSync(path);
 if(hash(bytes)!==input.expected_policy_digest)throw Error('Review policy changed; preserve concurrent authorizations');
 if(input.actual_human_verified!==true||input.scope_verified!==true||!present(evidence_ref)||source_thread_id!==bindings.threads.inbox||!id||id[1]!==repository||!control.work.config.scope.repositories.includes(repository)||!t||t.owner_id!==catalog?.owner_thread_id||catalog.state!=='accepted'||!t.contract.pull_requests?.some(p=>p.repository===repository&&p.pr_number===Number(id[2]))||!/^[a-f0-9]{40,64}$/.test(head_sha??''))throw Error('Exact accepted original task/PR and human-verified repository scope required');
 const at=Date.parse(native_proof?.checked_at),read=nativeReadback(native_proof?.readback),turn=read.turns?.find(t=>t.id===source_turn_id);
 if(native_proof?.source!=='codex_app.read_thread'||!present(native_proof.evidence_ref)||!Number.isFinite(at)||now-at>60000||at>now+5000||read.thread.id!==source_thread_id||read.thread.hostId!=='local'||turn?.items?.filter(i=>i.type==='userMessage'&&i.id===source_message_id&&(i.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')===verbatim_text).length!==1)throw Error('Fresh exact native human instruction required');
 const context=input.pr_context,checked=Date.parse(context?.checked_at);
 if(!present(context?.evidence_ref)||!Number.isFinite(checked)||now-checked>60000||checked>now+5000||[context.before,context.after].some(p=>p?.number!==Number(id[2])||p?.base?.repo?.full_name!==repository||p?.head?.sha!==head_sha||p?.state!=='open'))throw Error('Fresh stable real PR/head context required');
 const mode=input.mode;
 if(mode==='repository'){
  if(!['configured','not_configured'].includes(status)||!/gatekeeper/i.test(verbatim_text)||(status==='not_configured'?!/没配置|未配置|没有配置|not (?:configured|enabled)/i.test(verbatim_text):!/已配置|(?:is|has been) configured/i.test(verbatim_text)))throw Error('Explicit repository configuration declaration required');
 }else if(mode==='review_exception'){
  const answer=waiverText(verbatim_text);
  if(input.authorized_scope?.pr_urls?.length!==1||input.authorized_scope.pr_urls[0]!==pr_url||input.authorized_scope.head_sha!==head_sha||!new RegExp(`#${id[2]}(?![0-9])`).test(answer)||/(?:不要|拒绝|不豁免|不送审|do not|don't|not waive)/i.test(answer)||!/(?:豁免.*送审|waiv[e\w]*.*review)/is.test(answer))throw Error('Explicit human review waiver for one exact PR/head required');
 }else throw Error('Use repository configuration or review_exception');
 const record={record_protocol:'native_gatekeeper_applicability_v1',task_id,repository,...(mode==='repository'?{status}:{pr_url,head_sha,scope:'external_review_only'}),source_thread_id,source_turn_id,source_message_id,verbatim_text,evidence_ref,actual_human_verified:true,source_actor_verified:true,native_source_digest:hash(JSON.stringify(native_proof.readback)),context_ref:context.evidence_ref,recorded_at:new Date(now).toISOString()};
 const policy=JSON.parse(bytes);policy.gatekeeper_applicability??={repositories:[],review_exceptions:[]};
 const records=mode==='repository'?policy.gatekeeper_applicability.repositories:policy.gatekeeper_applicability.review_exceptions;
 if(records.some(r=>r.repository===repository&&r.source_message_id===source_message_id&&(mode==='repository'?r.status===status:r.pr_url===pr_url&&r.head_sha===head_sha)))return{recorded:false,duplicate:true,scope:mode};
 records.push(record);const tmp=path+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(policy,null,2)+'\n',{mode:0o600});
 if(hash(readFileSync(path))!==input.expected_policy_digest){unlinkSync(tmp);throw Error('Review policy changed before commit');}renameSync(tmp,path);
 return{recorded:true,scope:mode,repository,...(mode==='review_exception'?{pr_url,head_sha}:{}),source_message_id,merge_permission_granted:false};
}
