import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

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
