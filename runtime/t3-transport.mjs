import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

export const T3_BASELINE=Object.freeze({version:'0.1.9',commit:'24e77473ecf41bc1f7142529c7911c1c1aae1d76'});
const hash=v=>createHash('sha256').update(v).digest('hex');
const required=v=>typeof v==='string'&&!!v.trim();
const terminal=new Set(['completed','failed','cancelled','interrupted','rolled_back']);

// This adapter is intentionally separate from Codex proofs and the live driver.
// Production dispatch must enter through the existing business/ownership gates.
export class T3McpClient {
  constructor({url,token,fetch:request=globalThis.fetch,timeout_ms=15000,allow_writes=false}={}){
    const u=new URL(url);
    if(u.username||u.password||u.search||u.hash||u.pathname!=='/mcp'||
      (u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))))
      throw new Error('Use the authenticated T3 /mcp URL over HTTPS or loopback HTTP');
    if(!required(token)||/[\r\n]/.test(token))throw new Error('An explicitly authorized T3 OAuth access token is required');
    this.url=u.href;this.token=token;this.fetch=request;this.timeout=timeout_ms;this.allowWrites=allow_writes;this.id=0;
  }
  async rpc(method,params,{notification=false}={}){
    const id=notification?undefined:++this.id;
    const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${this.token}`};
    if(this.session)headers['Mcp-Session-Id']=this.session;
    if(this.protocol)headers['MCP-Protocol-Version']=this.protocol;
    const response=await this.fetch(this.url,{method:'POST',headers,redirect:'error',signal:AbortSignal.timeout(this.timeout),body:JSON.stringify({jsonrpc:'2.0',...(id===undefined?{}:{id}),method,params})});
    if(!response.ok)throw new Error(`T3 MCP HTTP ${response.status}; reconcile before retrying a write`);
    const session=response.headers.get('mcp-session-id');if(session)this.session=session;
    if(notification){await response.body?.cancel();return;}
    let result;
    if(response.headers.get('content-type')?.includes('text/event-stream')){
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',bytes=0;
      try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>4*1024*1024)throw new Error('T3 MCP result exceeded 4 MiB');buffer=(buffer+decoder.decode(chunk.value,{stream:true})).replaceAll('\r\n','\n');let i;
        while((i=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,i);buffer=buffer.slice(i+2);const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data)continue;const value=JSON.parse(data);if(value.id===id){result=value;break;}}
        if(result)break;
      }}finally{await reader.cancel();}
    }else{const text=await response.text();if(text.length>4*1024*1024)throw new Error('T3 MCP result exceeded 4 MiB');result=JSON.parse(text);}
    if(result?.id!==id||result.jsonrpc!=='2.0')throw new Error('No matching T3 MCP response');
    if(result.error)throw new Error(`T3 MCP rejected ${method} (${result.error.code})`);
    return result.result;
  }
  async connect(){
    if(this.connected)return;
    if(!this.connection)this.connection=(async()=>{
      const r=await this.rpc('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:'workflow-kit-t3code-preparation',version:'0.1.0'},capabilities:{}});
      if(!['2025-03-26','2025-06-18','2025-11-25'].includes(r.protocolVersion))throw new Error('Unverified MCP protocol version');
      this.protocol=r.protocolVersion;this.serverInfo=r.serverInfo;await this.rpc('notifications/initialized',{}, {notification:true});this.connected=true;
    })();
    try{await this.connection;}catch(error){this.connection=null;throw error;}
  }
  async call(name,args={}){
    const readOnly=['orchestrator_capabilities','t3_thread_list','t3_thread_read','t3_thread_wait'];
    if(!readOnly.includes(name)&&!(this.allowWrites&&name==='t3_thread_send'))throw new Error('T3 adapter is read-only; cutover is not enabled');
    await this.connect();const r=await this.rpc('tools/call',{name,arguments:args});
    if(r?.isError)throw new Error(`T3 tool ${name} rejected the operation; retain its receipt`);
    if(r?.structuredContent)return r.structuredContent;
    for(const c of r?.content??[])if(c.type==='text'){try{return JSON.parse(c.text);}catch{}}
    throw new Error(`No structured result from T3 ${name}`);
  }
}

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

export class T3WakeOutbox {
  constructor(path,{client,now=()=>Date.now()}={}){
    this.db=new DatabaseSync(path);this.client=client;this.now=now;
    this.db.exec('CREATE TABLE IF NOT EXISTS t3_prepared_wakes (wake_key TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,updated_at INTEGER NOT NULL)');
  }
  close(){this.db.close();}
  get(key){const r=this.db.prepare('SELECT * FROM t3_prepared_wakes WHERE wake_key=?').get(key);return r&&{...r,payload:JSON.parse(r.payload),receipt:r.receipt?JSON.parse(r.receipt):null};}
  prepare({instance_id,wake_id,environment_id,caller_id,thread_id,project_id,provider_instance_id,model,runtime_mode,message}){
    const p={instance_id,wake_id,environment_id,caller_id,thread_id,project_id,provider_instance_id,model,runtime_mode,message};
    if(!Object.values(p).every(required)||!['approval-required','auto-accept-edits','auto','full-access'].includes(runtime_mode))throw new Error('Explicit original task identity, caller, target, model and effective permission mode required');
    const key=`${instance_id}:${wake_id}`,id='workflow:'+hash(JSON.stringify([instance_id,wake_id,environment_id,caller_id,thread_id]));
    const previous=this.get(key);if(previous){if(previous.payload&&JSON.stringify(previous.payload)!==JSON.stringify(p))throw new Error('Prepared T3 wake is immutable');return previous;}
    this.db.prepare("INSERT INTO t3_prepared_wakes VALUES (?,?,?,'prepared',NULL,?)").run(key,id,JSON.stringify(p),this.now());return this.get(key);
  }
  async deliver(key){
    let row=this.get(key);if(!row)throw new Error('Prepare this exact wake first');
    if(this.client.allowWrites===false)throw new Error('T3 adapter is read-only; leave this wake prepared');
    if(row.state!=='prepared')return {...row,replayed:true};
    const target=await this.client.call('t3_thread_read',{environmentId:row.payload.environment_id,threadId:row.payload.thread_id,view:'messages',limit:1,runLimit:1});
    const t=target?.thread,p=row.payload;
    if(t?.threadId!==p.thread_id||t.projectId!==p.project_id||t.providerInstanceId!==p.provider_instance_id||t.model!==p.model||t.runtimeMode!==p.runtime_mode)
      throw new Error('T3 target identity or effective settings differ from the prepared mapping');
    if(t.archived||t.snoozed||t.settled||t.pendingRequestCount>0)return {...row,deferred:true,reason:'Target has a native hold, settlement or pending approval; preserve prepared work'};
    if(!this.db.prepare("UPDATE t3_prepared_wakes SET state='sending',updated_at=? WHERE wake_key=? AND state='prepared'").run(this.now(),key).changes)return this.get(key);
    try{
      const p=row.payload,result=await this.client.call('t3_thread_send',{environmentId:p.environment_id,threadId:p.thread_id,message:p.message,mode:'queue',clientRequestId:row.request_id});
      if(result.threadId!==p.thread_id||!required(result.runId)||!required(result.messageId)||!['queued','started'].includes(result.delivery))throw new Error('Invalid or interrupting T3 receipt');
      this.db.prepare("UPDATE t3_prepared_wakes SET state='accepted',receipt=?,updated_at=? WHERE wake_key=?").run(JSON.stringify({...result,message:p.message}),this.now(),key);
    }catch(error){this.db.prepare("UPDATE t3_prepared_wakes SET state='unknown',updated_at=? WHERE wake_key=?").run(this.now(),key);throw error;}
    return this.get(key);
  }
  async observe(key){
    const row=this.get(key);if(!row?.receipt)return {state:row?.state??'missing',execution_verified:false,next:'Reconcile original request before any resend; do not reset the outbox'};
    const p=row.payload,read=await this.client.call('t3_thread_read',{environmentId:p.environment_id,threadId:p.thread_id,view:'messages',limit:100,runLimit:50,maxCharsPerItem:50000});
    const execution=inspectT3Execution(read,row.receipt,p);return {source:'t3code.mcp.t3_thread_read',checked_at:new Date(this.now()).toISOString(),request_id:row.request_id,execution,readback:read};
  }
}
