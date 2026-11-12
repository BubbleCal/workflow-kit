import {originalSourceIndex} from './policy-store.mjs';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {inspectT3Execution} from './native-evidence.mjs';
import {migrationOperation} from './migration.mjs';
import {nativePrOperation} from './pr-authorization.mjs';

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
function human(proof,{threads,project_id,message_id,text,excluded=[]}){
  need(!excluded.includes(message_id),'Installation relay is not new human product authority');
  const r=nativeRead(proof);need(threads.includes(r.thread.threadId)&&r.thread.projectId===project_id,'Human source belongs to a different workflow conversation or project');
  const items=r.items??[];
  const m=items.find(i=>i.messageId===message_id&&i.type==='user_message');
  need(m&&m.createdBy==='user'&&!['mcp','provider'].includes(m.creationSource)&&m.visibility!=='inherited'&&(!m.sourceThreadId||m.sourceThreadId===r.thread.threadId)&&!m.textTruncated&&m.text===text,'Actual complete human message and provenance required');
  return {thread_id:r.thread.threadId,message_id,text,evidence_ref:proof.evidence_ref};
}

function reviewEvidence(path){
  const saved=JSON.parse(readFileSync(path,'utf8')),envelope=saved.response??saved;
  need(!envelope.isError,'Review source evidence returned an error');
  let body=envelope.structuredContent??envelope;
  if(body.content&&Array.isArray(body.content)){
    const text=body.content.find(c=>c.type==='text')?.text;
    need(text,'Complete review source evidence required');body=JSON.parse(text);
  }
  if(typeof body.content==='string')body=JSON.parse(body.content);
  return body;
}

// New T3 tasks only. Original Codex receipts/contracts remain in their own instance.
export class T3NativeLedger {
  constructor(root){
    this.root=resolve(root);this.config=JSON.parse(readFileSync(join(this.root,'t3-workflow.json'),'utf8'));
    need(['t3code','t3-native'].includes(this.config.backend)&&this.config.project_id&&this.config.roles?.main,'Verified T3-native instance configuration required');
    this.nativeControl=this.config.control_plane?.execution==='t3_native';
    this.roles=Object.fromEntries(Object.entries(this.config.roles).map(([k,v])=>[k,typeof v==='string'?v:v.thread_id]));
    this.db=new DatabaseSync(join(this.root,'t3-workflow.sqlite'));
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks(task_id TEXT PRIMARY KEY,canonical_key TEXT UNIQUE NOT NULL,data TEXT NOT NULL,owner TEXT,state TEXT NOT NULL,version INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions(case_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,answer TEXT,attention TEXT NOT NULL,snoozed_until TEXT);
      CREATE TABLE IF NOT EXISTS task_reports(report_key TEXT PRIMARY KEY,task_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decision_history(case_id TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,PRIMARY KEY(case_id,revision));
      CREATE TABLE IF NOT EXISTS result_deliveries(delivery_key TEXT PRIMARY KEY,case_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT);`);
  }
  close(){this.db.close();}
  atomic(fn){this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  task(id){const r=this.db.prepare('SELECT * FROM tasks WHERE task_id=? OR canonical_key=?').get(id,id);return r&&{...r,data:JSON.parse(r.data),owner:r.owner?JSON.parse(r.owner):null};}
  insertTask(key,data){
    let seq=1;while(this.task(`T3-${String(seq).padStart(3,'0')}`))seq++;
    const id=`T3-${String(seq).padStart(3,'0')}`;this.db.prepare("INSERT INTO tasks VALUES (?,?,?,NULL,'registered',1,?)").run(id,key,encode(data),Date.now());return {created:true,task:this.task(id)};
  }
  register(i){return this.atomic(()=>{
    need(this.config.processing!==false&&!this.config.task_admission?.paused,'Workflow paused; no new product admission');
    need(i.project_id===this.config.project_id,'Task must belong to this workflow project');
    need(i.canonical_key&&i.objective&&i.project_id&&i.workspace&&i.requirements?.length,'Task key, scope, workspace and acceptance required');
    const source=human(i.native_proof,{threads:[this.roles.main],project_id:this.config.project_id,excluded:this.config.authority?.agent_authored_message_ids??[],message_id:i.source_message_id,text:i.verbatim_text});
    const data={title:i.title??i.objective,objective:i.objective,requirements:i.requirements,constraints:i.constraints??[],project_id:i.project_id,workspace:i.workspace,source};
    const old=this.task(i.canonical_key);if(old){const comparable=v=>({...v,source:{...v.source,evidence_ref:null}});need(hash(comparable(old.data))===hash(comparable(data)),'Existing task contract is immutable; discuss a scoped amendment');return {created:false,task:old};}
    return this.insertTask(i.canonical_key,data);
  });}
  registerReview(i){return this.atomic(()=>{
    need(this.config.processing!==false&&!this.config.task_admission?.paused,'Workflow paused; no new product admission');
    const policy=this.config.task_admission?.automatic_reviews,grant=policy?.authority;
    need(policy?.enabled===true&&grant,'Automatic review admission requires standing human authority');
    const source=human(grant.native_proof,{threads:[this.roles.main,this.roles.maintenance].filter(Boolean),project_id:this.config.project_id,excluded:this.config.authority?.agent_authored_message_ids??[],message_id:grant.source_message_id,text:grant.verbatim_text});
    need(['pull_request','document'].includes(i.review_kind),'Use an authorized read-only review kind');
    const index=JSON.parse(readFileSync(join(this.root,'discovery/candidates.json'),'utf8'));
    const c=index.items?.[i.candidate_id];
    need(c&&c.canonical_id===i.candidate_id&&['candidate','admitted'].includes(c.disposition),'An actually classified review candidate is required');
    need(this.config.sources?.[c.source]?.enabled===true,'Review request must come from an enabled source');
    need(!c.hold&&!c.paused,'Preserve the candidate hold');
    need(c.evidence_refs?.includes(i.request_evidence_ref),'Request must use the original source evidence');
    const target=new URL(i.target_url);
    need(target.protocol==='https:'&&!target.username&&!target.password&&!target.hash,'Use the exact HTTPS review target');
    const body=reviewEvidence(i.request_evidence_ref);
    let key;
    if(i.review_kind==='pull_request'){
      const match=target.href.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
      need(match&&c.source==='github'&&c.source_url===target.href&&i.candidate_id===`github:${match[1]}:${match[2]}`,'PR review target must match its canonical source');
      const github=this.config.sources.github;
      need(github.scope?.repositories?.includes(match[1]),'PR review target must be in the configured repositories');
      need(c.metadata_pending===false&&c.state==='open'&&c.is_pr===true&&body.html_url===target.href&&body.state==='open'&&body.requested_reviewers?.some(r=>r.login===github.account?.login),'Actual open review request to the configured account required');
      key=i.candidate_id;
    }else{
      need(c.full_thread_pending===false,'Complete document request thread required');
      const text=encode(body).replaceAll('\\/','/');
      need(typeof i.request_text==='string'&&i.request_text.trim()&&text.includes(i.request_text)&&text.includes(target.href),'Document target and exact request must occur in source evidence');
      const notionId=/(^|\.)(notion\.so|notion\.com)$/.test(target.hostname)&&target.pathname.match(/([a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\/?$/i)?.[1];
      key=`document:${notionId?'https://app.notion.com/p/'+notionId.replaceAll('-','').toLowerCase():target.href}`;
    }
    const old=this.task(key);if(old)return {created:false,task:old};
    need(!c.owner_binding||Array.isArray(c.owner_binding)&&c.owner_binding.length===0,'Preserve the existing owner; do not create a second review task');
    const review={kind:i.review_kind,read_only:true,target_url:target.href,candidate_id:i.candidate_id,candidate_version:c.version,source_url:c.source_url,request_evidence_ref:i.request_evidence_ref,request_text:i.request_text??null};
    const objective=`Review ${target.href} and report evidence-backed findings and recommendations to Yang in this task's own conversation`;
    return this.insertTask(key,{title:i.title??objective,objective,requirements:['Read the current target and relevant context','Deliver a substantive summary, findings, tradeoffs and recommendations in the original owner thread','Ask Yang in the owner thread before any approve, external feedback or follow-up implementation'],constraints:['Read-only assessment only; do not edit product code or the reviewed document','Do not approve, comment, publish, merge or implement without separate human authority','Use one independent ordinary task conversation; Discovery cannot execute this review'],project_id:this.config.project_id,workspace:this.config.project_root,source,review});
  });}
  bind(i){return this.atomic(()=>{
    const task=this.task(i.task_id),r=nativeRead(i.native_proof),t=r.thread;
    need(task&&t.threadId===i.thread_id&&t.projectId===task.data.project_id&&t.createdBy==='agent'&&t.creationSource==='mcp','Original native ordinary-owner creation/project proof required');
    need(!Object.values(this.roles).includes(t.threadId),'A service role cannot become a product execution owner');
    if(this.config.task_admission?.independent_task_threads===true)need(!this.db.prepare('SELECT task_id,owner FROM tasks WHERE owner IS NOT NULL').all().some(row=>row.task_id!==task.task_id&&JSON.parse(row.owner).thread_id===t.threadId),'Independent tasks require separate owner threads');
    const owner={environment_id:i.environment_id,thread_id:t.threadId,provider_instance_id:t.providerInstanceId,model:t.model,runtime_mode:t.runtimeMode,evidence_ref:i.native_proof.evidence_ref};
    need(owner.environment_id===this.config.environment_id&&owner.provider_instance_id&&owner.model&&owner.runtime_mode==='full-access','Verified same-environment owner and actual Full access required');
    if(task.owner){const {evidence_ref:oldRef,...old}=task.owner,{evidence_ref:newRef,...current}=owner;need(encode(old)===encode(current),'Preserve the existing owner binding');return task;}
    this.db.prepare("UPDATE tasks SET owner=?,state='assigned' WHERE task_id=?").run(encode(owner),task.task_id);return this.task(task.task_id);
  });}
  report(i){return this.atomic(()=>{
    const task=this.task(i.task_id),r=nativeRead(i.native_proof);
    need(task?.owner&&task.version===i.expected_version&&r.thread.threadId===task.owner.thread_id&&r.thread.projectId===task.data.project_id,'Current original owner and task version required');
    need(i.report_key&&i.summary&&i.evidence_refs?.length&&['progress','waiting','blocked','complete'].includes(i.outcome),'Concrete evidenced owner report required');
    const message=r.items?.find(m=>m.type==='assistant_message'&&m.messageId===i.message_id);
    const run=r.recentRuns?.find(run=>run.runId===message?.runId);
    need(message&&!message.textTruncated&&message.text===i.summary&&run?.status==='completed','Exact completed native owner report required');
    const data={task_version:task.version,outcome:i.outcome,summary:i.summary,evidence_refs:i.evidence_refs,message_id:message.messageId,run_id:run.runId,next_action_at:i.next_action_at??null,wait_condition:i.wait_condition??null};
    if(data.next_action_at)need(Number.isFinite(Date.parse(data.next_action_at))&&/(Z|[+-]\d\d:\d\d)$/.test(data.next_action_at),'Next action time needs an explicit timezone');
    const old=this.db.prepare('SELECT * FROM task_reports WHERE report_key=?').get(i.report_key);
    if(old){const {native_evidence_ref,...prior}=JSON.parse(old.data);need(old.task_id===task.task_id&&hash(prior)===hash(data),'Owner report key is immutable');return {recorded:false,task:this.task(task.task_id)};}
    this.db.prepare('INSERT INTO task_reports VALUES (?,?,?)').run(i.report_key,task.task_id,encode({...data,native_evidence_ref:i.native_proof.evidence_ref}));
    this.db.prepare('UPDATE tasks SET state=? WHERE task_id=?').run(i.outcome==='complete'?'reported_complete':i.outcome,task.task_id);
    return {recorded:true,task:this.task(task.task_id),business_acceptance:false};
  });}
  decision(i){return this.atomic(()=>{
    const task=this.task(i.task_id);need(task&&i.case_id&&i.question&&i.recommendation&&i.options?.length&&i.evidence_refs?.length,'A concrete task decision with options and evidence is required');
    need(new Set(i.options.map(o=>o.id)).size===i.options.length&&i.options.every(o=>typeof o.id==='string'&&o.id),'Decision option identities must be unique');
    const discussion=i.discussion_thread_id??task.owner?.thread_id??null;
    if(this.nativeControl||this.config.attention?.decision_location==='owner_thread'){
      need(task.owner,'A bound original owner is required before requesting a decision');
      need(discussion===task.owner.thread_id,'Discuss the decision in the original owner thread');
    }
    const data={question:i.question,recommendation:i.recommendation,options:i.options,evidence_refs:i.evidence_refs,blocked_steps:i.blocked_steps??[],independent_steps:i.independent_steps??[],task_version:task.version,scope:i.scope??null,discussion_thread_id:discussion};
    const old=this.db.prepare('SELECT * FROM decisions WHERE case_id=?').get(i.case_id);
    if(old){need(old.task_id===task.task_id,'Decision identity cannot move to another task');if(hash(JSON.parse(old.data))===hash(data))return this.db.prepare('SELECT * FROM decisions WHERE case_id=?').get(i.case_id);}
    if(old)this.db.prepare('INSERT OR IGNORE INTO decision_history VALUES (?,?,?)').run(old.case_id,old.revision,encode(old));
    const revision=(old?.revision??0)+1;
    this.db.prepare("INSERT INTO decisions VALUES (?,?,?,?,NULL,?,NULL) ON CONFLICT(case_id) DO UPDATE SET revision=excluded.revision,data=excluded.data,answer=NULL,attention=excluded.attention,snoozed_until=NULL").run(i.case_id,task.task_id,revision,encode(data),this.nativeControl?'Native':'Inbox');
    return this.db.prepare('SELECT * FROM decisions WHERE case_id=?').get(i.case_id);
  });}
  answer(i){return this.atomic(()=>{
    need(this.config.processing!==false,'Workflow paused; migration does not resume decisions');
    const c=this.db.prepare('SELECT * FROM decisions WHERE case_id=?').get(i.case_id);need(c&&c.revision===i.expected_revision,'Decision revision changed');
    const data=JSON.parse(c.data),task=this.task(c.task_id);need(task?.owner&&task.version===data.task_version,'Current original task owner and contract required');
    const threads=this.nativeControl||this.config.attention?.decision_location==='owner_thread'?[task.owner.thread_id]:[this.roles.main,task.owner.thread_id,data.discussion_thread_id].filter(Boolean);
    const source=human(i.native_proof,{threads,project_id:task.data.project_id,excluded:this.config.authority?.agent_authored_message_ids??[],message_id:i.source_message_id,text:i.verbatim_text});
    need(data.options.some(o=>o.id===i.option_id),'Select an actual recorded decision option');
    const answer={option_id:i.option_id,source,revision:c.revision};
    if(c.answer){const prior=JSON.parse(c.answer);need(prior.option_id===answer.option_id&&prior.source.message_id===source.message_id&&prior.source.thread_id===source.thread_id&&prior.source.text===source.text,'Do not replace an applied human answer');return {answered:false,already_answered:true};}
    // The native human message already reaches this owner. Recording it must
    // not queue a duplicate turn or claim the owner has executed the decision.
    if(source.thread_id===task.owner.thread_id){
      source.run_id=nativeRead(i.native_proof).items.find(m=>m.messageId===source.message_id&&m.type==='user_message').runId??null;
      if(this.nativeControl)this.db.prepare('UPDATE decisions SET answer=? WHERE case_id=?').run(encode(answer),c.case_id);
      else this.db.prepare("UPDATE decisions SET answer=?,attention='Working',snoozed_until=NULL WHERE case_id=?").run(encode(answer),c.case_id);
      return {answered:true,delivery:'in_thread',source,native:null,execution_verified:false};
    }
    const key=`decision-result:${c.case_id}:${c.revision}:${source.message_id}`;
    const prompt=`[workflow-decision:${c.case_id}:${c.revision}]\nActual human answer: ${source.text}\nSelected option: ${i.option_id}\nSource: ${source.thread_id}/${source.message_id}\nOriginal evidence: ${source.evidence_ref}\nApply only within the current contract and exact decision scope; reevaluate stale artifact/head assumptions. Continue the original task and preserve other holds.`;
    const payload={threadId:task.owner.thread_id,environmentId:task.owner.environment_id,message:prompt,mode:'queue',clientRequestId:'workflow-decision:'+hash(key)};
    this.db.prepare("INSERT OR IGNORE INTO result_deliveries VALUES (?,?,?,'prepared',NULL)").run(key,c.case_id,encode(payload));
    this.db.prepare("UPDATE decisions SET answer=?,attention='Working',snoozed_until=NULL WHERE case_id=?").run(encode(answer),c.case_id);
    return {answered:true,delivery_key:key,native:{name:'t3_thread_send',arguments:payload},execution_verified:false};
  });}
  attention(i){
    need(!this.nativeControl,'Attention belongs to T3: use native Ask, Snooze or Settle; a ledger write cannot change native state');
    return this.atomic(()=>{
    need(['Inbox','Working','Snoozed','Settled'].includes(i.state),'Use a native attention state');
    need(i.state!=='Snoozed'||Number.isFinite(Date.parse(i.until))&&Date.parse(i.until)>Date.now(),'Snooze needs an actual future time');
    need(this.db.prepare('SELECT 1 FROM decisions WHERE case_id=?').get(i.case_id),'Unknown decision');
    this.db.prepare('UPDATE decisions SET attention=?,snoozed_until=? WHERE case_id=?').run(i.state,i.state==='Snoozed'?i.until:null,i.case_id);
    return {attention:i.state,owner_paused:false,human_answer_granted:false};
  });}
  pending(){
    const result={tasks:this.db.prepare('SELECT task_id,canonical_key,state,owner FROM tasks ORDER BY created_at').all(),decisions:this.db.prepare('SELECT case_id,task_id,revision,attention,snoozed_until FROM decisions WHERE answer IS NULL').all(),deliveries:this.db.prepare("SELECT delivery_key,payload,state FROM result_deliveries WHERE state IN ('prepared','unknown')").all()};
    if(this.nativeControl){
      result.authority={execution:'t3_native',attention:'t3_native',local_state:'recorded_evidence_only',decision_relay:false};
      result.tasks=result.tasks.map(({state,...t})=>({...t,recorded_outcome:state,native_execution_status:null}));
      result.decisions=result.decisions.map(({attention,snoozed_until,...d})=>({...d,historical_ledger_attention:attention,historical_ledger_snoozed_until:snoozed_until,native_attention:null}));
    }
    if(this.config.migration?.paused){
      const records=migrationOperation(this,{op:'migration_list',summary:true});
      const counts={};for(const r of records)counts[r.disposition]=(counts[r.disposition]??0)+1;
      const resumed=migrationOperation(this,{op:'migration_list'}).filter(r=>r.resumption);
      result.migration={execution_paused:resumed.length===0,resume_authorized:resumed.length>0,global_admission_paused:true,resumed_threads:resumed.map(r=>({thread_id:r.resumption.thread_id,action:r.resumption.action})),counts,records_operation:'migration_list',task_holds:this.db.prepare('SELECT task_id,data FROM migration_task_holds ORDER BY task_id').all().map(r=>({task_id:r.task_id,...JSON.parse(r.data)}))};
    }
    return result;
  }
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
  if(['pr_authorization_record','pr_authorization_get','pr_action_check','pr_action_claim','pr_action_settle','pr_action_reconcile'].includes(input.op))return nativePrOperation(ledger,input);
  if(input.op==='source_lookup'){
    need(input.task_id||input.canonical_key||input.source_key,'Exact task or source identity required');
    const index=originalSourceIndex(ledger),sources=index.sources.filter(s=>!input.source_key||s.source_key===input.source_key);
    const catalog=index.catalog.filter(t=>(!input.task_id||t.id===input.task_id)&&(!input.canonical_key||t.canonical_key===input.canonical_key)&&(!input.source_key||sources.some(s=>s.task_id===t.id)));
    const ids=new Set(catalog.map(t=>t.id)),mappings=migrationOperation(ledger,{op:'migration_list'}).filter(r=>ids.has(r.source_task_id));
    return {catalog,sources:sources.filter(s=>ids.has(s.task_id)),mappings,automatic_execution:false,source_state:'historical_archive'};
  }
  if(['migration_pause','migration_import','migration_list','migration_resume'].includes(input.op))return migrationOperation(ledger,input);
  const operations={register:()=>ledger.register(input),register_review:()=>ledger.registerReview(input),bind_owner:()=>ledger.bind(input),report:()=>ledger.report(input),decision:()=>ledger.decision(input),answer:()=>ledger.answer(input),attention:()=>ledger.attention(input),pending:()=>ledger.pending(),get:()=>ledger.task(input.task_id),settle:()=>ledger.settle(input),observe:()=>ledger.observe(input)};
  need(operations[input.op],'Unknown T3 native ledger operation');return operations[input.op]();
}finally{ledger.close();}}
