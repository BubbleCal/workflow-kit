import test from 'node:test';
import assert from 'node:assert/strict';
import {queuedResumeReasons,verifyQueuedRecoveryProof} from './queued-resume.mjs';
import {fixture,nativeProof} from './test-fixtures/reactive.mjs';
const now=Date.now(),task={mode:'active',status:'ready',owner_id:'owner',contract:{}},wake={id:'wake',queue_id:'queue',owner_id:'owner',state:'queued',turn_id:null};
const p={thread_id:'owner',existing_wake_id:'wake',existing_queue_id:'queue',native_resume_only:true,source_message_id:'human',verbatim_text:'Resume stalled work'};
const e={actual_human_message_verified:true,source_actor_verified:true,explicit_resume_request_verified:true,source_message_id:'human',source_text:p.verbatim_text,
 thread_archived:false,actual_turn_id:'old',expected_turn_id:'old',native_thread_snapshot:{checked_at:new Date(now).toISOString(),thread:{id:'owner',status:{type:'notLoaded',activeFlags:[]}},latestTurn:{id:'old',status:'completed'}}};
test('explicit background recovery preserves an identified unconsumed queue item',()=>assert.deepEqual(queuedResumeReasons(task,wake,p,e,now),[]));
test('running, consumed, uncertain, held and unrelated owners are never resumed',()=>{
 for(const state of ['running','finished','uncertain'])assert.ok(queuedResumeReasons(task,{...wake,state},p,e,now).length);
 for(const patch of [{mode:'paused'},{status:'complete'},{status:'needs_decision'},{owner_id:'other'}])assert.ok(queuedResumeReasons({...task,...patch},wake,p,e,now).length);
 assert.ok(queuedResumeReasons(task,wake,{...p,existing_queue_id:'other'},e,now).length);
});
test('recovery requires fresh native terminal evidence and actual human authority',()=>{
 for(const patch of [{actual_human_message_verified:false},{thread_archived:true},{actual_turn_id:'new'}])assert.ok(queuedResumeReasons(task,wake,p,{...e,...patch},now).length);
 const active={...e,native_thread_snapshot:{...e.native_thread_snapshot,thread:{id:'owner',status:{type:'active'}}}};
 assert.ok(queuedResumeReasons(task,wake,p,active,now).length);
 assert.ok(queuedResumeReasons(task,wake,p,e,now+61000).length);
});

test('an existing-wake resume cannot change the queued work',()=>{
 const item={...wake,prompt:'original queued work'},input={...p,intent:'resume_existing_wake',prompt:item.prompt};
 assert.deepEqual(queuedResumeReasons(task,item,input,e,now),[]);
 assert.ok(queuedResumeReasons(task,item,{...input,prompt:'different work'},e,now).includes('resume_must_preserve_exact_existing_work'));
});
test('a late duplicate delivery never runs an already claimed or finished wake',()=>{
 const f=fixture();try{f.activate();f.event();const w=f.begin();
 const proof=nativeProof({message:w.prompt,turn:'late-duplicate',now:f.now()});
 assert.equal(f.s.begin({task_id:'T-1',wake_id:w.id,native_proof:proof}).reason,'wake_owned_by_another_turn');
 assert.equal(f.s.openWake('T-1').turn_id,'native-turn');
 f.c.db.prepare("UPDATE rt_wakes SET state='finished' WHERE id=?").run(w.id);
 assert.equal(f.s.begin({task_id:'T-1',wake_id:w.id,native_proof:proof}).reason,'wake_already_terminal');
 assert.equal(f.s.openWake('T-1'),null);
 }finally{f.c.close();}
});


test('a native recovery hint binds the original wake without fabricating queue consumption',()=>{
 const f=fixture();try{f.activate();f.event();const old=f.begin();
 f.c.db.prepare("UPDATE rt_wakes SET state='queued',turn_id=NULL,started_at=NULL WHERE id=?").run(old.id);
 const task=f.s.task('T-1'),wake=f.s.openWake('T-1'),prompt='Resume the existing queued work',sender='maintenance-owner';
 const key=`resume-input:T-1:${wake.queue_id}`,payload={intent:'resume_queued_owner',native_resume_only:true,thread_id:task.owner_id,existing_wake_id:wake.id,existing_queue_id:wake.queue_id,prompt};
 const action={action_key:key,kind:'human_input',state:'sent',task_id:'T-1',owner:sender,created_at:f.now(),payload:JSON.stringify(payload),receipt:JSON.stringify({outcome:'sent',native_result:{isError:false,content:[{type:'text',text:JSON.stringify({threadId:task.owner_id})}]}})};
 const proof=nativeProof({turn:'recovery-turn',now:f.now()});proof.readback.turns[0].items=[{type:'functionCallOutput',namespace:'codex_app',name:'send_message_to_thread',output:{truncated:false,text:`<codex_delegation>\n  <source_thread_id>${sender}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>`}}];
 assert.equal(verifyQueuedRecoveryProof(proof,{task,wake,action,now:f.now()}).original_queue_consumed,false);
 for(const mutate of [p=>p.readback.turns[0].items[0].output.truncated=true,p=>p.readback.turns[0].items[0].output.text+='changed',p=>p.readback.turns[0].startedAt-=10,p=>p.readback.thread.id='another']){
   const bad=structuredClone(proof);mutate(bad);assert.throws(()=>verifyQueuedRecoveryProof(bad,{task,wake,action,now:f.now()}));
 }
 assert.throws(()=>verifyQueuedRecoveryProof(proof,{task,wake,action:{...action,state:'uncertain'},now:f.now()}));
 f.c.db.prepare('INSERT INTO actions(action_key,kind,task_id,scope_key,digest,payload,state,due,created_at,updated_at,owner,receipt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(key,action.kind,'T-1',`thread:${task.owner_id}`,'fixture',action.payload,'sent',f.now(),f.now(),f.now(),sender,action.receipt);
 f.s.begin({task_id:'T-1',wake_id:wake.id,native_proof:proof});
 assert.equal(f.s.openWake('T-1').turn_id,'recovery-turn');assert.equal(f.s.openWake('T-1').queue_id,wake.queue_id);
 const ended=structuredClone(proof);ended.readback.thread.status.type='idle';ended.readback.turns[0].status='completed';
 assert.throws(()=>verifyQueuedRecoveryProof(ended,{task,wake,action,now:f.now()}));
 assert.equal(verifyQueuedRecoveryProof(ended,{task,wake,action,now:f.now(),terminal:true}).status,'completed');
 assert.equal(f.s.begin({task_id:'T-1',wake_id:wake.id,native_proof:nativeProof({message:wake.prompt,turn:'late-queue-turn',now:f.now()})}).reason,'wake_owned_by_another_turn');
 }finally{f.c.close();}
});
