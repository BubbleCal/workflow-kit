import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewDestinationReasons} from './pr-review-routing.mjs';

const url='https://github.com/example/service/pull/1',head='a'.repeat(40);
const policy={schema_version:1,source_message_id:'human-route',default_channel_id:'CDEFAULT',
  routes:[{scope:'lancedb_functions',channel_id:'CFUNCTIONS'}]};
const payload=channel_id=>({channel_id,message:url,expected_head_sha:head});
const evidence=scope=>({pr_url:url,current_head_sha:head,review_routing:{scope,verified:true,pr_url:url,head_sha:head,evidence_ref:'current-pr-scope'}});
const check=(p,e,rule=policy)=>reviewDestinationReasons(p,e,rule,'CDEFAULT');

test('Functions and other PRs have distinct destinations',()=>{
  assert.deepEqual(check(payload('CFUNCTIONS'),evidence('lancedb_functions')),[]);
  assert.deepEqual(check(payload('CDEFAULT'),evidence('default')),[]);
  assert.deepEqual(check(payload('CDEFAULT'),evidence('lancedb_functions')),['slack_destination_forbidden']);
  assert.deepEqual(check(payload('CFUNCTIONS'),evidence('default')),['slack_destination_forbidden']);
});
test('scope must be verified against this exact PR and head',()=>{
  assert.deepEqual(check(payload('CFUNCTIONS'),{}),['current_pr_review_scope_required']);
  for(const patch of [{verified:false},{pr_url:url+'2'},{head_sha:'b'.repeat(40)},{evidence_ref:''}]){
    const e=evidence('lancedb_functions');Object.assign(e.review_routing,patch);
    assert.deepEqual(check(payload('CFUNCTIONS'),e),['current_pr_review_scope_required']);
  }
  assert.deepEqual(check(payload('CDEFAULT'),evidence('unknown')),['unknown_pr_review_scope']);
});
test('invalid scoped policy never silently restores the old channel',()=>{
  for(const patch of [{source_message_id:null},{routes:[...policy.routes,...policy.routes]},
    {routes:[{scope:'default',channel_id:'CFUNCTIONS'}]},{default_channel_id:'CHANGED'}])
    assert.deepEqual(check(payload('CDEFAULT'),evidence('default'),{...policy,...patch}),['invalid_slack_routing_policy']);
});
test('instances without scoped routing retain their configured single channel',()=>{
  assert.deepEqual(check(payload('CDEFAULT'),{},null),[]);
  assert.deepEqual(check(payload('CFUNCTIONS'),{},null),['slack_destination_forbidden']);
});

test('a human scope hold blocks delivery without redirecting or holding unrelated PRs',()=>{
  const held=structuredClone(policy);
  held.routes[0].delivery_hold={active:true,source_message_id:'human-pause',evidence_ref:'saved-human-pause'};
  for(const destination of ['CFUNCTIONS','CDEFAULT'])
    assert.deepEqual(check(payload(destination),evidence('lancedb_functions'),held),['review_delivery_paused_by_user']);
  assert.deepEqual(check(payload('CDEFAULT'),evidence('default'),held),[]);
  held.routes[0].delivery_hold.active=false;
  assert.deepEqual(check(payload('CFUNCTIONS'),evidence('lancedb_functions'),held),[]);
  held.routes[0].delivery_hold.active='false';
  assert.deepEqual(check(payload('CFUNCTIONS'),evidence('lancedb_functions'),held),['invalid_slack_routing_policy']);
});
