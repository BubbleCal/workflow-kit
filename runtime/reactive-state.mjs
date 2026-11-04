import { createHash, randomUUID } from 'node:crypto';
import { activeScopeExclusions } from './scope-exclusions.mjs';
import { verifyExecutionProof, verifyNativeBinding } from './native-queue.mjs';

export const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v)))
    : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))]))
  : value ?? null);
export const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
const required = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`); };
const parse = value => value ? JSON.parse(value) : null;
const liveAction = "state IN ('claimed','uncertain')";
const pendingWake = "state IN ('reserved','claimed','sent','queued','uncertain','running')";
export const registeredComplete=t=>t?.completed===true||t?.task_complete===true||['complete','completed','archived'].includes(t?.status);

// The event log, current facts, plans and wake outbox share control.sqlite.
// External effects still use ControlStore and its existing scope locks/receipts.
export class ReactiveState {
  constructor(db, { now = () => Date.now(), registry = () => null, checkWait = () => ({valid:false,reason:'typed_wait_source_unavailable'}) } = {}) {
    this.db = db; this.now = now; this.registry = registry; this.checkWait=checkWait;
    db.exec(`
      CREATE TABLE IF NOT EXISTS rt_tasks (
        task_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, mode TEXT NOT NULL,
        contract TEXT NOT NULL, contract_rev INTEGER NOT NULL DEFAULT 1,
        context_rev INTEGER NOT NULL DEFAULT 0, plan_rev INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ready',
        first_pending_at INTEGER, wake_at INTEGER, wake_seq INTEGER NOT NULL DEFAULT 0,
        authorization_ref TEXT NOT NULL, mode_source TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS rt_tasks_by_owner ON rt_tasks(owner_id);
      CREATE TABLE IF NOT EXISTS rt_events (
        event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source TEXT NOT NULL,
        subject TEXT NOT NULL, type TEXT NOT NULL, source_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL,
        evidence_ref TEXT NOT NULL, context_rev INTEGER, disposition TEXT, decision_id TEXT);
      CREATE INDEX IF NOT EXISTS rt_pending_events ON rt_events(task_id, disposition);
      CREATE TABLE IF NOT EXISTS rt_facts (
        task_id TEXT NOT NULL, subject TEXT NOT NULL, version TEXT NOT NULL,
        observed_at INTEGER NOT NULL, checked_at INTEGER NOT NULL, data TEXT NOT NULL,
        evidence_ref TEXT NOT NULL, PRIMARY KEY(task_id,subject));
      CREATE TABLE IF NOT EXISTS rt_plans (
        task_id TEXT NOT NULL, revision INTEGER NOT NULL, contract_rev INTEGER NOT NULL,
        context_rev INTEGER NOT NULL, state TEXT NOT NULL, plan TEXT NOT NULL,
        reason TEXT NOT NULL, evidence_refs TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(task_id,revision));
      CREATE TABLE IF NOT EXISTS rt_contracts (
        task_id TEXT NOT NULL, revision INTEGER NOT NULL, contract TEXT NOT NULL,
        source_message_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(task_id,revision));
      CREATE TABLE IF NOT EXISTS rt_decisions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, context_rev INTEGER NOT NULL,
        plan_rev INTEGER NOT NULL, disposition TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rt_waits (
        task_id TEXT PRIMARY KEY, condition TEXT NOT NULL, state TEXT NOT NULL,
        reason TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rt_wakes (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, context_rev INTEGER NOT NULL,
        plan_rev INTEGER NOT NULL, event_ids TEXT NOT NULL, state TEXT NOT NULL,
        prompt TEXT, preflight_turn TEXT, turn_id TEXT, created_at INTEGER NOT NULL,
        started_at INTEGER, completed_at INTEGER, evidence_ref TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS rt_one_wake ON rt_wakes(task_id)
        WHERE state IN ('reserved','claimed','sent','uncertain','running');
      CREATE TABLE IF NOT EXISTS rt_polls (
        subject TEXT PRIMARY KEY, task_id TEXT NOT NULL, config TEXT NOT NULL,
        next_at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
        unchanged INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_success_at INTEGER);
      CREATE TABLE IF NOT EXISTS rt_diagnostics (
        key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rt_handoffs (
        key TEXT PRIMARY KEY, task_id TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rt_wake_members (
        wake_id TEXT NOT NULL, task_id TEXT NOT NULL, context_rev INTEGER NOT NULL,
        PRIMARY KEY(wake_id,task_id));
    `);
    this.atomic(()=>{
      const columns=new Set(db.prepare('PRAGMA table_info(rt_wakes)').all().map(c=>c.name));
      if(!columns.has('transport'))db.exec("ALTER TABLE rt_wakes ADD COLUMN transport TEXT NOT NULL DEFAULT 'legacy_app_server'");
      if(!columns.has('queue_id'))db.exec('ALTER TABLE rt_wakes ADD COLUMN queue_id TEXT');
      if(!columns.has('owner_id'))db.exec('ALTER TABLE rt_wakes ADD COLUMN owner_id TEXT');
      db.exec(`UPDATE rt_wakes SET owner_id=(SELECT owner_id FROM rt_tasks WHERE task_id=rt_wakes.task_id) WHERE owner_id IS NULL;
        INSERT OR IGNORE INTO rt_wake_members SELECT id,task_id,context_rev FROM rt_wakes;
        CREATE UNIQUE INDEX IF NOT EXISTS rt_one_owner_delivery ON rt_wakes(owner_id) WHERE ${pendingWake};
        DROP INDEX IF EXISTS rt_one_task_per_owner;`);
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS rt_one_pending_delivery ON rt_wakes(task_id) WHERE state IN ('reserved','claimed','sent','queued','uncertain','running')");
      if(!db.prepare('PRAGMA table_info(rt_polls)').all().some(c=>c.name==='enabled'))db.exec('ALTER TABLE rt_polls ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
    });
  }
  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  task(id) {
    const t = this.db.prepare('SELECT * FROM rt_tasks WHERE task_id=?').get(id);
    return t ? { ...t, contract: parse(t.contract), dirty: !!t.dirty } : null;
  }
  tasks() { return this.db.prepare('SELECT task_id FROM rt_tasks ORDER BY task_id').all().map(t => this.task(t.task_id)); }
  plan(id) {
    const p = this.db.prepare("SELECT * FROM rt_plans WHERE task_id=? AND state='current'").get(id);
    return p ? { ...p, plan: parse(p.plan), evidence_refs: parse(p.evidence_refs) } : null;
  }
  adopt({ task_id, owner_thread_id, contract, source_message_id, actual_human_verified }) {
    required(task_id, 'task_id'); required(owner_thread_id, 'original owner'); required(source_message_id, 'human authorization');
    if (actual_human_verified !== true) throw new Error('Verify the actual user request before adopting a task');
    this.validateContract(task_id,owner_thread_id,contract);
    return this.atomic(() => {
      const old = this.task(task_id);
      if (old) {
        if (old.owner_id !== owner_thread_id || canonical(old.contract) !== canonical(contract))
          throw new Error('Adoption cannot overwrite an existing contract or owner');
        return { adopted: false, task: old };
      }
      this.db.prepare(`INSERT INTO rt_tasks(task_id,owner_id,mode,contract,authorization_ref,mode_source,updated_at)
        VALUES (?,?,'shadow',?,?,?,?)`).run(task_id, owner_thread_id, canonical(contract), contract.authorization_ref, source_message_id, this.now());
      this.db.prepare('INSERT INTO rt_contracts VALUES (?,1,?,?,?)').run(task_id,canonical(contract),source_message_id,this.now());
      return { adopted: true, task: this.task(task_id) };
    });
  }
  validateContract(task_id,owner_thread_id,contract) {
    required(contract?.objective, 'objective'); required(contract?.authorization_ref, 'original task authorization');
    required(contract?.project_id, 'verified project'); required(contract?.workspace, 'verified task workspace');
    if (!Array.isArray(contract.requirements) || !contract.requirements.length ||
        new Set(contract.requirements.map(r => r.id)).size !== contract.requirements.length)
      throw new Error('A contract needs distinct acceptance requirements');
    for (const r of contract.requirements) { required(r.id, 'requirement id'); required(r.text, 'requirement text'); }
    if (!Array.isArray(contract.constraints)) throw new Error('Explicit constraints are required');
    if (!Array.isArray(contract.job_sources) || !contract.job_sources.includes('native'))
      throw new Error('Declare native and any external job sources before automatic delivery');
    if(contract.trigger_only===true&&(!Array.isArray(contract.schedule_sources)||!contract.schedule_sources.length))throw new Error('Scheduled-only work needs bound native schedule sources');
    const registry = this.registry();
    if (registry) {
      const task = registry.task_registry?.items?.[task_id];
      if (task?.owner_thread_id !== owner_thread_id || !task.canonical_key ||
          task.canonical_key !== contract.canonical_key || registry.scope?.project_id !== contract.project_id)
        throw new Error('Contract must bind the registered canonical task and project');
    }
    const siblings=this.tasks().filter(t=>t.owner_id===owner_thread_id&&t.task_id!==task_id);
    if(siblings.some(t=>t.contract.workspace!==contract.workspace||t.contract.project_id!==contract.project_id))
      throw new Error('Shared owner contracts must preserve the same native workspace and project');
  }
  amend({ task_id, expected_contract_rev, contract, source_message_id, actual_human_verified }) {
    required(source_message_id,'actual contract change source');
    if(actual_human_verified!==true)throw new Error('Only an actual user instruction can change the goal contract');
    return this.atomic(()=>{
      const task=this.task(task_id);
      if(!task||task.contract_rev!==expected_contract_rev)throw new Error('Contract changed; reread the current task');
      this.validateContract(task_id,task.owner_id,contract);
      if(['project_id','workspace','canonical_key'].some(k=>contract[k]!==task.contract[k]))throw new Error('Goal amendment cannot move task identity or workspace');
      const revision=task.contract_rev+1;
      this.db.prepare('INSERT INTO rt_contracts VALUES (?,?,?,?,?)').run(task_id,revision,canonical(contract),source_message_id,this.now());
      this.db.prepare('UPDATE rt_tasks SET contract=?,contract_rev=?,authorization_ref=? WHERE task_id=?').run(canonical(contract),revision,contract.authorization_ref,task_id);
      this.db.prepare("UPDATE rt_plans SET state='superseded' WHERE task_id=? AND state='current'").run(task_id);
      this.ingestInside({event_id:`contract:${task_id}:${revision}`,task_id,source:'human_authorization',subject:`contract:${task_id}`,type:'goal_changed',
        observed_at:this.now(),payload:{contract,revision},evidence_ref:source_message_id,debounce_ms:0});
      return this.task(task_id);
    });
  }
  setMode({ task_id, mode, source_message_id, actual_human_verified, native_binding, queue_compatibility_verified, legacy_quiescent }) {
    return this.setModes({task_ids:[task_id],mode,source_message_id,actual_human_verified,native_binding,queue_compatibility_verified,legacy_quiescent}).tasks[0];
  }
  setModes({task_ids,mode,source_message_id,actual_human_verified,native_binding,queue_compatibility_verified,legacy_quiescent}) {
    if (!['shadow','active','paused','legacy'].includes(mode)) throw new Error('Unknown runtime mode');
    if(!Array.isArray(task_ids)||!task_ids.length||new Set(task_ids).size!==task_ids.length)throw new Error('Distinct task IDs are required');
    required(source_message_id, 'mode change source');
    if (actual_human_verified !== true) throw new Error('Mode changes require an actual user instruction');
    return this.atomic(() => {
      const tasks=task_ids.map(id=>this.task(id));if(tasks.some(t=>!t))throw new Error('Unknown task');
      if(new Set(tasks.map(t=>t.owner_id)).size!==1)throw new Error('A cutover group must have one original owner');
      if(mode==='active')this.assertOwnerCoverage(tasks[0].owner_id,new Set(task_ids));
      if(['legacy','shadow'].includes(mode)&&tasks.some(t=>['active','paused'].includes(t.mode))&&
        this.tasks().some(t=>t.owner_id===tasks[0].owner_id&&['active','paused'].includes(t.mode)&&!task_ids.includes(t.task_id)))
        throw new Error('Return all shared-owner tasks together before enabling another driver');
      for(const task of tasks){
      const task_id=task.task_id;
      if (task.mode === mode) continue;
      if (mode !== 'paused') {
        verifyNativeBinding(native_binding,{thread_id:task.owner_id,workspace:task.contract.workspace,now:this.now()});
        if(mode==='active'&&queue_compatibility_verified!==true)throw new Error('Verify actual idle and busy desktop queue consumption before activation');
        this.assertQueueOwner(task);
        if (legacy_quiescent !== true) throw new Error('Finish legacy batches and verify the existing driver before cutover');
        if (this.openWake(task_id) || this.db.prepare(`SELECT 1 FROM actions WHERE task_id=? AND ${liveAction}`).get(task_id))
          throw new Error('Reconcile in-flight deliveries before switching drivers');
      }
      this.db.prepare('UPDATE rt_tasks SET mode=?,mode_source=?,updated_at=? WHERE task_id=?').run(mode, source_message_id, this.now(), task_id);
      if(mode==='active' && task.status==='ready')this.db.prepare('UPDATE rt_tasks SET wake_at=COALESCE(wake_at,?) WHERE task_id=?').run(this.now(),task_id);
      if(mode==='legacy' || mode==='shadow' && ['active','paused'].includes(task.mode)) {
        const key=`runtime-return:${task_id}:${source_message_id}`;
        const payload={event:'reactive_handoff',task_id,owner_thread_id:task.owner_id,authorization_ref:task.authorization_ref,
          source_message_id,context_rev:task.context_rev,contract:task.contract,plan:this.plan(task_id),
          evidence_ref:`control.sqlite#rt_tasks/${task_id}`,text:'The user returned this task to the legacy driver. Read runtime status/checkpoint, actual results and action receipts. Reconcile remaining acceptance and source changes; do not replay external actions or infer completion.'};
        this.db.prepare("INSERT OR IGNORE INTO rt_handoffs VALUES (?,?,?,'pending')").run(key,task_id,canonical(payload));
      }
      }
      return {tasks:task_ids.map(id=>this.task(id))};
    });
  }
  assertOwnerCoverage(owner,changing=new Set()) {
    const missing=Object.entries(this.registry()?.task_registry?.items??{}).filter(([id,t])=>
      t.owner_thread_id===owner&&!registeredComplete(t)&&!changing.has(id)&&!['active','paused'].includes(this.task(id)?.mode));
    if(missing.length)throw new Error(`Migrate all unfinished tasks sharing this owner together: ${missing.map(([id])=>id).join(', ')}`);
  }
  assertQueueOwner(task) {
    const registered = this.registry()?.task_registry?.items?.[task.task_id];
    if(task.contract.execution_hold)throw new Error('Preserve the original explicit task hold');
    if (registered && (registered.owner_thread_id !== task.owner_id || registered.canonical_key!==task.contract.canonical_key || registered.hold || registered.existing_driver || registered.existing_driver_owns_step))
      throw new Error('Registered owner, hold or existing driver prevents automatic work');
  }
  ingest(input) { return this.atomic(() => this.ingestInside(input)); }
  ingestInside({ event_id, task_id, source, subject, type, observed_at, payload, evidence_ref, debounce_ms = 1000 }) {
    for (const [k,v] of Object.entries({ event_id, task_id, source, subject, type, evidence_ref })) required(v,k);
    const task = this.task(task_id); if (!task) throw new Error('Unknown event task');
    const at = typeof observed_at === 'number' ? observed_at : Date.parse(observed_at);
    if (!Number.isFinite(at) || at > this.now()+5000) throw new Error('Actual source observation time required');
    const content = canonical({ task_id, source, subject, type, observed_at: at, payload, evidence_ref });
    const digest = fingerprint(content), old = this.db.prepare('SELECT * FROM rt_events WHERE event_id=?').get(event_id);
    if (old) {
      if (old.digest !== digest) throw new Error('An immutable event identity cannot change meaning');
      return { recorded: false, duplicate: true, context_rev: old.context_rev };
    }
    const fact = this.db.prepare('SELECT * FROM rt_facts WHERE task_id=? AND subject=?').get(task_id,subject);
    const version = fingerprint(payload), stale = fact && at < fact.observed_at;
    const unchanged = !stale && fact?.version === version;
    const revision = task.context_rev + (stale || unchanged ? 0 : 1);
    this.db.prepare('INSERT INTO rt_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)').run(event_id,task_id,source,subject,type,at,this.now(),digest,canonical(payload),evidence_ref,revision,stale?'stale':unchanged?'unchanged':null);
    if (stale) return { recorded: true, stale: true, context_rev: revision };
    this.db.prepare(`INSERT INTO rt_facts VALUES (?,?,?,?,?,?,?) ON CONFLICT(task_id,subject) DO UPDATE SET
      version=excluded.version,observed_at=excluded.observed_at,checked_at=excluded.checked_at,data=excluded.data,evidence_ref=excluded.evidence_ref`)
      .run(task_id,subject,version,at,this.now(),canonical(payload),evidence_ref);
    if (unchanged) return { recorded: true, unchanged: true, context_rev: revision };
    const schedulePending=this.db.prepare("SELECT 1 FROM rt_events WHERE task_id=? AND type='schedule_due' AND disposition IS NULL").get(task_id);
    if(task.contract.trigger_only===true&&type!=='schedule_due'&&type!=='human_command'&&!schedulePending&&!this.openWake(task_id)){
      this.db.prepare("UPDATE rt_events SET disposition='schedule_observation' WHERE event_id=?").run(event_id);
      this.db.prepare("UPDATE rt_tasks SET context_rev=?,status='waiting',dirty=0,wake_at=NULL,updated_at=? WHERE task_id=?").run(revision,this.now(),task_id);
      return {recorded:true,changed:true,context_rev:revision,scheduled_only:true};
    }
    const first = task.first_pending_at ?? this.now();
    const due = Math.min(first+5000, this.now()+Math.max(0,Math.min(5000,debounce_ms)));
    this.db.prepare(`UPDATE rt_tasks SET context_rev=?,dirty=1,status=CASE WHEN status='complete' THEN 'needs_decision' ELSE 'ready' END,
      first_pending_at=?,wake_at=?,updated_at=? WHERE task_id=?`).run(revision,first,due,this.now(),task_id);
    this.db.prepare("UPDATE rt_waits SET state='invalidated',reason=?,updated_at=? WHERE task_id=? AND state='waiting'")
      .run(`New evidence: ${event_id}`,this.now(),task_id);
    // Only a reservation with no possible delivery can be replaced by a fresher batch.
    this.db.prepare("UPDATE rt_wakes SET state='superseded',completed_at=? WHERE id IN (SELECT wake_id FROM rt_wake_members WHERE task_id=?) AND state='reserved'").run(this.now(),task_id);
    return { recorded: true, changed: true, context_rev: revision, wake_at: due };
  }
  checkpoint(task_id) {
    const task = this.task(task_id); if (!task) throw new Error('Unknown task');
    return { task, plan: this.plan(task_id),scope_exclusions:activeScopeExclusions(this.registry(),task_id),
      facts: this.db.prepare('SELECT * FROM rt_facts WHERE task_id=? ORDER BY subject').all(task_id).map(f=>({...f,data:parse(f.data)})),
      events: this.db.prepare('SELECT * FROM rt_events WHERE task_id=? AND disposition IS NULL ORDER BY context_rev,event_id').all(task_id).map(e=>({...e,payload:parse(e.payload)})),
      wait: this.db.prepare('SELECT * FROM rt_waits WHERE task_id=?').get(task_id) ?? null,
      wake: this.openWake(task_id),
      owner_tasks:this.tasks().filter(t=>t.owner_id===task.owner_id).map(t=>({task_id:t.task_id,mode:t.mode,status:t.status,dirty:t.dirty,objective:t.contract.objective})) };
  }
  validatePlan(task, plan) {
    if (!plan || !Array.isArray(plan.steps) || !plan.steps.length || !Array.isArray(plan.assumptions))
      throw new Error('Plan needs steps and explicit working assumptions');
    const ids = new Set(plan.steps.map(s=>s.id)), requirements = new Set(task.contract.requirements.map(r=>r.id));
    if (ids.size !== plan.steps.length) throw new Error('Step identities must be unique');
    const covered = new Set();
    for (const s of plan.steps) {
      required(s.id,'step id'); required(s.action,'step action');
      if (!Array.isArray(s.requirement_ids) || !s.requirement_ids.length || s.requirement_ids.some(id=>!requirements.has(id)))
        throw new Error('Each step must bind existing contract requirements');
      s.requirement_ids.forEach(id=>covered.add(id));
      if (!Array.isArray(s.depends_on) || s.depends_on.some(id=>!ids.has(id))) throw new Error('Step dependencies must exist');
    }
    if ([...requirements].some(id=>!covered.has(id))) throw new Error('Replanning cannot drop an acceptance requirement');
    const visited=new Set(),visiting=new Set(),byId=new Map(plan.steps.map(s=>[s.id,s]));
    const visit=id=>{if(visiting.has(id))throw new Error('Cyclic plan');if(visited.has(id))return;visiting.add(id);byId.get(id).depends_on.forEach(visit);visiting.delete(id);visited.add(id);};
    [...ids].forEach(visit);
    for (const assumption of plan.assumptions) {
      required(assumption.id,'assumption id'); required(assumption.claim,'assumption claim');
      if (!['supported','unknown','refuted'].includes(assumption.status) || !Array.isArray(assumption.evidence_refs))
        throw new Error('Assumptions need their actual evidence status');
    }
  }
  decide({ task_id, expected_context_rev, expected_plan_rev, disposition, reason, evidence_refs, plan, wait,
    acceptance, wake_id, owner_thread_id, alternatives_considered = [] }) {
    if (!['continue','revise','wait','needs_decision','complete','cycle_complete'].includes(disposition)) throw new Error('Unknown decision disposition');
    required(reason,'decision reason');
    if (!Array.isArray(evidence_refs) || !evidence_refs.length || evidence_refs.some(r=>typeof r!=='string'||!r.trim())) throw new Error('Decision needs evidence');
    return this.atomic(() => {
      const task = this.task(task_id);
      if (!task || task.owner_id !== owner_thread_id || task.context_rev !== expected_context_rev || task.plan_rev !== expected_plan_rev)
        throw new Error('Task owner or context/plan changed; read a fresh checkpoint');
      if(task.mode==='paused'&&['continue','revise'].includes(disposition))throw new Error('Paused task may checkpoint but cannot resume engineering');
      const wake = wake_id ? this.openWake(task_id) : null;
      if(wake_id&&wake?.id!==wake_id)throw new Error('Decision must belong to this task and grouped wake');
      if (task.mode === 'active' && (!wake || wake.state !== 'running')) throw new Error('An active task decision needs its acknowledged execution wake');
      let revision=task.plan_rev;
      if (plan) {
        this.validatePlan(task,plan);
        if (this.db.prepare(`SELECT 1 FROM actions WHERE task_id=? AND kind NOT IN ('task_wake','task_queue') AND ${liveAction}`).get(task_id))
          throw new Error('Reconcile in-flight effects before replacing their plan');
        revision++;
        this.db.prepare("UPDATE rt_plans SET state='superseded' WHERE task_id=? AND state='current'").run(task_id);
        this.db.prepare("INSERT INTO rt_plans VALUES (?,?,?,?,'current',?,?,?,?)")
          .run(task_id,revision,task.contract_rev,task.context_rev,canonical(plan),reason,canonical(evidence_refs),this.now());
      } else if (disposition === 'revise' || !this.plan(task_id) && disposition === 'continue') throw new Error('A concrete plan is required');
      if (disposition === 'wait') this.validateWait(task_id,wait);
      if(disposition==='cycle_complete'&&!task.contract.schedule_sources?.length)throw new Error('Cycle completion requires a bound recurring schedule');
      if (['complete','cycle_complete'].includes(disposition)) {
        const childReasons=this.completionReasons?.(task_id)??[];
        if(childReasons.length)throw new Error(`Project acceptance still has unfinished work: ${childReasons.join(', ')}`);
        if (!Array.isArray(acceptance) || task.contract.requirements.some(r=>!acceptance.some(a=>a.requirement_id===r.id && a.passed===true && a.evidence_ref)))
          throw new Error('Completion requires evidence for every contract requirement');
        if (this.db.prepare(`SELECT 1 FROM actions WHERE task_id=? AND kind NOT IN ('task_wake','task_queue') AND ${liveAction}`).get(task_id))
          throw new Error('Uncertain external effects prevent whole-task completion');
      }
      const id=randomUUID(), data={reason,evidence_refs,alternatives_considered,acceptance,wait};
      this.db.prepare('INSERT INTO rt_decisions VALUES (?,?,?,?,?,?,?)').run(id,task_id,task.context_rev,revision,disposition,canonical(data),this.now());
      this.db.prepare("UPDATE rt_events SET disposition='handled',decision_id=? WHERE task_id=? AND disposition IS NULL AND context_rev<=?").run(id,task_id,task.context_rev);
      const status=['wait','cycle_complete'].includes(disposition)?'waiting':disposition==='complete'?'complete':disposition==='needs_decision'?'needs_decision':'ready';
      this.db.prepare('UPDATE rt_tasks SET plan_rev=?,dirty=0,status=?,first_pending_at=NULL,wake_at=NULL,updated_at=? WHERE task_id=?').run(revision,status,this.now(),task_id);
      if (wait && disposition==='wait') this.db.prepare(`INSERT INTO rt_waits VALUES (?,?,'waiting',?,?) ON CONFLICT(task_id) DO UPDATE SET
        condition=excluded.condition,state='waiting',reason=excluded.reason,updated_at=excluded.updated_at`).run(task_id,canonical(wait),reason,this.now());
      else this.db.prepare("UPDATE rt_waits SET state='resolved',reason=?,updated_at=? WHERE task_id=?").run(reason,this.now(),task_id);
      return { decision_id:id, task:this.task(task_id), action_context:{contract_rev:task.contract_rev,context_rev:task.context_rev,plan_rev:revision} };
    });
  }
  validateWait(task_id, wait) {
    if (!wait || !Array.isArray(wait.facts) || !wait.facts.length || !Number.isFinite(wait.expires_at) ||
        wait.expires_at <= this.now() || wait.expires_at > this.now()+3600000)
      throw new Error('A wait needs current fact versions and a recheck within one hour');
    for (const expected of wait.facts) {
      const actual=this.db.prepare('SELECT version,checked_at FROM rt_facts WHERE task_id=? AND subject=?').get(task_id,expected.subject);
      if (!actual || actual.version!==expected.version || this.now()-actual.checked_at>60000)
        throw new Error('A wait cannot rely on stale or superseded facts');
    }
    required(wait.resume_condition,'wait resume condition');
    const proof=this.checkWait(wait.condition);
    if(!proof?.valid)throw new Error(`Typed wait is not currently valid: ${proof?.reason??'unknown'}`);
  }
  expireWaits() {
    for (const row of this.db.prepare("SELECT * FROM rt_waits WHERE state='waiting'").all()) {
      const wait=parse(row.condition); if (wait.expires_at>this.now()) continue;
      this.ingest({event_id:`wait-expired:${row.task_id}:${row.updated_at}`,task_id:row.task_id,source:'runtime',subject:`wait:${row.task_id}`,
        type:'wait_expired',observed_at:wait.expires_at,payload:{expired_at:wait.expires_at,resume_condition:wait.resume_condition},evidence_ref:`wait:${row.updated_at}`,debounce_ms:0});
    }
  }
  openWake(task_id) {
    const w=this.db.prepare(`SELECT w.* FROM rt_wakes w JOIN rt_wake_members m ON m.wake_id=w.id WHERE m.task_id=? AND ${pendingWake}`).get(task_id);
    return w?{...w,event_ids:parse(w.event_ids),member_ids:this.db.prepare('SELECT task_id FROM rt_wake_members WHERE wake_id=? ORDER BY task_id').all(w.id).map(x=>x.task_id)}:null;
  }
  reserveQueuedWake(task_id) {
    return this.atomic(()=>{
      const task=this.task(task_id);
      if (!task || task.mode!=='active' || task.wake_at===null || task.wake_at>this.now()) return {reserved:false,reason:'not_due'};
      const old=this.openWake(task_id); if(old)return {reserved:false,reason:'wake_in_flight',wake:old};
      if(this.db.prepare(`SELECT 1 FROM rt_wakes WHERE owner_id=? AND ${pendingWake}`).get(task.owner_id))return {reserved:false,reason:'owner_wake_in_flight'};
      this.assertOwnerCoverage(task.owner_id);
      this.assertQueueOwner(task);
      const members=this.tasks().filter(t=>t.owner_id===task.owner_id&&t.mode==='active'&&t.wake_at!==null&&t.wake_at<=this.now());
      for(const member of members)this.assertQueueOwner(member);
      const events=members.flatMap(t=>this.db.prepare('SELECT event_id FROM rt_events WHERE task_id=? AND disposition IS NULL ORDER BY context_rev,event_id').all(t.task_id).map(e=>e.event_id));
      const id=`runtime:${task_id}:wake:${task.wake_seq+1}`;
      this.db.prepare("INSERT INTO rt_wakes(id,task_id,context_rev,plan_rev,event_ids,state,transport,created_at,owner_id) VALUES (?,?,?,?,?,'reserved','native_queue',?,?)")
        .run(id,task_id,task.context_rev,task.plan_rev,canonical(events),this.now(),task.owner_id);
      for(const member of members)this.db.prepare('INSERT INTO rt_wake_members VALUES (?,?,?)').run(id,member.task_id,member.context_rev);
      this.db.prepare('UPDATE rt_tasks SET wake_seq=wake_seq+1 WHERE task_id=?').run(task_id);
      return {reserved:true,wake:this.openWake(task_id)};
    });
  }
  begin({ task_id, wake_id, native_proof }) {
    return this.atomic(()=>{
      const task=this.task(task_id),wake=this.openWake(task_id);
      if(!task || task.mode!=='active' || wake?.id!==wake_id || wake.transport!=='native_queue' ||
        !['claimed','queued','uncertain','running'].includes(wake.state))
        throw new Error('Execution must match the original task, wake and actual new turn');
      const {turn_id,evidence_ref}=verifyExecutionProof(native_proof,{thread_id:task.owner_id,workspace:task.contract.workspace,prompt:wake.prompt,now:this.now()});
      if(wake.turn_id&&wake.turn_id!==turn_id)throw new Error('A different turn already owns this wake');
      this.db.prepare("UPDATE rt_wakes SET state='running',turn_id=?,started_at=COALESCE(started_at,?),evidence_ref=? WHERE id=?").run(turn_id,this.now(),evidence_ref,wake_id);
      this.db.prepare("UPDATE actions SET state='sent',receipt=?,updated_at=? WHERE action_key=? AND kind='task_queue' AND state IN ('claimed','uncertain')")
        .run(canonical({outcome:'sent',native_consumption:{turn_id,evidence_ref}}),this.now(),wake_id);
      return this.checkpoint(task_id);
    });
  }
  finish({ task_id, wake_id, turn_id, evidence_ref }) {
    required(evidence_ref,'checkpoint evidence');
    return this.atomic(()=>{
      const task=this.task(task_id),wake=this.openWake(task_id);
      if(!task || wake?.id!==wake_id || wake.state!=='running' || wake.turn_id!==turn_id)throw new Error('Finish the actual running wake');
      for(const id of wake.member_ids){
        const member=this.task(id);
        if(member.dirty)throw new Error(`New information for member ${id} must be assessed before finishing; checkpoint again`);
        if(member.status==='ready')throw new Error(`Continue the concrete plan for member ${id}, record a typed wait or request a decision before finishing`);
      }
      this.db.prepare("UPDATE rt_wakes SET state='finished',completed_at=?,evidence_ref=? WHERE id=?").run(this.now(),evidence_ref,wake_id);
      for(const id of wake.member_ids)if(this.task(id).status==='complete')this.onCompleteInside?.(id,wake_id,evidence_ref);
      return {finished:true,task_complete:this.task(task_id).status==='complete'};
    });
  }
  actionReasons(kind,task_id,payload) {
    if(kind==='task_wake')return ['direct_app_server_transport_removed'];
    const task=this.task(task_id);
    const owned=payload?.thread_id?this.db.prepare("SELECT task_id FROM rt_tasks WHERE owner_id=? AND mode IN ('active','paused')").get(payload.thread_id):null;
    if(owned&&kind==='dispatch'&&!['active','paused'].includes(task?.mode))return ['reactive_owner_manages_shared_tasks'];
    if(owned && task?.owner_id!==payload.thread_id && ['dispatch','task_queue'].includes(kind))return ['reactive_owner_has_another_task'];
    if(kind==='task_queue' && !task)return ['reactive_task_not_registered'];
    if(!task || !['active','paused'].includes(task.mode))return kind==='task_queue'?['reactive_task_not_active']:[];
    if(kind==='task_queue') {
      try{this.assertQueueOwner(task);}catch{return ['registered_owner_or_hold_changed'];}
      const wake=this.openWake(task_id);
      const members=wake?.member_ids.map(id=>this.task(id))??[];
      try{for(const member of members)this.assertQueueOwner(member);}catch{return ['registered_group_owner_or_hold_changed'];}
      if(members.some(t=>t.mode!=='active'||t.owner_id!==task.owner_id||this.db.prepare('SELECT context_rev FROM rt_wake_members WHERE wake_id=? AND task_id=?').get(wake.id,t.task_id)?.context_rev!==t.context_rev))return ['reactive_group_changed_or_paused'];
      return task.mode==='active' && wake?.id===payload.wake_id && wake.transport==='native_queue' && ['reserved','claimed'].includes(wake.state) &&
        wake.task_id===task_id && task.context_rev===wake.context_rev && task.owner_id===payload.thread_id && !!wake.prompt && wake.prompt===payload.prompt &&
        canonical(payload.scope_keys??[])===canonical(task.contract.scope_keys??[]) ? [] : ['reactive_wake_changed_or_paused'];
    }
    if(!['dispatch','create_thread','archive','pr_ready','slack_pr','merge','notion_sync'].includes(kind))return [];
    if(task.mode==='paused')return ['reactive_task_paused'];
    const c=payload.runtime_context;
    if(!c || c.contract_rev!==task.contract_rev || c.plan_rev!==task.plan_rev || c.context_rev!==task.context_rev || task.dirty)
      return ['reactive_plan_or_evidence_changed'];
    if(kind==='dispatch'||kind==='create_thread')return ['reactive_owner_already_manages_execution'];
    if(kind==='archive'&&task.status!=='complete')return ['reactive_contract_incomplete'];
    if(kind==='archive'&&this.tasks().some(t=>t.owner_id===task.owner_id&&t.status!=='complete'))return ['reactive_owner_has_unfinished_goals'];
    return [];
  }
  diagnostic(key,data) { this.db.prepare('INSERT INTO rt_diagnostics VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').run(key,canonical(data),this.now()); }
  status() {
    return {tasks:this.tasks(),wakes:this.db.prepare('SELECT * FROM rt_wakes ORDER BY created_at DESC LIMIT 100').all(),
      source_rate:this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='rt_source_rate'").get()?this.db.prepare('SELECT * FROM rt_source_rate').all().map(r=>({...r,data:parse(r.data)})):[],
      polls:this.db.prepare('SELECT * FROM rt_polls ORDER BY subject').all(),
      diagnostics:this.db.prepare('SELECT * FROM rt_diagnostics ORDER BY key').all().map(d=>({...d,data:parse(d.data)})),
      pending_handoffs:this.db.prepare("SELECT key,task_id FROM rt_handoffs WHERE state='pending'").all(),
      metrics:this.db.prepare(`SELECT t.task_id,COUNT(e.event_id) AS pending_events,MIN(e.received_at) AS oldest_received_at
        FROM rt_tasks t LEFT JOIN rt_events e ON e.task_id=t.task_id AND e.disposition IS NULL GROUP BY t.task_id`).all()};
  }
}
