import {historicalPath} from './policy-store.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

const need=(v,m)=>{if(!v)throw Error(m);};
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function unwrap(v){if(v.structuredContent)return v.structuredContent;for(const c of v.content??[])if(c.type==='text'){try{return JSON.parse(c.text);}catch{}}return v;}
function native(path){const s=JSON.parse(readFileSync(path));const v=s.response??s;need(!v.isError,'Native migration read failed');return unwrap(v);}
function authority(ledger){
  const m=ledger.config.migration;
  need(m?.paused===true&&ledger.config.processing===false,'Paused migration configuration required');
  need(sha(historicalPath(ledger,m.manifest))===m.manifest_sha256,'Migration manifest hash changed');
  const manifest=JSON.parse(readFileSync(historicalPath(ledger,m.manifest)));
  need(manifest.target_t3_thread_id===m.exempt_thread_id,'Wrong designated migration owner');
  const a=native(historicalPath(ledger,m.authority_ref));
  const message=a.turns?.flatMap(t=>t.items??[]).find(i=>i.type==='userMessage'&&i.id===m.human_message_id);
  const text=message?.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  need(a.thread?.id==='01a1acc4-a8af-7b72-87a7-30209ea4c70c'&&text?.includes('所有任务暂停')&&text.includes(m.exempt_thread_id),'Original complete Codex human migration authority required');
  return {source:'codex_native',thread_id:a.thread.id,message_id:message.id,verbatim_text:text,evidence_ref:m.authority_ref,manifest_sha256:m.manifest_sha256};
}
export function migrationOperation(ledger,input){
  const source=authority(ledger);
  ledger.db.exec('CREATE TABLE IF NOT EXISTS migration_records(source_key TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS migration_task_holds(task_id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS migration_resumptions(source_key TEXT PRIMARY KEY,data TEXT NOT NULL)');
  if(input.op==='migration_list'){
    const resumptions=new Map(ledger.db.prepare('SELECT source_key,data FROM migration_resumptions').all().map(r=>[r.source_key,JSON.parse(r.data)]));
    const rows=ledger.db.prepare('SELECT source_key,data FROM migration_records ORDER BY source_key').all().map(r=>({source_key:r.source_key,...JSON.parse(r.data),...(resumptions.has(r.source_key)?{resumption:resumptions.get(r.source_key)}:{})}));
    return input.summary?rows.map(r=>({source_key:r.source_key,disposition:r.disposition,source_host:r.source_host,source_thread_id:r.source_thread_id,source_task_id:r.source_task_id,target_thread_id:r.destination?.threadId??null,source_title:r.source_title})):rows;
  }
  return ledger.atomic(()=>{
    if(input.op==='migration_resume'){
      const proof=native(input.native_proof?.evidence_ref),m=proof.items?.find(i=>i.messageId===input.source_message_id);
      need(proof.thread?.threadId===ledger.config.migration.exempt_thread_id&&proof.thread.projectId===ledger.config.project_id,'Resume must be authorized in the designated native project/thread');
      need(m?.createdBy==='user'&&m.type==='user_message'&&!['mcp','provider'].includes(m.creationSource)&&m.visibility==='local'&&!m.textTruncated&&m.text===input.verbatim_text&&m.text.trim().endsWith('交接后继续任务执行'),'Actual complete human handoff-and-resume instruction required');
      need(Array.isArray(input.target_thread_ids)&&input.target_thread_ids.length>0&&new Set(input.target_thread_ids).size===input.target_thread_ids.length,'Explicit unique destination allowlist required');
      const records=ledger.db.prepare('SELECT source_key,data FROM migration_records').all().map(r=>({...r,record:JSON.parse(r.data)}));
      let inserted=0,reused=0;
      for(const id of input.target_thread_ids){
        const row=records.find(r=>r.record.destination?.threadId===id&&r.record.disposition==='migrated_paused');
        need(row,'Resume target must be an existing migrated owner, not a service role or unverified source');
        const data={thread_id:id,human_authority:{thread_id:proof.thread.threadId,message_id:m.messageId,verbatim_text:m.text,evidence_ref:input.native_proof.evidence_ref},action:row.record.original_state==='complete'?'handoff_only_preserve_complete':'handoff_then_resume_original_scope',migration_pause_lifted:true,historical_holds_preserved:true,original_completed_state_preserved:true,automatic_discovery_authorized:false,new_product_scope_authorized:false};
        const old=ledger.db.prepare('SELECT data FROM migration_resumptions WHERE source_key=?').get(row.source_key);
        if(old){need(old.data===JSON.stringify(data),'Resume provenance is immutable');reused++;}else{ledger.db.prepare('INSERT INTO migration_resumptions VALUES (?,?)').run(row.source_key,JSON.stringify(data));inserted++;}
      }
      return {inserted,reused,target_count:input.target_thread_ids.length,historical_holds_preserved:true,global_admission_paused:true,automatic_discovery_authorized:false};
    }
    if(input.op==='migration_pause'){
      const tasks=ledger.db.prepare('SELECT task_id,state,owner FROM tasks').all();
      for(const t of tasks)ledger.db.prepare('INSERT OR IGNORE INTO migration_task_holds VALUES (?,?)').run(t.task_id,JSON.stringify({reason:'all-task migration pause',source,prior_state:t.state,original_owner:t.owner&&JSON.parse(t.owner),execution_paused:true,resume_requires_explicit_human_instruction:true}));
      return {tasks_held:tasks.length,execution_paused:true,states_and_receipts_preserved:true,product_execution:false};
    }
    need(input.op==='migration_import'&&Array.isArray(input.records),'Use an explicit migration record batch');
    let inserted=0,reused=0;
    for(const r of input.records){
      need(r.source_host&&r.source_thread_id&&r.disposition&&r.paused===true,'Source identity, disposition and paused state required');
      const key=JSON.stringify([r.source_host,r.source_thread_id,r.source_task_id??null]);
      for(const s of r.snapshots??[])need(sha(s.path)===s.sha256,'Source snapshot hash changed');
      if(['migrated_paused','associated_existing'].includes(r.disposition)){
        need(r.destination?.evidence_ref&&r.destination.config_evidence_ref,'Actual native thread and configuration readback required');
        const b=native(r.destination.evidence_ref),t=b.thread,c=native(r.destination.config_evidence_ref);
        need(t?.threadId===r.destination.threadId&&t.projectId===r.destination.projectId&&t.runtimeMode==='full-access'&&!t.archived,'Native destination identity/project/Full access mismatch');
        need(!t.activeRunId||t.threadId===ledger.config.migration.exempt_thread_id&&r.control_role===true,'Migration may not start or retain another owner run');
        need(c.threadId===t.threadId&&c.runtimeMode==='full-access','Actual native configuration mismatch');
        if(r.disposition==='migrated_paused')need(t.runCount===0&&t.itemCount===0&&c.modelSelection?.model===r.original_model&&c.modelSelection?.options?.some(o=>o.id==='reasoningEffort'&&o.value===r.original_reasoning_effort),'New destination must be idle with preserved original model/options');
        need(r.classification!=='archived','Archived source cannot be revived');
      }
      need(r.original_actor_rewritten!==true&&r.resume_authorized!==true,'Migration cannot rewrite source actors or grant resume');
      const data={...r,migration_authority:source,migration_hold:{reason:'Yang global pause for migration',execution_paused:true,resume_authorized:false},native_history_imported:false};
      const old=ledger.db.prepare('SELECT data FROM migration_records WHERE source_key=?').get(key);
      if(old){need(old.data===JSON.stringify(data),'Existing migration record is immutable; reconcile instead of replacing');reused++;continue;}
      ledger.db.prepare('INSERT INTO migration_records VALUES (?,?)').run(key,JSON.stringify(data));inserted++;
    }
    return {inserted,reused,execution_paused:true,native_history_imported:false,product_execution:false};
  });
}
