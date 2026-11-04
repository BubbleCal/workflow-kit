import test from 'node:test';
import assert from 'node:assert/strict';
import { ownershipReasons } from './task-ownership.mjs';

const registry = {queue_transport:{dispatcher_thread_id:'dispatcher',immediate_human_trigger:{enabled:true,source_message_id:'rule'}},task_registry:{items:{}}};
const payload = {thread_id:'dispatcher',intent:'invoke_dispatcher',source_message_id:'human',trigger_action_key:'human-trigger:human:dispatcher'};
const evidence = {trigger_rule_source_id:'rule',service_invocation_authorized:true,actual_human_message_verified:true,source_actor_verified:true,source_message_id:'human',thread_status:'idle',queued_input:false,pending_dispatch:false,underlying_job_running:false};
const assess = (p=payload,e=evidence,key=payload.trigger_action_key) => ownershipReasons('human_input','T-176',p,e,registry,{},key);
test('authenticated idle invocation uses the actual registered dispatcher',()=>assert.deepEqual(assess(),[]));
test('busy or queued dispatcher is never invoked concurrently',()=>{
  for (const change of [{thread_status:'active'},{queued_input:true},{pending_dispatch:true},{underlying_job_running:true}]) assert.notDeepEqual(assess(payload,{...evidence,...change}),[]);
});
test('same source cannot use a second action key to evade receipt deduplication',()=>assert.notDeepEqual(assess(payload,evidence,'another-key'),[]));
test('machine or unverified input cannot invoke the service',()=>{
  for (const change of [{actual_human_message_verified:false},{source_actor_verified:false},{trigger_rule_source_id:'other'},{source_message_id:'different'}]) assert.notDeepEqual(assess(payload,{...evidence,...change}),[]);
});
test('the exception does not authorize an unrelated engineering target',()=>assert.deepEqual(assess({...payload,thread_id:'worker'}),['registered_task_owner_identity_required']));
