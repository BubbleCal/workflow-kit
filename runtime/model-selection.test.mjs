import test from 'node:test';
import assert from 'node:assert/strict';
import { withCreationModel } from './model-selection.mjs';

const selection = { source_message_id: 'actual-human', model: 'selected-model',
  thinking: 'xhigh', fast: false, service_tier_control_supported: false };

test('creation uses the requested native model and effort without inventing tier support', () => {
  const payload = { native: { prompt: 'Original task', target: { type: 'projectless' } } };
  const prepared = withCreationModel('create_thread', payload, selection);
  assert.equal(prepared.native.model, 'selected-model');
  assert.equal(prepared.native.thinking, 'xhigh');
  assert.equal(prepared.native.prompt, 'Original task');
  assert.equal(Object.hasOwn(prepared.native, 'serviceTier'), false);
  assert.equal(prepared.model_selection.service_tier_control_supported, false);
  assert.equal(payload.native.model, undefined);
  assert.deepEqual(withCreationModel('create_thread', prepared, selection), prepared);
});

test('explicit task choices and existing-thread dispatch settings remain intact', () => {
  const payload = { native: { model: 'task-choice', thinking: 'high' } };
  assert.deepEqual(withCreationModel('create_thread', payload, selection).native, payload.native);
  assert.equal(withCreationModel('dispatch', payload, selection), payload);
  assert.equal(withCreationModel('create_thread', payload, null), payload);
  assert.equal(withCreationModel('create_thread', { tool_args: { prompt: 'Existing adapter' } }, selection).tool_args.model, selection.model);
});

const routed={version:2,mode:'task_difficulty',source_message_id:'human:difficulty',routes:{simple:{model:'gpt-6.1-sol',thinking:'high'},other:{model:'gpt-6-astra',thinking:'xhigh'}}};
const simple={scope:'bounded',uncertainty:'low',validation:'routine',reason:'Correct one documented option using existing examples and a focused check.'};
const solHigh={model:'gpt-6.1-sol',thinking:'high',priority:1};
const solXhigh={model:'gpt-6.1-sol',thinking:'xhigh',priority:2};
const astra={model:'gpt-6-astra',thinking:'xhigh',priority:3};
const oss={simple:solHigh,difficult:solXhigh,extreme:astra,unknown:astra};
const repoPolicy={...routed,version:3,routes:{simple:solHigh,other:astra},repository_routes:{'lance-format/lance':oss,'lancedb/lancedb':oss,'lancedb/sophon':{...oss,difficult:astra}}};
test('repository and difficulty jointly select the native model, including mixed scope',()=>{
 for(const repo of ['lance-format/lance','lancedb/lancedb','lancedb/sophon'])for(const tier of ['simple','difficult','extreme']){
  const a={...simple,target_repositories:[repo],repository_evidence_ref:'actual-task-scope',...(tier==='simple'?{}:{uncertainty:'material',complexity:tier})};
  const p={native:{model:'stale'},difficulty_assessment:a};const r=withCreationModel('create_thread',p,repoPolicy);
  const expected=tier==='simple'?solHigh:tier==='extreme'||repo==='lancedb/sophon'?astra:solXhigh;
  assert.equal(r.native.model,expected.model);assert.equal(r.native.thinking,expected.thinking);
  assert.deepEqual(withCreationModel('create_thread',r,repoPolicy),r);
 }
 const mixed=withCreationModel('create_thread',{native:{},difficulty_assessment:{...simple,complexity:'difficult',target_repositories:['lance-format/lance','lancedb/sophon'],repository_evidence_ref:'cross-repo-scope'}},repoPolicy);
 assert.equal(mixed.native.model,astra.model);
 // The sidebar project or checkout does not establish the destination repository.
 assert.equal(withCreationModel('create_thread',{native:{target:{projectId:'LanceDB'}},difficulty_assessment:{...simple,uncertainty:'material'}},repoPolicy).native.model,astra.model);
 assert.throws(()=>withCreationModel('create_thread',{native:{},difficulty_assessment:{...simple,target_repositories:['lance-format/lance']}},repoPolicy),/scope evidence/);
 const overridden=withCreationModel('create_thread',{canonical_task_key:'task',native:{},difficulty_assessment:{...simple,target_repositories:['lance-format/lance'],repository_evidence_ref:'scope'},model_override:{canonical_task_key:'task',model:'gpt-6-astra',thinking:'high',actual_human_verified:true,source_message_id:'user',verbatim_text:'Use Astra high',evidence_ref:'user-request'}},repoPolicy);
 assert.equal(overridden.native.model,'gpt-6-astra');assert.equal(overridden.native.thinking,'high');
});
test('full task assessment selects the configured model and actual native effort',()=>{
 const p=withCreationModel('create_thread',{native:{prompt:'Create owner'},difficulty_assessment:simple},routed);
 assert.equal(p.native.model,'gpt-6.1-sol');assert.equal(p.native.thinking,'high');assert.equal(p.difficulty_assessment.level,'simple');assert.equal(p.difficulty_assessment.reason,simple.reason);
 for(const assessment of [undefined,{...simple,scope:'broad'},{...simple,uncertainty:'material'},{...simple,validation:'specialist'}]){
  const r=withCreationModel('create_thread',{native:{prompt:'Create owner'},difficulty_assessment:assessment},routed);assert.equal(r.native.model,'gpt-6-astra');assert.equal(r.native.thinking,'xhigh');
 }
 assert.deepEqual(withCreationModel('create_thread',p,routed),p);
});
test('agent-supplied defaults cannot bypass routing, but an evidenced user override can',()=>{
 const payload={canonical_task_key:'docs:option',native:{model:'old-default',thinking:'low',prompt:'Same task'},difficulty_assessment:simple};
 assert.equal(withCreationModel('create_thread',payload,routed).native.model,'gpt-6.1-sol');
 const override={canonical_task_key:'docs:option',model:'gpt-6-astra',thinking:'high',actual_human_verified:true,source_message_id:'human:task-choice',verbatim_text:'Use Astra high for this task.',evidence_ref:'actual-user-message'};
 const r=withCreationModel('create_thread',{...payload,model_override:override},routed);assert.equal(r.native.model,'gpt-6-astra');assert.equal(r.native.thinking,'high');assert.equal(r.model_override.source_message_id,override.source_message_id);
 assert.throws(()=>withCreationModel('create_thread',{...payload,model_override:{model:'other'}},routed),/actual user choice/);
 assert.equal(withCreationModel('dispatch',payload,routed),payload);
 assert.equal(Object.hasOwn(r.native,'serviceTier'),false);
 assert.throws(()=>withCreationModel('create_thread',{...payload,model_override:{...override,canonical_task_key:'another-task'}},routed),/actual user choice/);
});
test('difficulty cannot be asserted from a simple label without the assessment criteria',()=>{
 assert.throws(()=>withCreationModel('create_thread',{native:{},difficulty_assessment:{level:'simple',reason:'Small title'}},routed),/difficulty scope/);
 const p=withCreationModel('create_thread',{native:{},difficulty_assessment:{...simple,level:'simple',uncertainty:'material'}},routed);assert.equal(p.difficulty_assessment.level,'other');
});
