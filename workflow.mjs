#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const read = path => JSON.parse(readFileSync(path,'utf8'));
const atomic = (path,value) => { writeFileSync(path+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path); };
const args = process.argv.slice(2), command = args.shift();
const option = name => { const i=args.indexOf('--'+name);return i<0?undefined:args[i+1]; };
const output = value => process.stdout.write(JSON.stringify(value,null,2)+'\n');
const configPath=join(root,'instance.json');

try {
  if(command==='migrate' || command==='init'&&!args.includes('--legacy') || ['bind','doctor'].includes(command)&&existsSync(configPath)&&read(configPath).layout==='native') {
    const {nativeBootstrap}=await import('./runtime/native-bootstrap.mjs');
    const result=nativeBootstrap(command,args,root);output(result);if(command==='doctor'&&!result.local_ready)process.exitCode=2;
  } else if (command === 'runtime' || command==='task' || command==='sources' || command==='discovery') {
    const { runtimeMain } = await import('./runtime/reactive-cli.mjs');
    await runtimeMain(command==='runtime'?args:[command,...args],{root,output});
  } else if (command === 'init') {
    const name=option('name'),projectRoot=option('project-root');
    if(!name?.trim()||!projectRoot)throw new Error('Usage: node workflow.mjs init --name <name> --project-root <existing-directory>');
    if(existsSync(configPath)||existsSync(join(root,'registry.json'))||existsSync(join(root,'mailbox.sqlite'))||existsSync(join(root,'control.sqlite')))
      throw new Error('This directory already has instance state. Use a fresh extracted copy; init never overwrites tasks or receipts.');
    const project=realpathSync(resolve(projectRoot)),prefs=read(join(root,'templates/preferences.json'));
    if(!statSync(project).isDirectory())throw new Error('Project root must be a directory.');
    const config={schema_version:1,instance_id:randomUUID(),name,created_at:new Date().toISOString(),
      scope:{project_root:project,project_id:null,repositories:[]},threads:{coordinator:null,inbox:null,maintenance:null,dispatcher:null},
      identity:{github_login:null},delivery:{slack_enabled:false,slack_channel_id:null,ready_enabled:false,merge_enabled:false,approver_login:null,notion_enabled:false,notion_page_id:null},
      models:{default:'inherit',roles:{dispatcher:null,coordinator:null,maintenance:null,execution:null}},
      preferences:prefs,native_bindings_verified:false};
    for(const dir of ['batches','observations','completions','daily-review/checkpoints','daily-review/reports'])mkdirSync(join(root,dir),{recursive:true});
    const registry={schema_version:1,instance_id:config.instance_id,policy_version:'portable-0.1.0',setup_complete:false,timezone:prefs.timezone,
      scope:config.scope,capacity:{automatic_limit:null,max_new_heavy_concurrency:null,max_dispatches_per_run:null},
      task_registry:{items:{}},threads:[],outbox:[],discovery:{enabled:true,project_ids:[],source:'only verified chats in this instance project'},
      queue_transport:{mode:'fixed_batch_mailbox',dispatcher_interval_minutes:10},sources:{},delivery_items:{}};
    atomic(join(root,'registry.json'),registry);atomic(join(root,'decisions.json'),{schema_version:2,display:'task_only',items:[]});
    atomic(join(root,'pr-review-window.json'),{timezone:prefs.timezone,blocked_start_inclusive:prefs.review_blackout.start_inclusive,blocked_end_exclusive:prefs.review_blackout.end_exclusive});
    const localDate=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    atomic(join(root,'daily-review/config.json'),{enabled:true,timezone:prefs.timezone,time:prefs.daily_review_time,first_date:localDate,owner_thread_id:null,authorization_ref:'Instance installation request; preserve its actual native message reference in setup evidence.'});
    atomic(configPath,config);
    output({initialized:true,instance_id:config.instance_id,root,project_root:project,native_chats_created:0,automations_created:0,next:'Open START-HERE.md in Codex on this computer and complete native project/chat bindings.'});
  } else if(command==='bind') {
    if(!existsSync(configPath))throw new Error('Run init first.');
    const file=option('file');if(!file)throw new Error('Usage: node workflow.mjs bind --file <verified-bindings.json>');
    const input=read(resolve(file)),config=read(configPath);
    if(input.native_verified!==true||!input.evidence_ref||typeof input.project_id!=='string'||!input.project_id)
      throw new Error('Actual native project/chat readback and an evidence_ref are required.');
    const roles=['coordinator','inbox','maintenance','dispatcher'],ids=roles.map(role=>input.threads?.[role]);
    if(ids.some(id=>typeof id!=='string'||!id.trim())||new Set(ids).size!==4)throw new Error('Four distinct verified native chat IDs are required.');
    if(config.native_bindings_verified && (config.scope.project_id!==input.project_id||roles.some(role=>config.threads[role]!==input.threads[role])))
      throw new Error('This instance is already bound. Do not replace live owners through bootstrap.');
    config.scope.project_id=input.project_id;config.threads=Object.fromEntries(roles.map((role,i)=>[role,ids[i]]));config.native_bindings_verified=true;config.binding_evidence_ref=input.evidence_ref;
    const registry=read(join(root,'registry.json'));
    Object.assign(registry,{scope:config.scope,setup_thread_id:config.threads.maintenance,coordinator_thread_id:config.threads.coordinator,
      decision_inbox_thread_id:config.threads.inbox,hub_thread_id:config.threads.inbox,state_writer_thread_id:config.threads.coordinator});
    registry.discovery.project_ids=[input.project_id];Object.assign(registry.queue_transport,{dispatcher_thread_id:config.threads.dispatcher,maintenance_owner_thread_id:config.threads.maintenance});
    atomic(join(root,'registry.json'),registry);
    const daily=read(join(root,'daily-review/config.json'));daily.owner_thread_id=config.threads.maintenance;atomic(join(root,'daily-review/config.json'),daily);
    atomic(configPath,config);output({bound:true,instance_id:config.instance_id,automations_created:0,next:'Use supported Codex tools to pin this inbox and install one dispatcher heartbeat, then save native setup evidence.'});
  } else if(command==='doctor') {
    const checks=[];
    try {const sqlite=await import('node:sqlite');checks.push({name:'node_sqlite',ok:typeof sqlite.DatabaseSync==='function',node:process.version});}
    catch(error){checks.push({name:'node_sqlite',ok:false,detail:error.message});}
    const config=existsSync(configPath)?read(configPath):null;
    checks.push({name:'initialized',ok:!!config});
    if(config){
      checks.push({name:'project_directory',ok:existsSync(config.scope?.project_root??'')});
      const ids=Object.values(config.threads??{});
      checks.push({name:'native_project_and_chats_bound',ok:config.native_bindings_verified===true&&!!config.scope?.project_id&&ids.length===4&&ids.every(x=>typeof x==='string'&&x.length>0)&&new Set(ids).size===4});
      const enabled=Object.entries(config.delivery).filter(([k,v])=>k.endsWith('_enabled')&&v===true).map(([k])=>k);
      checks.push({name:'external_delivery_defaults',ok:true,enabled});
      const registry=read(join(root,'registry.json'));
      checks.push({name:'instance_identity_matches',ok:registry.instance_id===config.instance_id});
    }
    const receiptPath=join(root,'observations/native-setup.json'),receipt=existsSync(receiptPath)?read(receiptPath):null;
    const runtime=existsSync(join(root,'runtime.json'))?read(join(root,'runtime.json')):null;
    const queuedControls=receipt?.control_lanes_verified===true&&['coordinator','inbox','maintenance'].every(lane=>runtime?.control_lanes?.[lane]?.thread_id===config?.threads?.[lane]);
    const nativeReady=!!config && receipt?.instance_id===config.instance_id && receipt?.native_readback_verified===true&&
      (queuedControls||receipt?.dispatcher_thread_id===config.threads.dispatcher&&receipt?.automation_status==='ACTIVE');
    output({root,checks,local_ready:checks.every(c=>c.ok),native_setup_recorded:nativeReady,
      note:'The CLI cannot inspect Codex chat membership, connector credentials or scheduler availability. Verify them with native tools on the destination computer; a saved receipt is not a live probe.'});
    if(!checks.every(c=>c.ok))process.exitCode=2;
  } else if(command==='test') {
    await import('./tools/test.mjs');
  } else {
    output({version:'0.6.3',commands:['init --name <name> --project-root <directory>','bind --file <verified-bindings.json>','doctor','test','task list|builtin|op','sources list|op','discovery status|op','migrate --file <verified-migration.json>','runtime init|status|probe|queue-verify|bind-inbox|op|run|service'],
      native_setup:'START-HERE.md',model_selection:'instance.json models; inherit by default, explicit role overrides only after user selection'});
    if(command)process.exitCode=2;
  }
} catch(error) {output({error:error.message});process.exitCode=1;}
