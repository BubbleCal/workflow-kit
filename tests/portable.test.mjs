import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {queueHostFingerprint} from '../runtime/native-queue.mjs';
import {OWNER,compatibilityFixture,nativeProof} from '../runtime/test-fixtures/reactive.mjs';

const source=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function setup() {
  const root=mkdtempSync(join(tmpdir(),'workflow-instances-'));
  for(const name of ['one','two']) {
    const dir=join(root,name);mkdirSync(dir);cpSync(join(source,'runtime'),join(dir,'runtime'),{recursive:true});
    cpSync(join(source,'templates'),join(dir,'templates'),{recursive:true});cpSync(join(source,'workflow.mjs'),join(dir,'workflow.mjs'));
    mkdirSync(join(root,'project '+name));
  }
  return root;
}
function run(dir,file,args=[],input) {
  const p=spawnSync(process.execPath,[join(dir,file),...args],{cwd:dir,input:input===undefined?undefined:JSON.stringify(input),encoding:'utf8'});
  return {status:p.status,json:p.stdout.trim()?JSON.parse(p.stdout):null,stderr:p.stderr};
}
function init(root,name) {const dir=join(root,name);assert.equal(run(dir,'workflow.mjs',['init','--legacy','--name',name,'--project-root',join(root,'project '+name)]).status,0);return dir;}
function bind(dir,name) {
  const value={project_id:'project-'+name,threads:Object.fromEntries(['coordinator','inbox','maintenance','dispatcher'].map(role=>[role,name+'-'+role])),native_verified:true,evidence_ref:'isolated-native-fixture'};
  writeFileSync(join(dir,'bindings.json'),JSON.stringify(value));assert.equal(run(dir,'workflow.mjs',['bind','--file','bindings.json']).status,0);return value;
}

test('unbound installation cannot operate a mailbox or accidentally use another instance',()=>{
  const root=setup(),dir=join(root,'one');try {const p=run(dir,'runtime/mailbox.mjs',[],{op:'status'});assert.notEqual(p.status,0);assert.equal(existsSync(join(dir,'mailbox.sqlite')),false);}finally{rmSync(root,{recursive:true,force:true});}
});

test('independent instances keep identical event keys separate and route only to their bound project chats',()=>{
  const root=setup();try {
    const one=init(root,'one'),two=init(root,'two'),a=bind(one,'one');bind(two,'two');
    const first=JSON.parse(readFileSync(join(one,'instance.json'))),second=JSON.parse(readFileSync(join(two,'instance.json')));
    assert.notEqual(first.instance_id,second.instance_id);assert.equal(first.delivery.slack_enabled,false);assert.equal(first.models.default,'inherit');
    const event={op:'enqueue',key:'T-001:result',lane:'coordinator',kind:'event',payload:{text:'Local instance result'}};
    assert.equal(run(one,'runtime/mailbox.mjs',[],event).json.queued,true);
    assert.equal(run(one,'runtime/mailbox.mjs',[],event).json.queued,false);
    assert.equal(run(two,'runtime/mailbox.mjs',[],event).json.queued,true);
    const snapshot={checked_at:new Date().toISOString(),thread:{id:a.threads.coordinator,status:{type:'idle'}},latestTurn:{id:'old',status:'completed'}};
    const planned=run(one,'runtime/mailbox.mjs',[],{op:'plan',snapshots:[snapshot]});assert.equal(planned.status,0);
    assert.equal(planned.json.deliveries.length,1);assert.equal(planned.json.deliveries[0].thread_id,'one-coordinator');
    assert.ok(planned.json.deliveries[0].prompt.includes(realpathSync(one)));assert.ok(!planned.json.deliveries[0].prompt.includes(realpathSync(two)));
    assert.equal(run(two,'runtime/mailbox.mjs',[],{op:'status'}).json.active_batches.length,0);
    const before=readFileSync(join(one,'registry.json'),'utf8');assert.notEqual(run(one,'workflow.mjs',['init','--name','replace','--project-root',join(root,'project one')]).status,0);assert.equal(readFileSync(join(one,'registry.json'),'utf8'),before);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('default instance refuses external delivery and enforces native project evidence',()=>{
  const root=setup();try {
    const dir=init(root,'one');bind(dir,'one');
    const input={op:'prepare',key:'foreign-review',kind:'slack_pr',task_id:'T-001',payload:{message:'https://github.com/example/foreign/pull/1',channel_id:'foreign-channel',expected_head_sha:'a'.repeat(40)},evidence:{verified_at:new Date().toISOString(),scope_authorized:true,authorization_ref:'fixture',policy_version:'v',current_policy_version:'v',stopped:false,pr_owner:'someone',pr_open:true,pr_draft:false,ordinary_change:true,material_findings_open:false,validation_current:true,technical_review_current:true,current_head_sha:'a'.repeat(40),pr_url:'https://github.com/example/foreign/pull/1',already_announced:false}};
    const blocked=run(dir,'runtime/control.mjs',[],input);assert.equal(blocked.json.prepared,false);assert.ok(blocked.json.reasons.includes('delivery_not_enabled_for_this_instance'));assert.ok(blocked.json.reasons.includes('repository_outside_instance_scope'));
    const script="import {instancePolicyReasons} from './runtime/instance.mjs'; const own={operation_project_verified:true,operation_project_id:'project-one'}; console.log(JSON.stringify({other:instancePolicyReasons('dispatch',{}, {operation_project_verified:true,operation_project_id:'project-two'}),own:instancePolicyReasons('dispatch',{}, own),wrongCreate:instancePolicyReasons('create_thread',{placement:{project_id:'project-two'}},own),wrongQuestion:instancePolicyReasons('human_input',{thread_id:'foreign-worker'},{operation_project_verified:true,operation_project_id:'project-two'})}));";
    const p=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:dir,encoding:'utf8'});assert.equal(p.status,0);const result=JSON.parse(p.stdout);assert.deepEqual(result.other,['operation_outside_verified_instance_project']);assert.deepEqual(result.own,[]);
    assert.deepEqual(result.wrongCreate,['native_target_outside_instance_project']);assert.deepEqual(result.wrongQuestion,['operation_outside_verified_instance_project']);
    const doctor=run(dir,'workflow.mjs',['doctor']);assert.equal(doctor.json.local_ready,true);assert.equal(doctor.json.native_setup_recorded,false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('reactive CLI requires desktop queue evidence, submits once and preserves native settings',()=>{
  const root=setup();try{
    const dir=init(root,'one');bind(dir,'one');
    const before=readFileSync(join(dir,'instance.json'),'utf8'),registry=JSON.parse(readFileSync(join(dir,'registry.json'),'utf8'));
    registry.task_registry.items['T-001']={owner_thread_id:OWNER,canonical_key:'test-contract'};
    writeFileSync(join(dir,'registry.json'),JSON.stringify(registry));
    assert.equal(run(dir,'workflow.mjs',['runtime','init']).status,0);
    const configuration=JSON.parse(readFileSync(join(dir,'runtime.json'),'utf8'));
    const workspace=realpathSync(join(root,'project one'));
    configuration.queue.binary=join(dir,'runtime/test-fixtures/native-queue-cli.mjs');
    writeFileSync(join(dir,'runtime.json'),JSON.stringify(configuration));
    const adopted=run(dir,'workflow.mjs',['runtime','op'],{op:'adopt',task_id:'T-001',owner_thread_id:OWNER,source_message_id:'fixture-user',actual_human_verified:true,
      contract:{objective:'Complete the fixture task',canonical_key:'test-contract',project_id:'project-one',workspace,
        authorization_ref:'fixture-original',requirements:[{id:'r1',text:'Verify the result'}],constraints:[],job_sources:['native'],pull_requests:[]}});
    assert.equal(adopted.status,0,adopted.stderr);assert.equal(adopted.json.task.mode,'shadow');
    assert.equal(run(dir,'workflow.mjs',['runtime','probe']).json.desktop_consumption_verified,false);
    const activation={op:'mode',task_id:'T-001',mode:'active',source_message_id:'fixture-activate',actual_human_verified:true,
      native_binding:nativeProof({workspace,status:'completed',now:Date.now()})};
    assert.notEqual(run(dir,'workflow.mjs',['runtime','op'],activation).status,0);
    writeFileSync(join(dir,'observations/queue-proof.json'),JSON.stringify(compatibilityFixture({host:queueHostFingerprint()})));
    const verified=run(dir,'workflow.mjs',['runtime','queue-verify','--file','observations/queue-proof.json']);assert.equal(verified.status,0,JSON.stringify(verified));
    const activated=run(dir,'workflow.mjs',['runtime','op'],activation);
    assert.equal(activated.status,0,JSON.stringify(activated));
    const once=spawnSync(process.execPath,[join(dir,'workflow.mjs'),'runtime','run','--once'],{cwd:dir,encoding:'utf8'});
    assert.equal(once.status,0,once.stderr);
    const status=run(dir,'workflow.mjs',['runtime','status']);assert.equal(status.json.wakes.length,1);assert.equal(status.json.wakes[0].state,'queued');assert.equal(status.json.wakes[0].turn_id,null);
    const again=spawnSync(process.execPath,[join(dir,'workflow.mjs'),'runtime','run','--once'],{cwd:dir,encoding:'utf8'});assert.equal(again.status,0,again.stderr);
    const requests=readFileSync(join(dir,'native-queue-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(requests.filter(args=>args.includes('--thread')).length,1);
    assert.ok(requests.every(args=>!args.includes('--resume')&&!args.includes('app-server')&&!args.includes('--remote')));
    assert.equal(readFileSync(join(dir,'instance.json'),'utf8'),before);
    assert.equal(run(dir,'workflow.mjs',['runtime','op'],{op:'mode',task_id:'T-001',mode:'paused',source_message_id:'fixture-pause',actual_human_verified:true}).json.mode,'paused');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('migration refuses a live old process and preserves uncertain receipts while disabling the old transport',()=>{
  const root=setup();let db;try{
    const dir=init(root,'one');bind(dir,'one');assert.equal(run(dir,'workflow.mjs',['runtime','init']).status,0);
    const legacy={schema_version:1,adapter:{command:['codex','app-server','proxy']},tick_ms:1000,poll_min_ms:30000,poll_max_ms:300000};
    writeFileSync(join(dir,'runtime.json'),JSON.stringify(legacy));
    db=new DatabaseSync(join(dir,'control.sqlite'));
    db.prepare("INSERT INTO rt_tasks(task_id,owner_id,mode,contract,authorization_ref,mode_source,updated_at) VALUES ('T-old',?,'active','{}','user:original','user:enable',0)").run(OWNER);
    db.exec("INSERT INTO rt_wakes(id,task_id,context_rev,plan_rev,event_ids,state,prompt,created_at) VALUES ('old-wake','T-old',0,0,'[]','uncertain','old prompt',0)");
    db.exec('CREATE TABLE rt_process (id INTEGER PRIMARY KEY,pid INTEGER NOT NULL,instance_id TEXT NOT NULL)');
    db.prepare("INSERT INTO rt_process VALUES (1,?,'fixture')").run(process.pid);
    const blocked=run(dir,'workflow.mjs',['runtime','init']);assert.notEqual(blocked.status,0);assert.match(blocked.json.error,/Stop the existing/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir,'runtime.json'))),legacy);
    db.exec('DELETE FROM rt_process');const migrated=run(dir,'workflow.mjs',['runtime','init']);assert.equal(migrated.status,0);
    assert.equal(migrated.json.paused_tasks,1);assert.deepEqual(JSON.parse(readFileSync(migrated.json.backup)),legacy);
    const config=JSON.parse(readFileSync(join(dir,'runtime.json')));assert.equal(config.schema_version,2);assert.equal(config.adapter,undefined);assert.equal(config.transport,'native_queue');
    assert.equal(db.prepare("SELECT state FROM rt_wakes WHERE id='old-wake'").get().state,'uncertain');
    assert.equal(db.prepare("SELECT mode FROM rt_tasks WHERE task_id='T-old'").get().mode,'paused');
    assert.equal(existsSync(join(dir,'native-queue-calls.jsonl')),false);
  }finally{db?.close();rmSync(root,{recursive:true,force:true});}
});

const MAIN='44444444-4444-4444-8444-444444444444',DISCOVERY='55555555-5555-4555-8555-555555555555';
function nativeSetup(root,{discovery=false}={}){
  const dir=join(root,'one'),workspace=realpathSync(join(root,'project one'));
  const installed=run(dir,'workflow.mjs',['init','--name','native','--project-root',workspace]);assert.equal(installed.status,0,installed.stderr);
  writeFileSync(join(dir,'bindings.json'),JSON.stringify({project_id:'project-one',threads:{main:MAIN,...(discovery?{discovery:DISCOVERY}:{})},
    thread_workspaces:{main:workspace,...(discovery?{discovery:workspace}:{})},native_verified:true,evidence_ref:'native-fixture'}));
  assert.equal(run(dir,'workflow.mjs',['bind','--file','bindings.json']).status,0);
  assert.equal(run(dir,'workflow.mjs',['runtime','init']).status,0);
  const config=JSON.parse(readFileSync(join(dir,'runtime.json'),'utf8'));config.queue.binary=join(dir,'runtime/test-fixtures/native-queue-cli.mjs');
  writeFileSync(join(dir,'runtime.json'),JSON.stringify(config));
  writeFileSync(join(dir,'observations/queue-proof.json'),JSON.stringify(compatibilityFixture({host:queueHostFingerprint()})));
  assert.equal(run(dir,'workflow.mjs',['runtime','queue-verify','--file','observations/queue-proof.json']).status,0);
  return {dir,workspace,task:installed.json.builtin_exploration};
}
function op(dir,group,input){const r=run(dir,'workflow.mjs',[group,'op'],input);assert.equal(r.status,0,r.stderr);return r.json;}
function once(dir){const r=spawnSync(process.execPath,[join(dir,'workflow.mjs'),'runtime','run','--once'],{cwd:dir,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}

test('fresh native install runs built-in exploration through the ordinary queue without old roles or external sources',()=>{
 const root=setup();try{const {dir,workspace,task}=nativeSetup(root);
  assert.equal(existsSync(join(dir,'registry.json')),false);assert.equal(existsSync(join(dir,'decisions.json')),false);
  assert.equal(run(dir,'workflow.mjs',['doctor']).json.local_ready,true);
  assert.ok(run(dir,'workflow.mjs',['sources','list']).json.sources.every(s=>!s.enabled));
  const id=task.task_id;op(dir,'task',{op:'accept',task_id:id,actual_human_verified:true,source_message_id:'user:explore',evidence_ref:'actual-scope'});
  op(dir,'task',{op:'bind_owner',task_id:id,owner_thread_id:OWNER,native_binding:nativeProof({workspace,status:'completed',now:Date.now()}),
   evidence_ref:'native-owner',existing_owner_authorized:true,actual_human_verified:true,source_message_id:'user:owner'});
  op(dir,'task',{op:'start',task_id:id});once(dir);once(dir);
  const rt=run(dir,'workflow.mjs',['runtime','status']).json,w=rt.wakes[0];assert.equal(w.state,'queued');
  op(dir,'runtime',{op:'begin',task_id:id,wake_id:w.id,native_proof:nativeProof({workspace,message:w.prompt,now:Date.now()})});
  op(dir,'task',{op:'report',task_id:id,owner_thread_id:OWNER,report_key:'bounded-report',outcome:'no_actionable_findings',summary:'No supported change in the inspected scope',evidence_refs:['saved-report']});
  const current=op(dir,'runtime',{op:'checkpoint',task_id:id});
  op(dir,'runtime',{op:'decide',task_id:id,owner_thread_id:OWNER,wake_id:w.id,expected_context_rev:current.task.context_rev,expected_plan_rev:0,
   disposition:'complete',reason:'Research scope delivered',evidence_refs:['bounded-report'],acceptance:[{requirement_id:'evidence',passed:true,evidence_ref:'bounded-report'},{requirement_id:'outcome',passed:true,evidence_ref:'bounded-report'}]});
  assert.equal(op(dir,'runtime',{op:'finish',task_id:id,wake_id:w.id,turn_id:'native-turn',evidence_ref:'bounded-report'}).task_complete,true);
  assert.equal(run(dir,'workflow.mjs',['discovery','status']).json.batches.length,0);
  const calls=readFileSync(join(dir,'native-queue-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(a=>a.includes('--thread'));
  assert.equal(calls.length,1);assert.ok(calls[0].includes(OWNER));assert.equal(run(dir,'workflow.mjs',['task','list']).json.length,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('source-only native discovery recovers a durable finish before mailbox acknowledgement and skips invalidated queued work',()=>{
 const root=setup();let db;try{const {dir,workspace}=nativeSetup(root,{discovery:true});
  const configure=()=>op(dir,'sources',{op:'configure',source_id:'linear',enabled:true,scope:{project:'project'},source_message_id:'user:source',actual_human_verified:true,evidence_ref:'source-scope'});
  configure();
  const reserveCode="import {ControlStore} from './runtime/control.mjs';import {Mailbox} from './runtime/mailbox.mjs';const c=new ControlStore('./control.sqlite'),m=new Mailbox('./mailbox.sqlite');const scan=c.discovery.enqueueDue(m,process.cwd());const reserved=m.reserveQueuedInbox(null,'discovery');m.setPrompt(reserved.batch.id,c.discovery.batch(scan.batch_id).prompt);m.close();c.close();";
  const reserved=spawnSync(process.execPath,['--input-type=module','-e',reserveCode],{cwd:dir,encoding:'utf8'});assert.equal(reserved.status,0,reserved.stderr);
  once(dir);db=new DatabaseSync(join(dir,'control.sqlite'));
  let b=db.prepare("SELECT * FROM discovery_batches WHERE state='pending'").get();
  const proof=()=>nativeProof({thread:DISCOVERY,workspace,message:b.prompt,now:Date.now()});
  configure();assert.equal(op(dir,'discovery',{op:'begin',batch_id:b.id,generation:b.generation,native_proof:proof()}).invalidated,true);
  once(dir);b=db.prepare("SELECT * FROM discovery_batches WHERE state='pending'").get();
  op(dir,'discovery',{op:'begin',batch_id:b.id,generation:b.generation,native_proof:proof()});
  op(dir,'discovery',{op:'ingest',batch_id:b.id,generation:b.generation,source_id:'linear',page_key:'all',observations:[],complete:true,evidence_ref:'real-fixture-page'});
  // Simulate process exit between the two independent durable database commits.
  const code="import {ControlStore} from './runtime/control.mjs';const c=new ControlStore('./control.sqlite');const b=c.discovery.status().batches.find(b=>b.state==='running');c.discovery.finish({batch_id:b.id,generation:1,source_results:[{source_id:'linear',complete:true,followups_complete:true}]});c.close();";
  const p=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:dir,encoding:'utf8'});assert.equal(p.status,0,p.stderr);
  once(dir);const mailbox=new DatabaseSync(join(dir,'mailbox.sqlite'));try{
   assert.equal(mailbox.prepare("SELECT COUNT(*) AS n FROM batches WHERE lane='discovery' AND state<>'finished'").get().n,0);
  }finally{mailbox.close();}
  assert.equal(db.prepare('SELECT last_success_at FROM discovery_sources WHERE source_id=?').get('linear').last_success_at,Date.parse(JSON.parse(b.snapshot).sources[0].window.to));
 }finally{db?.close();rmSync(root,{recursive:true,force:true});}
});

test('native layout migration preserves legacy records and imports existing task ownership without creating roles',()=>{
 const root=setup();let db;try{const dir=init(root,'one'),old=bind(dir,'one'),workspace=realpathSync(join(root,'project one'));
  assert.equal(run(dir,'workflow.mjs',['runtime','init']).status,0);
  const registry=readFileSync(join(dir,'registry.json'),'utf8');
  db=new DatabaseSync(join(dir,'control.sqlite'));
  const contract={canonical_key:'existing-goal',objective:'Existing authorized work',workspace,requirements:[{id:'r',text:'Deliver'}],constraints:[],job_sources:['native'],pull_requests:[]};
  db.prepare("INSERT INTO rt_tasks(task_id,owner_id,mode,contract,authorization_ref,mode_source,updated_at) VALUES ('T-existing',?,'paused',?,'actual-user-goal','actual-enable',0)").run(OWNER,JSON.stringify(contract));
  const migration={actual_human_verified:true,source_message_id:'user:migrate',legacy_scheduler_paused:true,scheduler_evidence_ref:'scheduler-readback',
   native_verified:true,evidence_ref:'native-main',project_id:old.project_id,threads:{main:MAIN},thread_workspaces:{main:workspace}};
  writeFileSync(join(dir,'migration.json'),JSON.stringify(migration));
  const result=run(dir,'workflow.mjs',['migrate','--file','migration.json']);assert.equal(result.status,0,result.stderr);
  assert.deepEqual(result.json.imported_execution_tasks,['T-existing']);assert.equal(result.json.native_chats_created,0);assert.equal(existsSync(result.json.backup),true);
  assert.equal(readFileSync(join(dir,'registry.json'),'utf8'),registry);
  const list=run(dir,'workflow.mjs',['task','list']).json;
  assert.equal(list.find(t=>t.id==='T-existing').owner_thread_id,OWNER);assert.equal(list.find(t=>t.id==='T-existing').execution.mode,'paused');
  assert.equal(list.filter(t=>t.kind==='exploration').length,1);
 }finally{db?.close();rmSync(root,{recursive:true,force:true});}
});
