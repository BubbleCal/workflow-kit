import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {prepareT3Migration,t3Main} from './t3-preparation.mjs';

test('migration preparation preserves original identities, live receipts, holds and contracts without writing source state',async()=>{
 const root=mkdtempSync(join(tmpdir(),'t3-prepare-')),path=join(root,'control.sqlite');
 const db=new DatabaseSync(path);
 try{
  writeFileSync(join(root,'instance.json'),JSON.stringify({instance_id:'original-instance',threads:{main:'original-main',discovery:'original-discovery'}}));
  db.exec(`CREATE TABLE work_items(id,canonical_key,kind,state,owner_thread_id,data,authorization);
    CREATE TABLE rt_tasks(task_id,mode,status,contract,contract_rev,context_rev,plan_rev);
    CREATE TABLE rt_wakes(id,owner_id,state,transport,queue_id,turn_id);
    CREATE TABLE actions(action_key,kind,state,task_id);`);
  const contract={objective:'Finish original work',workspace:'/original-worktree',constraints:['No merge before personal review'],requirements:[{id:'perf',text:'Matched baseline evidence'}]};
  db.prepare('INSERT INTO work_items VALUES (?,?,?,?,?,?,?)').run('T-1','original-canonical','work','accepted','original-owner',JSON.stringify({workspace:'/original-worktree'}),JSON.stringify({source_message_id:'actual-human',actual_human_verified:true}));
  db.prepare('INSERT INTO rt_tasks VALUES (?,?,?,?,?,?,?)').run('T-1','paused','needs_decision',JSON.stringify(contract),4,8,2);
  db.prepare('INSERT INTO rt_wakes VALUES (?,?,?,?,?,?)').run('original-wake','original-owner','uncertain','native_queue','original-queue',null);
  db.prepare('INSERT INTO actions VALUES (?,?,?,?)').run('original-action','task_queue','uncertain','T-1');
  const before=readFileSync(path),config=readFileSync(join(root,'instance.json')),m=prepareT3Migration(root);
  assert.deepEqual(readFileSync(path),before);assert.deepEqual(readFileSync(join(root,'instance.json')),config);
  assert.equal(m.live_cutover_enabled,false);assert.deepEqual(m.tasks[0].contract,contract);
  assert.equal(m.tasks[0].open_executions[0].queue_id,'original-queue');assert.equal(m.tasks[0].original_authorization.source_message_id,'actual-human');
  assert(m.tasks[0].cutover_blockers.includes('explicit_pause'));assert.equal(m.tasks[0].target_owner,null);
  const out=join(root,'manifest.json');let result;await t3Main(['prepare','--instance',root,'--out',out],{output:v=>result=v});
  assert.equal(result.prepared,true);assert.equal(result.live_cutover_enabled,false);
  await assert.rejects(t3Main(['prepare','--instance',root,'--out',out]),/EEXIST/);
  assert.equal(db.prepare('SELECT count(*) n FROM rt_wakes').get().n,1);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
