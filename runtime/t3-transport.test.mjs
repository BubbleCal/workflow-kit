import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {T3McpClient,T3WakeOutbox,inspectT3Execution} from './t3-transport.mjs';

const payload={instance_id:'original-instance',wake_id:'runtime:T-1:wake:2',environment_id:'mini',caller_id:'authorized-oauth-client',thread_id:'original-thread',project_id:'project',provider_instance_id:'existing-codex',model:'unchanged-model',runtime_mode:'full-access',message:'Continue the existing scoped task'};
const thread={threadId:payload.thread_id,projectId:payload.project_id,providerInstanceId:payload.provider_instance_id,model:payload.model,runtimeMode:'full-access',activeRunId:null,archived:false,settled:false,snoozed:false,pendingRequestCount:0};
function fake(){
 const calls=[],runs=[],items=[],receipts=new Map();let busy=false,lose=false;
 return {calls,runs,items,thread:{...thread},set busy(v){busy=v;},set lose(v){lose=v;},
  async call(name,args){calls.push({name,args});
   if(name==='t3_thread_read')return {thread:this.thread,recentRuns:runs,items,hasMore:false};
   assert.equal(name,'t3_thread_send');assert.equal(args.mode,'queue');
   let r=receipts.get(args.clientRequestId);if(!r){r={threadId:args.threadId,messageId:'msg-'+receipts.size,runId:'run-'+receipts.size,status:busy?'queued':'starting',delivery:busy?'queued':'started'};receipts.set(args.clientRequestId,r);
    runs.push({runId:r.runId,providerInstanceId:payload.provider_instance_id,model:payload.model,status:r.status,startedAt:null,completedAt:null});items.push({type:'user_message',createdBy:'agent',creationSource:'mcp',messageId:r.messageId,runId:r.runId,text:args.message,textTruncated:false});}
   if(lose)throw new Error('Reply lost after server persisted intent');return r;
  }};
}
test('busy T3 delivery uses server queue and stable identity; restart/replay preserves one message and exact execution proof',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'t3-outbox-')),path=join(dir,'outbox.sqlite'),client=fake();let box=new T3WakeOutbox(path,{client});
 try{
  client.busy=true;const prepared=box.prepare(payload),accepted=await box.deliver(prepared.wake_key);
  assert.equal(accepted.state,'accepted');assert.equal(accepted.receipt.delivery,'queued');assert.equal((await box.observe(prepared.wake_key)).execution.execution_started,false);
  box.close();box=new T3WakeOutbox(path,{client});await box.deliver(prepared.wake_key);assert.equal(client.calls.filter(c=>c.name==='t3_thread_send').length,1);
  client.runs[0].status='running';client.runs[0].startedAt='2026-11-12T07:00:00Z';assert.equal((await box.observe(prepared.wake_key)).execution.execution_started,true);
  client.runs[0].status='completed';client.runs[0].completedAt='2026-11-12T07:01:00Z';const proof=await box.observe(prepared.wake_key);
  assert.equal(proof.execution.run_terminal,true);assert.equal(proof.execution.product_complete,false);
  const next=box.prepare({...payload,wake_id:'runtime:T-1:wake:3'});client.busy=false;await box.deliver(next.wake_key);assert.notEqual(next.request_id,prepared.request_id);assert.equal(client.items.length,2);
  assert.throws(()=>box.prepare({...payload,message:'Changed accepted instruction'}),/immutable/);
  const concurrent=box.prepare({...payload,wake_id:'runtime:T-1:wake:4'});await Promise.all([box.deliver(concurrent.wake_key),box.deliver(concurrent.wake_key)]);assert.equal(client.items.length,3);
 }finally{box.close();rmSync(dir,{recursive:true,force:true});}
});
test('lost reply and process death in sending never generate an automatic second send',async()=>{
 const c=fake(),box=new T3WakeOutbox(':memory:',{client:c});try{
  c.lose=true;const row=box.prepare(payload);await assert.rejects(box.deliver(row.wake_key),/Reply lost/);assert.equal(box.get(row.wake_key).state,'unknown');
  c.lose=false;await box.deliver(row.wake_key);assert.equal(c.items.length,1);assert.equal(c.calls.filter(x=>x.name==='t3_thread_send').length,1);
  const second=box.prepare({...payload,wake_id:'next'});box.db.prepare("UPDATE t3_prepared_wakes SET state='sending' WHERE wake_key=?").run(second.wake_key);await box.deliver(second.wake_key);assert.equal(c.items.length,1);
 }finally{box.close();}
});
test('effective mode, project, provider and model are verified before sending; native holds defer without touching work',async()=>{
 const c=fake(),box=new T3WakeOutbox(':memory:',{client:c});try{
  const row=box.prepare(payload);
  for(const [key,value]of [['projectId','other'],['providerInstanceId','other'],['model','other'],['runtimeMode','approval-required']]){
   c.thread={...thread,[key]:value};await assert.rejects(box.deliver(row.wake_key),/differ/);assert.equal(box.get(row.wake_key).state,'prepared');
  }
  for(const patch of [{snoozed:true},{archived:true},{settled:true},{pendingRequestCount:1}]){c.thread={...thread,...patch};assert.equal((await box.deliver(row.wake_key)).deferred,true);}
  assert.equal(c.items.length,0);
 }finally{box.close();}
});
test('read proof requires the exact accepted run and complete agent-authored MCP message, rather than latest idle/finished status',()=>{
 const receipt={threadId:thread.threadId,messageId:'message',runId:'run',message:payload.message};
 const good={thread,recentRuns:[{runId:'run',model:thread.model,providerInstanceId:thread.providerInstanceId,status:'completed',startedAt:'2026-11-12T07:00:00Z',completedAt:'2026-11-12T07:01:00Z'}],items:[{type:'user_message',createdBy:'agent',creationSource:'mcp',messageId:'message',runId:'run',text:payload.message,textTruncated:false}]};
 assert.equal(inspectT3Execution(good,receipt,payload).product_complete,false);
 for(const patch of [{textTruncated:true},{text:'Changed text'},{createdBy:'user'},{runId:'different'}])assert.equal(inspectT3Execution({...good,items:[{...good.items[0],...patch}]},receipt,payload).state,'unknown');
 assert.equal(inspectT3Execution({...good,recentRuns:[]},receipt,payload).state,'unknown');
 assert.throws(()=>inspectT3Execution({...good,thread:{...thread,projectId:'other'}},receipt,payload),/identity/);
});
test('MCP over loopback validates initialization, token/session headers and SSE response without waiting for stream close',async()=>{
 const requests=[];let open;
 const server=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;const v=JSON.parse(raw);requests.push(v);assert.equal(req.headers.authorization,'Bearer authorized-test-token');
  if(v.method==='notifications/initialized'){res.writeHead(202);res.end();return;}
  const result=v.method==='initialize'?{protocolVersion:'2025-06-18',serverInfo:{name:'t3-code',version:'0.1.9'},capabilities:{tools:{}}}:{structuredContent:{features:{threadManagement:true}}};
  if(v.method==='initialize'){res.setHeader('mcp-session-id','test-session');res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:v.id,result}));}
  else{assert.equal(req.headers['mcp-session-id'],'test-session');res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: message\r\ndata: '+JSON.stringify({jsonrpc:'2.0',id:v.id,result})+'\r');res.write('\n\r\n');open=res;}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const client=new T3McpClient({url:`http://127.0.0.1:${server.address().port}/mcp`,token:'authorized-test-token'});
  assert.equal((await client.call('orchestrator_capabilities')).features.threadManagement,true);
  await assert.rejects(client.call('t3_thread_send',{}),/read-only/);assert.equal(requests.length,3);
 }finally{open?.end();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('unsafe endpoints and missing explicit credentials are rejected',()=>{
 for(const url of ['http://10.0.0.1/mcp','https://user:secret@example.com/mcp','https://example.com/mcp?token=secret','https://example.com/other'])assert.throws(()=>new T3McpClient({url,token:'test'}),/HTTPS or loopback/);
 assert.throws(()=>new T3McpClient({url:'https://example.com/mcp'}),/authorized/);
});
