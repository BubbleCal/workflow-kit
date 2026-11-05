import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,OWNER,plan} from './test-fixtures/reactive.mjs';
import {Mailbox} from './mailbox.mjs';
import {routeOwnerInputs,nativeLifecycleProgress,ownerActionReasons,queueOwnerHealth} from './owner-delivery.mjs';

function setup(){const root=mkdtempSync(join(tmpdir(),'owner-delivery-')),f=fixture(join(root,'control.sqlite'),root),m=new Mailbox(join(root,'mailbox.sqlite'),{now:f.now});return {...f,root,m,route:()=>routeOwnerInputs({root,control:f.c,mailbox:m,now:f.now}),close(){m.close();f.c.close();rmSync(root,{recursive:true,force:true});}};}
test('delivery handoffs reach the original owner once without creating a service batch',()=>{
 const f=setup();try{f.activate();f.m.enqueue({key:'ready',lane:'coordinator',kind:'configuration',payload:{affected_task_ids:['T-1'],event:'ready_handoff'}});f.route();f.route();
 assert.equal(f.s.checkpoint('T-1').events.filter(e=>e.source==='owner_delivery').length,1);
 assert.equal(f.m.db.prepare('SELECT count(*) n FROM batches').get().n,0);
 assert.equal(f.m.db.prepare('SELECT state FROM mail WHERE item_key=?').get('ready').state,'owner_routed');
 }finally{f.close();}
});
test('paused owners receive durable input without being resumed or dispatched',()=>{
 const f=setup();try{f.mode('paused');f.m.enqueue({key:'paused-ready',lane:'coordinator',kind:'event',payload:{task_id:'T-1'}});f.route();assert.equal(f.s.task('T-1').mode,'paused');assert.equal(f.s.reserveQueuedWake('T-1').reserved,false);assert.equal(f.s.checkpoint('T-1').events.length,1);}finally{f.close();}
});
test('completed owners are not reopened by historical projections',()=>{
 const f=setup();try{f.c.db.prepare("UPDATE rt_tasks SET status='complete' WHERE task_id='T-1'").run();f.m.enqueue({key:'old',lane:'coordinator',kind:'event',payload:{affected_task_ids:['T-1'],event:'outcome_projection'}});f.route();assert.equal(f.s.task('T-1').status,'complete');assert.equal(f.s.checkpoint('T-1').events.length,0);}finally{f.close();}
});
test('a different delivery actor cannot publish on behalf of the original owner',()=>{
 const f=setup();try{assert.deepEqual(ownerActionReasons(f.c,'merge','T-1',{}, {},OWNER),[]);assert.deepEqual(ownerActionReasons(f.c,'merge','T-1',{}, {},'former-coordinator'),['original_task_owner_must_execute_delivery']);}finally{f.close();}
});
test('native lifecycle progress binds the actual handled source generation',()=>{
 const f=setup();try{const key='lifecycle:repo#1:ci',source=key+':1';f.c.db.prepare("INSERT INTO lifecycle_intents(intent_key,pr_key,action,revision,payload,state,due_at,created_at) VALUES (?,?,?,?,?,?,?,?)").run(key,'repo#1','triage_ci','r',JSON.stringify({task_id:'T-1',lifecycle_generation:1}),'pending',f.now(),f.now());
 f.m.enqueue({key:source,lane:'coordinator',kind:'event',payload:{task_id:'T-1',event:'pr_lifecycle_action',lifecycle_key:key,lifecycle_generation:1}});f.route();
 const d=f.decide({disposition:'revise',plan:plan('fix')});
 assert.equal(nativeLifecycleProgress(f.c,{key,generation:1,native_decision_id:d.decision_id,owner_thread_id:OWNER,evidence_ref:'triage'}).task_complete,false);
 assert.throws(()=>nativeLifecycleProgress(f.c,{key,generation:2,native_decision_id:d.decision_id,owner_thread_id:OWNER,evidence_ref:'triage'}),/exact lifecycle/);
 }finally{f.close();}
});
