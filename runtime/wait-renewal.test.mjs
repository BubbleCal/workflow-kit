import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './test-fixtures/reactive.mjs';
import {renewVerifiedWaits} from './wait-renewal.mjs';
const head='a'.repeat(40);
function waiting() {
 const f=fixture();
 f.c.lifecycle.track({repository:'example/service',pr_number:1,task_id:'T-1',owner_thread_id:f.s.task('T-1').owner_id,authorization_ref:'human'});
 const observe=(id)=>{
  const at=new Date(f.now()).toISOString(),pr={repository:'example/service',pr_number:1,head_sha:head,state:'open',draft:false,requested_reviewers:['reviewer'],checked_at:at,updated_at:'2026-11-04T05:00:00Z',evidence_ref:'pr-'+id,
   ci:{head_sha:head,checked_at:at,evidence_ref:'ci-'+id,complete:true,checks:[]}};
  f.c.feedback.ingest({repository:'example/service',pr_number:1,head_sha:head,head_before:head,head_after:head,checked_at:at,evidence_ref:'feedback-'+id,complete:{reviews:true,review_comments:true,issue_comments:true,review_threads:true},reviews:[],review_comments:[],issue_comments:[],review_threads:[]});
  f.c.lifecycle.observe(pr,{feedbackCollected:true});f.event(id,{pr,reviews:[],review_comments:[],issue_comments:[],review_threads:[]},{subject:'example/service#1'});
 };
 observe('first');f.decide();
 const wait={facts:f.s.checkpoint('T-1').facts.map(({subject,version})=>({subject,version})),expires_at:f.now()+1000,resume_condition:'The requested reviewer responds',
  condition:{kind:'review_request',pr_key:'example/service#1',head,reviewer:'reviewer',next_check_at:new Date(f.now()+1000).toISOString()}};
 f.decide({disposition:'wait',plan:undefined,wait});f.activate();return {...f,observe};
}
test('fresh unchanged source observations renew an elapsed wait without an owner event',()=>{
 const f=waiting();try{f.advance(1001);f.observe('next-poll');const context=f.s.task('T-1').context_rev;
 assert.deepEqual(renewVerifiedWaits({root:'/unused',control:f.c,now:f.now}),['T-1']);f.s.expireWaits();
 assert.equal(f.s.task('T-1').context_rev,context);assert.equal(f.s.task('T-1').wake_at,null);assert.equal(f.s.checkpoint('T-1').events.length,0);
 assert.equal(f.c.db.prepare('SELECT COUNT(*) AS n FROM rt_wait_renewals').get().n,1);
 assert.equal(JSON.parse(f.s.checkpoint('T-1').wait.condition).expires_at,f.now()+1800000);
 assert.deepEqual(renewVerifiedWaits({root:'/unused',control:f.c,now:f.now}),[]);
 }finally{f.c.close();}
});
test('unrefreshed evidence still wakes the owner once instead of silently renewing a stale wait',()=>{
 const f=waiting();try{f.advance(61000);assert.deepEqual(renewVerifiedWaits({root:'/unused',control:f.c,now:f.now}),[]);
 f.s.expireWaits();f.s.expireWaits();assert.equal(f.s.checkpoint('T-1').events.length,1);
 assert.equal(f.s.checkpoint('T-1').events[0].type,'wait_expired');
 }finally{f.c.close();}
});
test('material changes and paused work cannot be hidden by automatic renewal',()=>{
 for(const change of ['material','paused']){const f=waiting();try{f.advance(1001);f.observe('new');
  if(change==='material')f.event('human-feedback',{request:'Change the approach'},{source:'human',type:'human_command'});else f.mode('paused');
  assert.deepEqual(renewVerifiedWaits({root:'/unused',control:f.c,now:f.now}),[]);
  if(change==='material')assert.equal(f.s.task('T-1').dirty,true);else assert.equal(f.s.task('T-1').mode,'paused');
 }finally{f.c.close();}}
});
