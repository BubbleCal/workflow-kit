import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CodexAdapter} from './codex-adapter.mjs';

function setup(behavior='normal') {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'codex-adapter-')));
  const task={owner_id:'owner',contract:{project_id:'p',workspace:root}};
  const adapter=new CodexAdapter({command:[process.execPath,join(dirname(fileURLToPath(import.meta.url)),'test-fixtures/app-server.mjs'),root,behavior],timeout_ms:1000});
  return {root,task,adapter,requests:()=>readFileSync(join(root,'requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse),
    close:()=>{adapter.close();rmSync(root,{recursive:true,force:true});}};
}

test('supported RPC adapter verifies the owner and preserves model, reasoning, permissions and tier',async()=>{
  const f=setup();try{
    const o=await f.adapter.observe(f.task);assert.equal(o.turn_id,'old-turn');assert.equal(o.queued_input,false);
    assert.equal(o.permissions_preserved,true);assert.equal(o.permission_snapshot.approval_policy,'on-request');
    const wake={id:'wake-1',preflight_turn:o.turn_id};
    const sent=await f.adapter.start(f.task,wake,'[workflow-event:wake-1]\nReassess source facts');
    assert.equal(sent.turn.id,'new-turn');
    const requests=f.requests(),start=requests.find(r=>r.method==='turn/start');
    assert.deepEqual(Object.keys(start.params).sort(),['clientUserMessageId','input','threadId','turnTrigger']);
    assert.ok(requests.filter(r=>r.method==='thread/resume').every(r=>Object.keys(r.params).sort().join(',')==='excludeTurns,threadId'));
    assert.equal((await f.adapter.findDelivery(f.task,wake)).found,true);
  }finally{f.close();}
});

test('queued human input prevents automatic delivery',async()=>{
  const f=setup('queued');try{
    const o=await f.adapter.observe(f.task);assert.equal(o.queued_input,true);
    await assert.rejects(()=>f.adapter.start(f.task,{id:'w',preflight_turn:'old-turn'},'notice'),error=>error.not_sent===true);
    assert.ok(!f.requests().some(r=>r.method==='turn/start'));
  }finally{f.close();}
});

test('missing job-observation support is unknown, never an empty job list',async()=>{
  const f=setup('unknown-jobs');try{
    await assert.rejects(()=>f.adapter.observe(f.task),/Cannot verify idle owner/);
    assert.ok(!f.requests().some(r=>r.method==='turn/start'));
  }finally{f.close();}
});

test('a transport loss after writing a turn is not reported as proven non-delivery',async()=>{
  const f=setup('disconnect-after-send');try{
    await f.adapter.observe(f.task);
    await assert.rejects(()=>f.adapter.start(f.task,{id:'w',preflight_turn:'old-turn'},'notice'),error=>error.not_sent!==true);
    assert.equal(f.requests().filter(r=>r.method==='turn/start').length,1);
  }finally{f.close();}
});

test('an unrelated native project cannot be resumed or woken',async()=>{
  const f=setup();try{
    await assert.rejects(()=>f.adapter.observe({...f.task,contract:{...f.task.contract,project_id:'another-project'}}),/project or workspace/);
    assert.ok(!f.requests().some(r=>r.method==='thread/resume'));
  }finally{f.close();}
});
