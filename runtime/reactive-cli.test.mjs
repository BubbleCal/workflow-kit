import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {legacyQuiescent,runtimeConfig} from './reactive-cli.mjs';
import {bindings} from './instance.mjs';
import {nativeProof,OWNER} from './test-fixtures/reactive.mjs';

test('native control work does not prevent unrelated cutover, while old dispatches remain protected',()=>{
  const root=mkdtempSync(join(tmpdir(),'cutover-boundary-')),db=new DatabaseSync(join(root,'mailbox.sqlite'));
  try{
    db.exec('CREATE TABLE batches(lane TEXT,state TEXT,snapshot TEXT);CREATE TABLE continuation_actions(payload TEXT,state TEXT)');
    db.prepare('INSERT INTO batches VALUES (?,?,?)').run('coordinator','running',JSON.stringify({delivery_transport:'native_queue'}));
    assert.equal(legacyQuiescent(root,['T-1','T-2']),true);
    db.prepare('INSERT INTO continuation_actions VALUES (?,?)').run(JSON.stringify({task_id:'T-2'}),'uncertain');
    assert.equal(legacyQuiescent(root,['T-1','T-2']),false);assert.equal(legacyQuiescent(root,'T-1'),true);
    db.exec('DELETE FROM continuation_actions');db.prepare('INSERT INTO batches VALUES (?,?,?)').run('coordinator','running','{}');
    assert.equal(legacyQuiescent(root,'T-1'),false);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('cutover can inherit only the exact evidenced running turn without replaying its action',()=>{
  const root=mkdtempSync(join(tmpdir(),'running-cutover-')),m=new DatabaseSync(join(root,'mailbox.sqlite')),c=new DatabaseSync(join(root,'control.sqlite'));
  try{
    m.exec('CREATE TABLE batches(lane TEXT,state TEXT,snapshot TEXT);CREATE TABLE continuation_actions(action_key TEXT,payload TEXT,state TEXT,owner_thread_id TEXT,actual_turn TEXT,preflight_turn TEXT,receipt TEXT)');
    c.exec('CREATE TABLE actions(action_key TEXT,state TEXT,payload TEXT)');
    m.prepare('INSERT INTO continuation_actions VALUES (?,?,?,?,?,?,?)').run('old',JSON.stringify({task_id:'T-1'}),'running',OWNER,'native-turn','prior',JSON.stringify({outcome:'sent',control_action_key:'old',work_evidence_ref:'actual-work'}));
    c.prepare('INSERT INTO actions VALUES (?,?,?)').run('old','sent',JSON.stringify({thread_id:OWNER}));
    const proof=nativeProof({now:Date.now()});assert.equal(legacyQuiescent(root,'T-1',proof),true);
    proof.readback.turns[0].status='completed';proof.readback.thread.status.type='idle';assert.equal(legacyQuiescent(root,'T-1',proof),true);
    proof.readback.turns[0].status='interrupted';assert.equal(legacyQuiescent(root,'T-1',proof),false);
    proof.readback.turns[0].status='inProgress';proof.readback.thread.status.type='active';
    proof.readback.turns[0].id='another-turn';assert.equal(legacyQuiescent(root,'T-1',proof),false);
    proof.readback.turns[0].id='native-turn';m.exec("UPDATE continuation_actions SET state='sent'");assert.equal(legacyQuiescent(root,'T-1',proof),false);
    m.exec("UPDATE continuation_actions SET state='running'");c.exec("UPDATE actions SET state='uncertain'");assert.equal(legacyQuiescent(root,'T-1',proof),false);
    assert.equal(m.prepare('SELECT state FROM continuation_actions').get().state,'running');
  }finally{m.close();c.close();rmSync(root,{recursive:true,force:true});}
});


test('on-request config blocks main at the transport boundary without losing other queue settings',()=>{
  const root=mkdtempSync(join(tmpdir(),'human-only-config-'));
  try{
    const config={schema_version:2,transport:'native_queue',queue:{binary:'custom-codex',blocked_thread_ids:[OWNER]},
      inbox:{thread_id:bindings.threads.inbox,project_id:bindings.scope.project_id,workspace:'/inbox',delivery_mode:'on_request'}};
    writeFileSync(join(root,'runtime.json'),JSON.stringify(config));
    const actual=runtimeConfig(root);assert.equal(actual.queue.binary,'custom-codex');
    assert.deepEqual(actual.queue.blocked_thread_ids,[OWNER,bindings.threads.inbox]);
    config.inbox.delivery_mode='typo';writeFileSync(join(root,'runtime.json'),JSON.stringify(config));
    assert.throws(()=>runtimeConfig(root),/Invalid inbox delivery mode/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
