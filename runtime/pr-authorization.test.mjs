import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {workFixture} from './test-fixtures/work.mjs';
import {nativeProof,OWNER,NOW} from './test-fixtures/reactive.mjs';
import {passedReviewGates} from './test-fixtures/pr-review.mjs';
import {bindings} from './instance.mjs';
import {assess,INBOX,CHANNEL} from './control.mjs';
import {recordPrReviewAuthorization} from './pr-authorization.mjs';
import {explicitMergeAllowed} from './pr-personal-review.mjs';
const repository=bindings.scope.repositories?.[0]??'example/service',url='https://github.com/'+repository+'/pull/1',head='a'.repeat(40),main=INBOX;
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function setup(){
 const f=workFixture(),dir=mkdtempSync(join(tmpdir(),'pr-permission-')),path=join(dir,'policy.json');
 const t=f.work.create({canonical_key:'accepted-work',title:'Original work',objective:'Preserve product scope',requirements:[{id:'done',text:'Delivery accepted'}],pull_requests:[{repository,pr_number:1}]}).task;f.accept(t.id);f.bind(t.id);const wake=f.begin(t.id);
 const rule={enabled:true,effective_at:new Date(NOW-1000).toISOString(),source_thread_id:main,source_turn_id:'rule-turn',source_message_id:'human:rule',verbatim_text:'Review permission includes conditional merge',actual_human_verified:true,source_actor_verified:true,evidence_ref:'real-rule'};
 const policy={schema_version:1,source_message_id:'human:routing',default_channel_id:CHANNEL,routes:[],personal_review:{enabled:true,thread_id:main,source_message_id:'human:risk',evidence_ref:'actual-risk',authorizations:[]},merge_authorizations:[{pr_url:url+'0',head_sha:head,decision:'allow_merge',nonordinary_change_accepted:true,source_thread_id:main,source_message_id:'prior-seven',actual_human_verified:true,evidence_ref:'existing-grant'}],review_implies_conditional_merge:rule};
 writeFileSync(path,JSON.stringify(policy));
 const text='Allow this exact PR for external review: '+url,proof=nativeProof({thread:main,turn:'human-turn',message:text,now:NOW});proof.readback.turns[0].items[0].id='human:review';
 const input={task_id:t.id,pr_url:url,head_sha:head,authorized_scope:{task_id:t.id,pr_urls:[url]},scope_verified:true,explicit_external_review_permission_verified:true,recorded_by_thread_id:main,reviewed_personally:true,source_message_id:'human:review',source_thread_id:main,source_turn_id:'human-turn',verbatim_text:text,evidence_ref:'actual-human-proof',native_proof:proof,expected_policy_digest:digest(path)};
 const p={pr_url:url,expected_head_sha:head,task_id:t.id};
 const impact={pr_url:url,head_sha:head,checked_at:new Date(NOW).toISOString(),owner_thread_id:OWNER,evidence_ref:'actual-diff',reason:'Broad product change',breaking_change:false,format_change:false,broad_impact:true,high_risk:false,labels_complete:true,labels:[]};
 const e={...passedReviewGates(NOW,head,url),verified_at:new Date(NOW).toISOString(),scope_authorized:true,authorization_ref:'original',policy_version:'v',current_policy_version:'v',stopped:false,executor_thread_id:OWNER,pr_owner:bindings.identity.github_login,pr_open:true,pr_draft:false,ordinary_change:false,material_findings_open:false,validation_current:true,technical_review_current:true,current_head_sha:head,pr_url:url,approver:bindings.delivery.approver_login,approver_identity_verified:true,approval_state:'APPROVED',approved_head_sha:head,required_checks_pass:true,repository_rules_satisfied:true,mergeable:true,admin_override:false,pr_impact:impact,review_routing:{verified:true,scope:'default',pr_url:url,head_sha:head,evidence_ref:'actual-scope'}};
 return {...f,t,wake,dir,path,input,p,e,policy,load:()=>JSON.parse(readFileSync(path)),record(){return recordPrReviewAuthorization(f.c,input,{policyPath:path});},gate(policy,patch={}){return assess('merge',p,{...e,...patch},NOW,undefined,undefined,null,null,policy);},close(){f.c.close();rmSync(dir,{recursive:true,force:true});}};
}

test('native human review grant records exact conditional merge permission while preserving prior explicit grants',()=>{
 const f=setup();try{assert.equal(f.gate(f.policy).allowed,false);const prior=f.policy.merge_authorizations[0];assert(f.record().conditional_merge_recorded);const policy=f.load();assert.deepEqual(policy.merge_authorizations[0],prior);assert.equal(policy.merge_authorizations.length,2);assert.equal(f.gate(policy).allowed,true,JSON.stringify(f.gate(policy)));
  for(const patch of [{required_checks_pass:false},{gatekeeper:undefined},{applicable_ci:undefined},{approval_state:'CHANGES_REQUESTED'},{approved_head_sha:'b'.repeat(40)},{material_findings_open:true},{repository_rules_satisfied:false},{admin_override:true},{pr_owner:'other'},{current_head_sha:'b'.repeat(40)},{stopped:true}])assert.equal(f.gate(policy,patch).allowed,false,JSON.stringify(patch));
  assert.equal(explicitMergeAllowed({...f.p,pr_url:url+'1'},f.e,policy),false);assert.equal(explicitMergeAllowed({...f.p,task_id:'other-task'},f.e,policy),false);assert.equal(explicitMergeAllowed({...f.p,expected_head_sha:'b'.repeat(40)}, {...f.e,current_head_sha:'b'.repeat(40)},policy),false);
  policy.personal_review.authorizations[0].revoked=true;assert.equal(f.gate(policy).allowed,false);
 }finally{f.close();}
});

test('legacy review sources are not promoted and agent notifications cannot create human permission',()=>{
 for(const change of[f=>{f.input.native_proof.readback.turns[0].startedAt=(NOW-2000)/1000;},f=>{f.input.native_proof.readback.turns[0].items[0].type='agentMessage';},f=>{f.input.explicit_external_review_permission_verified=false;},f=>{f.input.authorized_scope.pr_urls=[url,url+'2'];},f=>{f.input.expected_policy_digest='stale';}]){
  const f=setup();try{change(f);if(f.input.native_proof.readback.turns[0].startedAt<(NOW-1000)/1000){assert.equal(f.record().conditional_merge_recorded,false);assert.equal(f.gate(f.load()).allowed,false);}else assert.throws(()=>f.record());assert.equal(f.load().merge_authorizations.length,1);}finally{f.close();}
 }
});

test('review-only permission preserves personal inspection, explicit merge prohibitions and Functions channel holds',()=>{
 const f=setup();try{f.input.reviewed_personally=false;f.record();let policy=f.load();assert(f.gate(policy).reasons.includes('Yang_personal_review_required_before_merge'));
  policy.personal_review.authorizations[0].reviewed_personally=true;assert(f.gate(policy).allowed);
  const hold={...policy.merge_authorizations.at(-1),decision:'forbid_merge',derived_from_review:undefined,head_sha:null};policy.merge_authorizations.push(hold);assert(f.gate(policy).reasons.includes('merge_explicitly_held_by_user'));hold.revoked=true;
  policy.routes=[{scope:'lancedb_functions',channel_id:'CFUNCTIONS',delivery_hold:{active:true,source_message_id:'human:functions-hold',evidence_ref:'original-hold'}}];f.e.review_routing.scope='lancedb_functions';assert(f.gate(policy).reasons.includes('review_delivery_paused_by_user'));
  policy.pr_authorizations=[{scope:'lancedb_functions',channel_id:'CFUNCTIONS',pr_url:url,actual_human_verified:true,source_message_id:'human:single-channel',evidence_ref:'actual-single-pr-channel'}];assert(f.gate(policy).allowed);
  delete policy.review_implies_conditional_merge;assert.equal(f.gate(policy).allowed,false); // Derived record cannot outlive its rule.
 }finally{f.close();}
});

test('an explicit review-without-merge instruction records a hold instead of derived permission',()=>{
 const f=setup();try{f.input.merge_prohibited=true;assert.equal(f.record().conditional_merge_recorded,false);const policy=f.load();assert(policy.merge_authorizations.some(d=>d.pr_url===url&&d.decision==='forbid_merge'));assert(f.gate(policy,{ordinary_change:true}).reasons.includes('merge_explicitly_held_by_user'));}finally{f.close();}
});


test('merge prepare and claim recheck review revocation and preserve a paused owner',()=>{
 const f=setup();try{f.record();f.c.reviewChannels=f.load;
  const state=f.c.reactive,task=state.task(f.t.id),decision=state.decide({task_id:f.t.id,owner_thread_id:OWNER,wake_id:f.wake.id,expected_context_rev:task.context_rev,expected_plan_rev:task.plan_rev,disposition:'revise',reason:'Validated current merge stage',evidence_refs:['current-diff'],plan:{steps:[{id:'merge',action:'merge',requirement_ids:['done'],depends_on:[]}],assumptions:[{id:'ready',claim:'Current product checks pass',status:'supported',evidence_refs:['current-proof']}]}});
  f.c.feedback.ingest({repository,pr_number:1,head_sha:head,head_before:head,head_after:head,checked_at:new Date(NOW).toISOString(),evidence_ref:'full-feedback',complete:{reviews:true,review_comments:true,issue_comments:true,review_threads:true},reviews:[],review_comments:[],issue_comments:[],review_threads:[]});
  const a={key:'conditional-merge',kind:'merge',task_id:f.t.id,payload:{...f.p,runtime_context:decision.action_context},evidence:f.e};
  assert.equal(f.c.prepare(a).prepared,true);
  let policy=f.load();policy.personal_review.authorizations[0].revoked=true;writeFileSync(f.path,JSON.stringify(policy));assert.equal(f.c.claim({key:a.key,owner:OWNER,evidence:f.e}).claimed,false);
  policy.personal_review.authorizations[0].revoked=false;writeFileSync(f.path,JSON.stringify(policy));f.c.db.prepare("UPDATE rt_tasks SET mode='paused' WHERE task_id=?").run(f.t.id);assert.equal(f.c.claim({key:a.key,owner:OWNER,evidence:f.e}).claimed,false);
 }finally{f.close();}
});


test('the same human source cannot silently extend a grant to a changed head',()=>{
 const f=setup();try{f.record();f.input.expected_policy_digest=digest(f.path);f.input.head_sha='b'.repeat(40);assert.throws(()=>f.record(),/Changed head/);
  f.input.head_revalidation={from_head_sha:head,to_head_sha:f.input.head_sha,source_message_id:f.input.source_message_id,within_authorized_scope:true,checked_at:new Date(NOW).toISOString(),evidence_ref:'actual-bounded-diff-and-human-scope'};
  assert(f.record().conditional_merge_recorded);const policy=f.load();assert.equal(policy.personal_review.authorizations.length,2);assert.equal(policy.personal_review.authorizations[0].head_sha,head);assert.equal(policy.personal_review.authorizations[1].head_revalidation.evidence_ref,f.input.head_revalidation.evidence_ref);
 }finally{f.close();}
});
