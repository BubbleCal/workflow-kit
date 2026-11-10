import {hasNewHumanInput} from './owner-continuation.mjs';
import {nativeReadback} from './native-queue.mjs';

export function classifyOwnerHealth(task,wake,snapshot) {
  const status=snapshot.thread?.status?.type,turn=snapshot.latestTurn;
  if(task.status==='complete')return 'complete';
  if(task.mode!=='active'||task.contract?.retired)return 'protected';
  if(status==='awaiting_input'||(snapshot.thread?.status?.activeFlags??[]).length)return 'awaiting_native_input';
  if(status==='active'&&turn?.status==='inProgress')return wake?.state==='running'&&wake.turn_id===turn.id?'running':'active_unbound';
  if(task.status==='needs_decision'&&!(wake?.state==='running'&&wake.turn_id===turn?.id&&turn?.status==='failed'))return 'protected';
  const error=JSON.stringify(turn?.error??'');
  if(turn?.status==='failed'&&/context_length_exceeded|context.window|ran out of room/i.test(error))return 'context_window_exhausted';
  if(turn?.status==='failed')return 'turn_failed';
  if(wake?.state==='running'&&wake.turn_id===turn?.id&&['completed','interrupted'].includes(turn?.status))return 'unfinished_terminal_turn';
  if(wake?.state==='uncertain')return 'uncertain_delivery';
  if(wake?.state==='queued')return 'queued_unconsumed';
  if(task.status==='ready'&&!wake)return 'continuation_needed';
  return 'waiting';
}

export class OwnerHealth {
  constructor(control,{now=()=>Date.now()}={}) {
    this.control=control;this.db=control.db;this.now=now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS rt_owner_health (
      task_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,state TEXT NOT NULL,turn_id TEXT,
      wake_id TEXT,checked_at INTEGER NOT NULL,next_check_at INTEGER NOT NULL,
      context_failures INTEGER NOT NULL DEFAULT 0,evidence_ref TEXT NOT NULL,snapshot TEXT NOT NULL)`);
  }
  targets({limit=8}={}) {
    if(!Number.isInteger(limit)||limit<1||limit>8)throw new Error('Health sweep limit must be 1..8');
    const tasks=this.control.reactive.tasks().filter(t=>t.mode==='active'&&t.status!=='complete'&&
      (t.status!=='needs_decision'||this.control.reactive.openWake(t.task_id)?.state==='running'||hasNewHumanInput(this.db,t))&&!t.contract.service_lane&&!t.contract.retired&&
      !this.control.reactive.waitPolicy.blocked(t.task_id)&&
      (this.control.reactive.openWake(t.task_id)||t.status==='ready'||hasNewHumanInput(this.db,t)));
    return tasks.map(t=>({task:t,health:this.db.prepare('SELECT * FROM rt_owner_health WHERE task_id=?').get(t.task_id),wake:this.control.reactive.openWake(t.task_id)}))
      .filter(x=>!x.health||x.health.next_check_at<=this.now())
      .sort((a,b)=>Number(!['queued','uncertain'].includes(a.wake?.state))-Number(!['queued','uncertain'].includes(b.wake?.state))||(a.health?.checked_at??0)-(b.health?.checked_at??0)||(a.wake?.created_at??a.task.updated_at)-(b.wake?.created_at??b.task.updated_at))
      .slice(0,limit).map(x=>({task_id:x.task.task_id,thread_id:x.task.owner_id,host_id:'local',wake_id:x.wake?.id??null,
        queue_id:x.wake?.queue_id??null,previous_state:x.health?.state??null,tool:'wait_threads',arguments:{targets:[{threadId:x.task.owner_id,hostId:'local'}],timeoutMs:0}}));
  }
  observe({task_id,native_proof}) {
    const task=this.control.reactive.task(task_id),at=Date.parse(native_proof?.checked_at);
    if(!task||!Number.isFinite(at)||at>this.now()+5000||this.now()-at>60000||!native_proof.evidence_ref)
      throw new Error('Fresh actual native owner observation required');
    let snapshot;
    if(native_proof.source==='codex_app.read_thread') {
      const r=nativeReadback(native_proof.readback);snapshot={thread:r.thread,latestTurn:r.turns?.[0]};
    } else if(native_proof.source==='codex_app.wait_threads') {
      let r=native_proof.readback;
      if(!r?.polls)for(const x of r?.content??[])if(x.type==='text'){try{r=JSON.parse(x.text);break;}catch{}}
      const matches=r?.polls?.filter(p=>p.thread?.id===task.owner_id)??[];
      if(matches.length!==1)throw new Error('One matching native owner snapshot required');
      snapshot=matches[0];
    } else throw new Error('Use native wait_threads or read_thread evidence');
    if(snapshot.thread?.id!==task.owner_id||snapshot.thread.hostId!=='local'||!snapshot.latestTurn?.id)
      throw new Error('Observed owner identity is missing or changed');
    const wake=this.control.reactive.openWake(task_id);let state=classifyOwnerHealth(task,wake,snapshot);
    if(state==='protected'&&task.mode==='active'&&task.status==='needs_decision'&&snapshot.latestTurn.status==='failed'&&hasNewHumanInput(this.db,task))state='unbound_turn_failed';
    const resume=wake?.queue_id&&this.db.prepare('SELECT state FROM actions WHERE action_key IN (?,?) ORDER BY updated_at DESC LIMIT 1').get(`resume-input:${task_id}:${wake.queue_id}`,`resume-execute:${task_id}:${wake.queue_id}`);
    if(state==='queued_unconsumed'&&['uncertain','failed'].includes(resume?.state))state='native_recovery_blocked';
    const prior=this.db.prepare('SELECT * FROM rt_owner_health WHERE task_id=?').get(task_id);
    let failures=prior?.context_failures??0;
    if(state==='context_window_exhausted'&&(prior?.state!==state||prior?.turn_id!==snapshot.latestTurn.id))failures++;
    else if(snapshot.latestTurn.status==='completed'&&!snapshot.latestTurn.error)failures=0;
    const interval=this.control.work?.config?.discovery?.owner_health_interval_ms;
    const next=at+(Number.isSafeInteger(interval)&&interval>=60000?interval:(state==='running'?600000:['queued_unconsumed','active_unbound','uncertain_delivery'].includes(state)?300000:600000));
    this.db.prepare(`INSERT INTO rt_owner_health VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
      owner_id=excluded.owner_id,state=excluded.state,turn_id=excluded.turn_id,wake_id=excluded.wake_id,
      checked_at=excluded.checked_at,next_check_at=excluded.next_check_at,context_failures=excluded.context_failures,
      evidence_ref=excluded.evidence_ref,snapshot=excluded.snapshot`).run(task_id,task.owner_id,state,snapshot.latestTurn.id,wake?.id??null,at,next,failures,native_proof.evidence_ref,JSON.stringify(snapshot));
    const action=state==='context_window_exhausted'?(failures>1?'checkpoint_and_replace_if_authorized':'recover_exact_failed_turn'):
      state==='unbound_turn_failed'?'inspect_and_bind_actual_failed_turn':['turn_failed','unfinished_terminal_turn'].includes(state)?'inspect_and_recover_exact_turn':
      state==='queued_unconsumed'?'reconcile_unconsumed_queue':state==='native_recovery_blocked'?'report_verified_client_blocker':state==='continuation_needed'?'continue_authorized_work':state==='active_unbound'?'reconcile_actual_native_execution':'preserve';
    return {task_id,state,next_action:action,context_failures:failures,next_check_at:next,task_complete:task.status==='complete',
      queue_consumed:wake?.state==='running'&&wake.turn_id===snapshot.latestTurn.id&&!this.db.prepare('SELECT 1 FROM rt_diagnostics WHERE key=?').get(`recovery-execution:${wake.id}`),execution_started:wake?.state==='running'&&wake.turn_id===snapshot.latestTurn.id,original_queue_id:wake?.queue_id??null};
  }
}
