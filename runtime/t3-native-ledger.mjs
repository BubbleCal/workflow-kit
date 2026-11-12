import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {inspectT3Execution} from './t3-transport.mjs';

const encode=JSON.stringify,hash=v=>createHash('sha256').update(encode(v)).digest('hex');
const need=(value,message)=>{if(!value)throw new Error(message);};
function nativeRead(proof){
  need(proof?.source==='t3code.mcp.t3_thread_read'&&proof.evidence_ref,'Original T3 read proof required');
  const saved=JSON.parse(readFileSync(proof.evidence_ref,'utf8'));
  const envelope=saved.response??saved.readback??saved;
  need(!envelope.isError,'Native tool returned an error');
  if(envelope?.thread)return envelope;
  if(envelope?.structuredContent?.thread)return envelope.structuredContent;
  for(const c of envelope?.content??[])if(c.type==='text'){try{const v=JSON.parse(c.text);if(v.thread)return v;}catch{}}
  throw new Error('No native T3 thread readback');
}
function human(proof,{threads,message_id,text,excluded=[]}){
  need(!excluded.includes(message_id),'Installation relay is not new human product authority');
  const r=nativeRead(proof);need(threads.includes(r.thread.threadId),'Human source belongs to a different workflow conversation');
  const items=r.items??[];
  const m=items.find(i=>i.messageId===message_id&&i.type==='user_message');
  need(m&&m.createdBy==='user'&&!['mcp','provider'].includes(m.creationSource)&&!m.textTruncated&&m.text===text,'Actual complete human message and provenance required');
  return {thread_id:r.thread.threadId,message_id,text,evidence_ref:proof.evidence_ref};
}

// New T3 tasks only. Original Codex receipts/contracts remain in their own instance.
export class T3NativeLedger {
  constructor(root){
    this.root=resolve(root);this.config=JSON.parse(readFileSync(join(this.root,'t3-workflow.json'),'utf8'));
    need(['t3code','t3-native'].includes(this.config.backend)&&this.config.project_id&&this.config.roles?.main,'Verified T3-native instance configuration required');
    this.roles=Object.fromEntries(Object.entries(this.config.roles).map(([k,v])=>[k,typeof v==='string'?v:v.thread_id]));
    this.db=new DatabaseSync(join(this.root,'t3-workflow.sqlite'));
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks(task_id TEXT PRIMARY KEY,canonical_key TEXT UNIQUE NOT NULL,data TEXT NOT NULL,owner TEXT,state TEXT NOT NULL,version INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions(case_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,answer TEXT,attention TEXT NOT NULL,snoozed_until TEXT);
      CREATE TABLE IF NOT EXISTS decision_history(case_id TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,PRIMARY KEY(case_id,revision));
      CREATE TABLE IF NOT EXISTS result_deliveries(delivery_key TEXT PRIMARY KEY,case_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT);`);
  }
  close(){this.db.close();}
  atomic(fn){this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  task(id){const r=this.db.prepare('SELECT * FROM tasks WHERE task_id=? OR canonical_key=?').get(id,id);return r&&{...r,data:JSON.parse(r.data),owner:r.owner?JSON.parse(r.owner):null};}
  register(i){return this.atomic(()=>{
    need(i.project_id===this.config.project_id,'Task must belong to this workflow project');
    need(i.canonical_key&&i.objective&&i.project_id&&i.workspace&&i.requirements?.length,'Task key, scope, workspace and acceptance required');
    const source=human(i.native_proof,{threads:[this.roles.main],excluded:this.config.authority?.agent_authored_message_ids??[],message_id:i.source_message_id,text:i.verbatim_text});
    const data={title:i.title??i.objective,objective:i.objective,requirements:i.requirements,constraints:i.constraints??[],project_id:i.project_id,workspace:i.workspace,source};
    const old=this.task(i.canonical_key);if(old){const comparable=v=>({...v,source:{...v.source,evidence_ref:null}});need(hash(comparable(old.data))===hash(comparable(data)),'Existing task contract is immutable; discuss a scoped amendment');return {created:false,task:old};}
    let seq=1;while(this.task(`T3-${String(seq).padStart(3,'0')}`))seq++;
    const id=`T3-${String(seq).padStart(3,'0')}`;this.db.prepare("INSERT INTO tasks VALUES (?,?,?,NULL,'registered',1,?)").run(id,i.canonical_key,encode(data),Date.now());return {created:true,task:this.task(id)};
  });}
  bind(i){return this.atomic(()=>{
    const task=this.task(i.task_id),r=nativeRead(i.native_proof),t=r.thread;
    need(task&&t.threadId===i.thread_id&&t.projectId===task.data.project_id&&t.createdBy==='agent'&&t.creationSource==='mcp','Original native ordinary-owner creation/project proof required');
    need(!Object.values(this.roles).includes(t.threadId),'A service role cannot become a product execution owner');
    const owner={environment_id:i.environment_id,thread_id:t.threadId,provider_instance_id:t.providerInstanceId,model:t.model,runtime_mode:t.runtimeMode,evidence_ref:i.native_proof.evidence_ref};
    need(owner.environment_id===this.config.environment_id&&owner.provider_instance_id&&owner.model&&owner.runtime_mode==='full-access','Verified same-environment owner and actual Full access required');
    if(task.owner){const {evidence_ref:oldRef,...old}=task.owner,{evidence_ref:newRef,...current}=owner;need(encode(old)===encode(current),'Preserve the existing owner binding');return task;}
    this.db.prepare("UPDATE tasks SET owner=?,state='assigned' WHERE task_id=?").run(encode(owner),task.task_id);return this.task(task.task_id);
  });}
  decision(i){return this.atomic(()=>{
    const task=this.task(i.task_id);need(task&&i.case_id&&i.question&&i.recommendation&&i.options?.length&&i.evidence_refs?.length,'A concrete task decision with options and evidence is required');
    need(new Set(i.options.map(o=>o.id)).size===i.options.length&&i.options.every(o=>typeof o.id==='string'&&o.id),'Decision option identities must be unique');
    const data={question:i.question,recommendation:i.recommendation,options:i.options,evidence_refs:i.evidence_refs,blocked_steps:i.blocked_steps??[],independent_steps:i.independent_steps??[],task_version:task.version,scope:i.scope??null,discussion_thread_id:i.discussion_thread_id??null};
    const old=this.db.prepare('SELECT * FROM decisions WHERE case_id=?').get(i.case_id);
    if(old){need(old.task_id===task.task_id,'Decision identity cannot move to another task');if(hash(JSON.parse(old.data))===hash(data))return this.db.prepare('SELECT * FROM decisions WHERE case_id=?').get(i.case_id);}
    if(old)this.db.prepare('INSERT OR IGNORE INTO decision_history VALUES (?,?,?)').run(old.case_id,old.revision,encode(old));
    const revision=(old?.revision??0)+1;
    this.db.prepare("INSERT INTO decisions VALUES (?,?,?,?,NULL,'Inbox',NULL) ON CONFLICT(case_id) DO UPDATE SET revision=excluded.revision,data=excluded.data,answer=NULL,attention='Inbox',snoozed_until=NULL").run(i.case_id,task.task_id,revision,encode(data));
    return this.db.prepare('SELECT * FROM decisions WHERE case_id=?').get(i.case_id);
  });}
  answer(i){return this.atomic(()=>{
    const c=this.db.prepare('SELECT * FROM decisions WHERE case_id=?').get(i.case_id);need(c&&c.revision===i.expected_revision,'Decision revision changed');
    const data=JSON.parse(c.data),task=this.task(c.task_id);need(task?.owner&&task.version===data.task_version,'Current original task owner and contract required');
    const source=human(i.native_proof,{threads:[this.roles.main,data.discussion_thread_id].filter(Boolean),excluded:this.config.authority?.agent_authored_message_ids??[],message_id:i.source_message_id,text:i.verbatim_text});
    need(data.options.some(o=>o.id===i.option_id),'Select an actual recorded decision option');
    const answer={option_id:i.option_id,source,revision:c.revision};
    if(c.answer){const prior=JSON.parse(c.answer);need(prior.option_id===answer.option_id&&prior.source.message_id===source.message_id&&prior.source.thread_id===source.thread_id&&prior.source.text===source.text,'Do not replace an applied human answer');return {answered:false,already_answered:true};}
    const key=`decision-result:${c.case_id}:${c.revision}:${source.message_id}`;
    const prompt=`[workflow-decision:${c.case_id}:${c.revision}]\nActual human answer: ${source.text}\nSelected option: ${i.option_id}\nSource: ${source.thread_id}/${source.message_id}\nOriginal evidence: ${source.evidence_ref}\nApply only within the current contract and exact decision scope; reevaluate stale artifact/head assumptions. Continue the original task and preserve other holds.`;
    const payload={threadId:task.owner.thread_id,environmentId:task.owner.environment_id,message:prompt,mode:'queue',clientRequestId:'workflow-decision:'+hash(key)};
    this.db.prepare("INSERT OR IGNORE INTO result_deliveries VALUES (?,?,?,'prepared',NULL)").run(key,c.case_id,encode(payload));
    this.db.prepare("UPDATE decisions SET answer=?,attention='Working',snoozed_until=NULL WHERE case_id=?").run(encode(answer),c.case_id);
    return {answered:true,delivery_key:key,native:{name:'t3_thread_send',arguments:payload},execution_verified:false};
  });}
  attention(i){return this.atomic(()=>{
    need(['Inbox','Working','Snoozed','Settled'].includes(i.state),'Use a native attention state');
    need(i.state!=='Snoozed'||Number.isFinite(Date.parse(i.until))&&Date.parse(i.until)>Date.now(),'Snooze needs an actual future time');
    need(this.db.prepare('SELECT 1 FROM decisions WHERE case_id=?').get(i.case_id),'Unknown decision');
    this.db.prepare('UPDATE decisions SET attention=?,snoozed_until=? WHERE case_id=?').run(i.state,i.state==='Snoozed'?i.until:null,i.case_id);
    return {attention:i.state,owner_paused:false,human_answer_granted:false};
  });}
  pending(){return {tasks:this.db.prepare('SELECT task_id,canonical_key,state,owner FROM tasks ORDER BY created_at').all(),decisions:this.db.prepare('SELECT case_id,task_id,revision,attention,snoozed_until FROM decisions WHERE answer IS NULL').all(),deliveries:this.db.prepare("SELECT delivery_key,payload,state FROM result_deliveries WHERE state IN ('prepared','unknown')").all()};}
  settle(i){return this.atomic(()=>{
    const r=this.db.prepare('SELECT * FROM result_deliveries WHERE delivery_key=?').get(i.delivery_key);need(r,'Unknown decision delivery');
    if(['accepted','observed'].includes(r.state))return {settled:false,already_accepted:true};
    const p=JSON.parse(r.payload),envelope=i.native_result;let result=envelope?.structuredContent??envelope;
    need(!envelope?.isError,'Native send failed');
    if(envelope?.content){const item=envelope.content.find(c=>c.type==='text');need(item,'Native send result missing');result=JSON.parse(item.text);}
    if(i.outcome==='unknown'){need(r.state==='prepared','Unknown outcome must not overwrite an existing receipt');this.db.prepare("UPDATE result_deliveries SET state='unknown',receipt=? WHERE delivery_key=?").run(encode(i.native_result??{}),i.delivery_key);return {state:'unknown',resend_allowed:false};}
    need(r.state==='prepared'&&result?.threadId===p.threadId&&result.messageId&&result.runId&&['queued','started'].includes(result.delivery),'Exact non-interrupting native decision-delivery receipt required');
    this.db.prepare("UPDATE result_deliveries SET state='accepted',receipt=? WHERE delivery_key=?").run(encode(i.native_result),i.delivery_key);return {accepted:true,execution_verified:false};
  });}
  observe(i){return this.atomic(()=>{
    const row=this.db.prepare('SELECT * FROM result_deliveries WHERE delivery_key=?').get(i.delivery_key);need(row,'Unknown decision delivery');
    const p=JSON.parse(row.payload),c=this.db.prepare('SELECT * FROM decisions WHERE case_id=?').get(row.case_id),task=this.task(c.task_id);
    let receipt=i.receipt??(row.receipt&&JSON.parse(row.receipt));
    receipt=receipt?.structuredContent??receipt;
    if(receipt?.content)receipt=JSON.parse(receipt.content.find(c=>c.type==='text').text);
    need(receipt?.threadId===p.threadId&&receipt.messageId&&receipt.runId,'Exact native send receipt identity required');
    const result=inspectT3Execution(nativeRead(i.native_proof),{...receipt,message:p.message},{thread_id:p.threadId,project_id:task.data.project_id,provider_instance_id:task.owner.provider_instance_id,model:task.owner.model,runtime_mode:task.owner.runtime_mode});
    need(result.execution_started,'Exact owner execution has not been observed');
    this.db.prepare("UPDATE result_deliveries SET state='observed',receipt=? WHERE delivery_key=?").run(encode({receipt,observation:result,evidence_ref:i.native_proof.evidence_ref}),i.delivery_key);
    return result;
  });}

}

export function runT3Ledger(root,input){const ledger=new T3NativeLedger(root);try{
  const operations={register:()=>ledger.register(input),bind_owner:()=>ledger.bind(input),decision:()=>ledger.decision(input),answer:()=>ledger.answer(input),attention:()=>ledger.attention(input),pending:()=>ledger.pending(),get:()=>ledger.task(input.task_id),settle:()=>ledger.settle(input),observe:()=>ledger.observe(input)};
  need(operations[input.op],'Unknown T3 native ledger operation');return operations[input.op]();
}finally{ledger.close();}}
