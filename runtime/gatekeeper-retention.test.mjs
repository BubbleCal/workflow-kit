import test from 'node:test';import assert from 'node:assert/strict';
import {ControlStore} from './control.mjs';import {passedReviewGates} from './test-fixtures/pr-review.mjs';
const START=Date.parse('2026-11-05T06:00:00Z'),HEAD='a'.repeat(40),repo='example/client',pr=42,url=`https://github.com/${repo}/pull/${pr}`;
function setup(){let now=START;const c=new ControlStore(':memory:',{now:()=>now});c.lifecycle.track({repository:repo,pr_number:pr,task_id:'T-1',owner_thread_id:'owner',authorization_ref:'human'});
 const s={...passedReviewGates(now,HEAD,url,'slack_pr'),repository:repo,pr_number:pr,head_sha:HEAD,state:'open',draft:false,updated_at:new Date(START).toISOString(),checked_at:new Date(now).toISOString(),evidence_ref:'full-proof'};
 s.ci={complete:true,head_sha:HEAD,checks:s.applicable_ci.checks};
 const feedback=(reviews=s.gatekeeper.reviews)=>c.feedback.ingest({repository:repo,pr_number:pr,head_sha:HEAD,head_before:HEAD,head_after:HEAD,checked_at:new Date(now).toISOString(),evidence_ref:'full-feedback',complete:{reviews:true,review_comments:true,issue_comments:true,review_threads:true},reviews,review_comments:[],issue_comments:[],review_threads:[]});
 feedback();c.lifecycle.observe(s,{feedbackCollected:true});
 const metadata=()=>{const n=structuredClone(s);delete n.gatekeeper;delete n.applicable_ci;n.checked_at=new Date(now).toISOString();n.evidence_ref='metadata';return n;};
 const saved=()=>JSON.parse(c.db.prepare('SELECT snapshot FROM lifecycle_prs').get().snapshot);
 return {c,s,feedback,metadata,saved,advance:ms=>{now+=ms;}};
}
test('same-source metadata retains Gatekeeper proof without refreshing its time',()=>{const f=setup();try{f.advance(240000);f.feedback();f.c.lifecycle.observe(f.metadata());assert.deepEqual(f.saved().gatekeeper,f.s.gatekeeper);assert.equal(f.saved().gatekeeper.checked_at,new Date(START).toISOString());}finally{f.c.close();}});
for(const changed of ['body','state','removed','new-review','check-producer','check-result','head','updated_at','expiry'])test(`Gatekeeper retention rejects ${changed}`,()=>{const f=setup();try{
 f.advance(changed==='expiry'?21*60000:1000);const reviews=structuredClone(f.s.gatekeeper.reviews),n=f.metadata();
 if(changed==='body')reviews[0].body='Please fix the regression';if(changed==='state')reviews[0].state='DISMISSED';if(changed==='removed')reviews.splice(0);if(changed==='new-review')reviews.push({...reviews[0],id:'new',state:'CHANGES_REQUESTED',body:'Fix this'});
 f.feedback(reviews);if(changed==='check-producer')n.ci.checks[0].app_id='different';if(changed==='check-result')n.ci.checks[0].conclusion='failure';if(changed==='head')n.head_sha='b'.repeat(40);if(changed==='updated_at')n.updated_at=new Date(START+1000).toISOString();
 f.c.lifecycle.observe(n);assert.equal(f.saved().gatekeeper,undefined);
 }finally{f.c.close();}});
