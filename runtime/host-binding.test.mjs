import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fixture,nativeProof,compatibilityFixture,OWNER} from './test-fixtures/reactive.mjs';
import {macHostFingerprint,verifyMigratedHostBinding} from './host-identity.mjs';
import {migrateRuntimeHostBinding} from './host-binding.mjs';
const digest=v=>createHash('sha256').update(v).digest('hex');
function setup(){
 const root=mkdtempSync(join(tmpdir(),'host-binding-')),f=fixture();f.activate();f.event();const wake=f.begin();
 const task=f.s.task('T-1');f.c.db.prepare('UPDATE rt_tasks SET contract=? WHERE task_id=?').run(JSON.stringify({...task.contract,service_lane:'maintenance'}),'T-1');
 const config={service_tasks:{maintenance:'T-1'},queue:{binary:'codex'},queue_validation:{file:'old'},desktop_loader:{enabled:false,mode:'idle_only',authorization_ref:'original-idle-authority',bundle_id:'com.openai.codex',min_idle_ms:600000,check_interval_ms:15000,open_interval_ms:30000,retry_interval_ms:300000,queue_grace_ms:30000,excluded_task_ids:['T-held'],validation_pending:{reason:'hostname'}},unrelated:{hold:true}};
 const save=(p,v)=>writeFileSync(join(root,p),JSON.stringify(v));save('runtime.json',config);
 save('queue.json',compatibilityFixture());const poll=status=>({polls:[{thread:{id:OWNER,hostId:'local',status:{type:status}},latestTurn:{id:'unchanged'}}]});
 save('desktop.json',{source:'codex_app.wait_threads',bundle_id:'com.openai.codex',host_fingerprint:'fixture-host',before:poll('notLoaded'),after:poll('idle')});
 const human=nativeProof({thread:'main',turn:'human-turn',message:'Repair original continuation',status:'completed',now:f.now()});human.readback.turns[0].items[0].id='human-message';
 const input={task_id:'T-1',actual_human_verified:true,source_message_id:'human-message',source_thread_id:'main',source_turn_id:'human-turn',verbatim_text:'Repair original continuation',evidence_ref:'real-human-proof',human_authorization:human,native_proof:nativeProof({message:wake.prompt,now:f.now()}),expected_runtime_digest:digest(readFileSync(join(root,'runtime.json'))),queue_evidence_file:join(root,'queue.json'),desktop_evidence_file:join(root,'desktop.json'),restore_desktop:true};
 const options={root,identity:()=>({legacy:'fixture-host',stable:'stable-machine-home'}),probeQueue:async()=>({cli_version:'codex-cli fixture',host_fingerprint:'stable-machine-home'})};
 return {...f,root,input,options,config,close(){f.c.close();rmSync(root,{recursive:true,force:true});}};
}
test('stable hardware and home identity excludes volatile host names and rejects missing hardware',()=>{
 const uuid='01234567-89ab-cdef-0123-456789abcdef',h=macHostFingerprint(uuid,'/Users/a');
 assert.equal(h,macHostFingerprint(uuid.toUpperCase(),'/Users/a'));assert.notEqual(h,macHostFingerprint(uuid,'/Users/b'));assert.notEqual(h,macHostFingerprint('11234567-89ab-cdef-0123-456789abcdef','/Users/a'));
 for(const id of ['',null,'00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff','hostname'])assert.throws(()=>macHostFingerprint(id,'/Users/a'));
});
test('acknowledged maintenance migrates exact native evidence without refreshing observations or weakening idle settings',async()=>{
 const f=setup();try{
 const originals=['queue','desktop'].map(n=>readFileSync(join(f.root,n+'.json'),'utf8'));
 const r=await migrateRuntimeHostBinding(f.c,f.input,f.options);assert(r.migrated);assert.equal(r.min_idle_ms,600000);
 const next=JSON.parse(readFileSync(join(f.root,'runtime.json')));assert.deepEqual(next.unrelated,f.config.unrelated);assert.deepEqual(next.desktop_loader.excluded_task_ids,['T-held']);assert.equal(next.desktop_loader.enabled,true);
 for(const [i,path] of [next.queue_validation.file,next.desktop_loader.evidence_file].entries()){
  const migrated=JSON.parse(readFileSync(path));verifyMigratedHostBinding(migrated);
  const restored={...migrated,host_fingerprint:'fixture-host'};delete restored.host_binding;assert.deepEqual(restored,JSON.parse(originals[i]));assert.equal(readFileSync(join(f.root,['queue','desktop'][i]+'.json'),'utf8'),originals[i]);
  const tampered=structuredClone(migrated);tampered.source='invented';assert.throws(()=>verifyMigratedHostBinding(tampered),/preserve/);
  writeFileSync(migrated.host_binding.original_evidence_ref,'{}');assert.throws(()=>verifyMigratedHostBinding(migrated),/changed/);
 }
 }finally{f.close();}
});
test('wrong human, actor, turn, stale proof, legacy host, CLI and concurrent config all fail closed',async()=>{
 const changes=[f=>f.input.actual_human_verified=false,f=>f.input.verbatim_text='invented',f=>f.input.native_proof.readback.thread.id='foreign',f=>f.input.native_proof.readback.turns[0].id='wrong',f=>f.advance(61000),f=>f.options.identity=()=>({legacy:'other-machine',stable:'stable-machine-home'}),f=>f.options.probeQueue=async()=>({cli_version:'another-cli',host_fingerprint:'stable-machine-home'}),f=>f.input.expected_runtime_digest='stale',f=>f.options.probeQueue=async()=>{writeFileSync(join(f.root,'runtime.json'),'{"concurrent":true}');return{cli_version:'codex-cli fixture',host_fingerprint:'stable-machine-home'};}];
 for(const change of changes){const f=setup();try{change(f);await assert.rejects(()=>migrateRuntimeHostBinding(f.c,f.input,f.options));const after=JSON.parse(readFileSync(join(f.root,'runtime.json')));assert(!after.desktop_loader?.enabled);assert.notEqual(after.queue_validation?.file,join(f.root,'queue-stable.json'));}finally{f.close();}}
});
function manualSupport(f){
 const owner='01900000-0000-7000-8000-000000000003';
 Object.assign(f.c.work.config,{layout:'native',threads:{main:'main',discovery:'discovery'},scope:{project_root:'/manual'},
  support:{maintenance_thread_id:owner,mode:'manual_only',automatic_control_lane:false,archive:false,source_message_id:'keep-support',evidence_ref:'preservation-receipt'}});
 const {service_tasks,...config}=f.config,path=join(f.root,'runtime.json');
 writeFileSync(path,JSON.stringify(config));
 delete f.input.task_id;
 f.input.actor_mode='manual_support';f.input.native_proof=nativeProof({thread:owner,workspace:'/manual',turn:'manual-current',now:f.now()});
 f.input.expected_runtime_digest=digest(readFileSync(path));
 return path;
}
test('bound manual support can rebind host proof without a maintenance task, wake, or schedule',async()=>{
 const f=setup();try{
  const path=manualSupport(f),wakes=()=>f.c.db.prepare('SELECT * FROM rt_wakes').all();
  const prior=wakes(),result=await migrateRuntimeHostBinding(f.c,f.input,f.options);
  const config=JSON.parse(readFileSync(path));
  assert.equal(result.actor_mode,'manual_support');assert.equal(result.actor_turn_id,'manual-current');
  assert.equal(result.previous_runtime_digest,f.input.expected_runtime_digest);
  assert.equal(existsSync(join(dirname(config.queue_validation.file),'runtime-before.json')),false);
  assert.equal(config.service_tasks,undefined);assert.equal(config.desktop_loader.min_idle_ms,600000);
  assert.deepEqual(wakes(),prior);
  for(const file of [config.queue_validation.file,config.desktop_loader.evidence_file])verifyMigratedHostBinding(JSON.parse(readFileSync(file)));
 }finally{f.close();}
});
test('manual support cannot use an ordinary chat, paused turn, stale proof or an automatic service binding',async()=>{
 const changes=[
  f=>{f.input.native_proof.readback.thread.id='other-owner';},
  f=>{f.input.native_proof.readback.thread.cwd='/wrong-project';},
  f=>{f.input.native_proof.readback.thread.status.activeFlags=['waitingOnApproval'];},
  f=>{f.input.native_proof.readback.turns[0].status='completed';},
  f=>{f.c.work.config.support.archive=true;},
  f=>{f.c.work.config.threads.main=f.c.work.config.support.maintenance_thread_id;},
  f=>{f.c.work.config.support.automatic_control_lane=true;},
  f=>{f.input.task_id='T-1';},
  f=>{f.input.verbatim_text='different human authority';},
  f=>{f.advance(61000);},
  (f,path)=>{const c=JSON.parse(readFileSync(path));c.service_tasks={maintenance:'T-1'};writeFileSync(path,JSON.stringify(c));f.input.expected_runtime_digest=digest(readFileSync(path));},
 ];
 for(const change of changes){const f=setup();try{
  const path=manualSupport(f);change(f,path);const before=readFileSync(path);
  await assert.rejects(()=>migrateRuntimeHostBinding(f.c,f.input,f.options));
  assert.deepEqual(readFileSync(path),before);
 }finally{f.close();}}
});
