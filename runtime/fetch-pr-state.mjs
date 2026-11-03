import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const run = promisify(execFile), args = process.argv.slice(2), option = k => args[args.indexOf('--'+k)+1];
const repository = option('repo'), number = Number(option('pr')), output = option('output');
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !Number.isSafeInteger(number) || number < 1 || !args.includes('--output'))
  throw new Error('Usage: node runtime/fetch-pr-state.mjs --repo owner/repo --pr NUMBER --output file.json');
const api = async values => {
  const result = await run('gh',['api',...values],{maxBuffer:32*1024*1024});
  const data = JSON.parse(result.stdout);
  if (data?.errors) throw new Error('Partial GitHub response');
  return data;
};
const root = `repos/${repository}`, before = await api([`${root}/pulls/${number}`]);
const ciAt = new Date().toISOString(), head = before.head.sha;
let checks, statuses;
if (before.state === 'open' && !before.merged) {
  const reads = await Promise.allSettled([
    api([`${root}/commits/${head}/check-runs?filter=latest&per_page=100`,'--paginate','--slurp']),
    api([`${root}/commits/${head}/status?per_page=100`,'--paginate','--slurp']),
  ]);
  if (reads.some(r=>r.status==='rejected')) throw new Error('CI source read failed: '+reads.filter(r=>r.status==='rejected').map(r=>r.reason.message).join('; '));
  const [runPages,statusPages] = reads.map(r=>r.value);
  if (!Array.isArray(runPages) || !runPages.length || runPages.some(p=>!Array.isArray(p.check_runs)) ||
      !Array.isArray(statusPages) || !statusPages.length || statusPages.some(p=>!Array.isArray(p.statuses) || p.sha!==head))
    throw new Error('Incomplete exact-head check/status pages');
  checks = runPages.flatMap(p=>p.check_runs); statuses = statusPages.flatMap(p=>p.statuses);
  if (checks.length < runPages[0].total_count || statuses.length < statusPages[0].total_count || checks.some(c=>c.head_sha!==head))
    throw new Error('Truncated or mixed-head CI source');
}
const pr = await api([`${root}/pulls/${number}`]);
if (pr.head.sha!==head || ['state','draft','merged','updated_at'].some(k=>pr[k]!==before[k]))
  throw new Error('PR changed during collection; discard and refresh before routing');
const snapshot = { repository, pr_number:number, state:pr.merged?'merged':pr.state, draft:pr.draft,
  head_sha:head, updated_at:pr.updated_at, merged_at:pr.merged_at, merge_sha:pr.merged?pr.merge_commit_sha:null,
  approval_state:'unknown', checks_state:'unknown', checked_at:new Date().toISOString(), evidence_ref:resolve(output),
  ...(checks ? {ci:{head_sha:head,checked_at:ciAt,evidence_ref:resolve(output),complete:true,scope:'observed',required_policy:'not_evaluated',
    checks:[...checks.map(c=>({kind:'check_run',id:String(c.id),name:c.name,head_sha:c.head_sha,status:c.status,
      conclusion:c.conclusion,completed_at:c.completed_at,url:c.html_url,app_id:c.app?.id,suite_id:c.check_suite?.id})),
      ...statuses.map(s=>({kind:'status',id:String(s.id),name:s.context,head_sha:head,status:s.state==='pending'?'in_progress':'completed',
        conclusion:s.state,completed_at:s.updated_at,url:s.target_url}))]}} : {}) };
writeFileSync(output,JSON.stringify(snapshot,null,2)+'\n',{mode:0o600});
process.stdout.write(JSON.stringify({snapshot_file:resolve(output),head,checks:snapshot.ci?.checks.length??0,checked_at:snapshot.checked_at})+'\n');
