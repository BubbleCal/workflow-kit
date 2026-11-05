import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync,realpathSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {WorkCatalog} from './work-catalog.mjs';

const read=p=>JSON.parse(readFileSync(p,'utf8'));
const save=(p,v)=>{writeFileSync(p+'.tmp',JSON.stringify(v,null,2)+'\n',{mode:0o600});renameSync(p+'.tmp',p);};
export function nativeBootstrap(command,args,root) {
  process.umask(0o077);const option=name=>{const n=args.indexOf('--'+name);return n<0?undefined:args[n+1];};
  const path=join(root,'instance.json');
  if(command==='init'){
    const name=option('name'),projectRoot=option('project-root');
    if(!name?.trim()||!projectRoot)throw new Error('Use init --name <name> --project-root <existing-directory>');
    if(['instance.json','registry.json','control.sqlite','mailbox.sqlite'].some(f=>existsSync(join(root,f))))throw new Error('Existing instance state must be preserved; init never overwrites it');
    const project=realpathSync(resolve(projectRoot));if(!statSync(project).isDirectory())throw new Error('Project root must be a directory');
    const preferences=read(join(root,'templates/preferences.json'));
    const config={schema_version:2,layout:'native',instance_id:randomUUID(),name,created_at:new Date().toISOString(),
      scope:{project_root:project,project_id:null,repositories:[]},threads:{main:null,discovery:null},
      identity:{github_login:null},delivery:{slack_enabled:false,ready_enabled:false,merge_enabled:false,notion_enabled:false},
      models:{default:'inherit',roles:{main:null,discovery:null,execution:null}},preferences,native_bindings_verified:false};
    for(const d of ['observations','batches','completions'])mkdirSync(join(root,d),{recursive:true});
    save(path,config);save(join(root,'pr-review-window.json'),{timezone:preferences.timezone,blocked_start_inclusive:preferences.review_blackout.start_inclusive,blocked_end_exclusive:preferences.review_blackout.end_exclusive});
    const db=new DatabaseSync(join(root,'control.sqlite'));let builtin;
    try{builtin=new WorkCatalog(db,{config}).seedBuiltins().task;}finally{db.close();}
    return {initialized:true,layout:'native',instance_id:config.instance_id,root,required_roles:['main'],optional_roles:['discovery'],
      builtin_exploration:{task_id:builtin.id,state:builtin.state,owner_thread_id:null},native_chats_created:0,automations_created:0,
      next:'Bind the existing main conversation. Discovery and all external discovery sources are optional. Configure and accept the built-in exploration as an ordinary task.'};
  }
  const config=read(path);
  if(command==='migrate'){
    if(config.layout==='native')return {migrated:false,reason:'already_native'};
    const file=option('file');if(!file)throw new Error('Use migrate --file <verified-migration.json>');
    const input=read(resolve(file));
    if(input.actual_human_verified!==true||!input.source_message_id||input.legacy_scheduler_paused!==true||!input.scheduler_evidence_ref||
      input.native_verified!==true||!input.evidence_ref||!input.threads?.main||!input.thread_workspaces?.main)
      throw new Error('Actual migration authority, paused scheduler evidence and verified main binding are required');
    if(input.project_id!==config.scope.project_id)throw new Error('Migration cannot change the instance project');
    const db=new DatabaseSync(join(root,'control.sqlite'));const imported=[],references=[];
    try{
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='rt_process'").get()){
        const old=db.prepare('SELECT pid FROM rt_process WHERE id=1').get();if(old){let live=true;try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')live=false;else throw e;}if(live)throw new Error('Stop the existing runtime before layout migration');}
      }
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='actions'").get()&&db.prepare("SELECT 1 FROM actions WHERE state IN ('claimed','uncertain')").get())
        throw new Error('Reconcile uncertain actions before migrating ownership');
      if(existsSync(join(root,'mailbox.sqlite'))){const mailbox=new DatabaseSync(join(root,'mailbox.sqlite'),{readOnly:true});try{
        if(mailbox.prepare("SELECT 1 FROM sqlite_master WHERE name='batches'").get()&&mailbox.prepare("SELECT 1 FROM batches WHERE state IN ('reserved','sending','sent','uncertain','running')").get())
          throw new Error('Finish existing control batches before migration');
      }finally{mailbox.close();}}
      const historicalRegistry=existsSync(join(root,'registry.json'))?read(join(root,'registry.json')):{};
      const next={...config,schema_version:2,layout:'native',legacy_roles:{...config.threads},
        threads:{main:input.threads.main,discovery:input.threads.discovery??null},
        thread_workspaces:{main:realpathSync(input.thread_workspaces.main),...(input.threads.discovery?{discovery:realpathSync(input.thread_workspaces.discovery)}:{})},
        migration:{source_message_id:input.source_message_id,scheduler_evidence_ref:input.scheduler_evidence_ref,evidence_ref:input.evidence_ref},
        models:{...config.models,roles:{...config.models?.roles,execution:config.models?.roles?.execution??historicalRegistry.model_preference?.new_chat??historicalRegistry.model_preference??null,main:null,discovery:null}},native_bindings_verified:true};
      if(next.threads.discovery===next.threads.main)throw new Error('Discovery and main must be separate conversations');
      if(db.prepare("SELECT owner_id FROM rt_tasks WHERE status<>'complete' GROUP BY owner_id HAVING count(*)>1").get())throw new Error('Assign one owner to each unfinished task before native migration');
      const work=new WorkCatalog(db,{config:next});
      work.atomic(()=>{
        if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='rt_tasks'").get())for(const t of db.prepare('SELECT * FROM rt_tasks').all()){
          const c=JSON.parse(t.contract);if(work.get(t.task_id))continue;
          const item=work.createInside({id:t.task_id,canonical_key:c.canonical_key,kind:c.task_kind??'work',title:c.objective,objective:c.objective,
            workspace:c.workspace,requirements:c.requirements,constraints:c.constraints,job_sources:c.job_sources,pull_requests:c.pull_requests,
            exploration:c.exploration,source:{kind:'migrated_runtime',key:`legacy:${t.task_id}`}}).task;
          db.prepare("UPDATE work_items SET state=?,owner_thread_id=?,authorization=?,binding=? WHERE id=?")
            .run(t.status==='complete'?'completed':'accepted',t.status==='complete'?null:t.owner_id,JSON.stringify({source_message_id:t.mode_source,evidence_ref:t.authorization_ref,actual_human_verified:true}),
              JSON.stringify({evidence_ref:input.evidence_ref,migrated_verified_owner:true}),item.id);
          if(t.status==='complete')db.prepare("UPDATE work_items SET data=json_set(data,'$.legacy_owner_thread_id',?) WHERE id=?").run(t.owner_id,item.id);
          imported.push(item.id);
        }
      });
      const legacyRecords=existsSync(join(root,'registry.json'))?read(join(root,'registry.json')).task_registry?.items??{}:{};
      work.atomic(()=>{
        db.exec('CREATE TABLE IF NOT EXISTS work_legacy_references (task_id TEXT PRIMARY KEY,catalog_task_id TEXT NOT NULL,data TEXT NOT NULL,imported_at INTEGER NOT NULL)');
        for(const [id,record]of Object.entries(legacyRecords)){
          if(work.get(id))continue;
          const canonical=record.canonical_key??`legacy:${config.instance_id}:${id}`;
          const complete=record.task_complete===true||record.completed===true||['complete','completed','complete_archived','completed_archived','complete_archived_verified','archived_completed_reference','completed_reference_human_reply_sent'].includes(record.status);
          const result=work.createInside({id,canonical_key:canonical,kind:'work',state:'draft',title:record.title??id,
            objective:record.bounded_scope??(typeof record.contract==='string'?record.contract:record.title)??`Preserve original scope of ${id}`,
            workspace:typeof record.worktree==='string'?record.worktree:typeof record.workspace==='string'?record.workspace:config.scope.project_root,
            requirements:[{id:'original-scope',text:'Reconcile the preserved original source, scope and acceptance before any execution; migration does not grant implementation authority.'}],
            constraints:['Migration reference only; preserve original holds, completion and authorization boundaries'],
            source:{kind:'legacy_reference',key:`legacy:${id}`,evidence_ref:input.evidence_ref}});
          if(result.created){const data={...result.task.data,legacy_record:record,legacy_owner_thread_id:record.owner_thread_id??null};
            db.prepare('UPDATE work_items SET state=?,data=? WHERE id=?').run(complete?'completed':'candidate',JSON.stringify(data),id);}
          db.prepare('INSERT OR IGNORE INTO work_legacy_references VALUES (?,?,?,?)').run(id,result.task.id,JSON.stringify(record),Date.now());references.push(id);
        }
      });
      work.seedBuiltins();
      const backup=path+'.pre-native-layout.'+Date.now();writeFileSync(backup,readFileSync(path),{mode:0o600});save(path,next);
      if(existsSync(join(root,'runtime.json'))){const {control_lanes,...runtime}=read(join(root,'runtime.json'));save(join(root,'runtime.json'),{...runtime,
        inbox:{thread_id:next.threads.main,project_id:next.scope.project_id,workspace:next.thread_workspaces.main}});}
      const legacy=existsSync(join(root,'registry.json'))?read(join(root,'registry.json')):{};
      return {migrated:true,backup,imported_execution_tasks:imported,
        imported_legacy_references:references,remaining_legacy_tasks:Object.keys(legacy.task_registry?.items??{}).filter(id=>!imported.includes(id)&&!references.includes(id)),
        native_chats_created:0,legacy_schedules_changed:false,receipts_preserved:true};
    }finally{db.close();}
  }
  if(config.layout!=='native')throw new Error('This is not a native-layout instance');
  if(command==='bind'){
    const file=option('file');if(!file)throw new Error('Use bind --file <native-readback.json>');
    const input=read(resolve(file)),main=input.threads?.main,discovery=input.threads?.discovery??config.threads.discovery??null;
    if(input.native_verified!==true||!input.evidence_ref||!input.project_id||typeof main!=='string'||!main.trim()||discovery===main)
      throw new Error('Verified project/main binding and a distinct optional discovery conversation are required');
    if(!input.thread_workspaces?.main || discovery&&!input.thread_workspaces.discovery)
      throw new Error('Include the actual native cwd for each bound main/discovery conversation');
    if(config.native_bindings_verified&&(config.threads.main!==main||config.scope.project_id!==input.project_id||config.threads.discovery&&config.threads.discovery!==discovery))
      throw new Error('Do not replace existing native owners through bootstrap');
    config.scope.project_id=input.project_id;config.threads={main,discovery};config.native_bindings_verified=true;config.binding_evidence_ref=input.evidence_ref;
    config.thread_workspaces={main:realpathSync(input.thread_workspaces.main),...(discovery?{discovery:realpathSync(input.thread_workspaces.discovery)}:{})};
    save(path,config);return {bound:true,required_roles:['main'],discovery_bound:!!discovery,legacy_roles_required:false,
      next:'Initialize the native queue runtime. Accept and bind an ordinary execution owner for the built-in exploration task; external discovery sources may remain disabled.'};
  }
  if(command==='doctor'){
    const checks=[{name:'project_directory',ok:existsSync(config.scope.project_root)},
      {name:'main_binding',ok:config.native_bindings_verified===true&&!!config.scope.project_id&&!!config.threads.main},
      {name:'optional_discovery_binding',ok:!config.threads.discovery||config.threads.discovery!==config.threads.main}];
    const db=new DatabaseSync(join(root,'control.sqlite'));let work,sources=[];
    try{work=new WorkCatalog(db,{config}).list();if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='discovery_sources'").get())sources=db.prepare('SELECT source_id,enabled FROM discovery_sources').all();}
    finally{db.close();}
    const needsDiscovery=sources.some(s=>s.enabled);
    checks.push({name:'discovery_role_when_sources_enabled',ok:!needsDiscovery||!!config.threads.discovery});
    return {layout:'native',checks,local_ready:checks.every(c=>c.ok),sources,work,
      native_setup_recorded:config.native_bindings_verified===true,note:'Saved bindings are not a live desktop or source-access probe. No legacy coordinator, dispatcher or maintenance conversation is required.'};
  }
  throw new Error('Unknown native bootstrap operation');
}
