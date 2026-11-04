import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ControlStore} from './control.mjs';
import {ownershipReasons,scopedHandoffReasons} from './task-ownership.mjs';

function setup(complete=false) {
 const registry={task_registry:{items:{'T-190':{canonical_key:'recall-calibration',owner_thread_id:'original-chat',task_complete:complete},'T-191':{canonical_key:'take-order',owner_thread_id:'original-chat'}}}};
 const c=new ControlStore(':memory:',{taskRegistry:()=>registry});
 c.db.prepare("INSERT INTO actions(action_key,kind,task_id,scope_key,digest,payload,state,due,created_at,updated_at) VALUES ('original-create','create_thread','T-190','create:recall','fixture',?,'sent',1,1,1)").run(JSON.stringify({canonical_task_key:'recall-calibration'}));
 c.db.prepare("INSERT INTO thread_setups(creation_key,task_id,placement,thread_id,host_id,state,updated_at) VALUES ('original-create','T-190','{}','original-chat','local','complete',1)").run();return {c,registry};
}
test('an idle or completed unrelated task never makes its chat reusable for a new task',()=>{
 for(const complete of [false,true]){const {c,registry}=setup(complete);const payload={thread_id:'original-chat'},e={owner_matches:true,thread_status:'idle'};
  assert.deepEqual(ownershipReasons('dispatch','T-191',payload,e,registry,c.db),['chat_canonical_task_mismatch']);
  assert.deepEqual(ownershipReasons('dispatch','T-190',payload,e,registry,c.db),[]);
  assert.equal(c.prepare({key:'wrong-task',kind:'dispatch',task_id:'T-191',payload,evidence:e}).allowed,false);
  assert.equal(c.db.prepare("SELECT count(*) n FROM actions WHERE action_key='wrong-task'").get().n,0);c.close();}
});
test('same repository or ambiguous registry-only mappings do not establish task identity',()=>{
 const {c,registry}=setup();c.db.prepare('DELETE FROM thread_setups').run();
 assert.deepEqual(ownershipReasons('dispatch','T-190',{thread_id:'original-chat'},{owner_matches:true},registry,c.db),['chat_canonical_task_mismatch']);
 assert.deepEqual(ownershipReasons('dispatch','missing',{thread_id:'original-chat'},{},registry,c.db),['registered_task_owner_identity_required']);c.close();
});
test('an actual scoped checkpoint release may reach the mixed writer but cannot start unrelated work',()=>{
 const {c,registry}=setup(),p={thread_id:'original-chat',intent:'scope_handoff_checkpoint',handoff_task_id:'T-191',handoff_canonical_task_key:'take-order'},e={actual_human_message_verified:true,scope_release_only:true,explicit_scope_split_verified:true};
 assert.deepEqual(ownershipReasons('human_input','T-191',p,e,registry,c.db),[]);
 assert.ok(ownershipReasons('dispatch','T-191',p,e,registry,c.db).length);assert.ok(ownershipReasons('human_input','T-191',p,{...e,scope_release_only:false},registry,c.db).length);c.close();
});
test('scope handoff binds the same task and actual checkpoint while preserving healthy jobs without old-chat archive',()=>{
 const dir=mkdtempSync(join(tmpdir(),'scope-handoff-')),path=join(dir,'checkpoint.json');writeFileSync(path,'{"task":"T-191","writer":"released"}');
 const p={canonical_task_key:'take-order',scope_handoff:{task_id:'T-191',canonical_task_key:'take-order',from_thread_id:'old-mixed-chat',checkpoint_path:path,checkpoint_sha256:createHash('sha256').update('{"task":"T-191","writer":"released"}').digest('hex')}},e={explicit_scope_split_verified:true,old_scope_writer_quiescent:true,scope_write_ownership_released:true,healthy_jobs_preserved:true,job_ownership_handoff_verified:true,duplicate_execution_owner_exists:false};
 try {assert.deepEqual(scopedHandoffReasons('T-191',p,e),[]);assert.ok(scopedHandoffReasons('T-190',p,e).length);assert.ok(scopedHandoffReasons('T-191',p,{...e,old_scope_writer_quiescent:false}).length);writeFileSync(path,'changed');assert.ok(scopedHandoffReasons('T-191',p,e).includes('scope_handoff_checkpoint_changed'));}finally{rmSync(dir,{recursive:true,force:true});}
});
