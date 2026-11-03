import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2), option = k => args[args.indexOf('--'+k)+1];
const repository = option('repo'), number = Number(option('pr')), output = option('output');
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !Number.isSafeInteger(number) || number < 1 || !args.includes('--output'))
  throw new Error('Usage: node runtime/fetch-pr-state.mjs --repo owner/repo --pr NUMBER --output file.json');
const pr = JSON.parse(execFileSync('gh',['api',`repos/${repository}/pulls/${number}`],{encoding:'utf8',maxBuffer:4*1024*1024}));
const snapshot = { repository, pr_number:number, state:pr.merged?'merged':pr.state, draft:pr.draft,
  head_sha:pr.head.sha, updated_at:pr.updated_at, merged_at:pr.merged_at, merge_sha:pr.merged?pr.merge_commit_sha:null,
  approval_state:'unknown', checks_state:'unknown', checked_at:new Date().toISOString(), evidence_ref:resolve(output) };
writeFileSync(output,JSON.stringify(snapshot,null,2)+'\n',{mode:0o600});
process.stdout.write(JSON.stringify(snapshot)+'\n');
