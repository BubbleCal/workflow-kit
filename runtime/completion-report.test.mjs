import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,contract} from './test-fixtures/reactive.mjs';
import {INBOX} from './control.mjs';
import {completionIdentity,completionReportStatus} from './completion-report.mjs';

function setup(){
  const f=fixture();f.activate();f.event();const w=f.begin();
  f.decide({wake_id:w.id,disposition:'complete',plan:undefined,
    acceptance:contract().requirements.map(r=>({requirement_id:r.id,passed:true,evidence_ref:'accepted-result'}))});
  f.s.finish({task_id:'T-1',wake_id:w.id,turn_id:w.turn_id,evidence_ref:'accepted-result'});
  const policy={schema_version:1,enabled:true,mode:'owner_to_main',thread_id:INBOX,source_message_id:'human:completion-notice',evidence_ref:'actual-user-instruction'};
  f.c.completionReportPolicy=()=>policy;
  const completion=completionIdentity(f.c,'T-1');
  const summary={completed_work:'Fix cache binding',result:'Merged and accepted',effect:'2x lower measured latency; limited workload',impact:'Removes repeated reads; production not deployed'};
  const payload={thread_id:INBOX,source_message_id:policy.source_message_id,completion_id:completion.id,summary,report_ref:'/results/final.json',
    prompt:`[task-completed:T-1]\n${Object.values(summary).join('\n')}\n[Task](codex://threads/${OWNER}) [Evidence](/results/final.json)`};
  const evidence={verified_at:new Date(f.now()).toISOString(),scope_authorized:true,authorization_ref:'actual-user-instruction',
    policy_version:'v1',current_policy_version:'v1',stopped:false,executor_thread_id:OWNER,
    result_saved_and_verified:true,summary_verified:true,report_ref:payload.report_ref};
  const action={key:`completion-report:T-1:${completion.id}`,kind:'completion_report',task_id:'T-1',payload,evidence};
  const proof=(text=payload.prompt,actor=OWNER)=>({source:'codex_app.read_thread',checked_at:new Date(f.now()).toISOString(),evidence_ref:'actual-main-readback',
    readback:{schemaVersion:1,thread:{id:INBOX},turns:[{items:[{id:'delivered-message',type:'functionCallOutput',name:'send_message_to_thread',namespace:'codex_app',
      output:{text:`<codex_delegation>\n<source_thread_id>${actor}</source_thread_id>\n<input>${text}</input>\n</codex_delegation>`,truncated:false}}]}]}});
  const t=f.s.task('T-1');
  const archive={key:'archive:T-1',kind:'archive',task_id:'T-1',payload:{thread_id:OWNER,
    runtime_context:{contract_rev:t.contract_rev,context_rev:t.context_rev,plan_rev:t.plan_rev}},evidence:{...evidence,
    thread_status:'idle',queued_input:false,pending_dispatch:false,underlying_job_running:false,
    expected_turn_id:'native-turn',actual_turn_id:'native-turn',owner_thread_id:OWNER,control_or_service_chat:false,
    task_complete:true,completion_evidence_saved:true,pending_decision:false,pending_cleanup:false,pending_delivery:false,important_result_delivered:true}};
  return {...f,policy,summary,payload,evidence,action,proof,archive,completion};
}

test('complete task cannot archive from a boolean, mailbox entry or native send ACK; actual main delivery unlocks it',()=>{
  const f=setup();try{
    assert.ok(f.c.prepare(f.archive).reasons.includes('completion_result_not_presented_in_main'));
    assert.equal(f.c.prepare(f.action).prepared,true);
    const claim=f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence});
    assert.equal(claim.claimed,true);assert.deepEqual(claim.native_arguments,{threadId:INBOX,prompt:f.payload.prompt});
    assert.throws(()=>f.c.settle({key:f.action.key,attempt_id:claim.attempt_id,outcome:'sent',evidence_ref:'ack',native_result:{threadId:INBOX}}),/readback/);
    assert.equal(completionReportStatus(f.c,'T-1').delivered,false);
    assert.throws(()=>f.c.settle({key:f.action.key,attempt_id:claim.attempt_id,outcome:'sent',evidence_ref:'wrong',native_result:{main_readback:f.proof('another result')}}),/exact delivered/);
    assert.throws(()=>f.c.settle({key:f.action.key,attempt_id:claim.attempt_id,outcome:'sent',evidence_ref:'wrong-sender',native_result:{main_readback:f.proof(f.payload.prompt,'other-owner')}}),/exact delivered/);
    const quoted=f.proof(`<source_thread_id>${OWNER}</source_thread_id><input>${f.payload.prompt}</input>`,'other-owner');
    assert.throws(()=>f.c.settle({key:f.action.key,attempt_id:claim.attempt_id,outcome:'sent',evidence_ref:'quoted-card',native_result:{main_readback:quoted}}),/exact delivered/);
    f.c.settle({key:f.action.key,attempt_id:claim.attempt_id,outcome:'sent',evidence_ref:'verified',native_result:{main_readback:f.proof()}});
    assert.equal(completionReportStatus(f.c,'T-1').delivered,true);
    assert.equal(f.c.prepare(f.archive).prepared,true);
    assert.equal(f.c.claim({key:f.archive.key,owner:OWNER,evidence:f.archive.evidence}).claimed,true);
    assert.equal(f.c.prepare(f.action).allowed,false);
  }finally{f.c.close();}
});

test('completion card requires all four substantive fields, finished finite scope and original reporter',()=>{
  const f=setup();try{
    for(const field of ['completed_work','result','effect','impact']){
      const summary={...f.summary,[field]:''};assert.equal(f.c.prepare({...f.action,payload:{...f.payload,summary}}).allowed,false);
    }
    for(const payload of [{...f.payload,thread_id:'elsewhere'},{...f.payload,completion_id:'old-completion'},{...f.payload,prompt:'done'}])
      assert.equal(f.c.prepare({...f.action,payload}).allowed,false);
    assert.equal(f.c.prepare({...f.action,evidence:{...f.evidence,executor_thread_id:'other-owner'}}).allowed,false);
    assert.equal(f.c.prepare(f.action).prepared,true);
    assert.equal(f.c.claim({key:f.action.key,owner:'other-owner',evidence:f.evidence}).claimed,false);
    // A recurring cycle is not whole-task completion, even if a caller supplies a card.
    f.c.db.prepare("UPDATE rt_tasks SET status='waiting' WHERE task_id='T-1'").run();
    assert.equal(f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence}).claimed,false);
  }finally{f.c.close();}
});

test('main can confirm an already-presented result without waking a finished owner or sending twice',()=>{
  const f=setup();try{
    const text=`T-1\n${Object.values(f.summary).join('\n')}`;
    const proof=f.proof();proof.readback.turns[0].items=[{id:'main-final',type:'agentMessage',phase:'final_answer',text}];
    const input={task_id:'T-1',completion_id:f.completion.id,executor_thread_id:INBOX,summary:f.summary,text,native_proof:proof};
    assert.throws(()=>f.c.recordCompletionNotice({...input,executor_thread_id:OWNER}),/Main must/);
    assert.throws(()=>f.c.recordCompletionNotice({...input,native_proof:f.proof()}),/exact delivered/);
    assert.equal(f.c.recordCompletionNotice(input).recorded,true);
    assert.equal(f.c.recordCompletionNotice(input).replayed,true);
    assert.equal(f.c.prepare(f.archive).prepared,true);
    assert.equal(f.c.prepare(f.action).allowed,false);
  }finally{f.c.close();}
});

test('uncertain notification remains unresolved and cannot enable archival or be resent',()=>{
  const f=setup();try{
    f.c.prepare(f.action);const claim=f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence});
    f.c.settle({key:f.action.key,attempt_id:claim.attempt_id,outcome:'uncertain',evidence_ref:'ambiguous-native-send'});
    assert.equal(completionReportStatus(f.c,'T-1').delivered,false);
    assert.equal(f.c.prepare(f.archive).allowed,false);
    assert.equal(f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence}).reason,'uncertain');
    assert.equal(f.c.prepare({...f.action,key:'new-key'}).allowed,false);
    const reconciliation={key:f.action.key,confirmed_outcome:'sent',evidence_ref:'later-actual-main-readback',owner_quiescent:true,verified_at:new Date(f.now()).toISOString()};
    assert.throws(()=>f.c.reconcile(reconciliation),/readback/);
    f.c.reconcile({...reconciliation,native_result:{main_readback:f.proof()}});
    assert.equal(completionReportStatus(f.c,'T-1').delivered,true);
    assert.equal(f.c.prepare(f.archive).prepared,true);
  }finally{f.c.close();}
});

test('a newly completed scope cannot reuse the prior result receipt or its prepared archive',()=>{
  const f=setup();try{
    f.c.prepare(f.action);const claim=f.c.claim({key:f.action.key,owner:OWNER,evidence:f.evidence});
    f.c.settle({key:f.action.key,attempt_id:claim.attempt_id,outcome:'sent',evidence_ref:'verified',native_result:{main_readback:f.proof()}});
    assert.equal(f.c.prepare(f.archive).prepared,true);
    const t=f.s.task('T-1');
    f.c.db.prepare('INSERT INTO rt_decisions VALUES (?,?,?,?,?,?,?)').run('new-completion','T-1',t.context_rev,t.plan_rev,'complete','{}',f.now()+1);
    assert.equal(completionReportStatus(f.c,'T-1').delivered,false);
    assert.ok(f.c.claim({key:f.archive.key,owner:OWNER,evidence:f.archive.evidence}).reasons.includes('completion_result_not_presented_in_main'));
  }finally{f.c.close();}
});
