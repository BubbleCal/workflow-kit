import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const run = promisify(execFile), args = process.argv.slice(2);
const option = name => args[args.indexOf('--' + name) + 1];
const repository = option('repo'), number = Number(option('pr')), output = option('output');
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !Number.isSafeInteger(number) || number < 1 || !args.includes('--output'))
  throw new Error('Usage: node runtime/fetch-merge-approval.mjs --repo owner/repo --pr NUMBER --output file.json');
const api = async values => {
  const result = await run('gh', ['api', ...values], { maxBuffer:16*1024*1024 });
  const data = JSON.parse(result.stdout);
  if (data?.errors) throw new Error('Incomplete GitHub approval/rule response');
  return data;
};
const [owner,name] = repository.split('/');
const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){url state isDraft headRefOid baseRefName updatedAt reviewDecision mergeable mergeStateStatus baseRef{branchProtectionRule{id pattern dismissesStaleReviews requireLastPushApproval}}}}}';
const readPR = async () => {
  const result = await api(['graphql','-f','query='+query,'-F','owner='+owner,'-F','name='+name,'-F','number='+number]);
  const pr = result.data?.repository?.pullRequest;
  if (!pr?.baseRef || !Object.hasOwn(pr.baseRef,'branchProtectionRule')) throw new Error('Applicable branch-protection state is unavailable');
  return pr;
};
const started = new Date().toISOString(), before = await readPR();
const reads = await Promise.allSettled([
  api([`repos/${repository}/pulls/${number}/reviews?per_page=100`,'--paginate','--slurp']),
  api([`repos/${repository}/rules/branches/${encodeURIComponent(before.baseRefName)}`,'--paginate','--slurp']),
]);
if (reads.some(r => r.status === 'rejected')) throw new Error('Approval/rule collection failed: ' + reads.filter(r => r.status === 'rejected').map(r => r.reason.message).join('; '));
if (!reads.every(r => Array.isArray(r.value) && r.value.every(Array.isArray))) throw new Error('Incomplete paginated reviews or rules');
const after = await readPR();
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('PR or approval changed during collection; discard and reconcile at the next safe boundary');
const snapshot = { pr_url:after.url,head_sha:after.headRefOid,head_before:before.headRefOid,head_after:after.headRefOid,
  base_ref:after.baseRefName,base_before:before.baseRefName,base_after:after.baseRefName,
  checked_at:started,evidence_ref:resolve(output),review_decision:after.reviewDecision,merge_state_status:after.mergeStateStatus,
  reviews_complete:true,reviews:reads[0].value.flat(),rules:{complete:true,base_ref:after.baseRefName,checked_at:started,
    evidence_ref:resolve(output),branch_protection:after.baseRef.branchProtectionRule,branch_rules:reads[1].value.flat()} };
writeFileSync(output, JSON.stringify(snapshot,null,2)+'\n', { mode:0o600 });
process.stdout.write(JSON.stringify({snapshot_file:resolve(output),head:snapshot.head_sha,review_decision:snapshot.review_decision,review_count:snapshot.reviews.length,checked_at:started})+'\n');
