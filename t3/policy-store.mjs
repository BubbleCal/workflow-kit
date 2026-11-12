import {readFileSync,writeFileSync,renameSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {normalizeBindings} from '../guards/instance.mjs';

const need=(v,m)=>{if(!v)throw Error(m);},hash=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8')),encode=v=>JSON.stringify(v,null,2)+'\n';
const unwrap=v=>v.structuredContent??(v.content?JSON.parse(v.content.find(c=>c.type==='text').text):v);
function localPath(root,path){const p=resolve(root,path);need(!relative(root,p).startsWith('..'),'Policy artifacts must remain inside this instance');return p;}
function artifact(root,ref){const p=localPath(root,ref.path),bytes=readFileSync(p);need(hash(bytes)===ref.sha256,'Installed policy/archive artifact changed; reconcile explicitly');return JSON.parse(bytes);}
function save(root,name,bytes){
  const sha256=hash(bytes),path=join('policies',`${name}-${sha256.slice(0,16)}.json`),p=localPath(root,path);
  mkdirSync(join(root,'policies'),{recursive:true});
  if(existsSync(p))need(hash(readFileSync(p))===sha256,'Do not overwrite an existing artifact');else writeFileSync(p,bytes,{flag:'wx',mode:0o600});
  return {path,sha256};
}
export function historicalPath(ledger,path){
  const ref=ledger.config.policy_store?.source_archives?.find(a=>a.original_path===path);
  if(!ref)return path;
  const p=localPath(ledger.root,ref.path);need(hash(readFileSync(p))===ref.sha256,'Original source archive changed');return p;
}
export function readPrPolicy(ledger){
  const store=ledger.config.policy_store;
  if(store){
    need(store.schema_version===1&&store.legacy_runtime_required===false,'Unsupported native policy store');
    const value=artifact(ledger.root,store.pr_policy);
    need(value.project_id===ledger.config.project_id,'Policy snapshot belongs to another project');
    const {b,p,window,dependency}=value.policy;
    return {b,p,window,dependency,version:hash(JSON.stringify({b,p,window,dependency})),source:'instance_policy'};
  }
  need(ledger.config.control_plane?.legacy_runtime_required!==false,'Native instance policy is missing; never fall back to the legacy runtime');
  // Transitional installations only. Detaching replaces these reads atomically.
  const root=read(historicalPath(ledger,ledger.config.migration.manifest)).old_local.root;
  const b=normalizeBindings(read(join(root,'instance.json'))),p=read(join(root,b.delivery.slack_routing_file));
  const window=read(join(root,'pr-review-window.json')),dependency=read(join(root,'dependency-policy.json'));
  return {root,b,p,window,dependency,version:hash(JSON.stringify({b,p,window,dependency})),source:'legacy_transition'};
}
export function originalActionReceipts(ledger){
  const store=ledger.config.policy_store;
  if(store){
    const a=artifact(ledger.root,store.legacy_action_receipts);
    need(a.project_id===ledger.config.project_id,'Action archive belongs to another project');
    return a.actions.map(a=>({...a,source:'legacy_archive'}));
  }
  need(ledger.config.control_plane?.legacy_runtime_required!==false,'Native action archive is missing; no legacy fallback');
  const root=read(historicalPath(ledger,ledger.config.migration.manifest)).old_local.root;
  const db=new DatabaseSync(join(root,'control.sqlite'),{readOnly:true});
  try{return db.prepare("SELECT * FROM actions WHERE kind IN ('slack_pr','merge','pr_ready')").all().map(a=>({...a,source:'legacy_read_only'}));}finally{db.close();}
}
export function originalSourceIndex(ledger){
  need(ledger.config.policy_store?.original_task_source_index,'Archive the original source index first');
  const index=artifact(ledger.root,ledger.config.policy_store.original_task_source_index);
  need(index.project_id===ledger.config.project_id,'Source index belongs to another project');return index;
}

// One explicit finite conversion. It never starts, resumes or writes the old
// runtime, sends a message, changes a product grant, or creates a native run.
export function detachLegacyRuntime(root,input){
  root=resolve(root);const configPath=join(root,'t3-workflow.json'),before=readFileSync(configPath),c=JSON.parse(before);
  const saved=read(input.native_proof?.evidence_ref),envelope=saved.response??saved;
  need(input.native_proof?.source==='t3code.mcp.t3_thread_read'&&!envelope.isError,'Actual native reform authority required');
  const r=unwrap(envelope),maintenance=typeof c.roles.maintenance==='string'?c.roles.maintenance:c.roles.maintenance.thread_id;
  const m=r.items?.find(m=>m.messageId===input.source_message_id);
  need(process.env.T3CODE_THREAD_ID===maintenance&&r.thread?.threadId===maintenance&&r.thread.projectId===c.project_id&&r.thread.runtimeMode==='full-access','Actual designated native Maintenance required');
  need(m?.type==='user_message'&&m.createdBy==='user'&&['web','mobile','server'].includes(m.creationSource)&&m.visibility==='local'&&
    (!m.sourceThreadId||m.sourceThreadId===maintenance)&&!m.textTruncated&&m.text===input.verbatim_text&&m.text.trim()==='开始改造吧','Direct complete human native reform instruction required');
  if(c.policy_store){
    readPrPolicy({root,config:c});originalActionReceipts({root,config:c});
    return {converted:false,already_native:true,policy_store:c.policy_store,execution:'t3_native'};
  }
  need(c.processing===false&&c.task_admission?.paused===true,'Preserve the current global admission pause during conversion');
  need(hash(readFileSync(c.migration.manifest))===c.migration.manifest_sha256,'Original migration manifest changed');
  const manifest=read(c.migration.manifest);need(manifest.target_t3_thread_id===maintenance,'Wrong migration instance');
  const oldRoot=manifest.old_local.root,db=new DatabaseSync(join(oldRoot,'control.sqlite'),{readOnly:true});
  let actions,catalog,sources;
  try{
    db.exec('BEGIN');
    need(db.prepare("SELECT value FROM settings WHERE key='processing'").get()?.value==='off','Legacy processing must stay off before freezing its receipts');
    actions=db.prepare("SELECT * FROM actions WHERE kind IN ('slack_pr','merge','pr_ready') ORDER BY action_key").all();
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t=>t.name));
    catalog=tables.has('work_items')?db.prepare('SELECT * FROM work_items ORDER BY id').all():[];
    sources=tables.has('work_sources')?db.prepare('SELECT * FROM work_sources').all():[];
    db.exec('COMMIT');
  }finally{db.close();}
  const b=normalizeBindings(read(join(oldRoot,'instance.json'))),p=read(join(oldRoot,b.delivery.slack_routing_file));
  const window=read(join(oldRoot,'pr-review-window.json')),dependency=read(join(oldRoot,'dependency-policy.json'));
  const authority={thread_id:maintenance,message_id:m.messageId,verbatim_text:m.text,evidence_ref:input.native_proof.evidence_ref,evidence_sha256:hash(readFileSync(input.native_proof.evidence_ref))};
  const snapshot={schema_version:1,project_id:c.project_id,source_root:oldRoot,policy:{b,p,window,dependency}};
  const actionArchive={schema_version:1,project_id:c.project_id,source_root:oldRoot,actions};
  const sourceIndex={schema_version:1,project_id:c.project_id,source_root:oldRoot,catalog,sources,
    collector_state:'archived_disabled',execution_authority:false};
  const policy_store={schema_version:1,legacy_runtime_required:false,authority,
    pr_policy:save(root,'pr-policy',encode(snapshot)),legacy_action_receipts:save(root,'original-action-receipts',encode(actionArchive)),
    original_task_source_index:save(root,'original-task-sources',encode(sourceIndex)),
    source_archives:[...new Set([c.migration.manifest,c.migration.authority_ref])].map(path=>({original_path:path,...save(root,'migration-source',readFileSync(path))}))};
  const next={...c,control_plane:{execution:'t3_native',queues:'t3_native',schedules:'t3_native',waits:'t3_native',attention:'t3_native',
    local_records:'contracts_authority_receipts_only',decision_relay:false,legacy_runtime_required:false},policy_store};
  if(next.discovery){
    next.discovery={...next.discovery,historical_legacy_database_path:next.discovery.legacy_database_read_only,
      original_source_index:policy_store.original_task_source_index.path,legacy_feedback_transport:'retired; native owner queue only within current authority',
      legacy_feedback_watches:'Archived bindings only; no old collector. Global sources and schedules remain paused.'};
    delete next.discovery.legacy_database_read_only;
  }
  need(hash(readFileSync(configPath))===hash(before),'Instance changed during conversion; preserve concurrent edits');
  const temp=configPath+'.native-reform.tmp';writeFileSync(temp,encode(next),{flag:'wx',mode:0o600});renameSync(temp,configPath);
  return {converted:true,project_id:c.project_id,execution:'t3_native',policy_store,
    preserved_policy_version:hash(JSON.stringify(snapshot.policy)),original_action_receipts:actions.length,
    unresolved_original_actions:actions.filter(a=>['prepared','deferred','claimed','uncertain'].includes(a.state)).map(a=>({key:a.action_key,kind:a.kind,state:a.state})),
    config_before_sha256:hash(before),config_after_sha256:hash(readFileSync(configPath)),
    existing_native_actions_and_grants_unchanged:true,models_and_owner_allowlist_unchanged:true,product_authority_expanded:false,services_enabled:false};
}
