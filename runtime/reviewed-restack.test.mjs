import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {workFixture} from './test-fixtures/work.mjs';
import {nativeProof,OWNER} from './test-fixtures/reactive.mjs';
import {bindings} from './instance.mjs';
import {recordPrReviewAuthorization} from './pr-authorization.mjs';
import {explicitMergeAllowed} from './pr-personal-review.mjs';
import {reviewStageReasons} from './pr-review-gates.mjs';
import {passedReviewGates} from './test-fixtures/pr-review.mjs';
const MAINT='66666666-6666-4666-8666-666666666666';
function setup(){
 const f=workFixture(),dir=mkdtempSync(join(tmpdir(),'reviewed-restack-')),path=join(dir,'policy.json'),repo=bindings.scope.repositories[0],url=`https://github.com/${repo}/pull/1`;
 const git=args=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(['init','-q']);git(['config','user.name','Test']);git(['config','user.email','test@example.invalid']);git(['remote','add','origin','https://github.com/'+repo+'.git']);
 const base=Array.from({length:20},(_,i)=>'# context '+i).join('\n')+'\ndef run(x):\n    return x\n';writeFileSync(join(dir,'feature.py'),base);git(['add','.']);git(['commit','-qm','parent feature']);const oldParent=git(['rev-parse','HEAD']);
 writeFileSync(join(dir,'feature.py'),base.replace('return x','return x + 1'));git(['commit','-qam','reviewed feature']);const oldHead=git(['rev-parse','HEAD']);
 git(['checkout','-qb','restacked',oldParent]);writeFileSync(join(dir,'feature.py'),'# accepted upstream context\n'+base);git(['commit','-qam','merged parent context']);const newParent=git(['rev-parse','HEAD']);
 writeFileSync(join(dir,'feature.py'),'# accepted upstream context\n'+base.replace('return x','return x + 1'));git(['commit','-qam','same feature restacked']);const newHead=git(['rev-parse','HEAD']);
 const t=f.work.create({canonical_key:'stacked-feature',title:'Accepted feature',objective:'Original reviewed product change',requirements:[{id:'done',text:'Accepted delivery'}],pull_requests:[{repository:repo,pr_number:1},{repository:repo,pr_number:2}]}).task;f.accept(t.id);f.bind(t.id);f.begin(t.id);
 const main=bindings.threads.inbox,text='Allow this existing stack for review and merge',proof=nativeProof({thread:main,turn:'original-human',message:text,now:f.now()});proof.readback.turns[0].items[0].id='human:original';
 const rule={enabled:true,effective_at:new Date(f.now()-1000).toISOString(),source_thread_id:main,source_turn_id:'rule',source_message_id:'human:rule',verbatim_text:'Review includes merge',actual_human_verified:true,source_actor_verified:true,evidence_ref:'actual-rule'};
 const policy={personal_review:{authorizations:[]},merge_authorizations:[],review_implies_conditional_merge:rule};writeFileSync(path,JSON.stringify(policy));
 const digest=()=>createHash('sha256').update(readFileSync(path)).digest('hex');
 const input={task_id:t.id,pr_url:url,head_sha:oldHead,authorized_scope:{task_id:t.id,pr_urls:[url]},scope_verified:true,explicit_external_review_permission_verified:true,recorded_by_thread_id:main,reviewed_personally:true,source_thread_id:main,source_turn_id:'original-human',source_message_id:'human:original',verbatim_text:text,evidence_ref:'actual-human-proof',native_proof:proof,expected_policy_digest:digest()};
 recordPrReviewAuthorization(f.c,input,{policyPath:path});
 const maintenance=f.work.create({id:'T-176',canonical_key:'maintenance',title:'Maintenance',objective:'Guarded workflow repair',workspace:'/task',requirements:[{id:'audit',text:'Preserve scope'}]}).task;f.accept(maintenance.id);f.bind(maintenance.id,MAINT);
 f.c.reactive.adopt({task_id:maintenance.id,owner_thread_id:MAINT,source_message_id:'human:maintenance',actual_human_verified:true,contract:{...f.work.contract(maintenance.id),service_lane:'maintenance'}});
 f.c.reactive.setMode({task_id:'T-176',mode:'active',source_message_id:'human:maintenance',actual_human_verified:true,native_binding:nativeProof({thread:MAINT,workspace:'/task',status:'completed',now:f.now()}),queue_compatibility_verified:true,legacy_quiescent:true});
 f.c.lifecycle.track({repository:repo,pr_number:2,task_id:t.id,owner_thread_id:OWNER,authorization_ref:'original-parent'});
 f.c.lifecycle.observe({repository:repo,pr_number:2,head_sha:oldParent,merge_sha:newParent,state:'merged',draft:false,merged_at:new Date(f.now()).toISOString(),updated_at:new Date(f.now()).toISOString(),checked_at:new Date(f.now()).toISOString(),evidence_ref:'actual-parent-merge'});
 f.advance(61000);Object.assign(input,{revalidation_only:true,recorded_by_thread_id:MAINT,head_sha:newHead,expected_policy_digest:digest(),head_revalidation:{from_head_sha:oldHead,to_head_sha:newHead,source_message_id:input.source_message_id,within_authorized_scope:true,checked_at:new Date(f.now()).toISOString(),evidence_ref:'actual-restack-source',parent_pr_url:`https://github.com/${repo}/pull/2`,old_parent:oldParent,new_parent:newParent,repository_path:dir,current_pr:{pr_url:url,head_sha:newHead,head_before:newHead,head_after:newHead,checked_at:new Date(f.now()).toISOString(),evidence_ref:'actual-current-PR'}}});
 return {...f,dir,path,input,t,git,newHead,oldHead,newParent,record:()=>recordPrReviewAuthorization(f.c,input,{policyPath:path}),policy:()=>JSON.parse(readFileSync(path)),close(){f.c.close();rmSync(dir,{recursive:true,force:true});}};
}

test('existing maintenance revalidates identical reviewed delta after a verified parent squash without claiming to be main',()=>{
 const f=setup();try{f.c.db.prepare("UPDATE lifecycle_prs SET retired=1").run();const old=f.policy();assert(f.record().recorded);const p=f.policy();assert.deepEqual(p.personal_review.authorizations[0],old.personal_review.authorizations[0]);const a=p.personal_review.authorizations[1];assert.equal(a.recorded_by_thread_id,MAINT);assert.equal(a.head_revalidation.verified_restack.mode,'unchanged_reviewed_parent_restack');assert.equal(a.source_at,p.personal_review.authorizations[0].source_at);
  assert(explicitMergeAllowed({task_id:f.t.id,pr_url:f.input.pr_url,expected_head_sha:f.newHead},{task_id:f.t.id,pr_url:f.input.pr_url,current_head_sha:f.newHead},p));
  const e=passedReviewGates(f.now(),f.newHead,f.input.pr_url);e.gatekeeper.reviews[0].commit_id=f.oldHead;e.gatekeeper.skip_check={status:'completed',conclusion:'skipped',head_sha:f.newHead};
  assert(reviewStageReasons('slack_pr',{pr_url:f.input.pr_url,expected_head_sha:f.newHead},e,f.now()).includes('current_head_Gatekeeper_approval_required'));
 }finally{f.close();}
});

test('maintenance rejects whitespace-changing delta even when a stable Git patch id ignores it',()=>{
 const f=setup();try{f.git(['checkout','-q',f.newParent]);const p=join(f.dir,'feature.py');writeFileSync(p,readFileSync(p,'utf8').replace('return x','return  x + 1'));f.git(['commit','-qam','changed whitespace']);const changed=f.git(['rev-parse','HEAD']);f.input.head_sha=changed;f.input.head_revalidation.to_head_sha=changed;Object.assign(f.input.head_revalidation.current_pr,{head_sha:changed,head_before:changed,head_after:changed});const patchId=(parent,head)=>execFileSync('git',['patch-id','--stable'],{encoding:'utf8',input:f.git(['diff','--binary',parent,head])}).trim().split(' ')[0];assert.equal(patchId(f.input.head_revalidation.old_parent,f.oldHead),patchId(f.newParent,changed));assert.throws(()=>f.record(),/delta changed/);assert.equal(f.policy().personal_review.authorizations.length,1);}finally{f.close();}
});

const rejectedRestacks=[
 ['foreign actor',f=>{f.input.recorded_by_thread_id=OWNER;}],
 ['same PR as parent',f=>{f.input.head_revalidation.parent_pr_url=f.input.pr_url;}],
 ['wrong parent merge',f=>{f.input.head_revalidation.new_parent=f.oldHead;}],
 ['changed current head',f=>{f.input.head_revalidation.current_pr.head_after=f.oldHead;}],
 ['stale source',f=>{f.advance(61000);}],
 ['revoked original review',f=>{const p=f.policy();p.personal_review.authorizations[0].revoked=true;writeFileSync(f.path,JSON.stringify(p));f.input.expected_policy_digest=createHash('sha256').update(readFileSync(f.path)).digest('hex');}],
 ['paused original owner',f=>{f.c.db.prepare("UPDATE rt_tasks SET mode='paused' WHERE task_id=?").run(f.t.id);}],
 ['another target PR',f=>{f.input.pr_url+='9';f.input.authorized_scope.pr_urls=[f.input.pr_url];}],
 ['explicit no-merge hold',f=>{const p=f.policy();p.merge_authorizations.push({...p.merge_authorizations[0],decision:'forbid_merge',head_sha:null});writeFileSync(f.path,JSON.stringify(p));f.input.expected_policy_digest=createHash('sha256').update(readFileSync(f.path)).digest('hex');}],
];
for(const [name,mutate] of rejectedRestacks)test('maintenance restack rejects '+name,()=>{
 const f=setup();try{mutate(f);assert.throws(()=>f.record());assert.equal(f.policy().personal_review.authorizations.length,1);}finally{f.close();}
});

test('revoking the original human scope also invalidates its maintenance restack record',()=>{
 const f=setup();try{f.record();const p=f.policy();p.personal_review.authorizations[0].revoked=true;assert.equal(explicitMergeAllowed({task_id:f.t.id,pr_url:f.input.pr_url,expected_head_sha:f.newHead},{task_id:f.t.id,pr_url:f.input.pr_url,current_head_sha:f.newHead},p),false);}finally{f.close();}
});
