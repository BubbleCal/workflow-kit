import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';

export const approvalPolicyText='感觉现在权限审核太严了, 导致对话很高频的问我一些没意义的问题\n只有以下情况需要向我询问授权:\n1. breaking-change, format-change\n2. 可能会对 enterprise 用户带来负面影响的改动 (暂时性能降级, 需要重建索引 之类的)\n3. 发送 slack 消息或者 github 评论';
const need=(v,m)=>{if(!v)throw Error(m);};
const hash=b=>createHash('sha256').update(b).digest('hex');
const role=(c,k)=>typeof c.roles[k]==='string'?c.roles[k]:c.roles[k].thread_id;
const unwrap=r=>r.structuredContent??(r.content?JSON.parse(r.content.find(c=>c.type==='text').text):r);
function authority(c,ref,message){
  const bytes=readFileSync(ref),saved=JSON.parse(bytes),envelope=saved.response??saved;
  need(!envelope.isError,'Native approval policy read failed');
  const r=unwrap(envelope),m=r.items?.find(m=>m.messageId===message);
  need(r.thread?.projectId===c.project_id&&[role(c,'main'),role(c,'maintenance')].includes(r.thread.threadId), 'Approval policy must come from this project Main or Maintenance');
  need(m?.createdBy==='user'&&m.type==='user_message'&&['web','server','mobile'].includes(m.creationSource)&&m.visibility==='local'&&!m.textTruncated&&
    (!m.sourceThreadId||m.sourceThreadId===r.thread.threadId)&&m.text===approvalPolicyText&&Number.isFinite(Date.parse(m.updatedAt)),
    'Actual complete direct human three-category approval instruction required');
  return {thread_id:r.thread.threadId,message_id:m.messageId,source_at:m.updatedAt,verbatim_text:m.text,evidence_ref:ref,evidence_sha256:hash(bytes)};
}
export function readApprovalPolicy(l){
  const ref=l.config.approval_policy;if(!ref)return null;
  const path=resolve(l.root,ref.path);need(!relative(l.root,path).startsWith('..'),'Approval policy must stay in this instance');
  const bytes=readFileSync(path);need(hash(bytes)===ref.sha256,'Approval policy changed; reconcile explicitly');
  const p=JSON.parse(bytes);need(p.protocol==='t3_three_category_approval_v1'&&p.project_id===l.config.project_id,'Invalid native approval policy/project');
  need(JSON.stringify(authority(l.config,p.source.evidence_ref,p.source.message_id))===JSON.stringify(p.source),'Approval policy human provenance changed');
  return p;
}
export function recordApprovalPolicy(l,i){
  need(process.env.T3CODE_THREAD_ID===role(l.config,'maintenance'),'Only actual Maintenance records shared approval policy');
  need(i.native_proof?.source==='t3code.mcp.t3_thread_read','Actual native policy proof required');
  const source=authority(l.config,i.native_proof.evidence_ref,i.source_message_id);
  const p={protocol:'t3_three_category_approval_v1',project_id:l.config.project_id,source};
  if(l.config.approval_policy){need(JSON.stringify(readApprovalPolicy(l))===JSON.stringify(p),'Do not overwrite another approval policy');return {recorded:false,already_recorded:true,policy:p};}
  const bytes=JSON.stringify(p,null,2)+'\n',sha256=hash(bytes),path=`policies/approval-scope-${sha256.slice(0,16)}.json`;
  mkdirSync(join(l.root,'policies'),{recursive:true});writeFileSync(join(l.root,path),bytes,{flag:'wx',mode:0o600});
  const configPath=join(l.root,'t3-workflow.json'),fresh=JSON.parse(readFileSync(configPath));
  need(!fresh.approval_policy,'Approval policy config changed concurrently');
  const c={...fresh,approval_policy:{path,sha256}};writeFileSync(configPath+'.approval.tmp',JSON.stringify(c,null,2)+'\n',{mode:0o600});renameSync(configPath+'.approval.tmp',configPath);l.config=c;
  return {recorded:true,policy:p,policy_ref:c.approval_policy,product_action_performed:false};
}
