import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

// Keep every changed/context byte, file path, mode and binary patch. Only Git's
// blob identities and hunk coordinates may differ after a parent squash.
const canonicalPatch=patch=>patch.toString('latin1').split('\n').filter(line=>!/^index [a-f0-9]+\.\.[a-f0-9]+(?: [0-7]{6})?$/.test(line))
 .map(line=>line.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/,'@@ @@')).join('\n');
const sha=value=>createHash('sha256').update(value,typeof value==='string'?'latin1':undefined).digest('hex');
export function verifyRestackRevalidation(control,input,policy,now,isHumanSource){
 const check=input.head_revalidation,actor=control.reactive.tasks().find(t=>t.owner_id===input.recorded_by_thread_id&&t.contract.service_lane==='maintenance'&&t.mode==='active'&&!t.contract.retired);
 const task=control.reactive.task(input.task_id);
 if(!actor||!task||task.mode!=='active'||['complete','needs_decision'].includes(task.status)||task.contract.execution_hold)
  throw new Error('Only existing active maintenance may revalidate an executable original task');
 const prior=policy.personal_review?.authorizations?.find(a=>a.task_id===input.task_id&&a.pr_url===input.pr_url&&a.head_sha===check?.from_head_sha&&
  a.source_message_id===input.source_message_id&&a.source_turn_id===input.source_turn_id&&a.source_thread_id===input.source_thread_id&&a.verbatim_text===input.verbatim_text&&
  a.reviewed_personally===true&&a.revoked!==true&&a.merge_prohibited!==true&&isHumanSource(a));
 const allowed=prior&&policy.merge_authorizations?.some(a=>a.task_id===prior.task_id&&a.pr_url===prior.pr_url&&a.head_sha===prior.head_sha&&a.source_message_id===prior.source_message_id&&
  a.decision==='allow_merge'&&a.nonordinary_change_accepted===true&&a.revoked!==true&&isHumanSource(a));
 const held=[...(policy.merge_authorizations??[]),...(policy.merge_holds??[])].some(a=>isHumanSource(a)&&a.revoked!==true&&a.active!==false&&
  ['forbid_merge','hold_merge'].includes(a.decision)&&(!a.pr_url||a.pr_url===input.pr_url)&&(!a.task_id||a.task_id===input.task_id)&&(a.pr_url||a.task_id));
 if(!prior||prior.source_thread_id!==prior.recorded_by_thread_id||!allowed||held)throw new Error('Unrevoked exact original personal and merge grants required; preserve explicit holds');
 const at=Date.parse(check?.checked_at),current=check?.current_pr,time=Date.parse(current?.checked_at);
 if(check?.within_authorized_scope!==true||check.source_message_id!==input.source_message_id||check.to_head_sha!==input.head_sha||
  !check.evidence_ref||!Number.isFinite(at)||at>now+5000||now-at>60000||
  current?.pr_url!==input.pr_url||current.head_sha!==input.head_sha||current.head_before!==input.head_sha||current.head_after!==input.head_sha||
  !current.evidence_ref||!Number.isFinite(time)||time>now+5000||now-time>60000)
  throw new Error('Fresh exact current PR and changed-head scope evidence required');
 const identity=input.pr_url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/),parent=check.parent_pr_url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
 if(!identity||!parent||identity[1]!==parent[1]||identity[2]===parent[2])throw new Error('A distinct original parent PR in the same repository required');
 const row=control.db.prepare('SELECT * FROM lifecycle_prs WHERE pr_key=?').get(parent[1]+'#'+parent[2]),snapshot=row?.snapshot&&JSON.parse(row.snapshot);
 if(!row||row.task_id!==input.task_id||row.owner_id!==task.owner_id||snapshot?.state!=='merged'||!Number.isFinite(Date.parse(snapshot.merged_at))||
  snapshot.head_sha!==check.old_parent||snapshot.merge_sha!==check.new_parent||!snapshot.evidence_ref||
  !task.contract.pull_requests?.some(p=>p.repository===parent[1]&&p.pr_number===Number(parent[2])))
  throw new Error('Verified merged parent transition for the same original owner/task required');
 const git=(args,encoding='utf8')=>execFileSync('git',['-C',check.repository_path,...args],{encoding,maxBuffer:16*1024*1024,timeout:10000});
 const remote=git(['remote','get-url','origin']).trim().replace(/\.git$/,'');
 if(![ 'https://github.com/'+identity[1], 'git@github.com:'+identity[1] ].includes(remote))throw new Error('Product repository identity changed');
 for(const ref of [check.from_head_sha,check.to_head_sha,check.old_parent,check.new_parent])if(!/^[a-f0-9]{40,64}$/.test(ref??''))throw new Error('Exact commit identities required');
 if(git(['rev-parse',check.from_head_sha+'^']).trim()!==check.old_parent||git(['rev-parse',check.to_head_sha+'^']).trim()!==check.new_parent)
  throw new Error('Only a direct parent squash restack may use maintenance revalidation');
 const diff=(parent,head)=>git(['diff','--binary','--no-ext-diff','--no-textconv','--full-index','--no-color','--no-renames','--ignore-submodules=none',parent,head],null),before=diff(check.old_parent,check.from_head_sha),after=diff(check.new_parent,check.to_head_sha);
 const oldDelta=canonicalPatch(before),newDelta=canonicalPatch(after);
 if(!oldDelta.trim()||!newDelta.trim()||oldDelta!==newDelta)throw new Error('Reviewed feature delta changed; maintenance cannot extend human permission');
 return {original:prior,evidence:{mode:'unchanged_reviewed_parent_restack',parent_pr_url:check.parent_pr_url,old_parent:check.old_parent,new_parent:check.new_parent,
  from_head_sha:check.from_head_sha,to_head_sha:check.to_head_sha,canonical_delta_sha256:sha(oldDelta),original_patch_sha256:sha(before),current_patch_sha256:sha(after),
  parent_evidence_ref:snapshot.evidence_ref,checked_at:new Date(now).toISOString(),recorded_by_thread_id:input.recorded_by_thread_id}};
}
