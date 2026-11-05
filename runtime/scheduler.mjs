import {randomUUID} from 'node:crypto';
import {canonical} from './reactive-state.mjs';

const required=(v,n)=>{if(typeof v!=='string'||!v.trim())throw new Error(`${n} is required`);};
const pendingWake="state IN ('reserved','claimed','sent','queued','uncertain','running')";
function authority(input){
  if(input.actual_human_verified!==true)throw new Error('An actual user schedule instruction is required');
  for(const key of ['source_message_id','evidence_ref'])required(input[key],key);
  return {source_message_id:input.source_message_id,evidence_ref:input.evidence_ref};
}
export function scheduleTime(value){
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value))throw new Error('start_at needs an ISO timestamp with an explicit UTC offset');
  const [year,month,day,hour,minute,second]=value.slice(0,19).split(/[-T:]/).map(Number);
  if(year<1970||new Date(Date.UTC(year,month-1,day)).toISOString().slice(0,10)!==value.slice(0,10)||hour>23||minute>59||second>59)throw new Error('Invalid calendar timestamp');
  const at=Date.parse(value);if(!Number.isSafeInteger(at)||at<0||at>8000000000000000)throw new Error('Invalid schedule timestamp');return at;
}
export class Scheduler {
  constructor(db,{state,now=()=>Date.now()}={}){
    this.db=db;this.state=state;this.now=now;
    db.exec(`CREATE TABLE IF NOT EXISTS rt_schedules (
      id TEXT PRIMARY KEY,task_id TEXT NOT NULL,owner_id TEXT NOT NULL,kind TEXT NOT NULL,
      timezone TEXT NOT NULL,start_at INTEGER NOT NULL,interval_ms INTEGER,overlap TEXT NOT NULL,
      status TEXT NOT NULL,next_at INTEGER,revision INTEGER NOT NULL,authority TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rt_schedule_runs (
        id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,task_id TEXT NOT NULL,state TEXT NOT NULL,
        first_due_at INTEGER NOT NULL,due_at INTEGER NOT NULL,occurrences INTEGER NOT NULL,
        event_id TEXT UNIQUE,contract_rev INTEGER,owner_id TEXT,wake_id TEXT,admitted_at INTEGER,started_at INTEGER,
        finished_at INTEGER,result TEXT,blocked_reason TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS rt_one_pending_schedule_run ON rt_schedule_runs(schedule_id) WHERE state='pending';
      CREATE UNIQUE INDEX IF NOT EXISTS rt_one_running_schedule_task ON rt_schedule_runs(task_id) WHERE state IN ('admitted','running');
      CREATE TABLE IF NOT EXISTS rt_schedule_changes (
        schedule_id TEXT NOT NULL,revision INTEGER NOT NULL,action TEXT NOT NULL,authority TEXT NOT NULL,at INTEGER NOT NULL,
        PRIMARY KEY(schedule_id,revision));`);
  }
  atomic(fn){return this.state.atomic(fn);}
  get(id){const r=this.db.prepare('SELECT * FROM rt_schedules WHERE id=?').get(id);return r?{...r,authority:JSON.parse(r.authority)}:null;}
  list(){return this.db.prepare('SELECT id FROM rt_schedules ORDER BY created_at,id').all().map(r=>this.get(r.id));}
  runs(id){return this.db.prepare('SELECT * FROM rt_schedule_runs WHERE schedule_id=? ORDER BY first_due_at,id').all(id).map(r=>({...r,result:r.result?JSON.parse(r.result):null}));}
  currentRuns(taskId){return this.db.prepare("SELECT * FROM rt_schedule_runs WHERE task_id=? AND state IN ('admitted','running') ORDER BY first_due_at").all(taskId);}
  create(input){
    const auth=authority(input),{id,task_id,kind,timezone,overlap='coalesce'}=input;
    if(typeof id!=='string'||!/^runtime:[a-zA-Z0-9][\w.-]{0,99}$/.test(id))throw new Error('Use a distinct runtime:<name> schedule ID');
    if(!['once','interval'].includes(kind)||!['coalesce','skip'].includes(overlap))throw new Error('Use once/interval and coalesce/skip');
    required(timezone,'IANA timezone');new Intl.DateTimeFormat('en',{timeZone:timezone});
    const start=scheduleTime(input.start_at),interval=kind==='interval'?input.interval_ms:null;
    if(kind==='interval'&&(!Number.isSafeInteger(interval)||interval<60000||interval>31536000000))throw new Error('Fixed interval must be between one minute and 365 days');
    if(kind==='once'&&input.interval_ms!==undefined)throw new Error('A one-time schedule has no interval');
    return this.atomic(()=>{
      const task=this.state.task(task_id);if(!task||!task.contract.schedule_sources?.includes(id))throw new Error('Bind the schedule ID in the authorized task contract first');
      if(task.contract.schedule_sources.some(s=>!s.startsWith('runtime:')))throw new Error('Reconcile the existing native schedule source before adding a runtime timer to this task');
      this.state.assertQueueOwner(task);
      const definition={task_id,owner_id:task.owner_id,kind,timezone,start_at:start,interval_ms:interval,overlap};
      const old=this.get(id);if(old){
        if(Object.entries(definition).some(([k,v])=>old[k]!==v)||canonical(old.authority)!==canonical(auth))throw new Error('Schedule ID already has a different immutable definition');
        return {created:false,schedule:old};
      }
      this.db.prepare("INSERT INTO rt_schedules VALUES (?,?,?,?,?,?,?,?,'enabled',?,1,?,?)")
        .run(id,task_id,task.owner_id,kind,timezone,start,interval,overlap,start,canonical(auth),this.now());
      this.db.prepare('INSERT INTO rt_schedule_changes VALUES (?,1,?,?,?)').run(id,'create',canonical(auth),this.now());
      return {created:true,schedule:this.get(id)};
    });
  }
  change(input){
    const auth=authority(input),{id,expected_revision,action}=input;
    if(!['pause','resume','cancel'].includes(action))throw new Error('Use pause, resume or cancel');
    return this.atomic(()=>{
      const s=this.get(id);if(!s||s.revision!==expected_revision)throw new Error('Schedule changed; reread its revision');
      if(['cancelled','finished'].includes(s.status))throw new Error('Terminal schedules cannot be resumed; use a new explicit schedule');
      const status={pause:'paused',resume:'enabled',cancel:'cancelled'}[action];
      this.db.prepare('UPDATE rt_schedules SET status=?,revision=revision+1 WHERE id=?').run(status,id);
      this.db.prepare('INSERT INTO rt_schedule_changes VALUES (?,?,?,?,?)').run(id,s.revision+1,action,canonical(auth),this.now());
      if(action==='cancel')this.db.prepare("UPDATE rt_schedule_runs SET state='cancelled',finished_at=?,blocked_reason='schedule_cancelled' WHERE schedule_id=? AND state='pending'").run(this.now(),id);
      return {schedule:this.get(id),accepted_runs_preserved:this.runs(id).filter(r=>['admitted','running'].includes(r.state)).map(r=>r.id)};
    });
  }
  blocked(s){
    const t=this.state.task(s.task_id);if(!t||t.owner_id!==s.owner_id||!t.contract.schedule_sources?.includes(s.id))return 'task_binding_changed';
    if(t.contract.schedule_sources.some(id=>!id.startsWith('runtime:')))return 'native_schedule_source_conflict';
    if(t.mode!=='active')return `task_mode:${t.mode}`;
    try{this.state.assertQueueOwner(t);this.state.assertOwnerCoverage(t.owner_id);}catch(e){return e.message;}
    if(t.status==='needs_decision')return 'human_decision_pending';
    if(this.currentRuns(t.task_id).length)return 'previous_cycle_unfinished';
    if(this.db.prepare(`SELECT 1 FROM rt_wakes WHERE owner_id=? AND ${pendingWake}`).get(t.owner_id))return 'owner_wake_in_flight';
    if(this.db.prepare("SELECT 1 FROM actions a JOIN rt_tasks t ON t.task_id=a.task_id WHERE t.owner_id=? AND a.state IN ('claimed','uncertain')").get(t.owner_id))return 'external_effect_in_flight';
    if(t.dirty)return 'task_has_unhandled_events';
    return null;
  }
  tick(){
    return this.atomic(()=>{
      const now=this.now();let admitted=0;
      for(const s of this.list().filter(s=>s.status==='enabled'&&s.next_at!==null&&s.next_at<=now)){
        const count=s.kind==='interval'?Math.floor((now-s.next_at)/s.interval_ms)+1:1;
        const last=s.next_at+(count-1)*(s.interval_ms??0),next=s.kind==='interval'?last+s.interval_ms:null;
        if(next!==null&&!Number.isSafeInteger(next))throw new Error('Schedule timestamp overflow');
        const blocked=this.blocked(s),skip=s.overlap==='skip'&&blocked!==null;
        const pending=this.db.prepare("SELECT * FROM rt_schedule_runs WHERE schedule_id=? AND state='pending'").get(s.id);
        if(pending&&!skip)this.db.prepare('UPDATE rt_schedule_runs SET due_at=?,occurrences=occurrences+?,blocked_reason=? WHERE id=?').run(last,count,blocked,pending.id);
        else this.db.prepare('INSERT INTO rt_schedule_runs(id,schedule_id,task_id,state,first_due_at,due_at,occurrences,finished_at,blocked_reason) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(randomUUID(),s.id,s.task_id,skip?'skipped':'pending',s.next_at,last,count,skip?now:null,blocked);
        this.db.prepare('UPDATE rt_schedules SET next_at=? WHERE id=?').run(next,s.id);
        if(skip&&s.kind==='once')this.db.prepare("UPDATE rt_schedules SET status='finished' WHERE id=?").run(s.id);
      }
      for(const run of this.db.prepare("SELECT r.* FROM rt_schedule_runs r JOIN rt_schedules s ON s.id=r.schedule_id WHERE r.state='pending' AND s.status='enabled' ORDER BY r.first_due_at,r.id").all()){
        const s=this.get(run.schedule_id),reason=this.blocked(s);
        if(reason){this.db.prepare('UPDATE rt_schedule_runs SET blocked_reason=? WHERE id=?').run(reason,run.id);continue;}
        const task=this.state.task(s.task_id),event=`timer:${run.id}`,evidence=`control.sqlite#rt_schedule_runs/${run.id}`;
        this.state.ingestInside({event_id:event,task_id:s.task_id,source:'runtime_schedule',subject:`schedule:${s.id}`,type:'schedule_due',observed_at:run.due_at,
          payload:{schedule_id:s.id,run_id:run.id,first_due_at:run.first_due_at,due_at:run.due_at,occurrences:run.occurrences,
            timezone:s.timezone,kind:s.kind,authorization_ref:s.authority.evidence_ref},evidence_ref:evidence,debounce_ms:0});
        this.db.prepare("UPDATE rt_schedule_runs SET state='admitted',event_id=?,contract_rev=?,owner_id=?,admitted_at=?,blocked_reason=NULL WHERE id=?")
          .run(event,task.contract_rev,task.owner_id,now,run.id);admitted++;
      }
      return {admitted};
    });
  }
  beginInside(wake){
    for(const id of wake.member_ids)this.db.prepare("UPDATE rt_schedule_runs SET state='running',wake_id=?,started_at=COALESCE(started_at,?) WHERE task_id=? AND state IN ('admitted','running')")
      .run(wake.id,this.now(),id);
  }
  finishInside(taskId,wake,evidence_ref){
    const task=this.state.task(taskId),decision=this.db.prepare('SELECT * FROM rt_decisions WHERE task_id=? AND context_rev=? ORDER BY rowid DESC LIMIT 1').get(taskId,task.context_rev);
    if(!decision||!['complete','cycle_complete'].includes(decision.disposition))return;
    for(const run of this.currentRuns(taskId)){
      if(run.state!=='running'||run.wake_id!==wake.id)throw new Error('Scheduled cycle must finish its actual executing wake');
      this.db.prepare("UPDATE rt_schedule_runs SET state='completed',finished_at=?,result=? WHERE id=?").run(this.now(),canonical({decision_id:decision.id,
        disposition:decision.disposition,contract_rev:task.contract_rev,context_rev:task.context_rev,plan_rev:task.plan_rev,
        acceptance:JSON.parse(decision.data).acceptance,evidence_refs:JSON.parse(decision.data).evidence_refs,checkpoint_evidence_ref:evidence_ref}),run.id);
      const s=this.get(run.schedule_id);
      if(s.kind==='once'&&s.status!=='cancelled')this.db.prepare("UPDATE rt_schedules SET status='finished',revision=revision+1 WHERE id=?").run(s.id);
    }
    if(decision.disposition==='complete'){
      this.db.prepare("UPDATE rt_schedules SET status='finished',revision=revision+1 WHERE task_id=? AND status IN ('enabled','paused')").run(taskId);
      this.db.prepare("UPDATE rt_schedule_runs SET state='cancelled',finished_at=?,blocked_reason='whole_task_complete' WHERE task_id=? AND state='pending'").run(this.now(),taskId);
    }
  }
}
