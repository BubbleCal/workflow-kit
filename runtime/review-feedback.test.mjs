import test from 'node:test';
import assert from 'node:assert/strict';
import {ControlStore,CHANNEL} from './control.mjs';
import {ReviewFeedback} from './review-feedback.mjs';

const NOW=Date.parse('2026-11-03T06:00:00Z'),HEAD='43f4a5bd1a58af454fe8a99cf3a31997b05a2cb5',NEW='b'.repeat(40);
const repo='example/format',number=10638,url=`https://github.com/${repo}/pull/${number}`;
const snapshot=(head=HEAD)=>({repository:repo,pr_number:number,head_sha:head,head_before:head,head_after:head,checked_at:new Date(NOW).toISOString(),evidence_ref:'actual-all-author-snapshot',
  complete:{reviews:true,review_comments:true,issue_comments:true,review_threads:true},
  reviews:[{id:5742996666,state:'COMMENTED',commit_id:HEAD,user:{login:'claude[bot]'},body:'This repository is configured for manual code reviews. Comment @claude review for a one-time review.'},
    {id:5743158692,state:'COMMENTED',commit_id:HEAD,user:{login:'lance-gatekeeper[bot]'},body:'Gate recommendation: request changes. Preserve native JSON document support. An ordinary append turns a working JSON BM25F query into a planning error.'}],
  review_comments:[{id:4447591625,pull_request_review_id:5743158692,original_commit_id:HEAD,user:{login:'lance-gatekeeper[bot]'},body:'This rejects native JSONB columns. Accept JsonEncoding::of_field and cover indexed-plus-appended data.',path:'rust/lance/src/io/exec/fts/flat_combined_fields.rs'}],
  review_threads:[{id:'actual-thread',isResolved:false,isOutdated:false,comments:{nodes:[{databaseId:4447591625}]}}],issue_comments:[]});
function decisions(f,head=HEAD,fix=false){return f.status(repo,number).items.map(i=>({key:i.key,digest:i.digest,disposition:i.id==='5742996666'?'informational':fix?'addressed':'actionable',reason:i.id==='5742996666'?'Configuration notice without a code finding':fix?'Current code and regression demonstrate the reported behavior is fixed':'Current-head JSONB append regression is substantive despite COMMENTED state',evidence_ref:'source-and-code-assessment',validation_ref:fix?'current-head-red-green-result':undefined,current_code_relevance_verified:true}));}
function evidence(head=HEAD){return {verified_at:new Date(NOW).toISOString(),scope_authorized:true,authorization_ref:'original-implementation-grant',policy_version:'v',current_policy_version:'v',stopped:false,pr_owner:'test-author',pr_open:true,pr_draft:false,ordinary_change:true,material_findings_open:false,validation_current:true,technical_review_current:true,current_head_sha:head,pr_url:url,approver:'test-reviewer',approver_identity_verified:true,approval_state:'APPROVED',approved_head_sha:head,required_checks_pass:true,repository_rules_satisfied:true,mergeable:true,admin_override:false};}

test('the actual COMMENTED request-changes regression blocks a green approved merge until assessed and fixed',()=>{
  const c=new ControlStore(':memory:',{now:()=>NOW}),f=new ReviewFeedback(c.db,()=>NOW);f.ingest(snapshot());
  const a={key:'merge-current',kind:'merge',task_id:'T-012',payload:{pr_url:url,expected_head_sha:HEAD},evidence:evidence()};
  assert.equal(c.prepare(a).prepared,false);
  f.assess({repository:repo,pr_number:number,head:HEAD,decisions:decisions(f)});
  assert.equal(c.prepare(a).prepared,false);assert.equal(f.gate(repo,number,HEAD).blocking.length,2);
  f.assess({repository:repo,pr_number:number,head:HEAD,decisions:decisions(f,HEAD,true)});
  assert.equal(c.prepare(a).prepared,true);c.close();
});

test('formal changes-requested, any author and incomplete feeds cannot disappear behind approval summaries',()=>{
  const c=new ControlStore(':memory:',{now:()=>NOW}),f=new ReviewFeedback(c.db,()=>NOW),s=snapshot();s.reviews=[{id:99,state:'CHANGES_REQUESTED',body:'',commit_id:HEAD,user:{login:'another-reviewer'}}];s.review_comments=[];s.review_threads=[];
  f.ingest(s);assert.equal(f.gate(repo,number,HEAD).allowed,false);assert.equal(f.status(repo,number).items[0].review_state,'CHANGES_REQUESTED');
  assert.throws(()=>f.ingest({...s,complete:{...s.complete,issue_comments:false}}),/Complete/);c.close();
});

test('old-head and outdated feedback requires current applicability, while local fix evidence can clear unresolved UI state',()=>{
  const c=new ControlStore(':memory:',{now:()=>NOW}),f=new ReviewFeedback(c.db,()=>NOW);f.ingest(snapshot());f.assess({repository:repo,pr_number:number,head:HEAD,decisions:decisions(f)});
  const next=snapshot(NEW);next.review_threads[0].isOutdated=true;f.ingest(next);
  assert.equal(f.gate(repo,number,NEW).unassessed.length,3);
  assert.throws(()=>f.assess({repository:repo,pr_number:number,head:NEW,decisions:decisions(f,NEW,true).map(d=>({...d,validation_ref:undefined}))}),/validation/);
  f.assess({repository:repo,pr_number:number,head:NEW,decisions:decisions(f,NEW,true)});assert.equal(f.gate(repo,number,NEW).allowed,true);
  assert.equal(f.status(repo,number).items.find(i=>i.kind==='inline').is_resolved,false);c.close();
});

test('same source IDs deduplicate, changed content needs reassessment, active owners and missing grants are not dispatched',()=>{
  const c=new ControlStore(':memory:',{now:()=>NOW}),f=new ReviewFeedback(c.db,()=>NOW),s=snapshot();f.ingest(s);f.assess({repository:repo,pr_number:number,head:HEAD,decisions:decisions(f)});f.ingest(s);assert.equal(f.status(repo,number).items.length,3);
  const args={repository:repo,pr_number:number,head:HEAD,owner_thread_id:'owner',task_id:'T-012',implementation_authorized:true,authorization_ref:'original-human',observation:{thread_id:'owner',status:'idle',turn_status:'completed',turn_id:'old',checked_at:new Date(NOW).toISOString(),queued_input:false,pending_dispatch:false,background_job_running:false,hold:false,existing_driver:false}};
  assert.equal(f.plan(args).eligible,true);assert.equal(f.plan({...args,implementation_authorized:false}).eligible,false);
  for(const patch of [{status:'active'},{queued_input:true},{pending_dispatch:true},{background_job_running:true},{hold:true}])assert.equal(f.plan({...args,observation:{...args.observation,...patch}}).eligible,false);
  const plan=f.plan(args);c.db.prepare("INSERT INTO actions(action_key,kind,task_id,scope_key,digest,payload,state,due,created_at,updated_at) VALUES ('actual-repair','human_input','T-012','thread:owner','fixture',?,'sent',?,?,?)").run(JSON.stringify({thread_id:'owner'}),NOW,NOW,NOW);
  f.recordRoute({...args,control_action_key:'actual-repair',item_keys:plan.item_keys,binding_verified:true,evidence_ref:'native-original-owner-repair-proof'});assert.equal(f.plan(args).reason,'already_routed');assert.equal(f.gate(repo,number,HEAD).allowed,false);
  s.review_comments[0].body+=' Additional current issue.';f.ingest(s);assert.equal(f.gate(repo,number,HEAD).unassessed.length,1);assert.equal(f.plan(args).reason,'feedback_assessment_incomplete');c.close();
});

test('new feedback after preparation is checked again at claim despite green CI',()=>{
  const c=new ControlStore(':memory:',{now:()=>NOW}),s=snapshot();s.reviews=[];s.review_comments=[];s.review_threads=[];c.feedback.ingest(s);
  const a={key:'prepared-merge',kind:'merge',task_id:'T-012',payload:{pr_url:url,expected_head_sha:HEAD},evidence:evidence()};assert.equal(c.prepare(a).prepared,true);
  c.feedback.ingest(snapshot());assert.equal(c.claim({key:a.key,owner:'coordinator',evidence:evidence()}).claimed,false);c.close();
});

test('new feedback after claim blocks final review delivery without resetting the claimed attempt',()=>{
  const c=new ControlStore(':memory:',{now:()=>NOW}),s=snapshot();s.reviews=[];s.review_comments=[];s.review_threads=[];c.feedback.ingest(s);
  const a={key:'claimed-review',kind:'slack_pr',task_id:'T-012',payload:{message:url,channel_id:CHANNEL,expected_head_sha:HEAD},evidence:{...evidence(),already_announced:false}};
  assert.equal(c.prepare(a).prepared,true);const claim=c.claim({key:a.key,owner:'coordinator',evidence:a.evidence});assert.equal(claim.claimed,true);
  c.feedback.ingest(snapshot());assert.equal(c.authorizeReviewSend({key:a.key,attempt_id:claim.attempt_id,owner:'coordinator',evidence:a.evidence,operation_not_started:true}).send,false);
  assert.equal(c.db.prepare('SELECT state FROM actions WHERE action_key=?').get(a.key).state,'claimed');c.close();
});
