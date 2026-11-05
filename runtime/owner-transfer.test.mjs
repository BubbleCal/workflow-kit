import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {fixture,OWNER,NOW,nativeProof} from './test-fixtures/reactive.mjs';
import {transferPausedOwner} from './owner-transfer.mjs';
const NEXT='33333333-3333-4333-8333-333333333333';
function setup(){
 const f=fixture(),root=mkdtempSync(join(tmpdir(),'owner-transfer-')),path=join(root,'scope.json');writeFileSync(path,'{"writer_released":true}');
 f.s.setMode({task_id:'T-1',mode:'paused',actual_human_verified:true,source_message_id:'pause'});
 const hash=createHash('sha256').update('{"writer_released":true}').digest('hex');
 const payload={canonical_task_key:f.s.task('T-1').contract.canonical_key,source_message_id:'split',scope_handoff:{from_thread_id:OWNER,checkpoint_path:path,checkpoint_sha256:hash}};
 f.c.db.prepare("INSERT INTO actions(action_key,kind,task_id,scope_key,digest,payload,state,due,created_at,updated_at) VALUES ('create','create_thread','T-1','task','digest',?,'sent',?,?,?)").run(JSON.stringify(payload),NOW,NOW,NOW);
 f.c.db.prepare("INSERT INTO thread_setups(creation_key,task_id,placement,host_id,thread_id,state,updated_at) VALUES ('create','T-1','{}','local',?,'complete',?)").run(NEXT,NOW);
 const input={task_id:'T-1',from_thread_id:OWNER,to_thread_id:NEXT,creation_action_key:'create',source_message_id:'split',checkpoint_path:path,checkpoint_sha256:hash,
  actual_human_verified:true,scope_release_verified:true,old_native_binding:nativeProof({status:'completed'}),native_binding:nativeProof({thread:NEXT,status:'completed'})};
 return {...f,input,root,close(){f.c.close();rmSync(root,{recursive:true,force:true});}};
}
test('verified paused scope transfer preserves task identity, requirements and receipts without starting work',()=>{
 const f=setup();try{const before=f.s.task('T-1');const result=transferPausedOwner(f.c,f.input);assert.equal(result.transferred,true);assert.equal(result.execution_started,false);
 assert.equal(result.task.owner_id,NEXT);assert.equal(result.task.mode,'paused');assert.deepEqual(result.task.contract.requirements,before.contract.requirements);
 assert.equal(result.task.contract.canonical_key,before.contract.canonical_key);assert.equal(f.c.db.prepare("SELECT state FROM actions WHERE action_key='create'").get().state,'sent');
 assert.equal(transferPausedOwner(f.c,f.input).duplicate,true);
 }finally{f.close();}
});
test('scope transfer rejects a changed checkpoint, wrong creation, active old writer and uncertain effects',()=>{
 for(const change of ['checkpoint','creation','writer','uncertain','authority']){const f=setup();try{
  if(change==='checkpoint')writeFileSync(f.input.checkpoint_path,'changed');
  if(change==='creation')f.input.creation_action_key='other';
  if(change==='writer')f.input.old_native_binding=nativeProof();
  if(change==='uncertain')f.c.db.prepare("UPDATE actions SET state='uncertain' WHERE action_key='create'").run();
  if(change==='authority')f.input.actual_human_verified=false;
  assert.throws(()=>transferPausedOwner(f.c,f.input));assert.equal(f.s.task('T-1').owner_id,OWNER);
 }finally{f.close();}}
});
