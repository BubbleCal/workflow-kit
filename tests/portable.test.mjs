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
function init(root,name) {const dir=join(root,name);assert.equal(run(dir,'workflow.mjs',['init','--name',name,'--project-root',join(root,'project '+name)]).status,0);return dir;}
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
