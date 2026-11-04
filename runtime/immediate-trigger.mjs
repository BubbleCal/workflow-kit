const fresh=(at,now)=>Number.isFinite(Date.parse(at))&&Date.parse(at)<=now+5000&&now-Date.parse(at)<=60000;
const idle=(s,id,now)=>s?.thread?.id===id&&!s.error&&fresh(s.checked_at,now)&&s.thread.status?.type==='idle'&&
  !(s.thread.status.activeFlags??[]).length&&['completed','failed','interrupted'].includes(s.latestTurn?.status);

// Native transport stays in the supported app tools. This durable ledger returns
// the exact guarded tool call, and never treats an active turn or timeout as ACK.
export class ImmediateTriggers {
  constructor(db,{now=()=>Date.now(),registry=()=>null}={}) {
    this.db=db;this.now=now;this.registry=registry;
    db.exec(`CREATE TABLE IF NOT EXISTS immediate_human_triggers (
      source_id TEXT PRIMARY KEY, action_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL,
      max_seq INTEGER NOT NULL, covered_seq INTEGER NOT NULL DEFAULT 0, coverage TEXT,
      preflight_turn TEXT, preflight_at TEXT, created_at INTEGER NOT NULL);`);
  }
  admit(mail,proof) {
    const r=this.registry(),rule=r?.queue_transport?.immediate_human_trigger;
    if(rule?.enabled!==true || !r.queue_transport.dispatcher_thread_id || proof?.action_required===false)return null;
    if(mail.lane!=='coordinator'||mail.kind!=='human_command'||proof?.actual_human_message_verified!==true||proof.source_actor_verified!==true)
      throw new Error('Immediate invocation requires admitted authenticated human action');
    const p=typeof mail.payload==='string'?JSON.parse(mail.payload):mail.payload;
    if(this.reactiveOwners?.().has(p.task_id))return null;
    if(!p.source_message_id||p.source_message_id!==proof.source_message_id||!p.authorization_ref||!p.text)
      throw new Error('Immediate invocation must bind its admitted source');
    const data={source_id:p.source_message_id,source_thread_id:p.source_thread_id,task_id:p.task_id,text:p.text,
      authorization_ref:p.authorization_ref,rule_source_id:rule.source_message_id,dispatcher_id:r.queue_transport.dispatcher_thread_id};
    const old=this.db.prepare('SELECT * FROM immediate_human_triggers WHERE source_id=?').get(data.source_id);
    if(old) {
      const before=JSON.parse(old.data);
      if(before.text!==data.text||before.source_thread_id!==data.source_thread_id)throw new Error('Originating human source changed');
      this.db.prepare('UPDATE immediate_human_triggers SET max_seq=MAX(max_seq,?) WHERE source_id=?').run(mail.seq,data.source_id);
    } else this.db.prepare('INSERT INTO immediate_human_triggers(source_id,action_key,data,max_seq,created_at) VALUES (?,?,?,?,?)')
      .run(data.source_id,`human-trigger:${data.source_id}:dispatcher`,JSON.stringify(data),mail.seq,this.now());
    if(mail.state==='acknowledged')this.db.prepare('UPDATE immediate_human_triggers SET covered_seq=MAX(covered_seq,?),coverage=? WHERE source_id=?')
      .run(mail.seq,JSON.stringify({reason:'source_already_consumed',mailbox_key:mail.item_key,seq:mail.seq,completed_at:mail.completed_at}),data.source_id);
    return this.status(data.source_id);
  }
  status(sourceId,control) {
    const rows=sourceId?this.db.prepare('SELECT * FROM immediate_human_triggers WHERE source_id=?').all(sourceId):
      this.db.prepare('SELECT * FROM immediate_human_triggers WHERE covered_seq<max_seq ORDER BY created_at').all();
    return rows.map(r=>({source_message_id:r.source_id,key:r.action_key,covered:r.covered_seq>=r.max_seq,
      coverage:r.coverage?JSON.parse(r.coverage):null,dispatcher_thread_id:JSON.parse(r.data).dispatcher_id,
      ...(control?{transport:control.db.prepare('SELECT state,attempt_id,receipt FROM actions WHERE action_key=?').get(r.action_key)??null}:{}),
      next:'Read a fresh native dispatcher snapshot, then control op=human_trigger_prepare; only its guarded claim may send.'}));
  }
  cover(watermark,proof) {
    if(!Number.isSafeInteger(watermark)||proof?.coordinator_snapshot_verified!==true) return {covered:[],pending:this.status()};
    const rows=this.db.prepare('SELECT source_id FROM immediate_human_triggers WHERE max_seq<=? AND covered_seq<max_seq').all(watermark);
    for(const r of rows)this.db.prepare('UPDATE immediate_human_triggers SET covered_seq=max_seq,coverage=? WHERE source_id=?')
      .run(JSON.stringify({...proof,mailbox_watermark:watermark,at:new Date(this.now()).toISOString()}),r.source_id);
    return {covered:rows.map(r=>r.source_id),pending:this.status(),meaning:'Dispatcher processing opportunity, not engineering start or completion'};
  }
  invocation(sourceId,snapshot,control,claim=false) {
    const row=this.db.prepare('SELECT * FROM immediate_human_triggers WHERE source_id=?').get(sourceId);
    if(!row)return {send:false,reason:'no_admitted_human_intent'};
    const d=JSON.parse(row.data),r=this.registry(),rule=r?.queue_transport?.immediate_human_trigger;
    if(rule?.enabled!==true||rule.source_message_id!==d.rule_source_id||r.queue_transport.dispatcher_thread_id!==d.dispatcher_id)
      return {send:false,reason:'trigger_binding_or_rule_changed'};
    const old=control.db.prepare('SELECT * FROM actions WHERE action_key=?').get(row.action_key);
    if(old) {
      const p=JSON.parse(old.payload);
      if(old.kind!=='human_input'||p.thread_id!==d.dispatcher_id||p.intent!=='invoke_dispatcher'||p.source_message_id!==d.source_id||p.trigger_action_key!==row.action_key)
        return {send:false,reason:'existing_service_action_identity_mismatch'};
    }
    if(old && ['claimed','uncertain'].includes(old.state))return {send:false,reason:'reconcile_uncertain_native_invocation',key:row.action_key,transport_state:old.state};
    if(this.reactiveOwners?.().has(d.task_id))return {send:false,reason:'reactive_runtime_owns_task',key:row.action_key};
    if(old?.state==='sent')return {send:false,reason:'already_invoked',key:row.action_key,receipt:JSON.parse(old.receipt??'{}')};
    if(old&&!['prepared','deferred'].includes(old.state))return {send:false,reason:'preserve_existing_invocation_state',transport_state:old.state};
    if(row.covered_seq>=row.max_seq)return {send:false,reason:'already_observed',coverage:JSON.parse(row.coverage??'{}')};
    if(this.nativeControlRuntime?.())return {send:false,reason:'native_queue_control_runtime',key:row.action_key,next:'The existing programmatic runtime will admit this durable input; do not invoke a second dispatcher.'};
    if(!idle(snapshot,d.dispatcher_id,this.now()))return {send:false,coalesced:true,reason:'preserve_busy_or_unknown_dispatcher',
      next_native:{tool:'wait_threads',arguments:{targets:[{threadId:d.dispatcher_id,hostId:'local',...(snapshot?.cursor?{afterCursor:snapshot.cursor}:{})}],timeoutMs:15000}},
      next:'After the existing short turn ends, recheck human_trigger_status. If still uncovered, immediately prepare/claim once; never inject into an active turn.'};
    if(claim && (!fresh(row.preflight_at,this.now())||row.preflight_turn!==snapshot.latestTurn.id))
      return {send:false,reason:'fresh_matching_second_snapshot_required'};
    const payload=old?JSON.parse(old.payload):{thread_id:d.dispatcher_id,host_id:'local',intent:'invoke_dispatcher',
      source_message_id:d.source_id,trigger_action_key:row.action_key,verbatim_text:d.text,
      prompt:`[workflow-human-trigger:${d.source_id}]\nAn authenticated user action is durably queued. Execute one existing short dispatcher round now. Read QUEUE_PROTOCOL.md and follow its normal watchdog_targets, fresh native snapshots, mailbox plan and guarded lane-delivery sequence. Preserve active controls/jobs and all uncertain receipts. A plan receipt records the covered human-input watermark; if its immediate_triggers.pending is nonempty, make one bounded fresh plan before ending. No engineering work, new timer, model/effort/permission change, acknowledgements or routine user report.`};
    if(payload.thread_id!==d.dispatcher_id||payload.intent!=='invoke_dispatcher'||payload.source_message_id!==d.source_id||payload.trigger_action_key!==row.action_key)
      return {send:false,reason:'existing_service_action_identity_mismatch'};
    const evidence={verified_at:snapshot.checked_at,scope_authorized:true,authorization_ref:d.authorization_ref,
      policy_version:`human-trigger:${d.rule_source_id}`,current_policy_version:`human-trigger:${d.rule_source_id}`,stopped:false,
      trigger_rule_source_id:d.rule_source_id,service_invocation_authorized:true,actual_human_message_verified:true,source_actor_verified:true,
      source_message_id:d.source_id,source_text:payload.verbatim_text,input_already_delivered:false,owner_matches:true,
      owner_thread_id:d.dispatcher_id,thread_status:'idle',queued_input:false,pending_dispatch:false,underlying_job_running:false};
    if(!claim) {
      const prepared=control.prepare({key:row.action_key,kind:'human_input',task_id:d.task_id,payload,evidence});
      if(prepared.allowed===false)return {send:false,...prepared};
      this.db.prepare('UPDATE immediate_human_triggers SET preflight_turn=?,preflight_at=? WHERE source_id=?')
        .run(snapshot.latestTurn.id,snapshot.checked_at,sourceId);
      return {send:false,prepared:true,key:row.action_key,next:'Immediately repeat the native idle snapshot, then control op=human_trigger_claim with the same source_message_id.'};
    }
    const result=control.claim({key:row.action_key,owner:'human-trigger-producer',evidence});
    if(!result.claimed)return {send:false,...result};
    return {send:true,key:row.action_key,attempt_id:result.attempt_id,owner:'human-trigger-producer',
      native_tool:'send_message_to_thread',native_arguments:{threadId:d.dispatcher_id,hostId:'local',prompt:result.payload.prompt},
      settle:'Record control op=settle immediately with this key/attempt, outcome and exact tool receipt. Ambiguous send is uncertain, never not_sent without evidence.'};
  }
  coverQueued(snapshot) {
    for(const item of snapshot.items.filter(i=>i.kind==='human_command')){
      const source=item.payload.source_message_id;
      this.db.prepare('UPDATE immediate_human_triggers SET covered_seq=MAX(covered_seq,?),coverage=? WHERE source_id=?')
        .run(item.seq,JSON.stringify({reason:'native_queue_batch_admission',batch_id:snapshot.id,sequence:item.seq,execution_verified:false}),source??'');
    }
  }
}
