import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {T3NativeLedger} from './t3-native-ledger.mjs';
import {t3Main,STANDARD_ROLES} from '../t3/cli.mjs';

function fixture(t,{roles={},attention={},control_plane}={}){
  const root=mkdtempSync(join(tmpdir(),'workflow-t3-inbox-'));
  const config={backend:'t3-native',project_id:'project',environment_id:'environment',
    roles:{main:{thread_id:'main'},decision_report_inbox:{thread_id:'inbox',pinned:true},maintenance:{thread_id:'maintenance'},...roles},
    authority:{agent_authored_message_ids:['install-relay']},attention,...(control_plane?{control_plane}:{})};
  writeFileSync(join(root,'t3-workflow.json'),JSON.stringify(config));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const open=()=>{const ledger=new T3NativeLedger(root);t.after(()=>ledger.close());return ledger;};
  let sequence=0;
  const proof=(thread='main',items=[])=>{
    const body={thread:{threadId:thread,projectId:'project',createdBy:'agent',creationSource:'mcp',providerInstanceId:'codex',model:'selected-model',runtimeMode:'full-access'},items};
    const evidence_ref=join(root,`native-${++sequence}.json`);
    writeFileSync(evidence_ref,JSON.stringify({call:{tool:'t3_thread_read',args:{environmentId:'environment'}},response:{content:[{type:'text',text:JSON.stringify(body)}],isError:false}}));
    return {source:'t3code.mcp.t3_thread_read',evidence_ref};
  };
  const human=(messageId,text,thread)=>proof(thread,[{type:'user_message',messageId,text,createdBy:'user',creationSource:'web',textTruncated:false}]);
  const setup=ledger=>{
    const task=ledger.register({canonical_key:'repo:scope',objective:'Implement accepted scope',requirements:['A verified outcome'],workspace:root,project_id:'project',
      source_message_id:'human-request',verbatim_text:'Implement the accepted scope',native_proof:human('human-request','Implement the accepted scope','main')}).task;
    ledger.bind({task_id:task.task_id,thread_id:'owner',environment_id:'environment',native_proof:proof('owner')});
    return task;
  };
  const decide=(ledger,task,extra={})=>ledger.decision({task_id:task.task_id,case_id:'case',question:'Which approach?',recommendation:'A',options:[{id:'A'},{id:'B'}],evidence_refs:['report'],...extra});
  const answerFrom=(ledger,thread,id='choice')=>ledger.answer({case_id:'case',expected_revision:1,option_id:'A',source_message_id:id,verbatim_text:'1',native_proof:human(id,'1',thread)});
  return {root,config,open,proof,human,setup,decide,answerFrom};
}

test('decision_report_inbox is a standard role',()=>{
  assert.deepEqual(STANDARD_ROLES,['main','decision_report_inbox']);
});

test('a bound inbox becomes the default decision location and forwards the answer to the owner via queue',t=>{
  const f=fixture(t),ledger=f.open(),task=f.setup(ledger);
  assert.equal(ledger.decisionLocation(),'decision_report_inbox');
  assert.throws(()=>f.decide(ledger,task,{discussion_thread_id:'owner'}),/Decision & Report Inbox/);
  const d=f.decide(ledger,task);
  assert.equal(JSON.parse(d.data).discussion_thread_id,'inbox');
  assert.throws(()=>f.answerFrom(ledger,'main'),/different workflow conversation/);
  const result=f.answerFrom(ledger,'inbox');
  assert.equal(result.answered,true);assert.equal(result.execution_verified,false);
  assert.equal(result.native.name,'t3_thread_send');
  assert.equal(result.native.arguments.threadId,'owner');
  assert.equal(result.native.arguments.mode,'queue');
  assert.match(result.native.arguments.message,/Actual human answer: 1/);
  assert.equal(ledger.pending().deliveries.length,1);
  assert.equal(f.answerFrom(ledger,'inbox').already_answered,true);
});

test('an inbox decision needs a bound owner and accepts a direct owner-thread answer without a second turn',t=>{
  const f=fixture(t),ledger=f.open();
  const task=ledger.register({canonical_key:'repo:unbound',objective:'Unbound task',requirements:['Outcome'],workspace:f.root,project_id:'project',
    source_message_id:'req',verbatim_text:'Do it',native_proof:f.human('req','Do it','main')}).task;
  assert.throws(()=>f.decide(ledger,task),/bound original owner/);
  const bound=f.setup(ledger);f.decide(ledger,bound);
  const result=f.answerFrom(ledger,'owner');
  assert.equal(result.delivery,'in_thread');assert.equal(result.native,null);
  assert.deepEqual(ledger.pending().deliveries,[]);
});

test('native control keeps T3 attention while routing through the inbox',t=>{
  const f=fixture(t,{control_plane:{execution:'t3_native',decision_relay:false}}),ledger=f.open(),task=f.setup(ledger);
  f.decide(ledger,task);
  assert.equal(f.answerFrom(ledger,'inbox').native.arguments.threadId,'owner');
  assert.equal(ledger.db.prepare('SELECT attention FROM decisions WHERE case_id=?').get('case').attention,'Native');
});

test('explicit owner_thread keeps the legacy per-owner Ask routing',t=>{
  const f=fixture(t,{attention:{decision_location:'owner_thread'}}),ledger=f.open(),task=f.setup(ledger);
  assert.equal(ledger.decisionLocation(),'owner_thread');
  assert.throws(()=>f.decide(ledger,task,{discussion_thread_id:'inbox'}),/original owner thread/);
  f.decide(ledger,task);
  assert.throws(()=>f.answerFrom(ledger,'inbox'),/different workflow conversation/);
});

test('the inbox cannot be Main, an execution owner, or required without a binding',t=>{
  assert.throws(()=>fixture(t,{roles:{decision_report_inbox:{thread_id:'main'}}}).open(),/separate conversation from Main/);
  const f=fixture(t),ledger=f.open();
  const task=ledger.register({canonical_key:'repo:x',objective:'X',requirements:['Outcome'],workspace:f.root,project_id:'project',
    source_message_id:'req',verbatim_text:'Do it',native_proof:f.human('req','Do it','main')}).task;
  assert.throws(()=>ledger.bind({task_id:task.task_id,thread_id:'inbox',environment_id:'environment',native_proof:f.proof('inbox')}),/service role/);
  const g=fixture(t,{roles:{decision_report_inbox:undefined},attention:{decision_location:'decision_report_inbox'}});
  delete g.config.roles.decision_report_inbox;writeFileSync(join(g.root,'t3-workflow.json'),JSON.stringify(g.config));
  const l2=g.open(),t2=g.setup(l2);
  assert.throws(()=>g.decide(l2,t2),/decision_report_inbox role/);
});

test('t3 status reports missing standard roles and exits 2',async t=>{
  const f=fixture(t);let out;
  await t3Main(['status','--instance',f.root],{output:v=>{out=v;}});
  assert.deepEqual(out.missing_standard_roles,[]);assert.equal(out.decision_location,'decision_report_inbox');
  assert.equal(out.roles.decision_report_inbox,'inbox');
  delete f.config.roles.decision_report_inbox;writeFileSync(join(f.root,'t3-workflow.json'),JSON.stringify(f.config));
  const before=process.exitCode;
  try{
    await t3Main(['status','--instance',f.root],{output:v=>{out=v;}});
    assert.deepEqual(out.missing_standard_roles,['decision_report_inbox']);
    assert.equal(process.exitCode,2);
  }finally{process.exitCode=before;}
});
