import {ControlStore} from '../control.mjs';
import {messageDigest} from '../native-queue.mjs';

export const NOW=Date.parse('2026-11-04T06:00:00Z');
export const OWNER='11111111-1111-4111-8111-111111111111';
export const QUEUE_ID='22222222-2222-4222-8222-222222222222';
export const contract=(workspace='/task')=>({objective:'Reduce query latency without changing results',authorization_ref:'human:original',
  project_id:'project',workspace,canonical_key:'query-work',constraints:['Preserve query semantics'],job_sources:['native'],
  requirements:[{id:'correct',text:'Preserve results'},{id:'latency',text:'Meet the agreed latency target'}]});
export const plan=action=>({steps:[{id:action,action,requirement_ids:['correct','latency'],depends_on:[]}],
  assumptions:[{id:'bottleneck',claim:action,status:'supported',evidence_refs:['profile']}]});
export const nativeProof=({thread=OWNER,workspace='/task',message='',turn='native-turn',status='inProgress',now=NOW}={})=>({
  source:'codex_app.read_thread',checked_at:new Date(now).toISOString(),evidence_ref:`native:${turn}`,
  readback:{schemaVersion:1,thread:{id:thread,kind:'codex',hostId:'local',cwd:workspace,status:{type:status==='inProgress'?'active':'idle'}},
    turns:[{id:turn,status,error:null,startedAt:now/1000,completedAt:status==='completed'?now/1000:null,
      items:message?[{type:'userMessage',content:[{type:'text',text:message}]}]:[]}]}});
export const receipt=(thread,message,now=NOW)=>({queued:true,queue_id:QUEUE_ID,thread_id:thread,message_digest:messageDigest(message),submitted_at:now,accepted_at:now,execution_verified:false});
export function fixture(path=':memory:',workspace='/task') {
  let time=NOW;const c=new ControlStore(path,{now:()=>time,taskRegistry:()=>null}),s=c.reactive;
  s.adopt({task_id:'T-1',owner_thread_id:OWNER,contract:contract(workspace),source_message_id:'human:migrate',actual_human_verified:true});
  const binding=()=>nativeProof({workspace,status:'completed',now:time});
  const event=(key='e1',payload={review:'pending'},patch={})=>s.ingest({event_id:key,task_id:'T-1',source:'github',subject:'repo#1',type:'pr_changed',
    observed_at:time,payload,evidence_ref:`source:${key}`,debounce_ms:0,...patch});
  const decide=(patch={})=>s.decide({task_id:'T-1',owner_thread_id:OWNER,expected_context_rev:s.task('T-1').context_rev,expected_plan_rev:s.task('T-1').plan_rev,
    disposition:'revise',reason:'Observed profile changes the next step',evidence_refs:['profile'],plan:plan('cache'),...patch});
  const mode=mode=>s.setMode({task_id:'T-1',mode,source_message_id:`human:${mode}`,actual_human_verified:true,native_binding:binding(),queue_compatibility_verified:true,legacy_quiescent:true});
  const begin=()=>{
    const w=s.reserveQueuedWake('T-1').wake,message=`[workflow-event:${w.id}] fixture event`;
    c.db.prepare("UPDATE rt_wakes SET prompt=?,state='queued',queue_id=? WHERE id=?").run(message,QUEUE_ID,w.id);
    s.begin({task_id:'T-1',wake_id:w.id,native_proof:nativeProof({workspace,message,now:time})});return s.openWake('T-1');
  };
  return {c,s,event,decide,binding,mode,activate:()=>mode('active'),begin,advance:n=>{time+=n;},now:()=>time,workspace};
}

export function compatibilityFixture({version='codex-cli fixture',host='fixture-host'}={}) {
  const idleMessage='QUEUE_IDLE_UNIQUE',busyMessage='QUEUE_BUSY_UNIQUE';
  const finished=(id,message,reply,start,end)=>({id,status:'completed',error:null,startedAt:start,completedAt:end,durationMs:(end-start)*1000,
    items:[{type:'userMessage',content:[{type:'text',text:message}]},{type:'agentMessage',phase:'final_answer',text:reply}]});
  const readback=turns=>({schemaVersion:1,thread:{id:OWNER,kind:'codex',hostId:'local',cwd:'/task',status:{type:'idle'}},turns});
  const base=NOW/1000;
  return {schema_version:1,source:'codex_app.read_thread',cli_version:version,host_fingerprint:host,checked_at:new Date(NOW+60000).toISOString(),cases:[
    {name:'idle',receipt:receipt(OWNER,idleMessage,NOW),message:idleMessage,expected_reply:'IDLE_OK',
      before:{thread:{id:OWNER,status:{type:'idle'}},latestTurn:{id:'previous',status:'completed'}},readback:readback([finished('idle-consumed',idleMessage,'IDLE_OK',base+1,base+2)])},
    {name:'busy',receipt:{...receipt(OWNER,busyMessage,NOW+10000),queue_id:'33333333-3333-4333-8333-333333333333'},message:busyMessage,expected_reply:'BUSY_OK',busy_expected_reply:'ORIGINAL_DONE',minimum_busy_ms:30000,
      before:{thread:{id:OWNER,status:{type:'active'}},latestTurn:{id:'original-busy',status:'inProgress'}},
      readback:readback([finished('busy-consumed',busyMessage,'BUSY_OK',base+31,base+32),finished('original-busy','ORIGINAL','ORIGINAL_DONE',base,base+30)])}
  ]};
}
