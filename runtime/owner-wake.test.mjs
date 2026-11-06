import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeSetupNotice,prWakeProjection,prChangeReasons} from './owner-wake.mjs';
import {fixture,NOW,OWNER} from './test-fixtures/reactive.mjs';
import {wakePrompt} from './reactive-driver.mjs';
const head='a'.repeat(40);
const check=(id,status='in_progress',conclusion=null)=>({id,kind:'check_run',name:`test-${id}`,head_sha:head,status,conclusion});
const snapshot=()=>({pr:{repository:'example/service',pr_number:1,head_sha:head,state:'open',draft:false,approval_state:'pending',checks_state:'unknown',updated_at:new Date(NOW).toISOString(),ci:{head_sha:head,complete:true,checks:[check(1),check(2)]}},reviews:[],issue_comments:[],review_comments:[],review_threads:[]});
const event=(f,id,payload)=>f.event(id,payload,{subject:'example/service#1'});

test('ordinary CI progress and metadata refresh retain the owner plan and wait version',()=>{
 const f=fixture();try{const a=snapshot();event(f,'first',a);f.decide();const rev=f.s.task('T-1').context_rev,version=f.s.checkpoint('T-1').facts[0].version;
 const b=structuredClone(a);b.pr.updated_at='2026-11-04T06:00:01Z';b.pr.ci.checks[0]=check(1,'completed','success');b.pr.ci.checks.reverse();
 assert.equal(event(f,'progress',b).unchanged,true);assert.equal(f.s.task('T-1').context_rev,rev);assert.equal(f.s.task('T-1').dirty,false);
 assert.equal(f.s.checkpoint('T-1').facts[0].version,version);assert.deepEqual(f.s.checkpoint('T-1').facts[0].data,b);
 }finally{f.c.close();}
});
test('existing raw fact versions survive a noise-only first poll after deployment',()=>{
 const f=fixture();try{const a=snapshot();event(f,'first',a);f.decide();f.c.db.prepare("UPDATE rt_facts SET version='legacy-version' WHERE task_id='T-1'").run();
 const b=structuredClone(a);b.pr.ci.checks[0]=check(1,'completed','success');assert.equal(event(f,'next',b).unchanged,true);
 assert.equal(f.s.checkpoint('T-1').facts[0].version,'legacy-version');
 }finally{f.c.close();}
});
for(const [name,mutate] of [
 ['first CI failure',s=>{s.pr.ci.checks[0]=check(1,'completed','failure');}],
 ['all CI finished',s=>{s.pr.ci.checks=[check(1,'completed','success'),check(2,'completed','skipped')];}],
 ['head update',s=>{s.pr.head_sha='b'.repeat(40);}],
 ['closed PR',s=>{s.pr.state='closed';}],
 ['merged PR',s=>{s.pr.state='merged';s.pr.merge_sha='c'.repeat(40);}],
 ['approval',s=>{s.pr.approval_state='approved';}],
 ['human comment',s=>{s.issue_comments=[{id:11,body:'This breaks null inputs',user:{login:'reviewer'}}];}],
 ['bot finding',s=>{s.reviews=[{id:12,state:'COMMENTED',body:'The append path corrupts JSON',user:{login:'claude[bot]'}}];}],
 ['changes requested',s=>{s.reviews=[{id:13,state:'CHANGES_REQUESTED',body:'',user:{login:'reviewer'}}];}],
 ['Gatekeeper completion',s=>{s.pr.ci.checks.push({...check(3,'completed','success'),name:'LanceDB Gatekeeper'});}],
])test(`${name} immediately creates actionable owner context`,()=>{
 const f=fixture();try{const a=snapshot();event(f,'first',a);f.decide();const b=structuredClone(a);mutate(b);
 assert.equal(event(f,'change',b).changed,true);assert.equal(f.s.task('T-1').dirty,true);assert.ok(f.s.task('T-1').wake_at<=f.now()+5000);
 assert.ok(prChangeReasons(a,b).length);
 }finally{f.c.close();}
});
test('only the exact known bot setup notice is quiet; changed content or author remains actionable',()=>{
 const a=snapshot(),b=structuredClone(a);b.reviews=[{id:1,state:'COMMENTED',body:claudeSetupNotice,user:{login:'claude[bot]'}}];
 assert.deepEqual(prWakeProjection(a),prWakeProjection(b));
 b.reviews[0].body+='\nAlso fix the data loss.';assert.notDeepEqual(prWakeProjection(a),prWakeProjection(b));
 b.reviews[0].body=claudeSetupNotice;b.reviews[0].user.login='reviewer';assert.notDeepEqual(prWakeProjection(a),prWakeProjection(b));
});
test('known notices retain raw feedback evidence without an assessment wake or relaxed review gate',()=>{
 const f=fixture();try{const s={...snapshot(),repository:'example/service',pr_number:1,head_sha:head,head_before:head,head_after:head,checked_at:new Date(f.now()).toISOString(),evidence_ref:'actual-feedback',complete:{reviews:true,issue_comments:true,review_comments:true,review_threads:true}};
 s.reviews=[{id:1,state:'COMMENTED',body:claudeSetupNotice,user:{login:'claude[bot]'}}];f.c.feedback.ingest(s);
 assert.equal(f.c.feedback.status('example/service',1).items[0].body,claudeSetupNotice);
 assert.equal(f.c.feedback.gate('example/service',1,head).allowed,true);assert.equal(f.c.lifecycle.feedback('example/service',1,head).items.length,0);
 s.reviews[0].body+='\nFix corruption.';f.c.feedback.ingest(s);assert.equal(f.c.feedback.gate('example/service',1,head).allowed,false);
 }finally{f.c.close();}
});
test('owner wake carries the actual reason and protocol instead of repeated defensive rules',()=>{
 const prompt=wakePrompt('/instance',{task_id:'T-202',owner_id:OWNER,contract:{}},{id:'runtime:T-202:wake:8'},
 {events:[{type:'pr_changed',subject:'repo#42',wake_reasons:['CI 失败结果变化']}],schedule_runs:[]});
 assert.match(prompt,/CI 失败结果变化/);assert.match(prompt,/begin → checkpoint → decide → finish/);
 assert.match(prompt,/runtime:T-202:wake:8/);assert.doesNotMatch(prompt,/T-026|推理强度|模型|不能伪造/);assert.ok(prompt.length<650);
});
