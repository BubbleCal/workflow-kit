const terminal=new Set(['completed','failed','interrupted','cancelled','rolled_back']);
export function inspectT3Execution(read,receipt,{thread_id,project_id,provider_instance_id,model,runtime_mode}){
  const t=read?.thread;
  if(receipt.threadId!==thread_id||t?.threadId!==thread_id||t.projectId!==project_id||t.providerInstanceId!==provider_instance_id||t.model!==model||t.runtimeMode!==runtime_mode)
    throw new Error('T3 execution identity, project, provider, model or permissions changed');
  const run=read.recentRuns?.find(r=>r.runId===receipt.runId);
  if(!run)return {state:'unknown',reason:'Exact accepted run absent from this page; paginate/read it, never infer from latestRunId'};
  const input=read.items?.find(i=>i.type==='user_message'&&i.messageId===receipt.messageId&&i.runId===receipt.runId);
  if(!input||input.createdBy!=='agent'||input.creationSource!=='mcp'||input.textTruncated||input.text!==receipt.message)return {state:'unknown',reason:'Exact complete message/run evidence not available on this page'};
  if(run.providerInstanceId!==provider_instance_id||run.model!==model)throw new Error('Accepted T3 run settings changed');
  if(run.startedAt!==null&&!Number.isFinite(Date.parse(run.startedAt))||run.completedAt!==null&&!Number.isFinite(Date.parse(run.completedAt)))throw new Error('Invalid native T3 execution timestamps');
  return {state:run.status,execution_started:run.startedAt!==null,run_terminal:terminal.has(run.status),
    product_complete:false,run_id:run.runId,message_id:receipt.messageId,started_at:run.startedAt,completed_at:run.completedAt,
    pending_request_count:t.pendingRequestCount,reported_executed_model:run.executedModel??null};
}

