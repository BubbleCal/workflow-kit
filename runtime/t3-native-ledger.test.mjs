import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {T3NativeLedger,runT3Ledger} from './t3-native-ledger.mjs';
import {t3Main} from './t3-preparation.mjs';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'workflow-t3-native-'));
  writeFileSync(join(root,'t3-workflow.json'),JSON.stringify({backend:'t3-native',project_id:'project',environment_id:'environment',roles:{main:{thread_id:'main'},discovery:{thread_id:'discovery'},maintenance:{thread_id:'maintenance'}},authority:{agent_authored_message_ids:['install-relay']}}));
  const ledger=new T3NativeLedger(root);t.after(()=>{ledger.close();rmSync(root,{recursive:true,force:true});});
  let sequence=0;
  const proof=(thread='main',items=[],extra={})=>{
    const body={thread:{threadId:thread,projectId:'project',createdBy:'agent',creationSource:'mcp',providerInstanceId:'codex',model:'selected-model',runtimeMode:'full-access',...extra},items};
    const evidence_ref=join(root,`native-${++sequence}.json`);
    writeFileSync(evidence_ref,JSON.stringify({call:{tool:'t3_thread_read',args:{environmentId:'environment'}},response:{content:[{type:'text',text:JSON.stringify(body)}],isError:false}}));
    return {source:'t3code.mcp.t3_thread_read',evidence_ref};
  };
  const human=(messageId='human-request',text='Implement the accepted scope',thread='main',extra={})=>proof(thread,[{type:'user_message',messageId,text,createdBy:'user',creationSource:'web',textTruncated:false,...extra}]);
  const request={canonical_key:'repo:accepted-scope',objective:'Implement accepted scope',requirements:['A verified outcome'],workspace:root,project_id:'project',source_message_id:'human-request',verbatim_text:'Implement the accepted scope'};
  const register=()=>ledger.register({...request,native_proof:human()}).task;
  const bind=(id)=>ledger.bind({task_id:id,thread_id:'owner',environment_id:'environment',native_proof:proof('owner')});
  const decision=(id,extra={})=>ledger.decision({task_id:id,case_id:'case',question:'Which approach?',recommendation:'A',options:[{id:'A'},{id:'B'}],scope:'current task only',evidence_refs:['report'],discussion_thread_id:'discussion',independent_steps:['Continue profiling'],...extra});
  const answer=()=>ledger.answer({case_id:'case',expected_revision:1,option_id:'A',source_message_id:'human-choice',verbatim_text:'Choose A',native_proof:human('human-choice','Choose A','discussion')});
  return {root,ledger,proof,human,request,register,bind,decision,answer};
}

test('actual human admission deduplicates and rejects relay, truncated and wrong-source authority',t=>{
  const f=fixture(t),task=f.register();
  assert.equal(f.register().task_id,task.task_id);
  assert.equal(task.task_id,'T3-001');
  for(const native_proof of [f.human('human-request',f.request.verbatim_text,'other'),f.human('human-request',f.request.verbatim_text,'main',{createdBy:'agent',creationSource:'mcp'}),f.human('human-request',f.request.verbatim_text,'main',{textTruncated:true})])
    assert.throws(()=>f.ledger.register({...f.request,native_proof}),/Human source|Actual complete human/);
  assert.throws(()=>f.ledger.register({...f.request,source_message_id:'install-relay',native_proof:f.human('install-relay')}),/Installation relay/);
  assert.throws(()=>f.ledger.register({...f.request,objective:'Broader scope',native_proof:f.human()}),/immutable/);
  assert.throws(()=>f.ledger.register({...f.request,project_id:'other',native_proof:f.human()}),/workflow project/);
});

test('binding preserves one original owner across fresh readback paths and rejects service or wrong project/mode',t=>{
  const f=fixture(t),task=f.register();f.bind(task.task_id);
  assert.equal(f.bind(task.task_id).owner.thread_id,'owner');
  assert.throws(()=>f.ledger.bind({task_id:task.task_id,thread_id:'discovery',environment_id:'environment',native_proof:f.proof('discovery')}),/service role/);
  for(const extra of [{projectId:'other'},{runtimeMode:'approval-required'}])assert.throws(()=>f.ledger.bind({task_id:task.task_id,thread_id:'owner',environment_id:'environment',native_proof:f.proof('owner',[],extra)}),/project proof|Full access/);
});

test('decision result is queued once without interrupting owner; unknown is reconciled by actual exact run',t=>{
  const f=fixture(t),task=f.register();f.bind(task.task_id);f.decision(task.task_id);
  const result=f.answer(),p=result.native.arguments;
  assert.equal(p.mode,'queue');assert.equal(p.threadId,'owner');assert.equal(result.execution_verified,false);
  assert.equal(f.answer().already_answered,true);
  assert.equal(f.ledger.pending().deliveries.length,1);
  const receipt={threadId:'owner',messageId:'accepted-message',runId:'accepted-run',delivery:'started'};
  f.ledger.settle({delivery_key:result.delivery_key,outcome:'unknown',native_result:{failure:'transport closed'}});
  assert.throws(()=>f.ledger.settle({delivery_key:result.delivery_key,outcome:'sent',native_result:receipt}),/receipt required/);
  const native_proof=f.proof('owner',[{type:'user_message',messageId:receipt.messageId,runId:receipt.runId,text:p.message,createdBy:'agent',creationSource:'mcp',textTruncated:false}]);
  const saved=JSON.parse(readFileSync(native_proof.evidence_ref,'utf8')),body=JSON.parse(saved.response.content[0].text);
  body.recentRuns=[{runId:receipt.runId,providerInstanceId:'codex',model:'selected-model',status:'completed',startedAt:'2026-11-12T01:00:00Z',completedAt:'2026-11-12T01:01:00Z'}];
  saved.response.content[0].text=JSON.stringify(body);writeFileSync(native_proof.evidence_ref,JSON.stringify(saved));
  assert.equal(f.ledger.observe({delivery_key:result.delivery_key,receipt,native_proof}).execution_started,true);
  assert.equal(f.ledger.pending().deliveries.length,0);
  assert.equal(f.ledger.task(task.task_id).state,'assigned');
});

test('changed decisions preserve prior answers and deliveries and reject stale answers',t=>{
  const f=fixture(t),task=f.register();f.bind(task.task_id);f.decision(task.task_id);f.answer();
  assert.equal(f.decision(task.task_id).revision,1);
  assert.equal(f.decision(task.task_id,{question:'A different scoped choice?'}).revision,2);
  assert.throws(f.answer,/revision changed/);
  const prior=JSON.parse(f.ledger.db.prepare('SELECT snapshot FROM decision_history WHERE case_id=? AND revision=1').get('case').snapshot);
  assert.equal(JSON.parse(prior.answer).option_id,'A');assert.equal(f.ledger.pending().deliveries.length,1);
});

test('snooze and settle affect attention only and never invent an answer or pause task',t=>{
  const f=fixture(t),task=f.register();f.bind(task.task_id);f.decision(task.task_id);
  const original=f.ledger.task(task.task_id);
  for(const state of ['Snoozed','Settled']){
    const r=f.ledger.attention({case_id:'case',state,until:new Date(Date.now()+3600000).toISOString()});
    assert.equal(r.owner_paused,false);assert.equal(r.human_answer_granted,false);
    assert.deepEqual(f.ledger.task(task.task_id),original);
    assert.equal(f.ledger.pending().decisions.length,1);
  }
  assert.throws(()=>f.ledger.attention({case_id:'case',state:'Snoozed',until:'yesterday'}),/future time/);
});

test('native content-envelope receipt is accepted but wrong target and error envelope are rejected',t=>{
  const f=fixture(t),task=f.register();f.bind(task.task_id);f.decision(task.task_id);const r=f.answer();
  const receipt={threadId:'owner',messageId:'message',runId:'run',delivery:'queued'};
  assert.throws(()=>f.ledger.settle({delivery_key:r.delivery_key,native_result:{...receipt,threadId:'other'}}),/receipt required/);
  assert.throws(()=>f.ledger.settle({delivery_key:r.delivery_key,native_result:{isError:true,structuredContent:receipt}}),/send failed/);
  assert.equal(f.ledger.settle({delivery_key:r.delivery_key,native_result:{content:[{type:'text',text:JSON.stringify(receipt)}]}}).accepted,true);
  assert.equal(f.ledger.settle({delivery_key:r.delivery_key,native_result:receipt}).already_accepted,true);
});

test('public CLI persists native instance data across reopen without starting an execution',async t=>{
  const f=fixture(t);const task=f.register();const file=join(f.root,'operation.json');writeFileSync(file,JSON.stringify({op:'pending'}));let result;
  await t3Main(['ledger','--instance',f.root,'--file',file],{output:v=>result=v});
  assert.equal(result.tasks[0].task_id,task.task_id);assert.deepEqual(result.deliveries,[]);
  assert.equal(runT3Ledger(f.root,{op:'get',task_id:task.task_id}).data.objective,task.data.objective);
});

test('original owner reports preserve real wait and completion evidence without claiming acceptance or replaying stale state',t=>{
  const f=fixture(t),task=f.register();f.bind(task.task_id);
  function report(outcome,extra={}){
    const summary=outcome==='waiting'?'Waiting for a released dependency':'Scoped result verified';
    const native_proof=f.proof('owner',[{type:'assistant_message',messageId:outcome,runId:'run:'+outcome,text:summary,textTruncated:false}]);
    const saved=JSON.parse(readFileSync(native_proof.evidence_ref,'utf8')),body=JSON.parse(saved.response.content[0].text);
    body.recentRuns=[{runId:'run:'+outcome,status:'completed'}];saved.response.content[0].text=JSON.stringify(body);writeFileSync(native_proof.evidence_ref,JSON.stringify(saved));
    return {task_id:task.task_id,expected_version:1,report_key:outcome,message_id:outcome,outcome,summary,evidence_refs:['actual-report'],native_proof,...extra};
  }
  const wait=report('waiting',{wait_condition:'Dependency release'});
  assert.equal(f.ledger.report(wait).task.state,'waiting');
  const done=report('complete');assert.equal(f.ledger.report(done).business_acceptance,false);
  assert.equal(f.ledger.report(report('complete')).recorded,false);
  assert.equal(f.ledger.report(wait).task.state,'reported_complete');
  assert.throws(()=>f.ledger.report({...done,expected_version:2}),/task version/);
  assert.throws(()=>f.ledger.report({...done,summary:'Different result'}),/completed native owner/);
  assert.throws(()=>f.ledger.report({...done,native_proof:f.proof('other')}),/original owner/);
});
