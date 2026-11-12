import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {T3McpClient,T3_BASELINE} from './t3-transport.mjs';

export function prepareT3Migration(instance){
  const root=resolve(instance),config=JSON.parse(readFileSync(join(root,'instance.json'),'utf8'));
  const db=new DatabaseSync(join(root,'control.sqlite'),{readOnly:true});
  try{
    db.exec('BEGIN');
    const tasks=db.prepare('SELECT w.id,w.canonical_key,w.kind,w.state,w.owner_thread_id,w.data,w.authorization,r.mode,r.status,r.contract,r.contract_rev,r.context_rev,r.plan_rev FROM work_items w LEFT JOIN rt_tasks r ON r.task_id=w.id ORDER BY w.id').all().map(row=>{
      const open=db.prepare("SELECT id,state,transport,queue_id,turn_id FROM rt_wakes WHERE owner_id=? AND state IN ('reserved','claimed','queued','running','uncertain','sent')").all(row.owner_thread_id);
      const effects=db.prepare("SELECT action_key,kind,state FROM actions WHERE task_id=? AND state IN ('claimed','uncertain')").all(row.id);
      const contract=row.contract?JSON.parse(row.contract):null,data=JSON.parse(row.data);
      return {task_id:row.id,canonical_key:row.canonical_key,kind:row.kind,state:row.state,mode:row.mode,status:row.status,
        original_owner:{backend:'codex-desktop',thread_id:row.owner_thread_id},target_owner:null,
        workspace:contract?.workspace??data.workspace,contract,contract_rev:row.contract_rev,context_rev:row.context_rev,plan_rev:row.plan_rev,
        contract_sha256:row.contract?createHash('sha256').update(row.contract).digest('hex'):null,
        original_authorization:row.authorization?JSON.parse(row.authorization):null,open_executions:open,unresolved_effects:effects,
        cutover_blockers:[...(open.length?['original_owner_has_live_or_unresolved_execution']:[]),...(effects.length?['unresolved_original_effects']:[]),...(row.mode==='paused'?['explicit_pause']:[]),...(row.status==='needs_decision'?['human_decision_pending']:[]),
          ...(!row.owner_thread_id?['no_original_owner_mapping']:[]),'target_mapping_and_credentials_unverified','connector_parity_unverified','explicit_cutover_not_recorded']};
    });
    db.exec('COMMIT');
    return {schema_version:1,prepared_at:new Date().toISOString(),source_instance_id:config.instance_id,source_root:root,
      branch:'yang/t3code',baseline:T3_BASELINE,stage:'preparation_only',live_cutover_enabled:false,
      original_roles:config.threads,sources:config.discovery?.sources??null,tasks,
      summary:{tasks:tasks.length,bound_owners:tasks.filter(t=>t.original_owner.thread_id).length,tasks_with_open_execution:tasks.filter(t=>t.open_executions.length).length,
        paused:tasks.filter(t=>t.mode==='paused').length,needs_decision:tasks.filter(t=>t.status==='needs_decision').length},
      invariants:['Original IDs, contracts, human authority, holds and execution receipts remain authoritative','No parallel Codex App/T3 writer for the same native provider session','T3 completion/settlement is not business acceptance or permission to archive','Keep one scheduler per occurrence; initial T3 pilot reuses runtime scheduling','No provider/model/effort/permission changes inferred from platform migration'],
      next:'Review T3_MIGRATION.md, verify connectors and an authorized target environment, then select a quiescent pilot. This manifest starts no threads and changes no source state.'};
  }finally{db.close();}
}

export async function t3Main(args,{output=v=>process.stdout.write(JSON.stringify(v,null,2)+'\n')}={}){
  const command=args[0],option=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1];};
  if(command==='prepare'){
    const instance=option('instance');if(!instance)throw new Error('Use t3 prepare --instance <existing-workflow-root> [--out <new-manifest.json>]');
    const manifest=prepareT3Migration(instance),out=option('out');
    if(out){writeFileSync(resolve(out),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});output({prepared:true,output:resolve(out),summary:manifest.summary,live_cutover_enabled:false});}
    else output(manifest);
  }else if(command==='probe'){
    const file=option('config');if(!file||!existsSync(file))throw new Error('Use t3 probe --config <t3 connection JSON>');
    const config=JSON.parse(readFileSync(file,'utf8')),token=process.env[config.token_env];
    const client=new T3McpClient({url:config.mcp_url,token,allow_writes:false});
    const capabilities=await client.call('orchestrator_capabilities',config.environment_id?{environmentId:config.environment_id}:{});
    output({read_only:true,server:client.serverInfo,capabilities,baseline:T3_BASELINE,
      live_cutover_enabled:false,note:'Capability/read access is not a successful cold/busy execution or connector migration.'});
  }else output({commands:['t3 prepare --instance <root> --out <new manifest>','t3 probe --config <connection JSON>'],live_cutover_enabled:false});
}
