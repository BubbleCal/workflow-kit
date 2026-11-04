import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const run=promisify(execFile),args=process.argv.slice(2),option=k=>args[args.indexOf('--'+k)+1];
const repository=option('repo'),number=Number(option('pr')),output=option('output'),phase=args.includes('--phase')?option('phase'):'pre_ready';
if(!/^[\w.-]+\/[\w.-]+$/.test(repository??'')||!Number.isSafeInteger(number)||number<1||!args.includes('--output')||!['pre_ready','pre_delivery'].includes(phase))
  throw new Error('Usage: node runtime/fetch-no-ci-policy.mjs --repo owner/repo --pr NUMBER --output file.json [--phase pre_ready|pre_delivery]');
const api=async path=>JSON.parse((await run('gh',['api',...path],{maxBuffer:16*1024*1024})).stdout);
const pages=path=>api([path,'--paginate','--slurp']);
const startedAt=Date.now(),root=`repos/${repository}`,before=await api([`${root}/pulls/${number}`]),head=before.head.sha,base=before.base.sha;
if(before.base.repo.full_name!==repository)throw new Error('PR repository identity differs');
const tree=async(repo,sha)=>{
  const data=await api([`repos/${repo}/git/trees/${sha}`]);
  if(data.truncated!==false||!Array.isArray(data.tree))throw new Error('Incomplete workflow tree');
  return data.tree;
};
const workflowFiles=async(repo,sha)=>{
  let entries=await tree(repo,sha);
  for(const directory of ['.github','workflows']) {
    const entry=entries.find(x=>x.path===directory);if(!entry)return [];
    if(entry.type!=='tree')throw new Error('Workflow directory is not a verified tree');
    entries=await tree(repo,entry.sha);
  }
  return entries.filter(x=>/\.ya?ml$/i.test(x.path)).map(x=>x.path);
};
const branchPath=`${root}/branches/${encodeURIComponent(before.base.ref)}`,rulesPath=`${root}/rules/branches/${encodeURIComponent(before.base.ref)}?per_page=100`;
const reads=await Promise.allSettled([
  pages(`${root}/commits/${head}/check-runs?filter=latest&per_page=100`),pages(`${root}/commits/${head}/status?per_page=100`),
  pages(`${root}/actions/workflows?per_page=100`),pages(rulesPath),api([branchPath]),
  workflowFiles(before.head.repo.full_name,head),workflowFiles(repository,base),
]);
if(reads.some(r=>r.status==='rejected'))throw new Error('Cannot verify absence from failed provider reads: '+reads.filter(r=>r.status==='rejected').map(r=>r.reason.message).join('; '));
const [checkPages,statusPages,workflowPages,rulePages,branch,headFiles,baseFiles]=reads.map(r=>r.value);
if(!Array.isArray(checkPages)||!checkPages.length||checkPages.some(p=>!Array.isArray(p.check_runs))||
   !Array.isArray(statusPages)||!statusPages.length||statusPages.some(p=>p.sha!==head||!Array.isArray(p.statuses))||
   !Array.isArray(workflowPages)||!workflowPages.length||workflowPages.some(p=>!Array.isArray(p.workflows))||
   !Array.isArray(rulePages)||!rulePages.length||rulePages.some(p=>!Array.isArray(p)))throw new Error('Incomplete policy/check pagination');
const counts=[checkPages.flatMap(p=>p.check_runs).length,statusPages.flatMap(p=>p.statuses).length,workflowPages.flatMap(p=>p.workflows).length];
if(counts.some((n,i)=>n!==[checkPages,statusPages,workflowPages][i][0].total_count))throw new Error('Truncated CI/workflow inventory');
const [after,branchAfter,rulesAfter]=await Promise.all([api([`${root}/pulls/${number}`]),api([branchPath]),pages(rulesPath)]);
if(after.head.sha!==head||after.base.sha!==base||after.base.ref!==before.base.ref||after.head.repo.full_name!==before.head.repo.full_name||
   after.base.repo.full_name!==repository||['state','draft','updated_at'].some(k=>before[k]!==after[k])||branch.commit.sha!==base||branchAfter.commit.sha!==base||
   branch.name!==before.base.ref||branchAfter.name!==before.base.ref||branch.protected!==branchAfter.protected||JSON.stringify(rulePages)!==JSON.stringify(rulesAfter))throw new Error('PR/base/rules changed during policy collection');
if(counts.some(n=>n!==0)||headFiles.length||baseFiles.length||branch.protected!==false||rulePages.flat().length)
  throw new Error('Verified-no-hosted-CI path is not applicable; preserve ordinary CI/policy handling');
const at=new Date(startedAt).toISOString(),ref=resolve(output),absence={repository,pr_number:number,head_sha:head,checked_at:at,evidence_ref:ref,complete:true,
  base_ref:before.base.ref,base_before:base,base_after:after.base.sha,base_ref_before:before.base.ref,base_ref_after:after.base.ref,
  check_runs:{complete:true,count:0},statuses:{complete:true,count:0},workflows:{complete:true,count:0},
  workflow_files:{complete:true,head:headFiles,base:baseFiles},branch_policy:{complete:true,protected:false,effective_rules:rulePages.flat()}};
const result={applicable_ci:{pr_url:before.html_url,head_sha:head,head_before:head,head_after:after.head.sha,checked_at:at,evidence_ref:ref,policy_ref:ref,
  complete:true,phase,mode:'verified_no_hosted_ci',checks:[],no_hosted_ci:absence},
  snapshot:{repository,pr_number:number,state:after.merged?'merged':after.state,draft:after.draft,head_sha:head,updated_at:after.updated_at,
    merged_at:after.merged_at,merge_sha:after.merged?after.merge_commit_sha:null,checked_at:at,evidence_ref:ref,approval_state:'unknown',checks_state:'unknown',
    ci:{head_sha:head,checked_at:at,evidence_ref:ref,complete:true,scope:'observed',required_policy:'verified_no_hosted_ci',checks:[]}},
  raw:{pr_before:before,pr_after:after,branch_before:branch,branch_after:branchAfter,check_pages:checkPages,status_pages:statusPages,workflow_pages:workflowPages,rule_pages:rulePages},
  collected_at:new Date().toISOString(),local_validation:'Not asserted by this collector. Attach actual same-head local validation evidence before control prepare/claim/final send.'};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
process.stdout.write(JSON.stringify({evidence_ref:ref,repository,pr_number:number,head,verified_no_hosted_ci:true,checked_at:at,local_validation_still_required:true})+'\n');
