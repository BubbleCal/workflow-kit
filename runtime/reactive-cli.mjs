import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ControlStore} from './control.mjs';
import {Mailbox} from './mailbox.mjs';
import {NativeQueue,validateQueueCompatibility,verifyExecutionProof,verifyNativeBinding,nativeReadback} from './native-queue.mjs';
import {ReactiveDriver} from './reactive-driver.mjs';
import {publishScheduledOccurrence} from './schedule-source.mjs';
import {verifyDesktopLoader} from './desktop-loader.mjs';
import {bindings,requireBindings} from './instance.mjs';
import {EXPLORATION_TEMPLATE} from './work-catalog.mjs';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const save=(path,data)=>{writeFileSync(path+'.tmp',JSON.stringify(data,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);};
const digest=data=>createHash('sha256').update(data).digest('hex');
export const DEFAULT_RUNTIME=Object.freeze({schema_version:2,transport:'native_queue',queue:{binary:'codex',timeout_ms:15000},
  tick_ms:1000,poll_min_ms:30000,poll_max_ms:300000,poll_connections:2,github_read_budget_per_hour:1800});

export function runtimeConfig(root=ROOT) {
  const path=join(root,'runtime.json');if(!existsSync(path))throw new Error('Run node workflow.mjs runtime init first');
  const c={...DEFAULT_RUNTIME,...read(path)};
  if(c.schema_version!==2||c.transport!=='native_queue'||c.adapter)throw new Error('Direct session transport was removed. Stop the old service and run runtime init, then verify the native queue');
  for(const key of ['tick_ms','poll_min_ms','poll_max_ms'])if(!Number.isSafeInteger(c[key])||c[key]<100||c[key]>3600000)throw new Error(`Invalid ${key}`);
  if(c.poll_min_ms>c.poll_max_ms)throw new Error('Poll bounds are reversed');
  if(!Number.isSafeInteger(c.poll_connections)||c.poll_connections<1||c.poll_connections>16||
    !Number.isSafeInteger(c.github_read_budget_per_hour)||c.github_read_budget_per_hour<120||c.github_read_budget_per_hour>5000)throw new Error('Invalid GitHub source budget');
  if(c.inbox&&(c.inbox.thread_id!==bindings.threads.inbox||c.inbox.project_id!==bindings.scope.project_id||!c.inbox.workspace))throw new Error('Inbox must match this instance');
  if(c.control_lanes)for(const [lane,b]of Object.entries(c.control_lanes))
    if(!['coordinator','inbox','maintenance'].includes(lane)||b.thread_id!==bindings.threads[lane]||!b.workspace)throw new Error('Control lanes must match verified instance roles');
  if(c.desktop_loader?.enabled){
    if(process.platform!=='darwin'||!c.desktop_loader.authorization_ref)throw new Error('Authorized macOS App loading is required');
    const bytes=readFileSync(c.desktop_loader.evidence_file);
    if(digest(bytes)!==c.desktop_loader.evidence_digest)throw new Error('Desktop loading evidence changed');
    verifyDesktopLoader(JSON.parse(bytes),c.desktop_loader.bundle_id);
  }
  return {...c,repositories:bindings.scope.repositories};
}
export async function queueCapability(config,queue) {
  if(!config.queue_validation)throw new Error('Actual desktop idle/busy queue verification is required; use runtime queue-verify');
  const bytes=readFileSync(config.queue_validation.file);
  if(digest(bytes)!==config.queue_validation.digest)throw new Error('Native queue verification evidence changed');
  const proof=validateQueueCompatibility(JSON.parse(bytes),await queue.probe());
  return {...proof,evidence_digest:config.queue_validation.digest};
}
export function legacyQuiescent(root,taskId,nativeBinding) {
  const path=join(root,'mailbox.sqlite');if(!existsSync(path))return true;
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='batches'").get())return true;
    // Native control batches use the same action ledger and task-mode guards;
    // setModes atomically rejects claimed/uncertain effects. Only the old
    // dispatcher batches require a global quiescent boundary.
    if(db.prepare("SELECT 1 FROM batches WHERE lane='coordinator' AND state IN ('reserved','sending','sent','uncertain','running') AND COALESCE(json_extract(snapshot,'$.delivery_transport'),'legacy')<>'native_queue'").get())return false;
    const actions=(Array.isArray(taskId)?taskId:[taskId]).flatMap(id=>db.prepare("SELECT * FROM continuation_actions WHERE json_extract(payload,'$.task_id')=? AND state IN ('reserved','sent','uncertain','running')").all(id));
    if(!actions.length)return true;
    if(actions.some(a=>a.state!=='running'))return false;
    // An evidenced already-running turn is inherited, never resent. The native
    // queue waits for that exact turn to end; sent/unknown inputs still block.
    let native;try{native=nativeReadback(nativeBinding?.readback);verifyNativeBinding(nativeBinding,{thread_id:native.thread.id,workspace:native.thread.cwd});}catch{return false;}
    const turn=native.turns?.[0];
    if(!(native.thread.status?.type==='active'&&turn?.status==='inProgress'||['idle','notLoaded'].includes(native.thread.status?.type)&&turn?.status==='completed'))return false;
    const controlPath=join(root,'control.sqlite');if(!existsSync(controlPath))return false;
    const control=new DatabaseSync(controlPath,{readOnly:true});
    try{return actions.every(a=>{
      const receipt=a.receipt?JSON.parse(a.receipt):{},sent=control.prepare('SELECT state,payload FROM actions WHERE action_key=?').get(a.action_key);
      return a.owner_thread_id===native.thread.id&&a.actual_turn===turn.id&&a.actual_turn!==a.preflight_turn&&receipt.outcome==='sent'&&
        !!receipt.work_evidence_ref&&receipt.control_action_key===a.action_key&&sent?.state==='sent'&&JSON.parse(sent.payload).thread_id===native.thread.id;
    });}finally{control.close();}
  }finally{db.close();}
}
function existingProcess(control) {
  if(!control.db.prepare("SELECT 1 FROM sqlite_master WHERE name='rt_process'").get())return null;
  const old=control.db.prepare('SELECT * FROM rt_process WHERE id=1').get();if(!old)return null;
  try{process.kill(old.pid,0);return old;}catch(error){if(error.code==='ESRCH')return null;throw error;}
}
function lockRuntime(control) {
  control.db.exec('CREATE TABLE IF NOT EXISTS rt_process (id INTEGER PRIMARY KEY,pid INTEGER NOT NULL,instance_id TEXT NOT NULL)');
  control.atomic(()=>{
    const old=existingProcess(control);if(old)throw new Error(`Runtime PID ${old.pid} is still alive; stop it before starting another driver`);
    control.db.prepare('INSERT OR REPLACE INTO rt_process VALUES (1,?,?)').run(process.pid,bindings.instance_id);
  });
  return ()=>control.db.prepare('DELETE FROM rt_process WHERE id=1 AND pid=?').run(process.pid);
}

export async function runtimeMain(args,{root=ROOT,output=v=>process.stdout.write(JSON.stringify(v,null,2)+'\n')}={}) {
  process.umask(0o077);requireBindings();
  const command=args[0]??'status',fileIndex=args.indexOf('--file');
  const inputFile=()=>{if(fileIndex<0)throw new Error('--file is required');return resolve(args[fileIndex+1]);};
  const control=new ControlStore(join(root,'control.sqlite')),state=control.reactive;
  let mailbox,release;
  try{
    if(command==='init'){
      const path=join(root,'runtime.json'),old=existsSync(path)?read(path):null;
      if(old?.schema_version===2){output({initialized:true,unchanged:true});return;}
      if(existingProcess(control))throw new Error('Stop the existing workflow runtime before migrating its transport');
      let backup=null;
      if(old){backup=path+'.pre-native-queue.'+Date.now();writeFileSync(backup,readFileSync(path),{mode:0o600});}
      save(path,{...DEFAULT_RUNTIME,...Object.fromEntries(['tick_ms','poll_min_ms','poll_max_ms'].filter(k=>old?.[k]!==undefined).map(k=>[k,old[k]])),
        ...(bindings.layout==='native'?{inbox:{thread_id:bindings.threads.main,project_id:bindings.scope.project_id,workspace:bindings.thread_workspaces.main}}:{})});
      const paused=control.db.prepare("UPDATE rt_tasks SET mode='paused' WHERE mode='active'").run().changes;
      output({initialized:true,transport:'native_queue',backup,paused_tasks:paused,queue_verified:false,receipts_preserved:true});return;
    }
    if(command==='status'){output(state.status());return;}
    if(command==='schedule'){
      const input=args[1]==='list'?{op:'list'}:fileIndex>=0?read(inputFile()):JSON.parse(readFileSync(0,'utf8'));
      let result;
      if(input.op==='list')result=control.scheduler.list();
      else if(input.op==='get')result={schedule:control.scheduler.get(input.id),runs:control.scheduler.runs(input.id)};
      else if(input.op==='create')result=control.scheduler.create(input);
      else if(['pause','resume','cancel'].includes(input.op))result=control.scheduler.change({...input,action:input.op});
      else throw new Error('Use schedule list or create|get|pause|resume|cancel');
      output(result);return;
    }
    if(['task','sources','discovery'].includes(command)) {
      if(bindings.layout!=='native')throw new Error('Use the independent native layout for new task registration and discovery; preserve or migrate the legacy instance first');
      const action=args[1];
      const input=['list','status','builtin'].includes(action)?{op:action}:fileIndex>=0?read(inputFile()):JSON.parse(readFileSync(0,'utf8'));
      let result;
      if(command==='task'){
        if(input.op==='list'||input.op==='status')result=control.work.list();
        else if(input.op==='builtin')result=control.work.seedBuiltins();
        else if(input.op==='get')result=control.work.get(input.task_id);
        else if(input.op==='create')result=control.work.create(input.kind==='exploration'?{...structuredClone(EXPLORATION_TEMPLATE),...input}:input);
        else if(input.op==='configure'){if(input.changes?.workspace)input.changes.workspace=realpathSync(input.changes.workspace);result=control.work.configure(input);}
        else if(input.op==='accept')result=control.work.accept(input);
        else if(input.op==='policy')result=control.work.setPolicy(input);
        else if(input.op==='dismiss')result=control.work.dismiss(input);
        else if(input.op==='request_owner')result=control.work.requestOwner(input);
        else if(input.op==='bind_owner')result=control.work.bindOwner(input);
        else if(input.op==='start'){
          const config=runtimeConfig(root);await queueCapability(config,new NativeQueue(config.queue));
          result=control.work.start(state,{...input,queue_compatibility_verified:true});
        }else if(input.op==='report')result=control.work.recordReport(input);
        else throw new Error('Unknown ordinary task operation');
      }else if(command==='sources'){
        if(input.op==='list'||input.op==='status')result=control.discovery.status();
        else if(input.op==='configure')result=control.discovery.configure(input);
        else throw new Error('Use sources list or configure');
      }else{
        if(input.op==='status')result=control.discovery.status();
        else if(input.op==='plan')result=control.discovery.checkBatch(input.batch_id);
        else if(input.op==='begin'){
          result=control.discovery.begin(input);mailbox=new Mailbox(join(root,'mailbox.sqlite'));
          const mail=mailbox.db.prepare('SELECT batch_id FROM mail WHERE item_key=?').get(result.mail_key);
          if(!mail?.batch_id)throw new Error('Discovery has no native queue batch receipt');
          mailbox.begin(mail.batch_id);
          if(result.invalidated)mailbox.finish(mail.batch_id,{processed_keys:[result.mail_key],note:'source scope changed; no source reads'});
        }else if(input.op==='ingest')result=control.discovery.ingest(input);
        else if(input.op==='classify')result=control.discovery.classify(input);
        else if(input.op==='finish'){
          const b=control.discovery.batch(input.batch_id);result=control.discovery.finish(input);
          mailbox=new Mailbox(join(root,'mailbox.sqlite'));const mail=mailbox.db.prepare('SELECT batch_id FROM mail WHERE item_key=?').get(b.mail_key);
          if(!mail?.batch_id)throw new Error('Discovery queue receipt unavailable');
          mailbox.finish(mail.batch_id,{processed_keys:[b.mail_key],note:result.finished?'source scan completed':'source scan checkpointed'});
        }else throw new Error('Unknown source-only discovery operation');
      }
      output(result);return;
    }
    // Service shutdown must remain usable even when migrating obsolete config.
    if(command==='service'){
      if(process.platform!=='darwin')throw new Error('Use runtime run on non-macOS hosts');
      const action=args[1],label=`com.workflow-kit.${bindings.instance_id}`,agentDir=join(process.env.HOME,'Library/LaunchAgents'),path=join(agentDir,label+'.plist');
      const domain=`gui/${process.getuid()}`,target=`${domain}/${label}`;
      const launchctl=values=>{const p=spawnSync('launchctl',values,{encoding:'utf8'});if(p.status!==0)throw new Error(p.stderr.trim()||`launchctl exited ${p.status}`);return p.stdout;};
      if(action==='stop'){launchctl(['bootout',target]);output({stopped:true,task_modes_preserved:true});return;}
      if(action==='status'){output({service:launchctl(['print',target])});return;}
      runtimeConfig(root);
      if(action==='start'){
        const loaded=spawnSync('launchctl',['print',target],{encoding:'utf8'});launchctl(loaded.status===0?['kickstart',target]:['bootstrap',domain,path]);output({started:true});return;
      }
      if(action!=='install')throw new Error('Use service install|start|stop|status');
      mkdirSync(agentDir,{recursive:true});mkdirSync(join(root,'observations/runtime'),{recursive:true});
      if(existsSync(path))throw new Error(`Service already exists: ${path}; use service start`);
      const xml=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
      const values=[process.execPath,join(realpathSync(root),'workflow.mjs'),'runtime','run'];
      const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${values.map(v=>`<string>${xml(v)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(realpathSync(root))}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH??'/usr/bin:/bin')}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(join(realpathSync(root),'observations/runtime/service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(realpathSync(root),'observations/runtime/service-error.log'))}</string></dict></plist>`;
      writeFileSync(path,plist,{mode:0o600});launchctl(['bootstrap',domain,path]);output({installed:true,path});return;
    }
    const config=runtimeConfig(root),queue=new NativeQueue(config.queue);
    if(command==='probe'){
      if(args.length!==1)throw new Error('probe only checks CLI queue support; obtain thread identity through desktop native tools');
      output(await queue.probe());return;
    }
    if(command==='queue-verify'){
      const bytes=readFileSync(inputFile()),proof=validateQueueCompatibility(JSON.parse(bytes),await queue.probe()),hash=digest(bytes);
      const directory=join(root,'observations/runtime');mkdirSync(directory,{recursive:true});
      const file=join(directory,`queue-capability-${hash}.json`);writeFileSync(file,bytes,{mode:0o600});
      save(join(root,'runtime.json'),{...read(join(root,'runtime.json')),queue_validation:{file,digest:hash}});
      output({...proof,cases:proof.cases.map(c=>({name:c.name,passed:c.passed})),evidence_digest:hash});return;
    }
    if(command==='bind-inbox'){
      const proof=read(inputFile()),readback=nativeReadback(proof.readback);
      const binding=verifyNativeBinding(proof,{thread_id:bindings.threads.inbox,workspace:readback?.thread?.cwd});
      const inbox={thread_id:binding.thread_id,project_id:bindings.scope.project_id,workspace:binding.workspace};
      save(join(root,'runtime.json'),{...read(join(root,'runtime.json')),inbox});output({bound:true,inbox});return;
    }
    if(command==='bind-controls'){
      await queueCapability(config,queue);const proofs=read(inputFile()),lanes={};
      for(const lane of ['coordinator','inbox','maintenance']){
        const proof=proofs[lane],readback=nativeReadback(proof?.readback);
        const binding=verifyNativeBinding(proof,{thread_id:bindings.threads[lane],workspace:readback?.thread?.cwd});
        lanes[lane]={thread_id:binding.thread_id,workspace:binding.workspace};
      }
      save(join(root,'runtime.json'),{...read(join(root,'runtime.json')),control_lanes:lanes});output({bound:true,control_lanes:lanes});return;
    }
    if(command==='op'){
      const input=fileIndex>=0?read(inputFile()):JSON.parse(readFileSync(0,'utf8'));let result;
      if(input.op==='adopt'){
        input.contract.workspace=realpathSync(input.contract.workspace);const existing=state.adopt(input),t=existing.task;
        const original=control.db.prepare('SELECT created_at FROM rt_contracts WHERE task_id=? AND revision=1').get(t.task_id);
        state.ingest({event_id:`adopt:${t.task_id}:${input.source_message_id}`,task_id:t.task_id,source:'human_authorization',subject:`contract:${t.task_id}`,
          type:'task_adopted',observed_at:original.created_at,payload:t.contract,evidence_ref:input.source_message_id,debounce_ms:0});result=existing;
      }else if(input.op==='mode'||input.op==='mode_group'){
        if(input.mode==='active')await queueCapability(config,queue);
        result=state[input.op==='mode_group'?'setModes':'setMode']({...input,queue_compatibility_verified:input.mode==='active',legacy_quiescent:legacyQuiescent(root,input.task_ids??input.task_id,input.native_binding)});
      }else if(input.op==='amend'){input.contract.workspace=realpathSync(input.contract.workspace);result=state.amend(input);}
      else if(input.op==='checkpoint')result=state.checkpoint(input.task_id);
      else if(input.op==='publish')result=state.ingest(input);
      else if(input.op==='schedule_event')result=publishScheduledOccurrence(root,state,input);
      else if(input.op==='begin')result=state.begin(input);
      else if(input.op==='decide'){
        mailbox=new Mailbox(join(root,'mailbox.sqlite'));state.checkWait=c=>['pr','review_request'].includes(c?.kind)?control.checkReactiveWait(c):mailbox.waits.check(c);
        result=state.decide(input);
      }else if(input.op==='finish'){const w=state.openWake(input.task_id);result=state.finish({...input,turn_id:input.turn_id??w?.turn_id});}
      else if(input.op==='wait_observe'){
        mailbox=new Mailbox(join(root,'mailbox.sqlite'));result=mailbox.atomic(()=>mailbox.waits.observe(input));
        for(const w of control.db.prepare("SELECT * FROM rt_waits WHERE state='waiting'").all()){
          if(JSON.parse(w.condition).condition?.fact_key!==input.fact_key)continue;
          state.ingest({event_id:`wait-fact:${w.task_id}:${input.fact_key}:${input.observed_at}`,task_id:w.task_id,source:'typed_wait_source',subject:`wait-fact:${input.fact_key}`,
            type:'wait_fact_changed',observed_at:input.observed_at,payload:input.data,evidence_ref:input.evidence_ref,debounce_ms:0});
        }
      }else if(input.op==='feedback_status')result=control.feedback.status(input.repository,input.pr_number);
      else if(input.op==='feedback_assess')result=control.atomic(()=>control.feedback.assess(input));
      else if(input.op==='recover'){
        const task=state.task(input.task_id),wake=state.openWake(input.task_id);if(!task||!wake)throw new Error('No wake to reconcile');
        const proof=verifyExecutionProof(input.native_proof,{thread_id:task.owner_id,workspace:task.contract.workspace,prompt:wake.prompt,terminal:true});
        if(!input.evidence_ref)throw new Error('Inspect actual results before recovery');
        control.atomic(()=>{
          const other=wake.member_ids.some(id=>control.db.prepare("SELECT 1 FROM actions WHERE task_id=? AND action_key<>? AND state IN ('claimed','uncertain')").get(id,wake.id));
          if(other)throw new Error('Reconcile uncertain external effects first');
          // Exact native message consumption proves this transport delivered; it
          // does not prove the task succeeded or authorize repeating side effects.
          control.db.prepare("UPDATE actions SET state='sent',receipt=?,updated_at=? WHERE action_key=? AND state IN ('claimed','uncertain')")
            .run(JSON.stringify({outcome:'sent',evidence_ref:proof.evidence_ref,native_turn:proof.turn_id}),Date.now(),wake.id);
          control.db.prepare("UPDATE rt_wakes SET state='ended_unresolved',turn_id=?,completed_at=?,evidence_ref=? WHERE id=?")
            .run(proof.turn_id,Date.now(),input.evidence_ref,wake.id);
          for(const id of wake.member_ids)state.ingestInside({event_id:`recover:${wake.id}:${id}`,task_id:id,source:'native_desktop_observation',subject:`turn:${proof.turn_id}`,type:'owner_ended',
            observed_at:Date.now(),payload:{previous_wake:wake.id,actual_turn:proof.turn_id,status:proof.status},evidence_ref:input.evidence_ref,debounce_ms:0});
        });result={recovered:true,task_complete:false};
      }else throw new Error(`Unknown runtime operation: ${input.op}`);
      output(result);return;
    }
    if(command==='run'){
      const needsQueue=()=>state.tasks().some(t=>t.mode==='active')||control.discovery.sources().some(s=>s.enabled);
      const capability=needsQueue()?await queueCapability(config,queue):null;
      release=lockRuntime(control);const driver=new ReactiveDriver({root,control,queue,config,capability});
      let stopping=false;const stop=()=>{stopping=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
      output({event:'runtime_started',instance_id:bindings.instance_id,transport:'native_queue',pid:process.pid});
      try{do{
        const current=runtimeConfig(root);
        if(JSON.stringify(current.queue)!==JSON.stringify(config.queue))throw new Error('Queue executable configuration changed; restart the runtime before sending');
        if(needsQueue()&&(!driver.capability||current.queue_validation?.digest!==driver.capability.evidence_digest))
          driver.capability=await queueCapability(current,queue);
        driver.config=current;
        await driver.tick({wait:args.includes('--once')});if(args.includes('--once'))break;
        await new Promise(resolve=>setTimeout(resolve,config.tick_ms));}while(!stopping);
      }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await driver.close();}
      return;
    }
    throw new Error('Use runtime init|status|probe|queue-verify|bind-inbox|op|run|service');
  }finally{release?.();mailbox?.close();control.close();}
}
