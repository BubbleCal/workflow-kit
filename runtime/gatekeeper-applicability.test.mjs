import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {reviewStageReasons} from './pr-review-gates.mjs';
import {recordGatekeeperApplicability} from './gatekeeper-applicability.mjs';
import {passedReviewGates} from './test-fixtures/pr-review.mjs';
import {bindings} from './instance.mjs';

const now=Date.parse('2026-11-11T10:00:00Z'),head='a'.repeat(40),url='https://github.com/example/service/pull/6';
const payload={pr_url:url,expected_head_sha:head};
const grant={record_protocol:'native_gatekeeper_applicability_v1',actual_human_verified:true,source_actor_verified:true,source_thread_id:bindings.threads.inbox,source_turn_id:'human-turn',source_message_id:'human-source',verbatim_text:'这个 repo 没配置 gatekeeper',evidence_ref:'native-human',native_source_digest:'source-digest',repository:'example/service',status:'not_configured'};
const rules=()=>({repositories:[structuredClone(grant)],review_exceptions:[]});
function absent(){const e=passedReviewGates(now,head,url);delete e.gatekeeper.identity;e.gatekeeper.reviews=[];e.gatekeeper.applicability={status:'not_configured',policy_source_message_id:'human-source'};return e;}
const reasons=(e=absent(),p=payload,r=rules(),kind='slack_pr')=>reviewStageReasons(kind,p,e,now,60000,r);

test('an explicit repository configuration source permits review without inventing a bot approval',()=>{
 assert.deepEqual(reasons(),[]);assert.deepEqual(reasons(absent(),payload,rules(),'review_decision'),[]);
 assert.deepEqual(absent().gatekeeper.reviews,[]);
 const e=absent();delete e.gatekeeper.applicability;assert.ok(reasons(e).includes('fresh_verified_Gatekeeper_surface_required'));
});
test('empty reviews, unknown or configured repositories and contradictory current signals never establish absence',()=>{
 for(const r of [{repositories:[],review_exceptions:[]},{repositories:[{...grant,status:'configured'}]}, {repositories:[{...grant,repository:'other/repo'}]}, {repositories:[{...grant,actual_human_verified:false}]}, {repositories:[{...grant,revoked:true}]}])assert.ok(reasons(absent(),payload,r).length);
 for(const patch of [{configuration_status:'configured'},{configuration_status:'unknown'},{reviews_complete:false},{head_after:'b'.repeat(40)},{checked_at:new Date(now-61000).toISOString()},{semantic_assessment_ref:''},{reviews:[{commit_id:head,user:{login:'lance-gatekeeper[bot]'},state:'CHANGES_REQUESTED'}]}]){const e=absent();Object.assign(e.gatekeeper,patch);assert.ok(reasons(e).length);}
 const e=absent();e.applicable_ci.checks.push({id:'gk',name:'Gatekeeper',head_sha:head,applicable:false,status:'completed',conclusion:'skipped',exclusion_reason:'skip',applicability_ref:'source'});assert.ok(reasons(e).length);
});
test('repository absence does not waive failing CI, stale evidence or a changed PR/head',()=>{
 const e=absent();e.applicable_ci.checks[0].conclusion='failure';assert.ok(reasons(e).includes('current_applicable_CI_not_passed'));
 assert.ok(reasons(absent(),{...payload,expected_head_sha:'b'.repeat(40)}).length);
 assert.ok(reasons(absent(),{...payload,pr_url:'https://github.com/other/repo/pull/6'}).length);
 const r=rules();r.repositories.push({...grant,source_message_id:'new-config',status:'configured'});assert.ok(reasons(absent(),payload,r).length);
});
test('an exact human review waiver never transfers to another PR, task, head or merge',()=>{
 const e=absent();e.gatekeeper.applicability={status:'explicit_review_exception',policy_source_message_id:'human-waiver'};
 const r={repositories:[],review_exceptions:[{...grant,task_id:'T-1',pr_url:url,head_sha:head,scope:'external_review_only',source_message_id:'human-waiver'}]};
 assert.deepEqual(reasons(e,payload,r),[]);assert.deepEqual(reasons(e,payload,r,'review_decision'),[]);
 for(const p of [{...payload,pr_url:url.replace('/6','/7')},{...payload,expected_head_sha:'b'.repeat(40)}])assert.ok(reasons(e,p,r).length);
 assert.ok(reasons({...e,task_id:'T-2'},payload,r).length);assert.ok(reasons(e,payload,r,'merge').length);
});

function registration(){
 const root=mkdtempSync(join(tmpdir(),'gk-scope-')),path=join(root,'policy.json'),base={personal_review:{authorizations:[{unrelated:true}]},merge_authorizations:[{unrelated:true}]};writeFileSync(path,JSON.stringify(base));
 const digest=()=>createHash('sha256').update(readFileSync(path)).digest('hex');
 const pr={number:6,state:'open',base:{repo:{full_name:'example/service'}},head:{sha:head}};
 const source=grant.verbatim_text;
 const input={mode:'repository',status:'not_configured',task_id:'T-1',repository:'example/service',pr_url:url,head_sha:head,actual_human_verified:true,scope_verified:true,
  source_thread_id:bindings.threads.inbox,source_turn_id:'human-turn',source_message_id:'human-source',verbatim_text:source,evidence_ref:'native-human',expected_policy_digest:digest(),
  native_proof:{source:'codex_app.read_thread',checked_at:new Date(now).toISOString(),evidence_ref:'exact-native',readback:{schemaVersion:1,thread:{id:bindings.threads.inbox,hostId:'local'},turns:[{id:'human-turn',items:[{type:'userMessage',id:'human-source',content:[{type:'text',text:source}]}]}]}},
  pr_context:{checked_at:new Date(now).toISOString(),evidence_ref:'actual-pr',before:pr,after:pr}};
 const control={now:()=>now,reactive:{task:()=>({owner_id:'original',contract:{pull_requests:[{repository:'example/service',pr_number:6}]}})},work:{get:()=>({state:'accepted',owner_thread_id:'original'}),config:{scope:{repositories:['example/service']}}}};
 return{path,base,input,control,digest,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('public applicability registration preserves unrelated grants, validates source and PR context, uses CAS and is idempotent',()=>{
 const f=registration();try{
  const result=recordGatekeeperApplicability(f.control,f.input,{policyPath:f.path});assert.equal(result.recorded,true);assert.equal(result.merge_permission_granted,false);
  const saved=JSON.parse(readFileSync(f.path));assert.deepEqual(saved.personal_review,f.base.personal_review);assert.deepEqual(saved.merge_authorizations,f.base.merge_authorizations);
  assert.equal(recordGatekeeperApplicability(f.control,{...f.input,expected_policy_digest:f.digest()},{policyPath:f.path}).duplicate,true);
 }finally{f.close();}
 for(const mutate of [i=>i.expected_policy_digest='wrong',i=>i.source_thread_id='another-agent',i=>i.native_proof.checked_at=new Date(now-61000).toISOString(),i=>i.verbatim_text='Agent says no gatekeeper',i=>i.pr_context.after={...i.pr_context.after,head:{sha:'b'.repeat(40)}},i=>i.repository='other/repo']){
  const x=registration();try{mutate(x.input);const bytes=readFileSync(x.path);assert.throws(()=>recordGatekeeperApplicability(x.control,x.input,{policyPath:x.path}));assert.deepEqual(readFileSync(x.path),bytes);}finally{x.close();}
 }
});
test('only the actual selected answer can grant a waiver; quoting its question or declining cannot',()=>{
 for(const answer of ['仅 #6 豁免并送审（推荐）','不豁免，等待批准']){
  const f=registration();try{const text='<send_user_message_question_reply>\n'+JSON.stringify([{question:'是否仅 #6 豁免并送审？',answer}])+'\n</send_user_message_question_reply>';
   const i={...f.input,mode:'review_exception',verbatim_text:text,authorized_scope:{pr_urls:[url],head_sha:head}};i.native_proof.readback.turns[0].items[0].content[0].text=text;
   if(answer.startsWith('仅'))assert.equal(recordGatekeeperApplicability(f.control,i,{policyPath:f.path}).recorded,true);
   else assert.throws(()=>recordGatekeeperApplicability(f.control,i,{policyPath:f.path}),/waiver/);
  }finally{f.close();}
 }
});
