import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ControlStore } from './control.mjs';
import { Mailbox } from './mailbox.mjs';
import { CodexAdapter } from './codex-adapter.mjs';
import { ReactiveDriver } from './reactive-driver.mjs';
import { bindings, requireBindings } from './instance.mjs';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const save=(path,data)=>{writeFileSync(path+'.tmp',JSON.stringify(data,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);};
export const DEFAULT_RUNTIME = Object.freeze({schema_version:1,adapter:{command:['codex','app-server','proxy'],timeout_ms:15000},
  tick_ms:1000,owner_check_ms:5000,poll_min_ms:30000,poll_max_ms:300000});
export function runtimeConfig(root=ROOT) {
  const path=join(root,'runtime.json');
  if(!existsSync(path))throw new Error('Run node workflow.mjs runtime init first');
  const saved=read(path),c={...DEFAULT_RUNTIME,...saved};
  if(c.schema_version!==1)throw new Error('Unsupported runtime configuration');
  for(const key of ['tick_ms','owner_check_ms','poll_min_ms','poll_max_ms'])if(!Number.isSafeInteger(c[key])||c[key]<100||c[key]>3600000)throw new Error(`Invalid ${key}`);
  if(c.poll_min_ms>c.poll_max_ms)throw new Error('Poll bounds are reversed');
  if(c.inbox && (c.inbox.thread_id!==bindings.threads.inbox || c.inbox.project_id!==bindings.scope.project_id || !c.inbox.workspace))
    throw new Error('Runtime inbox must match this instance binding');
  return {...c,repositories:bindings.scope.repositories};
}
export function legacyQuiescent(root,taskId) {
  const path=join(root,'mailbox.sqlite');if(!existsSync(path))return true;
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='batches'").get())return true;
    // A fixed coordinator batch can have relevant work beyond its source-task field.
    return !db.prepare("SELECT 1 FROM batches WHERE lane='coordinator' AND state IN ('reserved','sending','sent','uncertain','running')").get() &&
      !db.prepare("SELECT 1 FROM continuation_actions WHERE json_extract(payload,'$.task_id')=? AND state IN ('reserved','sent','uncertain','running')").get(taskId);
  }finally{db.close();}
}
function lockRuntime(control) {
  control.db.exec('CREATE TABLE IF NOT EXISTS rt_process (id INTEGER PRIMARY KEY,pid INTEGER NOT NULL,instance_id TEXT NOT NULL)');
  control.atomic(()=>{
    const old=control.db.prepare('SELECT * FROM rt_process WHERE id=1').get();
    if(old){
      let live=true;try{process.kill(old.pid,0);}catch(error){if(error.code==='ESRCH')live=false;else throw error;}
      if(live)throw new Error(`Runtime PID ${old.pid} is still alive; do not start a second driver`);
    }
    control.db.prepare('INSERT OR REPLACE INTO rt_process VALUES (1,?,?)').run(process.pid,bindings.instance_id);
  });
  return ()=>control.db.prepare('DELETE FROM rt_process WHERE id=1 AND pid=?').run(process.pid);
}
export async function runtimeMain(args,{root=ROOT,output=value=>process.stdout.write(JSON.stringify(value,null,2)+'\n')}={}) {
  process.umask(0o077);
  const command=args[0]??'status',fileIndex=args.indexOf('--file'),taskIndex=args.indexOf('--task');
  requireBindings();
  if(command==='init') {
    const path=join(root,'runtime.json');if(!existsSync(path))save(path,DEFAULT_RUNTIME);
    output({initialized:true,configuration:path,existing_tasks_unchanged:true,mode:'Each adopted task starts in shadow mode'});return;
  }
  const control=new ControlStore(join(root,'control.sqlite')),state=control.reactive;
  let adapter,mailbox,release;
  try {
    if(command==='status'){output(state.status());return;}
    const config=runtimeConfig(root);
    const getAdapter=()=>adapter??=new CodexAdapter(config.adapter);
    if(command==='bind-inbox') {
      const result=await getAdapter().request('thread/read',{threadId:bindings.threads.inbox});
      if(result.thread?.id!==bindings.threads.inbox||result.thread.projectId!==bindings.scope.project_id)throw new Error('Native inbox is outside this instance');
      const inbox={thread_id:result.thread.id,project_id:result.thread.projectId,workspace:realpathSync(result.thread.cwd)};
      save(join(root,'runtime.json'),{...read(join(root,'runtime.json')),inbox});output({bound:true,inbox});return;
    }
    if(command==='probe') {
      await getAdapter().connect();
      const task=taskIndex>=0?state.task(args[taskIndex+1]):null;
      const observation=task?await adapter.observe(task):null;
      output({connected:true,server:adapter.initialization,observation,
        note:task?'Actual project, queue and native-job readback; no turn started':'Transport only. Probe an adopted task to verify owner access; no thread created or resumed.'});return;
    }
    if(command==='op') {
      const input=fileIndex>=0?read(args[fileIndex+1]):JSON.parse(readFileSync(0,'utf8'));
      let result;
      if(input.op==='adopt') {
        input.contract.workspace=realpathSync(input.contract.workspace);
        const existing=state.adopt(input);const t=existing.task;
        const original=control.db.prepare('SELECT created_at FROM rt_contracts WHERE task_id=? AND revision=1').get(t.task_id);
        state.ingest({event_id:`adopt:${t.task_id}:${input.source_message_id}`,task_id:t.task_id,source:'human_authorization',subject:`contract:${t.task_id}`,
          type:'task_adopted',observed_at:original.created_at,payload:t.contract,evidence_ref:input.source_message_id,debounce_ms:0});result=existing;
      } else if(input.op==='mode') {
        const t=state.task(input.task_id);if(!t)throw new Error('Unknown task');
        const observation=input.mode==='paused'?null:await getAdapter().observe(t);
        result=state.setMode({...input,observation,legacy_quiescent:legacyQuiescent(root,input.task_id)});
      } else if(input.op==='amend'){input.contract.workspace=realpathSync(input.contract.workspace);result=state.amend(input);}
      else if(input.op==='checkpoint')result=state.checkpoint(input.task_id);
      else if(input.op==='publish')result=state.ingest(input);
      else if(input.op==='begin') {
        const t=state.task(input.task_id),w=state.openWake(input.task_id);if(!t||w?.id!==input.wake_id)throw new Error('Unknown task wake');
        const found=await getAdapter().findDelivery(t,w);if(!found.found)throw new Error('Native delivery marker has not been verified');
        result=state.begin({...input,owner_thread_id:t.owner_id,turn_id:found.turn.id,evidence_ref:`native:${found.turn.id}`});
      } else if(input.op==='decide') {
        mailbox=new Mailbox(join(root,'mailbox.sqlite'));
        state.checkWait=condition=>['pr','review_request'].includes(condition?.kind)?control.checkReactiveWait(condition):mailbox.waits.check(condition);
        result=state.decide(input);
      } else if(input.op==='finish') {
        const wake=state.openWake(input.task_id);result=state.finish({...input,turn_id:input.turn_id??wake?.turn_id});
      } else if(input.op==='wait_observe') {
        mailbox=new Mailbox(join(root,'mailbox.sqlite'));result=mailbox.atomic(()=>mailbox.waits.observe(input));
        for(const wait of control.db.prepare("SELECT * FROM rt_waits WHERE state='waiting'").all()) {
          if(JSON.parse(wait.condition).condition?.fact_key!==input.fact_key)continue;
          state.ingest({event_id:`wait-fact:${wait.task_id}:${input.fact_key}:${input.observed_at}`,task_id:wait.task_id,source:'typed_wait_source',
            subject:`wait-fact:${input.fact_key}`,type:'wait_fact_changed',observed_at:input.observed_at,payload:input.data,evidence_ref:input.evidence_ref,debounce_ms:0});
        }
      } else if(input.op==='feedback_status')result=control.feedback.status(input.repository,input.pr_number);
      else if(input.op==='feedback_assess')result=control.atomic(()=>control.feedback.assess(input));
      else if(input.op==='recover') {
        const task=state.task(input.task_id),wake=state.openWake(input.task_id);
        if(!task||!wake)throw new Error('No wake to reconcile');
        const observation=await getAdapter().observe(task);state.assertIdle(task,observation);
        if(observation.turn_id!==wake.turn_id)throw new Error('A different owner turn needs manual source reconciliation');
        if(!input.evidence_ref)throw new Error('Inspect the actual result and record evidence before recovery');
        control.atomic(()=>{
          if(control.db.prepare("SELECT 1 FROM actions WHERE task_id=? AND state IN ('claimed','uncertain')").get(task.task_id))throw new Error('Reconcile uncertain effects first');
          control.db.prepare("UPDATE rt_wakes SET state='ended_unresolved',completed_at=?,evidence_ref=? WHERE id=?").run(Date.now(),input.evidence_ref,wake.id);
          state.ingestInside({event_id:`recover:${wake.id}`,task_id:task.task_id,source:'runtime',subject:`turn:${wake.turn_id}`,
            type:'owner_ended',observed_at:Date.now(),payload:{previous_wake:wake.id,actual_turn:wake.turn_id},evidence_ref:input.evidence_ref,debounce_ms:0});
        });result={recovered:true,task_complete:false};
      } else throw new Error(`Unknown runtime operation: ${input.op}`);
      output(result);return;
    }
    if(command==='service') {
      if(process.platform!=='darwin')throw new Error('LaunchAgent management is available on macOS; use runtime run on other hosts');
      const action=args[1],label=`com.workflow-kit.${bindings.instance_id}`;
      const agentDir=join(process.env.HOME,'Library','LaunchAgents'),path=join(agentDir,label+'.plist');
      const domain=`gui/${process.getuid()}`,target=`${domain}/${label}`;
      const launchctl=values=>{const p=spawnSync('launchctl',values,{encoding:'utf8'});if(p.status!==0)throw new Error(p.stderr.trim()||`launchctl exited ${p.status}`);return p.stdout;};
      if(action==='install') {
        mkdirSync(agentDir,{recursive:true});mkdirSync(join(root,'observations','runtime'),{recursive:true});
        if(existsSync(path))throw new Error(`Service already exists: ${path}; use service start or inspect it`);
        const xml=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
        const values=[process.execPath,join(realpathSync(root),'workflow.mjs'),'runtime','run'];
        const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${values.map(v=>`<string>${xml(v)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(realpathSync(root))}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH??'/usr/bin:/bin')}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(join(realpathSync(root),'observations/runtime/service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(realpathSync(root),'observations/runtime/service-error.log'))}</string></dict></plist>`;
        writeFileSync(path,plist,{mode:0o600});launchctl(['bootstrap',domain,path]);output({installed:true,path});
      } else if(action==='start'){
        const loaded=spawnSync('launchctl',['print',target],{encoding:'utf8'});
        launchctl(loaded.status===0?['kickstart',target]:['bootstrap',domain,path]);output({started:true});
      }
      else if(action==='stop'){launchctl(['bootout',target]);output({stopped:true,task_modes_preserved:true});}
      else if(action==='status')output({service:launchctl(['print',target])});
      else throw new Error('Use service install|start|stop|status');
      return;
    }
    if(command==='run') {
      release=lockRuntime(control);
      const driver=new ReactiveDriver({root,control,adapter:getAdapter(),config});
      let stopping=false;const stop=()=>{stopping=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
      output({event:'runtime_started',instance_id:bindings.instance_id,mode:'per_task',pid:process.pid});
      try {
        do {
          await driver.tick({wait:args.includes('--once')});
          if(args.includes('--once'))break;
          await new Promise(resolve=>setTimeout(resolve,config.tick_ms));
        }while(!stopping);
      }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await driver.close();}
      return;
    }
    throw new Error('Use runtime init|status|probe|bind-inbox|op|run|service');
  }finally{release?.();adapter?.close();mailbox?.close();control.close();}
}
