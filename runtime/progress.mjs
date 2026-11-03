import { createHash } from 'node:crypto';

const stable = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(x => JSON.parse(stable(x))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(stable(value[k]))])) : value ?? null);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const required = (value, field) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`); };
const fresh = (at, now) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now + 5000 && now - Date.parse(at) <= 60000;

export function requiresProgress(item, contractVersion = 1) {
  if (item.kind === 'worker_result') return true;
  if (item.kind !== 'event') return false;
  const p = item.payload ?? {};
  if (['pr_lifecycle_action','wait_reconciliation'].includes(p.event)) return false;
  if (contractVersion >= 2 && p.task_id && p.owner_thread_id) return true;
  return p.continuation_authorized === true || p.current_task_complete === false || p.project_complete === false ||
    ['ready_pr', 'pr_ready', 'pr_merged', 'stage_complete', 'stage_completed', 'permission_probe_complete'].includes(p.event_type ?? p.event) ||
    !!(p.task_id && p.owner_thread_id && p.next_action);
}

export function continuationKey(goal, stage) {
  return `continue:${goal.id}:${stage.id}:${digest({ step: stage.step_id, owner: stage.owner_thread_id, scope: stage.scope_key }).slice(0, 24)}`;
}

function validateGoal(goal) {
  required(goal.id, 'goal.id'); required(goal.authorization_ref, 'goal.authorization_ref');
  if (!Array.isArray(goal.stages) || !goal.stages.length || typeof goal.complete !== 'boolean') throw new Error('Explicit goal acceptance and stages required');
  const ids = new Set(goal.stages.map(s => s.id));
  if (ids.size !== goal.stages.length) throw new Error('Duplicate stage ID');
  for (const s of goal.stages) {
    for (const field of ['id', 'task_id', 'owner_thread_id', 'scope_key']) required(s[field], `stage.${field}`);
    if (!['pending', 'running', 'blocked', 'complete'].includes(s.state)) throw new Error('Stage needs running, pending, blocked or complete state');
    if (s.state === 'pending') { required(s.step_id, 'stage.step_id'); required(s.action, 'concrete next action'); }
    if (s.state === 'running' && (!s.running_evidence_ref || !s.turn_id && !s.job_id)) throw new Error('Running stage needs actual turn/job evidence');
    if (s.state === 'blocked' && (!s.blocker?.reason || !s.blocker?.resume_condition || !s.blocker?.evidence_ref)) throw new Error('Blocked stage needs a real blocker and resume condition');
    if (s.state === 'complete') required(s.completion_evidence_ref, 'stage completion evidence');
    if (!Array.isArray(s.depends_on) || s.depends_on.some(id => !ids.has(id))) throw new Error('Stage dependencies must be explicit and known');
  }
  const visiting = new Set(), visited = new Set(), byId = new Map(goal.stages.map(s => [s.id, s]));
  const visit = id => { if (visiting.has(id)) throw new Error('Cyclic stage dependencies'); if (visited.has(id)) return; visiting.add(id); for (const d of byId.get(id).depends_on) visit(d); visiting.delete(id); visited.add(id); };
  for (const id of ids) visit(id);
  const allComplete = goal.stages.every(s => s.state === 'complete');
  if (goal.complete && (!allComplete || goal.acceptance_verified !== true || !goal.completion_evidence_ref)) throw new Error('A child completion is not whole-goal acceptance');
  if (!goal.complete && allComplete) throw new Error('Unfinished goal needs a concrete acceptance/follow-through stage');
}

// All mutations run inside the owning Mailbox transaction, including event ACK.
export class ProgressLedger {
  constructor(db, now = () => Date.now()) {
    this.db = db; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS progress_goals (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS progress_events (event_key TEXT PRIMARY KEY, digest TEXT NOT NULL, evidence_ref TEXT NOT NULL, recorded_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS progress_event_tasks (event_key TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(event_key,task_id));
      CREATE TABLE IF NOT EXISTS continuation_actions (action_key TEXT PRIMARY KEY, goal_id TEXT NOT NULL, stage_id TEXT NOT NULL,
        owner_thread_id TEXT NOT NULL, scope_key TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        preflight_turn TEXT, actual_turn TEXT, receipt TEXT, updated_at INTEGER NOT NULL);`);
  }
  goals() { return this.db.prepare('SELECT * FROM progress_goals ORDER BY updated_at').all().map(r => ({ ...JSON.parse(r.data), revision: r.revision })); }
  record({ event_key, goals, evidence_ref }) {
    required(event_key, 'source event'); required(evidence_ref, 'progress evidence');
    if (!Array.isArray(goals) || !goals.length) throw new Error('Stage result needs its remaining-goal disposition');
    const hash = digest(goals);
    const prior = this.db.prepare('SELECT digest FROM progress_events WHERE event_key=?').get(event_key);
    if (prior) { if (prior.digest !== hash) throw new Error('Progress event replay changed meaning'); return { recorded: false, duplicate: true }; }
    if (new Set(goals.map(g => g.id)).size !== goals.length) throw new Error('Duplicate goal update');
    for (const goal of goals) {
      validateGoal(goal);
      const previous = this.db.prepare('SELECT * FROM progress_goals WHERE id=?').get(goal.id);
      if ((previous?.revision ?? 0) !== goal.expected_revision) throw new Error('Progress revision changed; reread before updating');
      const old = previous ? JSON.parse(previous.data) : null;
      if (old && old.stages.some(s => !goal.stages.some(n => n.id === s.id))) throw new Error('Cannot drop a requested stage');
      for (const s of goal.stages) {
        const before = old?.stages.find(x => x.id === s.id);
        if (before?.state === 'complete' && s.state !== 'complete') throw new Error('Completed stage needs a new scoped stage, not replay');
        if (before && before.step_id !== s.step_id && !s.progress_evidence_ref && s.state !== 'complete') throw new Error('New step needs verified progress evidence');
        if (before && (s.state === 'complete' || before.step_id !== s.step_id)) {
          const inFlight = this.db.prepare("SELECT state,actual_turn FROM continuation_actions WHERE goal_id=? AND stage_id=? AND state IN ('reserved','sent','uncertain','running')").all(goal.id, s.id);
          if (inFlight.some(a => !a.actual_turn || s.previous_turn_id !== a.actual_turn)) throw new Error('Reconcile the original start and result before changing its step');
          this.db.prepare("UPDATE continuation_actions SET state='finished',updated_at=? WHERE goal_id=? AND stage_id=? AND state<>'finished'").run(this.now(), goal.id, s.id);
        }
        if (s.state === 'pending') {
          const key = continuationKey(goal, s), payload = stable({ ...s, goal_id: goal.id, authorization_ref: goal.authorization_ref });
          const existing = this.db.prepare('SELECT payload FROM continuation_actions WHERE action_key=?').get(key);
          if (existing && JSON.parse(existing.payload).action !== s.action) throw new Error('Same step cannot silently change its action');
          this.db.prepare('INSERT OR IGNORE INTO continuation_actions(action_key,goal_id,stage_id,owner_thread_id,scope_key,payload,updated_at) VALUES (?,?,?,?,?,?,?)')
            .run(key, goal.id, s.id, s.owner_thread_id, s.scope_key, payload, this.now());
        }
      }
      this.db.prepare('INSERT INTO progress_goals VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at')
        .run(goal.id, goal.expected_revision + 1, stable(goal), this.now());
    }
    this.db.prepare('INSERT INTO progress_events VALUES (?,?,?,?)').run(event_key, hash, evidence_ref, this.now());
    for (const task of new Set(goals.flatMap(g=>g.stages.map(s=>s.task_id))))
      this.db.prepare('INSERT OR IGNORE INTO progress_event_tasks VALUES (?,?)').run(event_key,task);
    return { recorded: true, event_key, goals: goals.map(g => ({ id: g.id, revision: g.expected_revision + 1 })) };
  }
  hasResolution(key) { return !!this.db.prepare('SELECT 1 FROM progress_events WHERE event_key=?').get(key); }
  plan(observations = []) {
    const eligible = [], waiting = [];
    for (const g of this.goals().filter(g => !g.complete)) for (const s of g.stages.filter(s => s.state === 'running')) {
      const o = observations.find(o => o.thread_id === s.owner_thread_id);
      const ended = o && fresh(o.checked_at, this.now()) && ['idle','notLoaded'].includes(o.status) && ['completed','failed','interrupted'].includes(o.turn_status) && o.background_job_running === false;
      waiting.push({ goal_id: g.id, stage_id: s.id, task_id: s.task_id, owner_thread_id: s.owner_thread_id,
        reason: ended ? 'ended_owner_needs_result_reconciliation' : 'preserve_or_observe_running_stage' });
    }
    for (const goal of this.goals().filter(g => !g.complete)) for (const s of goal.stages.filter(s => s.state === 'pending')) {
      const key = continuationKey(goal, s), action = this.db.prepare('SELECT * FROM continuation_actions WHERE action_key=?').get(key);
      const o = observations.find(o => o.thread_id === s.owner_thread_id);
      let reason;
      if (!action || action.state !== 'pending') reason = action?.state === 'running' && o && fresh(o.checked_at, this.now()) && ['idle','notLoaded'].includes(o.status) && o.background_job_running === false ? 'ended_owner_needs_result_reconciliation' : action?.state ?? 'missing_action';
      else if (s.depends_on.some(id => goal.stages.find(x => x.id === id).state !== 'complete')) reason = 'dependency';
      else if (!o || !fresh(o.checked_at, this.now())) reason = 'fresh_owner_observation_required';
      else if (!['idle', 'notLoaded'].includes(o.status) || !['completed','failed','interrupted'].includes(o.turn_status)) reason = 'owner_busy';
      else if (o.background_job_running !== false || o.queued_input !== false || o.existing_driver !== false || o.hold !== false || !o.turn_id) reason = 'job_hold_or_pending_input';
      else if (this.goals().some(g => g.stages.some(x => x.state === 'running' && (x.owner_thread_id === s.owner_thread_id || x.scope_key === s.scope_key)))) reason = 'running_stage_needs_result_reconciliation';
      else if (this.db.prepare("SELECT 1 FROM continuation_actions WHERE (owner_thread_id=? OR scope_key=?) AND state IN ('reserved','sent','uncertain','running') LIMIT 1").get(s.owner_thread_id, s.scope_key)) reason = 'existing_start_or_writer';
      const value = { key, goal_id: goal.id, stage_id: s.id, task_id: s.task_id, owner_thread_id: s.owner_thread_id, scope_key: s.scope_key, action: s.action, execution_mode: s.execution_mode ?? 'engineering',
        ...(s.required_capabilities ? { required_capabilities: s.required_capabilities } : {}) };
      if (reason) waiting.push({ ...value, reason }); else eligible.push({ ...value, preflight_turn: o.turn_id, authorization_ref: goal.authorization_ref });
    }
    return { eligible, waiting };
  }
  claim({ key, observation }) {
    const candidate = this.plan([observation]).eligible.find(x => x.key === key);
    if (!candidate) return { reserved: false, reason: 'continuation_not_eligible' };
    this.db.prepare("UPDATE continuation_actions SET state='reserved',preflight_turn=?,updated_at=? WHERE action_key=? AND state='pending'").run(candidate.preflight_turn, this.now(), key);
    return { reserved: true, ...candidate, requires_control_dispatch_claim: true };
  }
  delivery({ key, outcome, evidence_ref, verified_not_sent = false, control_action_key }) {
    required(evidence_ref, 'continuation transport evidence');
    const row = this.db.prepare('SELECT * FROM continuation_actions WHERE action_key=?').get(key);
    if (!row || row.state !== 'reserved' || control_action_key !== key) throw new Error('Continuation needs its same-key guarded dispatch receipt');
    if (!['sent','uncertain','not_sent'].includes(outcome) || outcome === 'not_sent' && !verified_not_sent) throw new Error('Non-delivery requires positive evidence');
    this.db.prepare('UPDATE continuation_actions SET state=?,receipt=?,updated_at=? WHERE action_key=?')
      .run(outcome === 'not_sent' ? 'pending' : outcome, stable({ evidence_ref, control_action_key, outcome }), this.now(), key);
    return { key, state: outcome, execution_started: false };
  }
  started({ key, observation, work_evidence_ref, work_turn_id }) {
    required(work_evidence_ref, 'actual execution evidence');
    const a = this.db.prepare('SELECT * FROM continuation_actions WHERE action_key=?').get(key);
    if (!a || !['sent','uncertain','running'].includes(a.state) || !fresh(observation?.checked_at, this.now()) ||
      observation.thread_id !== a.owner_thread_id || !observation.turn_id || observation.turn_id === a.preflight_turn || work_turn_id !== observation.turn_id)
      throw new Error('A transport ACK is not actual successor execution');
    this.db.prepare("UPDATE continuation_actions SET state='running',actual_turn=?,receipt=?,updated_at=? WHERE action_key=?")
      .run(observation.turn_id, stable({ ...JSON.parse(a.receipt ?? '{}'), work_evidence_ref }), this.now(), key);
    return { key, execution_started: true, turn_id: observation.turn_id };
  }
  unfinishedForOwner(owner) { return this.goals().some(g => !g.complete && g.stages.some(s => s.owner_thread_id === owner && s.state !== 'complete')); }
  reconcile({ key, control_action, owner_quiescent, verified_at, evidence_ref }) {
    required(evidence_ref, 'recovery evidence');
    if (owner_quiescent !== true || !fresh(verified_at, this.now())) throw new Error('Fresh quiescent dispatcher evidence required');
    const row = this.db.prepare('SELECT * FROM continuation_actions WHERE action_key=?').get(key);
    if (!row || !['reserved','sent','uncertain'].includes(row.state)) throw new Error('Continuation does not need transport reconciliation');
    if (control_action && JSON.parse(control_action.payload).thread_id !== row.owner_thread_id) throw new Error('Control receipt belongs to a different owner');
    let state;
    if ((!control_action || control_action.state === 'prepared') && row.state === 'reserved') state = 'pending';
    else if (control_action?.state === 'sent') state = 'sent';
    else state = 'uncertain';
    this.db.prepare('UPDATE continuation_actions SET state=?,receipt=?,updated_at=? WHERE action_key=?').run(state, stable({ evidence_ref, control_state: control_action?.state ?? 'no_guarded_action' }), this.now(), key);
    return { key, state, native_send_performed: false };
  }
  status() { return { goals: this.goals(), actions: this.db.prepare("SELECT action_key,goal_id,stage_id,owner_thread_id,scope_key,state,preflight_turn,actual_turn FROM continuation_actions WHERE state<>'finished' ORDER BY updated_at").all() }; }
}

export function findContinuationGaps(tasks, observations, trackedGoals = []) {
  const tracked = new Set(trackedGoals.flatMap(g => g.stages.map(s => s.task_id)));
  return tasks.filter(t => t.incomplete === true && t.authorized === true && !tracked.has(t.id)).map(t => {
    const o = observations.find(o => o.thread_id === t.owner_thread_id);
    return { task_id: t.id, owner_thread_id: t.owner_thread_id, next_action: t.next_action ?? null,
      reason: !o ? 'observe_owner' : o.status === 'active' || o.background_job_running ? 'preserve_running_work' : t.hold || t.blocker?.resume_condition ? 'record_real_blocker' : 'idle_incomplete_without_durable_successor' };
  });
}

export function registeredContinuationCandidates(registry) {
  const controls = new Set([registry.setup_thread_id, registry.coordinator_thread_id, registry.decision_inbox_thread_id]);
  return Object.values(registry.task_registry?.items ?? {}).filter(t => t.owner_thread_id && !controls.has(t.owner_thread_id) &&
    !/service|reference|informational|workflow_maintenance/.test(t.role ?? '') && t.task_complete !== true &&
    !['complete','completed','archived','cancelled','closed','reference_only'].includes(t.status)).map(t => ({
      id: t.id, owner_thread_id: t.owner_thread_id, incomplete: true,
      authorized: !!(t.authorization_message_id || t.source_message_ids?.length || t.originating_human_source?.message_id || t.authorization_mode),
      next_action: t.next_action, hold: t.hold === true || /implementation_hold|human_hold/.test(t.status ?? ''),
      source_status: t.status, dispatch_allowed: false,
    }));
}
