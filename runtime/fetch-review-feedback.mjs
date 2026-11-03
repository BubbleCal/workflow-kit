import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const run=promisify(execFile);
const args=process.argv.slice(2),option=name=>args[args.indexOf('--'+name)+1];
const repository=option('repo'),number=Number(option('pr')),output=option('output');
if(!/^[\w.-]+\/[\w.-]+$/.test(repository??'')||!Number.isSafeInteger(number)||number<1||!args.includes('--output'))throw new Error('Usage: node runtime/fetch-review-feedback.mjs --repo owner/repo --pr number --output file.json');
const api=async values=>{
  const result=await run('gh',['api',...values],{maxBuffer:32*1024*1024});
  const data=JSON.parse(result.stdout);
  if(data?.errors||Array.isArray(data)&&data.some(x=>x?.errors))throw new Error('GitHub returned partial/error feedback data');
  return data;
};
const root=`repos/${repository}/pulls/${number}`,before=await api([root]);
const [owner,name]=repository.split('/');
const query='query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated comments(first:1){nodes{databaseId}}}}}}}';
const feeds=await Promise.allSettled([
  api([root+'/reviews?per_page=100','--paginate','--slurp']),
  api([root+'/comments?per_page=100','--paginate','--slurp']),
  api([`repos/${repository}/issues/${number}/comments?per_page=100`,'--paginate','--slurp']),
  api(['graphql','--paginate','--slurp','-f','query='+query,'-F','owner='+owner,'-F','name='+name,'-F','number='+number]),
]);
const failures=feeds.filter(x=>x.status==='rejected');if(failures.length)throw new Error('Feedback collection failed: '+failures.map(x=>x.reason.message).join('; '));
const [reviews,reviewComments,issueComments,threadPages]=feeds.map(x=>x.value);
const finalPage=threadPages.at(-1)?.data?.repository?.pullRequest?.reviewThreads;
if(!finalPage||finalPage.pageInfo.hasNextPage)throw new Error('Review-thread pagination is incomplete');
const after=await api([root]);
if(before.head.sha!==after.head.sha || ['state','draft','merged','updated_at'].some(k=>before[k]!==after[k]))
  throw new Error('PR state or feedback changed during collection; discard snapshot and retry at the next safe boundary');
const snapshot={repository,pr_number:number,head_sha:after.head.sha,head_before:before.head.sha,head_after:after.head.sha,
  checked_at:new Date().toISOString(),evidence_ref:resolve(output),collector:'gh REST all pages plus GraphQL thread state; read-only',
  complete:{reviews:true,review_comments:true,issue_comments:true,review_threads:true},reviews:reviews.flat(),review_comments:reviewComments.flat(),issue_comments:issueComments.flat(),
  review_threads:threadPages.flatMap(p=>p.data.repository.pullRequest.reviewThreads.nodes)};
snapshot.pr = { repository, pr_number:number, head_sha:after.head.sha, state:after.merged?'merged':after.state,
  draft:after.draft, updated_at:after.updated_at, merged_at:after.merged_at,
  merge_sha:after.merged?after.merge_commit_sha:null, checked_at:snapshot.checked_at, evidence_ref:snapshot.evidence_ref,
  approval_state:'unknown', checks_state:'unknown' };
writeFileSync(output,JSON.stringify(snapshot,null,2)+'\n',{mode:0o600});
process.stdout.write(JSON.stringify({snapshot_file:resolve(output),head:snapshot.head_sha,counts:{reviews:snapshot.reviews.length,inline:snapshot.review_comments.length,issue:snapshot.issue_comments.length,threads:snapshot.review_threads.length},checked_at:snapshot.checked_at})+'\n');
