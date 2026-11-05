import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER} from './test-fixtures/reactive.mjs';

test('archived-target rejection preserves one occurrence and recovers only after restored-owner proof',()=>{
 const f=fixture();try{
  f.activate();f.event();const w=f.s.reserveQueuedWake('T-1').wake;
  f.c.db.prepare('UPDATE rt_wakes SET prompt=? WHERE id=?').run('same occurrence',w.id);
  const evidence={verified_at:new Date(f.now()).toISOString(),scope_authorized:true,authorization_ref:'human',policy_version:'v1',current_policy_version:'v1',stopped:false,owner_matches:true,owner_thread_id:OWNER,native_queue_only:true,event_wake_authorized:true,queue_compatibility_verified:true,queue_compatibility_ref:'actual-proof'};
  const a={key:w.id,kind:'task_queue',task_id:'T-1',payload:{thread_id:OWNER,wake_id:w.id,starts_heavy_work:false,prompt:'same occurrence'},evidence};
  const prepared=f.c.prepare(a);assert.equal(prepared.prepared,true,JSON.stringify(prepared));const claim=f.c.claim({key:w.id,owner:'runtime',evidence});assert.equal(claim.claimed,true);
  f.c.settle({key:w.id,attempt_id:claim.attempt_id,outcome:'not_sent',error_class:'invalid_before_send',evidence_ref:`native-queue-error:session ${OWNER} is archived.`});
  assert.equal(f.s.openWake('T-1').id,w.id);assert.equal(f.s.openWake('T-1').state,'reserved');
  assert.equal(f.c.claim({key:w.id,owner:'runtime',evidence}).claimed,false);
  const reconcile={key:w.id,confirmed_outcome:'not_sent',evidence_ref:'inspected-provider-rejection-and-restored-owner',owner_quiescent:true,verified_at:new Date(f.now()).toISOString(),recover_queue:true};
  assert.throws(()=>f.c.reconcile(reconcile),/native|desktop/i);
  f.c.reconcile({...reconcile,native_binding:f.binding()});
  assert.equal(f.s.openWake('T-1').id,w.id);assert.equal(f.c.claim({key:w.id,owner:'runtime',evidence}).claimed,true);
  // A restored thread alone cannot turn possible delivery into permission to retry.
  f.c.db.prepare("UPDATE rt_wakes SET queue_id='accepted-queue' WHERE id=?").run(w.id);
  assert.throws(()=>f.c.reconcile({...reconcile,native_binding:f.binding()}),/without acceptance/);
 }finally{f.c.close();}
});
