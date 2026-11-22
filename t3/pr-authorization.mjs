import {readPrPolicy,originalActionReceipts} from './policy-store.mjs';
import {verifyNormalizedSlackReceipt} from './slack-receipt.mjs';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {assessPrAction} from '../guards/pr-action.mjs';
import {ReviewFeedback,reviewSurfaceDigest} from '../guards/review-feedback.mjs';
import {scopedReviewRule,reviewWindowAt,isReviewDelivery} from '../guards/review-window.mjs';
import {migrationOperation} from './migration.mjs';
import {recordApprovalPolicy} from './approval-policy.mjs';
import {approvalScope} from '../guards/approval-scope.mjs';

const need=(v,m)=>{if(!v)throw Error(m);},json=p=>JSON.parse(readFileSync(p,'utf8'));
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fileHash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const unwrap=v=>v.structuredContent??(v.content?JSON.parse(v.content.find(c=>c.type==='text').text):v);
function readProof(proof){
  need(proof?.source==='t3code.mcp.t3_thread_read'&&proof.evidence_ref,'Original native T3 proof required');
  const saved=json(proof.evidence_ref),r=saved.response??saved;
  need(!r.isError,'Native read failed');return unwrap(r);
}
function directHuman(proof,thread,project,message){
  const r=readProof(proof),m=r.items?.find(m=>m.messageId===message);
  need(r.thread?.threadId===thread&&r.thread.projectId===project,'Original owner/project required');
  need(m?.type==='user_message'&&m.createdBy==='user'&&['server','web','mobile'].includes(m.creationSource)&&m.visibility==='local'&&Number.isFinite(Date.parse(m.updatedAt))&&
    (!m.sourceThreadId||m.sourceThreadId===thread)&&!m.textTruncated&&m.text?.trim(),'Direct complete human answer required; agent relays are not authority');
  return {thread_id:thread,message_id:message,run_id:m.runId,source_at:m.updatedAt,text:m.text,evidence_ref:proof.evidence_ref,evidence_sha256:fileHash(proof.evidence_ref)};
}
function migratedOwner(l,i){
  const rows=migrationOperation(l,{op:'migration_list'}).filter(r=>r.source_task_id===i.task_id);
  need(rows.length===1,'One exact migration task required');const r=rows[0],owner=r.destination?.threadId;
  need(r.source_host==='local'&&r.destination?.projectId===l.config.project_id&&!r.control_role&&
    r.resumption?.thread_id===owner&&r.resumption.action==='handoff_then_resume_original_scope'&&
    l.config.migration.resumption?.target_thread_ids?.includes(owner),'Original migration owner is not allowlisted for execution');
  for(const snapshot of r.snapshots??[])need(fileHash(snapshot.path)===snapshot.sha256,'Original migration snapshot changed');
  const pr=i.pr_url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)$/);
  need(pr,'Exact canonical PR required');
  const exported=r.source_task_context_ref?json(r.source_task_context_ref):null;
  const task=exported?.tasks?.find(t=>t.runtime_task?.task_id===i.task_id)?.runtime_task;
  return {r,owner,task,exported,repository:pr[1],pr_number:Number(pr[2])};
}
function pullRequestProof(proof,i){
  need(proof?.evidence_ref,'Original GitHub PR/head proof required');
  const saved=json(proof.evidence_ref),envelope=saved.response??saved;
  need(!envelope.isError,'GitHub proof returned an error');const pr=unwrap(envelope);
  need((pr.html_url??pr.display_url??pr.url)===i.pr_url&&(pr.head_sha??pr.headRefOid??pr.head?.sha)===i.head_sha&&
    Number(pr.number)===Number(i.pr_url.split('/').at(-1)),'Actual exact GitHub PR/full head required');
  return {evidence_ref:proof.evidence_ref,evidence_sha256:fileHash(proof.evidence_ref)};
}
function nativeBinding(l,i,o,proof){
  need(proof?.owner_native_proof,'Actual original owner PR association required');
  const r=readProof(proof.owner_native_proof);
  need(r.thread?.threadId===o.owner&&r.thread.projectId===l.config.project_id&&r.thread.runtimeMode==='full-access'&&!r.thread.archived&&
    r.thread.pullRequests?.some(p=>p.url===i.pr_url&&p.repository===o.repository&&p.number===o.pr_number),'Actual original owner/project/native PR association required');
  return {task_id:i.task_id,pr_url:i.pr_url,head_sha:i.head_sha,owner_thread_id:o.owner,
    owner_native_proof:{...proof.owner_native_proof,evidence_sha256:fileHash(proof.owner_native_proof.evidence_ref)},
    pr_native_proof:pullRequestProof(proof.pr_native_proof,i)};
}
function originalTask(l,i){
  const o=migratedOwner(l,i);
  const saved=l.db.prepare('SELECT data FROM native_pr_bindings WHERE task_id=? AND pr_url=? AND head=?').get(i.task_id,i.pr_url,i.head_sha);
  if(saved){
    const b=JSON.parse(saved.data);
    for(const p of [b.owner_native_proof,b.pr_native_proof])need(fileHash(p.evidence_ref)===p.evidence_sha256,'Native PR binding evidence changed');
    need(digest(b)===digest(nativeBinding(l,i,o,b)),'Native PR binding changed');
    return {...o,binding:b,task:{...o.task,contract:{...o.task?.contract,pull_requests:[{repository:o.repository,pr_number:o.pr_number}]}}};
  }
  // Existing v1 evidence remains readable. New native bindings never require
  // enrollment, an accepted runtime row or a frozen contract's PR array.
  need(o.task?.owner_id===o.r.source_thread_id&&o.exported?.catalog?.some(t=>t.id===i.task_id&&t.state==='accepted')&&
    o.task.contract.pull_requests?.some(p=>p.repository===o.repository&&p.pr_number===o.pr_number),'Accepted original task and bound PR required; supply native binding proof instead of legacy enrollment');
  return o;
}
function permission(source,input,approvalPolicy){
  const answer=source.text.trim().split('\n').at(-1).replace(/（推荐）$|\(Recommended\)$/,'').trim();
  if(approvalPolicy&&input.approval_categories){
    const names={'breaking-change':'breaking_change','format-change':'format_change','Enterprise 用户负面影响':'enterprise_negative_impact','发送 Slack 消息':'slack_message'};
    const tokens=/^允许\s*(.+?)[。.]?$/.exec(answer)?.[1].split('、');
    need(tokens?.length&&tokens.every(t=>names[t])&&new Set(tokens).size===tokens.length,'Actual explicit approval categories required');
    const categories=tokens.map(t=>names[t]).sort();
    need(Array.isArray(input.approval_categories)&&JSON.stringify([...input.approval_categories].sort())===JSON.stringify(categories),'Requested categories must equal actual human permission');
    const urls=[...new Set(source.text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*/g)??[])];
    const heads=[...new Set([...source.text.matchAll(/\bhead\s*(?:(?:为|是|:|=)\s*)?`?([a-f0-9]{7,40})(?![a-f0-9])/gi)].map(m=>m[1]))];
    need(urls.length===1&&urls[0]===input.pr_url&&heads.length===1&&input.head_sha.startsWith(heads[0])&&(heads[0].length===40||input.binding_proof),'One exact authorized PR/head required');
    return {decision:'allow_explicit_categories',reviewed_personally:false,external_review:categories.includes('slack_message'),conditional_merge:categories.some(k=>k!=='slack_message'),approved_categories:categories,mentioned_head:heads[0]};
  }
  const reviewed=/^(?:我已(?:经)?(?:亲自)?|已(?:经)?亲自)(?:审阅|看过|看完|检查)(?:完毕)?[，,；;。\s]+/.exec(answer);
  need(reviewed,'Explicit personal inspection answer required');
  const action=answer.slice(reviewed[0].length);
  need(/^(?:允许|同意)(?:按原门禁)?(?:外部)?送审/.test(action),'Actual affirmative external-review answer required');
  need(/^(?:允许|同意)(?:按原门禁)?(?:外部)?送审(?:(?:及|和|与)(?:(?:条件)?合并|满足(?:原有|既有|全部)?条件后合并)|[，,；;]\s*(?:不允许|禁止|不含)合并)?[。.]?$/.test(action),'Ambiguous or negative answer is not permission');
  const merge=/(?:及|和|与)(?:(?:条件)?合并|满足(?:原有|既有|全部)?条件后合并)/.test(action);
  const decision=merge?'allow_external_review_and_conditional_merge':'allow_external_review';
  need(!input.decision||input.decision===decision,'Requested permission must equal the actual human answer; never infer merge');
  const urls=[...new Set(source.text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*/g)??[])];
  const heads=[...new Set([...source.text.matchAll(/\bhead\s*(?:(?:为|是|:|=)\s*)?`?([a-f0-9]{7,40})(?![a-f0-9])/gi)].map(m=>m[1]))];
  need(urls.length===1&&urls[0]===input.pr_url&&heads.length===1&&input.head_sha.startsWith(heads[0]),'One exact inspected PR/head in the direct answer required');
  need(heads[0].length===40||input.binding_proof,'An abbreviated head requires original native PR/full-head binding proof');
  return {decision,reviewed_personally:true,external_review:true,conditional_merge:merge,mentioned_head:heads[0]};
}
const policies=readPrPolicy;

function grant(l,i){
  const row=l.db.prepare('SELECT data FROM native_pr_authorizations WHERE task_id=? AND pr_url=? AND head=?').get(i.task_id,i.pr_url,i.head_sha);
  const categories=l.db.prepare('SELECT data FROM native_pr_category_authorizations WHERE task_id=? AND pr_url=? AND head=?').all(i.task_id,i.pr_url,i.head_sha);
  if(!row&&!categories.length){
    const policy=policies(l);need(policy.approval,'Record the actual native human authorization first');
    const o=originalTask(l,i);
    return {o,g:{protocol:'t3_standing_scope_v1',task_id:i.task_id,pr_url:i.pr_url,head_sha:i.head_sha,owner_thread_id:o.owner,
      source:policy.approval.source,reviewed_personally:false,external_review:false,conditional_merge:false,supersedes:[]}};
  }
  const o=originalTask(l,i),grants=[...(row?[JSON.parse(row.data)]:[]),...categories.map(r=>JSON.parse(r.data))];
  for(const g of grants)verifyGrant(l,i,g,o);
  if(grants.length===1)return {g:grants[0],o};
  grants.sort((a,b)=>Date.parse(a.source.source_at)-Date.parse(b.source.source_at)||a.source.message_id.localeCompare(b.source.message_id));
  return {o,g:{protocol:'t3_composed_authority_v1',task_id:i.task_id,pr_url:i.pr_url,head_sha:i.head_sha,owner_thread_id:o.owner,
    source:grants.at(-1).source,reviewed_personally:false,external_review:grants.some(g=>g.external_review),conditional_merge:grants.some(g=>g.conditional_merge),
    approved_categories:[...new Set(grants.flatMap(g=>g.approved_categories??[]))].sort(),legacy_grants:grants,supersedes:grants.flatMap(g=>g.supersedes)}};
}
function verifyGrant(l,i,g,o){
  need(g.owner_thread_id===o.owner,'Preserve original owner');
  for(const s of [g.source,g.repair_source,g.maintenance_source].filter(Boolean)){
    need(fileHash(s.evidence_ref)===s.evidence_sha256,'Native authority evidence changed');
    const actual=directHuman({source:'t3code.mcp.t3_thread_read',evidence_ref:s.evidence_ref},s===g.maintenance_source?l.roles.main:o.owner,l.config.project_id,s.message_id);
    need(digest(actual)===digest(s),'Native authority provenance changed');
  }
  if(g.binding){
    need(digest(g.binding)===digest(o.binding),'Authorization and native PR binding differ');
    const parsed=permission(g.source,{...i,binding_proof:g.binding,...(g.approved_categories?{approval_categories:g.approved_categories}:{})},policies(l).approval);
    need(parsed.conditional_merge===g.conditional_merge&&parsed.external_review===g.external_review&&parsed.reviewed_personally===g.reviewed_personally&&
      digest(parsed.approved_categories??[])===digest(g.approved_categories??[]),'Native grant must preserve actual human permission');
  }
}
function actor(l,proof,expected){
  const r=readProof(proof);
  need(process.env.T3CODE_THREAD_ID===expected&&r.thread?.threadId===expected&&r.thread.projectId===l.config.project_id&&
    r.thread.runtimeMode==='full-access'&&!r.thread.archived,'Actual original native caller/project/Full access required');
}
function register(l,i){
  const mapped=migratedOwner(l,i);
  need([l.roles.maintenance,mapped.owner].includes(process.env.T3CODE_THREAD_ID),'Only the designated Maintenance or original owner may record this repair');
  actor(l,i.caller_proof,process.env.T3CODE_THREAD_ID);
  need(/^[a-f0-9]{40}$/.test(i.head_sha??''),'Exact inspected head required');
  const source=directHuman(i.native_proof,mapped.owner,l.config.project_id,i.source_message_id);
  const allowed=permission(source,i,policies(l).approval);
  const binding=i.binding_proof?nativeBinding(l,i,mapped,i.binding_proof):null;
  if(!binding)originalTask(l,i);
  const o=mapped;
  const repair=i.repair_proof?directHuman(i.repair_proof,o.owner,l.config.project_id,i.repair_message_id):null;
  const maintenance=i.maintenance_authority?directHuman(i.maintenance_authority.native_proof,l.roles.main,l.config.project_id,i.maintenance_authority.source_message_id):null;
  // Repair authority records provenance only; product permission always comes
  // from this exact original owner's human answer, not an agent/Main relay.
  const policy=policies(l),supersedes=[];
  for(const id of i.supersedes_hold_message_ids??[]){
    const holds=(policy.p.merge_holds??[]).filter(h=>h.source_message_id===id&&h.task_id===i.task_id&&h.pr_url===i.pr_url);
    need(holds.length===1&&holds[0].task_id===i.task_id&&holds[0].pr_url===i.pr_url&&holds[0].decision==='hold_merge'&&
      !holds[0].head_sha&&holds[0].reason==='Investigate performance regression and establish actual product benefit before renewed delivery decision'&&
      source.text.includes('首查询变慢')&&source.text.includes('总 CPU 增加')&&
      Date.parse(holds[0].verified_at)<Date.parse(source.source_at),'Only the earlier same-PR performance renewal hold may be resolved by this informed answer');
    supersedes.push({message_id:id,hold_digest:digest(holds[0])});
  }
  need(supersedes.length<=1,'No bulk hold changes');
  need(!allowed.approved_categories||binding,'Category approval requires native PR/full-head binding');
  const g={protocol:allowed.approved_categories?'t3_owner_pr_authorization_v3':binding?'t3_owner_pr_authorization_v2':'t3_owner_pr_authorization_v1',task_id:i.task_id,pr_url:i.pr_url,head_sha:i.head_sha,owner_thread_id:o.owner,
    source,...(repair?{repair_source:repair}:{}),...(maintenance?{maintenance_source:maintenance}:{}),
    ...(binding?{binding,head_resolution:{mentioned_head:allowed.mentioned_head,full_head:i.head_sha,pr_evidence_ref:binding.pr_native_proof.evidence_ref}}:{}),
    reviewed_personally:allowed.reviewed_personally,external_review:allowed.external_review,conditional_merge:allowed.conditional_merge,
    ...(allowed.approved_categories?{approved_categories:allowed.approved_categories}:{}),
    release:false,deploy:false,other_channel_holds_waived:false,supersedes};
  const category=!!allowed.approved_categories;
  const prior=category?l.db.prepare('SELECT data FROM native_pr_category_authorizations WHERE task_id=? AND pr_url=? AND head=? AND message_id=?').get(i.task_id,i.pr_url,i.head_sha,source.message_id):
    l.db.prepare('SELECT data FROM native_pr_authorizations WHERE task_id=? AND pr_url=? AND head=?').get(i.task_id,i.pr_url,i.head_sha);
  if(prior){need(prior.data===JSON.stringify(g),'Native authorization is immutable');return {recorded:false,already_recorded:true,authorization:g};}
  if(binding){
    const old=l.db.prepare('SELECT data FROM native_pr_bindings WHERE task_id=? AND pr_url=? AND head=?').get(i.task_id,i.pr_url,i.head_sha);
    if(old)need(old.data===JSON.stringify(binding),'Native PR binding is immutable');
    else l.db.prepare('INSERT INTO native_pr_bindings VALUES (?,?,?,?)').run(i.task_id,i.pr_url,i.head_sha,JSON.stringify(binding));
  }
  if(category)l.db.prepare('INSERT INTO native_pr_category_authorizations VALUES (?,?,?,?,?)').run(i.task_id,i.pr_url,i.head_sha,source.message_id,JSON.stringify(g));
  else l.db.prepare('INSERT INTO native_pr_authorizations VALUES (?,?,?,?)').run(i.task_id,i.pr_url,i.head_sha,JSON.stringify(g));
  return {recorded:true,authorization:g,legacy_policy_changed:false,product_action_performed:false};
}
function overlay(p,g){
  const policy=structuredClone(p);
  policy.merge_holds=(policy.merge_holds??[]).filter(h=>!g.supersedes.some(s=>s.message_id===h.source_message_id&&s.hold_digest===digest(h)));
  const base={task_id:g.task_id,pr_url:g.pr_url,head_sha:g.head_sha,source_thread_id:g.source.thread_id,source_message_id:g.source.message_id,
    evidence_ref:g.source.evidence_ref,record_protocol:g.protocol,reviewed_personally:g.reviewed_personally,nonordinary_change_accepted:true};
  const review={...base,decision:'allow_external_review'},merge={...base,decision:'allow_merge'};
  const grants=[...(g.external_review?[review]:[]),...(g.conditional_merge?[merge]:[])];
  policy.personal_review.authorizations.push(...grants.filter(d=>d.decision==='allow_external_review'));
  policy.merge_authorizations??=[];policy.merge_authorizations.push(...grants.filter(d=>d.decision==='allow_merge'));
  return {policy,nativeAuthorization:d=>grants.some(g=>digest(d)===digest(g))};
}
function previousActions(l,root,kind,pr){
  const relevant=a=>a.kind===kind||['prepared','deferred','claimed','uncertain'].includes(a.state);
  return [...originalActionReceipts(l).filter(a=>{const p=JSON.parse(a.payload);return (p.pr_url??p.message)===pr&&relevant(a);}),
    ...l.db.prepare('SELECT action_key,kind,payload,state,receipt FROM native_pr_actions WHERE pr_url=?').all(pr).filter(relevant)];
}

function evaluate(l,i,now){
  const {g,o}=grant(l,i),p=policies(l),e=i.evidence??{},payload=i.payload??{};
  need(['pr_ready','slack_pr','merge'].includes(i.kind),'Only draft-to-ready, canonical review URL delivery and conditional merge are supported');
  need(payload.expected_head_sha===g.head_sha&&(payload.pr_url??payload.message)===g.pr_url,'Exact authorized PR/head required');
  const {policy,nativeAuthorization}=overlay(p.p,g),reasons=[];
  const approval=p.approval?approvalScope(i.kind,payload,{...e,task_id:i.task_id},p.approval,g,now):null;
  if(approval)reasons.push(...approval.reasons);
  else if(i.kind==='merge'&&g.conditional_merge!==true)reasons.push('native_authorization_external_review_only');
  const rule=scopedReviewRule(p.window,now,{task_id:i.task_id,pull_requests:o.task.contract.pull_requests,payload});
  const evidence={...e,task_id:i.task_id};
  if(e.executor_thread_id!==o.owner)reasons.push('original_native_owner_required');
  if(e.policy_version!==p.version||e.current_policy_version!==p.version)reasons.push('policy_changed_or_unknown');
  if(e.authorization_ref!==g.source.evidence_ref)reasons.push('exact_native_authorization_reference_required');
  reasons.push(...assessPrAction(i.kind,payload,evidence,{now,reviewRule:rule,dependencyPolicy:p.dependency,reviewChannels:policy,bindings:p.b,nativeAuthorization,approvalScope:approval}).reasons);
  const feedback=new ReviewFeedback(l.db,()=>now);
  // Ingest and semantically assess complete actual source surfaces. The same
  // current review surface must feed Gatekeeper and the full-feedback guard.
  if(i.feedback_snapshot){
    need(i.feedback_snapshot.repository===o.repository&&i.feedback_snapshot.pr_number===o.pr_number&&i.feedback_snapshot.head_sha===g.head_sha,'Exact feedback PR/head required');
    feedback.ingest(i.feedback_snapshot);
    feedback.assess({repository:o.repository,pr_number:o.pr_number,head:g.head_sha,decisions:i.feedback_decisions});
  }
  reasons.push(...feedback.gate(o.repository,o.pr_number,g.head_sha).reasons);
  const surface=l.db.prepare('SELECT review_digest FROM feedback_source_versions WHERE repository=? AND pr_number=?').get(o.repository,o.pr_number);
  if(i.kind!=='pr_ready'&&(!surface||surface.review_digest!==reviewSurfaceDigest(e.gatekeeper?.reviews)))reasons.push('Gatekeeper_and_feedback_review_surfaces_differ');
  const previous=previousActions(l,p.root,i.kind,g.pr_url);
  for(const a of previous)if(!['cancelled','failed','not_sent'].includes(a.state))reasons.push(`existing_${a.source??'native'}_action:${a.action_key}:${a.state}`);
  return {allowed:!reasons.length,reasons:[...new Set(reasons)],human_authorization_recognized:true,authorization:g,...(approval?{approval_scope:approval}:{}),
    feedback_status:feedback.status(o.repository,o.pr_number),policy_version:p.version,window:reviewWindowAt(now,rule),previous_actions:previous,
    product_action_performed:false};
}
export function nativePrOperation(l,i,{now=Date.now()}={}){
  l.db.exec(`CREATE TABLE IF NOT EXISTS native_pr_authorizations(task_id TEXT,pr_url TEXT,head TEXT,data TEXT,PRIMARY KEY(task_id,pr_url,head));
    CREATE TABLE IF NOT EXISTS native_pr_category_authorizations(task_id TEXT,pr_url TEXT,head TEXT,message_id TEXT,data TEXT,PRIMARY KEY(task_id,pr_url,head,message_id));
    CREATE TABLE IF NOT EXISTS native_pr_bindings(task_id TEXT,pr_url TEXT,head TEXT,data TEXT,PRIMARY KEY(task_id,pr_url,head));
    CREATE TABLE IF NOT EXISTS native_pr_actions(action_key TEXT PRIMARY KEY,task_id TEXT,pr_url TEXT,kind TEXT,payload TEXT,state TEXT,attempt_id TEXT,valid_until INTEGER,receipt TEXT);
    CREATE TABLE IF NOT EXISTS native_pr_action_events(event_id TEXT PRIMARY KEY,action_key TEXT,data TEXT);`);
  return l.atomic(()=>{
    if(i.op==='approval_policy_record')return recordApprovalPolicy(l,i);
    if(i.op==='pr_binding_record'){
      const o=migratedOwner(l,i);actor(l,i.caller_proof,o.owner);
      const binding=nativeBinding(l,i,o,i.binding_proof);
      const old=l.db.prepare('SELECT data FROM native_pr_bindings WHERE task_id=? AND pr_url=? AND head=?').get(i.task_id,i.pr_url,i.head_sha);
      if(old){need(old.data===JSON.stringify(binding),'Native PR binding is immutable');return {recorded:false,already_recorded:true,binding};}
      l.db.prepare('INSERT INTO native_pr_bindings VALUES (?,?,?,?)').run(i.task_id,i.pr_url,i.head_sha,JSON.stringify(binding));
      return {recorded:true,binding,permission_granted:false,product_action_performed:false};
    }
    if(i.op==='pr_authorization_record')return register(l,i);
    if(i.op==='pr_authorization_get'){
      const {g}=grant(l,i);return {authorization:g,policy_version:policies(l).version,actions:l.db.prepare('SELECT * FROM native_pr_actions WHERE task_id=? AND pr_url=?').all(i.task_id,i.pr_url)};
    }
    if(i.op==='pr_action_check')return evaluate(l,i,now);
    if(i.op==='pr_action_claim'){
      const {o}=grant(l,i);actor(l,i.caller_proof,o.owner);
      const result=evaluate(l,i,now);if(!result.allowed)return {send:false,...result};
      need(i.action_key,'Stable action key required');
      const until=Math.min(now+60000,isReviewDelivery(i.kind)?result.window.next_block_at:Infinity,result.window.exception_valid_until??Infinity);
      const attempt=randomUUID();
      l.db.prepare("INSERT INTO native_pr_actions VALUES (?,?,?,?,?,'claimed',?,?,NULL)").run(i.action_key,i.task_id,i.pr_url,i.kind,JSON.stringify(i.payload),attempt,until);
      l.db.prepare('INSERT INTO native_pr_action_events VALUES (?,?,?)').run(randomUUID(),i.action_key,JSON.stringify({event:'claimed',attempt_id:attempt,checked_at:now,input:i}));
      return {send:true,action_key:i.action_key,attempt_id:attempt,valid_until:until,kind:i.kind,payload:i.payload,
        owner_thread_id:o.owner,next:'Original owner invokes this exact external action once immediately before valid_until. Save the exact receipt. Any unknown result blocks retries; no automatic retry.'};
    }
    need(['pr_action_settle','pr_action_reconcile'].includes(i.op),'Unknown native PR operation');
    const row=l.db.prepare('SELECT * FROM native_pr_actions WHERE action_key=?').get(i.action_key);need(row&&row.attempt_id===i.attempt_id,'Exact existing action attempt required');
    const o=originalTask(l,{task_id:row.task_id,pr_url:row.pr_url,head_sha:JSON.parse(row.payload).expected_head_sha});actor(l,i.caller_proof,o.owner);
    need((i.op==='pr_action_settle'&&row.state==='claimed'||i.op==='pr_action_reconcile'&&['claimed','uncertain'].includes(row.state))&&
      ['sent','uncertain'].includes(i.outcome)&&i.receipt_ref,'Exact receipt and unresolved owned attempt required; unsupported non-delivery assertions cannot unlock a retry');
    const proof=json(i.receipt_ref);let verification;
    if(i.outcome==='sent'){
      const envelope=proof.response??proof;
      need(!envelope.isError,'Error is not a sent receipt');const r=unwrap(envelope);
      const payload=JSON.parse(row.payload);
      if(row.kind==='slack_pr'){
        const rawMatches=r.ok===true&&r.channel===payload.channel_id&&r.ts&&r.message?.text===payload.message;
        if(rawMatches){/* Preserve the existing exact raw-receipt protocol. */}
        else if(r.message_context||r.message_link){
          need(i.slack_readback?.evidence_ref!==i.receipt_ref,'Independent Slack receipt/readback files required');
          verification=verifyNormalizedSlackReceipt(r,payload,i.slack_readback,l.config.sources?.slack?.account?.user_id);
        }else need(false,'Exact channel/message/ts native Slack receipt required');
      }
      else if(row.kind==='pr_ready')need((r.html_url??r.display_url??r.url)===row.pr_url&&(r.head_sha??r.headRefOid??r.head?.sha)===payload.expected_head_sha&&
        (r.draft??r.isDraft)===false&&['open','OPEN'].includes(r.state),'Exact current-head non-draft PR readback required');
      else need(r.merged===true&&r.sha&&proof.expected_head_sha===payload.expected_head_sha&&proof.pr_url===row.pr_url,'Exact expected-head merge receipt required');
    }
    const receipt={outcome:i.outcome,evidence_ref:i.receipt_ref,sha256:fileHash(i.receipt_ref),native_result:proof,...(verification?{verification}:{})};
    l.db.prepare('UPDATE native_pr_actions SET state=?,receipt=? WHERE action_key=?').run(i.outcome,JSON.stringify(receipt),row.action_key);
    l.db.prepare('INSERT INTO native_pr_action_events VALUES (?,?,?)').run(randomUUID(),row.action_key,JSON.stringify({event:i.op,attempt_id:row.attempt_id,receipt}));
    return {state:i.outcome,retry_allowed:false,...(verification?{verification}:{})};
  });
}
