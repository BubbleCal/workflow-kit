import test from 'node:test';
import assert from 'node:assert/strict';
import { dependencyReasons, releaseSuccessorVerified } from './dependency-provenance.mjs';
import { ControlStore } from './control.mjs';

const NOW=Date.parse('2026-11-03T06:00:00Z'),HEAD='a'.repeat(40),UPSTREAM='b'.repeat(40),SYNC='c'.repeat(40);
const route={upstream_repository:'example/format',fork_repository:'example/client',consumer_repository:'example/service'};
const policy={enabled:true,source_message_id:'actual-release-first-request',routes:[route]};
const adoption=()=>({consumer_repository:route.consumer_repository,consumer_head:HEAD,dependencies:[{...route,required_commit:'d'.repeat(40),
  release:{tag:'v1.0.0-beta.1',commit:UPSTREAM,published:true,draft:false,published_at:'2026-11-03T01:00:00Z',contains_required_commit:true,evidence_ref:'upstream-release-and-ancestry'},
  sync:{method:'existing_automation',result:'success',run_id:'actual-sync-run',upstream_tag:'v1.0.0-beta.1',upstream_commit:UPSTREAM,commit:SYNC,evidence_ref:'sync-run-and-source'},pin_commit:SYNC}]});

test('ordinary publication cannot target a governed internal fork even with green checks',()=>{
  for(const kind of ['pr_ready','slack_pr','merge'])assert.deepEqual(dependencyReasons(kind,{pr_url:'https://github.com/example/client/pull/12'}, {},policy,NOW),['manual_internal_fork_delivery_forbidden']);
  assert.deepEqual(dependencyReasons('merge',{pr_url:'https://GitHub.com/Example/Client/pull/12'}, {},policy,NOW),['manual_internal_fork_delivery_forbidden']);
  assert.deepEqual(dependencyReasons('merge',{pr_url:'https://github.com/example/other/pull/12'}, {},policy,NOW),[]);
});

test('consumer adoption requires a published fix, actual automatic sync and the exact synced pin',()=>{
  const payload={pr_url:'https://github.com/example/service/pull/1',expected_head_sha:HEAD};
  assert.deepEqual(dependencyReasons('merge',payload,{dependency_adoption:adoption()},policy,NOW),[]);
  for(const mutate of [d=>d.release.published=false,d=>d.release.contains_required_commit=false,d=>d.sync.method='manual_backport',d=>d.sync.upstream_commit='e'.repeat(40),d=>d.pin_commit='f'.repeat(40)]){
    const a=adoption();mutate(a.dependencies[0]);assert.ok(dependencyReasons('merge',payload,{dependency_adoption:a},policy,NOW).length);
  }
  const wrongHead=adoption();wrongHead.consumer_head='f'.repeat(40);assert.ok(dependencyReasons('merge',payload,{dependency_adoption:wrongHead},policy,NOW).length);
  assert.deepEqual(dependencyReasons('dispatch',{}, {dependency_adoption:adoption()},policy,NOW),[]);
});

const goal=()=>({id:'existing-task-goal',dependency_delivery:{...route,required_commit:'d'.repeat(40)},stages:
  ['upstream_release','automatic_fork_sync','consumer_adoption','integrated_acceptance'].map((kind,i)=>({id:kind,release_step:kind,task_id:'T-010',state:i?'pending':'complete',depends_on:i?[['upstream_release','automatic_fork_sync','consumer_adoption'][i-1]]:[]}))});

test('closed fork PR needs a concrete released-upstream successor and never completes the task by closure alone',()=>{
  const c=new ControlStore(':memory:',{now:()=>NOW,dependencyPolicy:()=>policy});
  c.lifecycle.track({repository:route.fork_repository,pr_number:12,task_id:'T-010',owner_thread_id:'original-owner',authorization_ref:'original-human'});
  c.lifecycle.observe({repository:route.fork_repository,pr_number:12,head_sha:HEAD,state:'closed',draft:true,updated_at:new Date(NOW).toISOString(),checked_at:new Date(NOW).toISOString(),evidence_ref:'actual-closed-unmerged'});
  const event=c.lifecycle.reconcile()[0];assert.equal(event.payload.action,'reconcile_release_route');assert.equal(event.payload.state,'closed_unmerged');
  assert.throws(()=>c.lifecycle.resolve({key:event.payload.lifecycle_key,generation:1,disposition:'progress',evidence_ref:'generic-wait',progress_resolution:{verified:true,task_ids:['T-010'],goals:[]}}),/successor path/);
  const plan=goal();assert.equal(releaseSuccessorVerified([plan],'T-010',route),true);plan.stages[2].depends_on=[];assert.equal(releaseSuccessorVerified([plan],'T-010',route),false);
  const accepted=c.lifecycle.resolve({key:event.payload.lifecycle_key,generation:1,disposition:'progress',evidence_ref:'actual-release-first-progress',progress_resolution:{verified:true,task_ids:['T-010'],goals:[goal()],task_complete:false}});
  assert.equal(accepted.state,'resolved');assert.equal(c.lifecycle.inspect(`${route.fork_repository}#12`).state,'retired');c.close();
});

test('a previously claimed fork-ready action is denied at final send after the scoped policy becomes active',()=>{
  let active=null;const c=new ControlStore(':memory:',{now:()=>NOW,dependencyPolicy:()=>active});
  const url='https://github.com/example/client/pull/13';
  c.feedback.ingest({repository:route.fork_repository,pr_number:13,head_sha:HEAD,head_before:HEAD,head_after:HEAD,checked_at:new Date(NOW).toISOString(),evidence_ref:'complete-feedback',complete:{reviews:true,review_comments:true,issue_comments:true,review_threads:true},reviews:[],review_comments:[],issue_comments:[],review_threads:[]});
  const e={verified_at:new Date(NOW).toISOString(),scope_authorized:true,authorization_ref:'original',policy_version:'v',current_policy_version:'v',stopped:false,pr_owner:'test-author',pr_open:true,pr_draft:true,ordinary_change:true,material_findings_open:false,validation_current:true,technical_review_current:true,current_head_sha:HEAD,pr_url:url};
  const a={key:'old-ready',kind:'pr_ready',task_id:'T-010',payload:{pr_url:url,operation:'mark_ready',expected_head_sha:HEAD},evidence:e};assert.equal(c.prepare(a).prepared,true);const claim=c.claim({key:a.key,owner:'coordinator',evidence:e});assert.equal(claim.claimed,true);
  active=policy;assert.equal(c.authorizeReviewSend({key:a.key,attempt_id:claim.attempt_id,owner:'coordinator',evidence:e,operation_not_started:true}).send,false);assert.equal(c.db.prepare('SELECT state FROM actions WHERE action_key=?').get(a.key).state,'claimed');c.close();
});
