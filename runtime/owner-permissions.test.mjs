import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readOwnerPermissions,creationPermissionRequirement} from './owner-permissions.mjs';
import {workFixture} from './test-fixtures/work.mjs';
import {nativeProof,OWNER} from './test-fixtures/reactive.mjs';

const ID='01a1ce0f-d90f-7200-95d5-1230b96ed2e5';
function fixture(id=ID,workspace='/task'){
 const root=mkdtempSync(join(tmpdir(),'native-permissions-'));mkdirSync(join(root,'sessions'));
 const path=join(root,'sessions','rollout.jsonl'),db=new DatabaseSync(join(root,'state_5.sqlite'));
 db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,approval_mode TEXT,sandbox_policy TEXT)');
 // The summary deliberately claims Full access while actual first-turn policy differs.
 db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run(id,path,'never','{"type":"disabled"}');db.close();
 writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id}})+'\n');
 const turn=(patch={})=>appendFileSync(path,JSON.stringify({timestamp:'2026-11-12T05:00:00Z',type:'turn_context',payload:{turn_id:'setup',cwd:workspace,approval_policy:'on-request',sandbox_policy:{type:'workspace-write',network_access:false},permission_profile:{type:'managed'},...patch}})+'\n');
 return {root,path,turn,read:(patch={})=>readOwnerPermissions({thread_id:id,workspace,codex_home:root,...patch}),close:()=>rmSync(root,{recursive:true,force:true})};
}
test('native effective permissions override a Full access summary; later real correction is observed without rewriting history',()=>{
 const f=fixture();try{
  f.turn();assert.equal(f.read().verified,false);
  f.turn({turn_id:'corrected',approval_policy:'never',sandbox_policy:{type:'danger-full-access'},permission_profile:{type:'disabled'}});
  const r=f.read({expected_turn_id:'corrected'});assert.equal(r.verified,true);assert.equal(r.recorded_at,'2026-11-12T05:00:00Z');
  assert.throws(()=>f.read({expected_turn_id:'setup'}),/mismatch/);
 }finally{f.close();}
});
test('approval never alone and a contradictory restricted profile are insufficient',()=>{
 const f=fixture();try{
  f.turn({approval_policy:'never'});assert.equal(f.read().verified,false);
  f.turn({approval_policy:'never',sandbox_policy:{type:'danger-full-access'}});assert.equal(f.read().verified,false);
 }finally{f.close();}
});
test('permission context must identify the original session, workspace and actual current turn',()=>{
 const f=fixture();try{
  assert.throws(()=>f.read(),/mismatch/);f.turn();assert.throws(()=>f.read({workspace:'/other'}),/mismatch/);
  appendFileSync(f.path,JSON.stringify({type:'session_meta',payload:{id:'other'}})+'\n');assert.throws(()=>f.read(),/mismatch/);
 }finally{f.close();}
});
test('large command output is skipped and Unicode workspace context survives chunk boundaries',()=>{
 const f=fixture(ID,'/任务');try{
  appendFileSync(f.path,JSON.stringify({type:'response_item',payload:{output:'x'.repeat(2200000)}})+'\n');f.turn();
  assert.equal(f.read().workspace,'/任务');assert.equal(f.read().verified,false);
 }finally{f.close();}
});
test('creation requirement derives only from the recorded real human Full access policy',()=>{
 const f=fixture();try{
  assert.equal(creationPermissionRequirement(f.root),null);
  const policy={enabled:true,sandbox_mode:'danger-full-access',approval_policy:'never',actual_human_verified:false};
  const save=()=>writeFileSync(join(f.root,'OWNER_CREATION_POLICY.json'),JSON.stringify({new_chat_permissions:policy}));
  save();assert.equal(creationPermissionRequirement(f.root),null);policy.actual_human_verified=true;policy.source_message_id='human:full-access';save();
  assert.equal(creationPermissionRequirement(f.root).source_message_id,'human:full-access');
 }finally{f.close();}
});
test('catalog refuses to bind a newly required owner on restricted setup, then binds the same corrected owner',()=>{
 const f=workFixture(),n=fixture(OWNER,'/workspace'),prior=process.env.CODEX_HOME;
 try{
  process.env.CODEX_HOME=n.root;f.config.instance_root=n.root;
  writeFileSync(join(n.root,'OWNER_CREATION_POLICY.json'),JSON.stringify({new_chat_permissions:{enabled:true,actual_human_verified:true,source_message_id:'human:full',sandbox_mode:'danger-full-access',approval_policy:'never'}}));
  const t=f.work.create({canonical_key:'permissions',title:'Work',objective:'Work',workspace:'/workspace',requirements:[{id:'done',text:'Done'}]}).task;f.accept(t.id);
  const r=f.work.requestOwner({task_id:t.id,source_message_id:'human:create',verbatim_text:'Create this task',actual_human_verified:true,explicit_new_thread_request_verified:true});
  assert(r.request.required_native_permissions);n.turn();
  const bind=turn=>f.work.bindOwner({task_id:t.id,owner_thread_id:OWNER,existing_owner_authorized:true,actual_human_verified:true,source_message_id:'human:create',evidence_ref:'native',native_binding:nativeProof({thread:OWNER,workspace:'/workspace',cwd:'/workspace',turn,message:'setup',now:f.now()})});
  assert.throws(()=>bind('setup'),/effective_owner_permissions_mismatch/);assert.equal(f.work.get(t.id).owner_thread_id,null);
  n.turn({approval_policy:'never',sandbox_policy:{type:'danger-full-access'},permission_profile:{type:'disabled'}});
  assert.equal(bind('setup').owner_thread_id,OWNER);
  // Rebinding the same existing owner preserves live work; this is admission, not a runtime permission mutation.
  n.turn({approval_policy:'on-request',sandbox_policy:{type:'workspace-write'}});assert.equal(bind('setup').owner_thread_id,OWNER);
 }finally{if(prior===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=prior;n.close();f.c.close();}
});
