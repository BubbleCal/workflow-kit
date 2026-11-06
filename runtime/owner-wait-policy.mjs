const parse=value=>value?JSON.parse(value):null;
const prFields=['state','head_sha','merge_sha','draft','approval_state','checks_state'];
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export const changeDrivenWait=wait=>wait?.wake_on==='change'||wait?.wake_on===undefined&&
  (['dependency','access','job','pr_state','review_request'].includes(wait?.condition?.kind)||
   wait?.condition?.kind==='pr'&&['approval_pending','ci_pending'].includes(wait.condition.expected));

export function waitDataMeaning(kind,data) {
  if(kind==='job')return {job_id:data.job_id,state:['pending','running'].includes(data.state)?'active':data.state,exit_code:data.exit_code??null};
  const clean=v=>Array.isArray(v)?v.map(clean):v&&typeof v==='object'?
    Object.fromEntries(Object.entries(v).filter(([k])=>!['checked_at','observed_at','evidence_ref','snapshot_file'].includes(k)).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,clean(x)])):v;
  return clean(data);
}

export class OwnerWaitPolicy {
  constructor(state){
    this.state=state;this.db=state.db;this.now=state.now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS rt_owner_wait_windows (
      owner_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,wake_id TEXT NOT NULL,not_before INTEGER NOT NULL,
      state TEXT NOT NULL,reason TEXT NOT NULL,evidence TEXT NOT NULL,updated_at INTEGER NOT NULL);`);
  }
  window(taskId){
    const task=this.state.task(taskId);if(!task)return null;
    const row=this.db.prepare("SELECT w.* FROM rt_owner_wait_windows w JOIN rt_tasks t ON t.task_id=w.task_id AND t.owner_id=w.owner_id WHERE w.owner_id=? AND w.state='waiting'").get(task.owner_id);
    return row?{...row,evidence:parse(row.evidence)}:null;
  }
  blocked(taskId){const w=this.window(taskId);return w&&w.not_before>this.now()?w:null;}
  clear({task_id,actual_human_verified,source_message_id,evidence_ref}){
    if(actual_human_verified!==true||!source_message_id||!evidence_ref)throw new Error('Clearing an owner wait window needs an actual human instruction and evidence');
    const task=this.state.task(task_id);if(!task)throw new Error('Unknown owner task');
    return this.state.atomic(()=>{
      const cleared=this.db.prepare("UPDATE rt_owner_wait_windows SET state='human_override',reason=?,updated_at=? WHERE owner_id=? AND state='waiting'").run(`Human instruction ${source_message_id}`,this.now(),task.owner_id);
      if(!cleared.changes)return {cleared:false,wake_created:false,reason:'no_wait_window'};
      const released=this.releaseMembers(task.owner_id,task_id,`owner-wait-override:${source_message_id}`,'human_command',
        {source_message_id,actual_human_verified:true},evidence_ref);
      return {cleared:true,wake_created:released.length>0,task_ids:released};
    });
  }
  normalize(wait,next_action_at,reason){
    if(next_action_at===undefined)return wait;
    if(typeof next_action_at!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(next_action_at))throw new Error('next_action_at needs an explicit timezone');
    const due=Date.parse(next_action_at);
    if(!Number.isFinite(due)||due<=this.now()||due>this.now()+31536000000)throw new Error('next_action_at must be in the future and within 365 days');
    const condition=wait?.condition??{kind:'time'};
    return {...wait,facts:wait?.facts??[],condition,expires_at:wait?.expires_at??(condition.kind==='time'?due:Math.min(due,this.now()+3600000)),
      next_action_at:new Date(due).toISOString(),resume_condition:wait?.resume_condition??reason};
  }
  record(task,wake,wait,disposition,reason,evidence){
    if(wait?.next_action_at){
      this.db.prepare(`INSERT INTO rt_owner_wait_windows VALUES (?,?,?,?,'waiting',?,?,?) ON CONFLICT(owner_id) DO UPDATE SET
        task_id=excluded.task_id,wake_id=excluded.wake_id,not_before=excluded.not_before,state='waiting',reason=excluded.reason,evidence=excluded.evidence,updated_at=excluded.updated_at`)
        .run(task.owner_id,task.task_id,wake?.id??'shadow-decision',Date.parse(wait.next_action_at),reason,JSON.stringify(evidence),this.now());
    }else if(disposition!=='wait'){
      const cleared=this.db.prepare("UPDATE rt_owner_wait_windows SET state='cleared',updated_at=? WHERE owner_id=? AND task_id=? AND state='waiting'").run(this.now(),task.owner_id,task.task_id);
      if(cleared.changes)this.releaseMembers(task.owner_id,null,`owner-wait-cleared:${wake?.id??this.now()}`,'next_action_due',
        {reason:'Original owner replaced its timed wait'},`owner-wait:${wake?.id??task.task_id}`);
    }
  }
  releaseMembers(owner,origin,key,type,payload,evidence_ref){
    const released=[];
    for(const member of this.state.tasks().filter(t=>t.owner_id===owner&&t.mode==='active'&&!['complete','needs_decision'].includes(t.status))){
      if(member.task_id!==origin&&!this.db.prepare('SELECT 1 FROM rt_events WHERE task_id=? AND disposition IS NULL').get(member.task_id))continue;
      this.state.ingestInside({task_id:member.task_id,event_id:`${key}:${member.task_id}`,source:'runtime',subject:`next-action:${member.task_id}`,
        type,observed_at:this.now(),payload,evidence_ref,debounce_ms:0});
      released.push(member.task_id);
    }
    return released;
  }

  validatePrWait(taskId,wait){
    const c=wait.condition,key=c.pr_key,fields=c.fields??['state','head_sha','merge_sha'];
    if(!/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(key??'')||!Array.isArray(fields)||!fields.length||fields.some(f=>!prFields.includes(f)))throw new Error('PR blocker needs an exact pr_key and supported change fields');
    const repos=this.state.registry()?.scope?.repositories;
    if(repos&&!repos.includes(key.split('#')[0]))throw new Error('PR blocker is outside the authorized repository scope');
    const fact=this.db.prepare('SELECT data FROM rt_facts WHERE task_id=? AND subject=?').get(taskId,key),pr=prSnapshot(parse(fact?.data));
    if(!wait.facts.some(f=>f.subject===key)||!pr?.head_sha||pr.state!=='open')throw new Error('PR blocker needs its fresh observed open PR fact');
  }
  quietObservation(task,event_id,revision,subject,payload,oldFact,version){
    const row=this.db.prepare("SELECT * FROM rt_waits WHERE task_id=? AND state='waiting'").get(task.task_id),wait=parse(row?.condition);
    if(!row||task.status!=='waiting'||task.dirty||!changeDrivenWait(wait))return false;
    const c=wait.condition;
    let quiet=false;
    if(c.kind==='pr_state'&&c.pr_key===subject&&oldFact){
      const fields=c.fields??['state','head_sha','merge_sha'],a=prSnapshot(parse(oldFact.data)),b=prSnapshot(payload);
      quiet=!!a&&!!b&&same(fields.map(k=>a[k]??null),fields.map(k=>b[k]??null));
    }
    if(!quiet)return false;
    this.db.prepare("UPDATE rt_events SET disposition='wait_observation' WHERE event_id=?").run(event_id);
    this.db.prepare('UPDATE rt_tasks SET context_rev=?,updated_at=? WHERE task_id=?').run(revision,this.now(),task.task_id);
    const next={...wait,facts:wait.facts.map(f=>f.subject===subject?{...f,version}:f)};
    this.db.prepare('UPDATE rt_waits SET condition=? WHERE task_id=? AND state=\'waiting\'').run(JSON.stringify(next),task.task_id);
    return true;
  }
  deferObservation(task,revision){
    const window=this.blocked(task.task_id);if(!window||task.status==='complete')return null;
    if(task.status==='needs_decision'){
      this.db.prepare('UPDATE rt_tasks SET context_rev=?,dirty=1,wake_at=NULL,updated_at=? WHERE task_id=?').run(revision,this.now(),task.task_id);
      return window;
    }
    // Facts and unhandled events remain durable. They become actionable together
    // at the reported time, without forcing the current owner to re-check them.
    this.db.prepare("UPDATE rt_tasks SET context_rev=?,dirty=0,status='waiting',wake_at=NULL,updated_at=? WHERE task_id=?").run(revision,this.now(),task.task_id);
    return window;
  }
  releaseDue(){
    for(const row of this.db.prepare("SELECT * FROM rt_owner_wait_windows WHERE state='waiting' AND not_before<=?").all(this.now())){
      const task=this.state.task(row.task_id);
      if(!task||task.owner_id!==row.owner_id||task.status==='complete'){
        this.db.prepare("UPDATE rt_owner_wait_windows SET state='obsolete' WHERE owner_id=?").run(row.owner_id);continue;
      }
      this.state.atomic(()=>{
        this.db.prepare("UPDATE rt_owner_wait_windows SET state='elapsed' WHERE owner_id=? AND state='waiting'").run(row.owner_id);
        this.releaseMembers(row.owner_id,task.task_id,`owner-next-action:${row.not_before}:${row.updated_at}`,'next_action_due',
          {next_action_at:new Date(row.not_before).toISOString(),reason:row.reason},`owner-wait:${row.wake_id}`);
      });
    }
  }
}

function prSnapshot(data){return data?.pr?.head_sha?data.pr:data?.head_sha?data:null;}
