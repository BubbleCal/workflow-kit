import test from 'node:test';
import assert from 'node:assert/strict';
import {workFixture,MAIN} from './test-fixtures/work.mjs';
import {nativeProof,OWNER,QUEUE_ID} from './test-fixtures/reactive.mjs';
import {reconcileCreationWorkspace} from './creation-workspace-repair.mjs';

function setup(){
 const f=workFixture(),t=f.work.create({canonical_key:'product-fix',title:'Fix accepted product',objective:'Repair the Sophon path',workspace:'/product',requirements:[{id:'done',text:'Real product acceptance'}],constraints:['No deployment']}).task;
 f.accept(t.id);const key='owner-create:product-fix',prompt='Confirm setup only';
 const payload={canonical_task_key:t.canonical_key,native:{target:{type:'project',projectId:'project'},prompt}};
 f.c.db.prepare("INSERT INTO actions(action_key,kind,task_id,scope_key,digest,payload,state,receipt,due,created_at,updated_at) VALUES (?,'create_thread',?,'scope','digest',?,'sent',?,0,?,?)").run(key,t.id,JSON.stringify(payload),JSON.stringify({outcome:'sent',native_result:{structuredContent:{threadId:OWNER}}}),f.now(),f.now());
 f.c.db.prepare("INSERT INTO work_owner_requests VALUES (?,?,?,'requested')").run(t.id,key,JSON.stringify({workspace:'/product'}));
 f.c.db.prepare("INSERT INTO thread_setups(creation_key,task_id,placement,host_id,thread_id,state,updated_at) VALUES (?,?,?,'local',?,'complete',?)").run(key,t.id,JSON.stringify({project_id:'project'}),OWNER,f.now());
 const human=nativeProof({thread:MAIN,turn:'human-turn',message:'Repair workflow registration',now:f.now()});human.readback.turns[0].items[0].id='human:repair';
 const input={task_id:t.id,owner_thread_id:OWNER,creation_action_key:key,expected_revision:f.work.get(t.id).revision,source_message_id:'human:repair',source_thread_id:MAIN,source_turn_id:'human-turn',verbatim_text:'Repair workflow registration',actual_human_verified:true,evidence_ref:'human-proof',human_authorization:human,native_proof:nativeProof({message:prompt,status:'completed',now:f.now()}),project_listing:{source:'codex_app.list_projects',checked_at:new Date(f.now()).toISOString(),evidence_ref:'actual-projects',readback:{projects:[{projectId:'project',hostId:'local',path:'/task'}]}}};
 input.native_proof.active_listing={source:'codex_app.list_threads',checked_at:new Date(f.now()).toISOString(),request:{mode:'history',archived:false},readback:{threads:[{id:OWNER,kind:'codex',hostId:'local',projectId:'project',cwd:'/task'}]}};
 return {...f,t,key,input};
}

test('repair launch registration preserves product scope and enables the original guarded bind/start/native begin',()=>{
 const f=setup();try{
  const before=f.work.get(f.t.id),binding={task_id:f.t.id,owner_thread_id:OWNER,native_binding:f.input.native_proof,evidence_ref:'native-proof',creation_action_key:f.key};
  assert.throws(()=>f.work.bindOwner(binding),/identity\/workspace/);
  const result=reconcileCreationWorkspace(f.c,f.input);assert(result.reconciled);assert.equal(result.owner_bound,false);
  const fixed=f.work.get(f.t.id);assert.deepEqual(fixed.data,{...before.data,workspace:'/task',product_workspace:'/product'});assert.deepEqual(fixed.authorization,before.authorization);
  assert(reconcileCreationWorkspace(f.c,f.input).already_reconciled);
  f.work.bindOwner(binding);f.work.start(f.c.reactive,{task_id:f.t.id,queue_compatibility_verified:true});
  const contract=f.c.reactive.task(f.t.id).contract;assert.equal(contract.workspace,'/task');assert.equal(contract.product_workspace,'/product');assert.deepEqual(contract.constraints,before.data.constraints);
  const w=f.c.reactive.reserveQueuedWake(f.t.id).wake,prompt='[workflow-event:'+w.id+'] Execute original scope';
  f.c.db.prepare("UPDATE rt_wakes SET state='queued',queue_id=?,prompt=? WHERE id=?").run(QUEUE_ID,prompt,w.id);
  f.c.reactive.begin({task_id:f.t.id,wake_id:w.id,native_proof:nativeProof({message:prompt,now:f.now()})});assert.equal(f.c.reactive.openWake(f.t.id).state,'running');
  assert.throws(()=>reconcileCreationWorkspace(f.c,f.input),/unbound unstarted/);
 }finally{f.c.close();}
});

test('creation workspace repair rejects wrong project/owner, nonterminal setup, unknown effects, stale CAS and false human proof',()=>{
 const mutations=[f=>{f.input.native_proof.active_listing.readback.threads[0].projectId='foreign';},f=>{f.input.expected_revision++;},f=>{f.input.owner_thread_id='foreign';},f=>{f.input.project_listing.readback.projects[0].path='/foreign';},f=>{f.input.project_listing.readback.projects[0].projectId='foreign';},f=>{f.input.native_proof.readback.turns[0].status='inProgress';},f=>{f.input.human_authorization.readback.turns[0].items[0].id='false';},f=>{f.advance(61000);},f=>{f.c.db.prepare("UPDATE thread_setups SET state='pending'").run();},f=>{f.c.db.prepare("UPDATE actions SET state='uncertain'").run();},f=>{f.input.native_proof.readback.turns[0].items[0].content[0].text='unrelated task';}];
 for(const mutate of mutations){const f=setup();try{mutate(f);assert.throws(()=>reconcileCreationWorkspace(f.c,f.input));assert.equal(f.work.get(f.t.id).data.workspace,'/product');assert.equal(f.work.get(f.t.id).owner_thread_id,null);}finally{f.c.close();}}
});


test('real create_thread relay setup is verified while a later human continuation remains undisturbed',()=>{
 const f=setup();try{
  f.c.db.prepare('UPDATE actions SET owner=? WHERE action_key=?').run(MAIN,f.key);
  const read=f.input.native_proof.readback,setupTurn=read.turns[0];setupTurn.items=[{type:'functionCallOutput',namespace:'codex_app',name:'create_thread',output:{truncated:false,text:`<codex_delegation>\n  <source_thread_id>${MAIN}</source_thread_id>\n  <input>Confirm setup only</input>\n</codex_delegation>`}}];
  read.thread.status.type='active';read.turns.unshift({id:'human-continue',status:'inProgress',items:[{type:'userMessage',content:[{type:'text',text:'Continue'}]}]});
  assert(reconcileCreationWorkspace(f.c,f.input).reconciled);assert.equal(read.turns[0].id,'human-continue');assert.equal(f.work.get(f.t.id).owner_thread_id,null);
 }finally{f.c.close();}
 for(const mutation of[i=>{i.output.truncated=true;},i=>{i.output.text=i.output.text.replace(MAIN,'foreign');}]){
  const f=setup();try{f.c.db.prepare('UPDATE actions SET owner=? WHERE action_key=?').run(MAIN,f.key);const i={type:'functionCallOutput',namespace:'codex_app',name:'create_thread',output:{truncated:false,text:`<codex_delegation>\n  <source_thread_id>${MAIN}</source_thread_id>\n  <input>Confirm setup only</input>\n</codex_delegation>`}};mutation(i);f.input.native_proof.readback.turns[0].items=[i];assert.throws(()=>reconcileCreationWorkspace(f.c,f.input),/completed native creation/);}finally{f.c.close();}
 }
});
