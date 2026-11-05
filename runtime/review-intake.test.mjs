import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,OWNER} from './test-fixtures/reactive.mjs';
import {ReviewIntake,reviewCreationReasons} from './review-intake.mjs';
const policy={enabled:true,task_id:'T-1',owner_thread_id:OWNER,timezone:'Asia/Shanghai',daily_limit:5,github_login:'BubbleCal',authorization_ref:'actual-user'};
const candidate=(f,n)=>({owner_thread_id:OWNER,source:'vector_fts',evidence_ref:'actual-changed-paths',checked_at:new Date(f.now()).toISOString(),pr:{url:`https://github.com/lance-format/lance/pull/${n}`,state:'open',draft:false,head_sha:'a'.repeat(40),base_sha:'b'.repeat(40),author:'another-author'}});
test('daily review selections are durable, deduplicated and bounded across repeated scans',()=>{
 const f=fixture();try{f.activate();const q=new ReviewIntake(f.c,policy);
  for(let n=1;n<=5;n++)assert.equal(q.admit(candidate(f,n)).new_selection,true);
  assert.equal(new ReviewIntake(f.c,policy).admit(candidate(f,6)).reason,'daily_review_limit');
  assert.equal(q.admit(candidate(f,1)).new_selection,false);assert.equal(q.status().selections.length,5);
  f.advance(86400000);assert.equal(q.status().selections.length,0);assert.equal(q.admit(candidate(f,1)).new_selection,false);assert.equal(q.admit(candidate(f,6)).admitted,true);
  f.mode('paused');assert.throws(()=>q.admit(candidate(f,7)),/active Review Queue/);
 }finally{f.c.close();}
});
test('review intake rejects stale, draft, closed, own PRs and unbound sources',()=>{
 const f=fixture();try{f.activate();const q=new ReviewIntake(f.c,policy),a=candidate(f,1);
  for(const patch of [{owner_thread_id:'other'},{source:'arbitrary'},{checked_at:new Date(f.now()-300001).toISOString()},{pr:{...a.pr,draft:true}},{pr:{...a.pr,state:'closed'}},{pr:{...a.pr,author:'BubbleCal'}}])assert.throws(()=>q.admit({...a,...patch}));
  assert.equal(q.status().selections.length,0);
  const disabled=new ReviewIntake(f.c,{...policy,sources:{linear_queue:{enabled:false}}});
  assert.throws(()=>disabled.admit({...a,source:'linear_queue'}),/authorized source/);
 }finally{f.c.close();}
});
test('creation by the queue requires the exact admitted PR and read-only task identity',()=>{
 const f=fixture(),dir=mkdtempSync(join(tmpdir(),'review-intake-'));try{
  f.activate();f.c.work.config.instance_root=dir;mkdirSync(join(dir,'review-queue'));writeFileSync(join(dir,'review-queue/config.json'),JSON.stringify(policy));
  const q=new ReviewIntake(f.c,policy),admitted=q.admit(candidate(f,1));
  const t=f.c.work.create({canonical_key:admitted.key,title:'PR review',objective:'Review only',source:{kind:'user',review_queue_service_task_id:'T-1',review_only:true,pr_url:admitted.data.pr.url},pull_requests:[{repository:'lance-format/lance',pr_number:1}]}).task;
  const action={kind:'create_thread',task_id:t.id,evidence:{executor_thread_id:OWNER},payload:{canonical_task_key:admitted.key,review_queue_admission_key:admitted.key}};
  assert.deepEqual(reviewCreationReasons(f.c,action),[]);
  for(const kind of ['merge','slack_pr','pr_ready','notion_sync','automation_update'])assert.deepEqual(reviewCreationReasons(f.c,{...action,kind}),['review_only_task_external_action_forbidden']);
  assert.deepEqual(reviewCreationReasons(f.c,{...action,payload:{canonical_task_key:admitted.key}}),['review_queue_selection_required']);
  assert.deepEqual(reviewCreationReasons(f.c,{...action,payload:{...action.payload,canonical_task_key:'another'}}),['review_queue_selection_required']);
 }finally{f.c.close();rmSync(dir,{recursive:true,force:true});}
});
