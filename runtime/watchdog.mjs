import { createHash } from 'node:crypto';
import { registeredContinuationCandidates } from './progress.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const fresh = (at, now) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now + 5000 && now - Date.parse(at) <= 60000;
const idle = o => ['idle','notLoaded'].includes(o?.thread?.status?.type) && !(o.thread.status.activeFlags ?? []).length && ['completed','failed','interrupted'].includes(o.latestTurn?.status);

// A bounded detector/outbox on the existing dispatcher. It never dispatches work.
export class ContinuationWatchdog {
  constructor(db, progress, now = () => Date.now()) {
    this.db = db; this.progress = progress; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS watchdog_cursor (id INTEGER PRIMARY KEY, last_owner TEXT NOT NULL);
      INSERT OR IGNORE INTO watchdog_cursor VALUES (1,'');
      CREATE TABLE IF NOT EXISTS watchdog_rounds (id INTEGER PRIMARY KEY, owners TEXT NOT NULL, observed_at INTEGER);
      CREATE TABLE IF NOT EXISTS watchdog_cases (case_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        tasks TEXT NOT NULL, phase TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
        recovery_key TEXT NOT NULL, recovery_payload TEXT NOT NULL, escalation_payload TEXT,
        created_at INTEGER NOT NULL, opportunity_after INTEGER NOT NULL, next_check_at INTEGER,
        resolution_key TEXT, resolution TEXT);`);
  }
  protection(registry, taskId, ownerId) {
    const controls = [registry.setup_thread_id, registry.coordinator_thread_id, registry.hub_thread_id,
      registry.decision_inbox_thread_id, registry.queue_transport?.dispatcher_thread_id,
      registry.queue_transport?.maintenance_owner_thread_id, registry.meeting_prep?.worker_thread_id];
    if (controls.includes(ownerId)) return 'existing_control_or_meeting_driver';
    const task = registry.task_registry?.items?.[taskId] ?? {};
    if (task.hold === true || typeof task.hold === 'string' && task.hold.trim() ||
        /implementation_hold|human_hold/.test(task.status ?? '')) return 'explicit_human_hold';
    if (/service|reference|informational|workflow_maintenance|meeting|standup|daily_plan|scheduled/.test(task.role ?? '') ||
        task.existing_driver_owns_step === true) return 'existing_driver_or_non_work_role';
    if (task.archived === true || task.thread_archived === true || /^archived/.test(task.status ?? '')) return 'archived';
    const stages = this.progress.goals().filter(g => !g.complete).flatMap(g => g.stages)
      .filter(s => s.task_id === taskId && s.owner_thread_id === ownerId && s.state !== 'complete');
    if (stages.length && stages.every(s => ['human_hold','native_approval'].includes(s.blocker?.kind))) return 'held_goal_stages';
    return null;
  }
  reconcileContinuations() {
    // Execution normally changes the owner turn, so retirement cannot depend on observing the old turn again.
    const goals = this.progress.goals();
    for (const c of this.db.prepare("SELECT * FROM watchdog_cases WHERE phase IN ('open','queued','escalated')").all()) {
      const resolution = JSON.parse(c.resolution ?? '{}');
      if (!resolution.continuation_key) {
        // A separately handled result may start the exact successor before its
        // recovery item is consumed. Match every affected task, not just a busy owner.
        const tasks = JSON.parse(c.tasks), matches = new Map(tasks.map(id => [id, []]));
        const candidates = this.db.prepare(`SELECT * FROM continuation_actions
          WHERE owner_thread_id=? AND preflight_turn=? AND state IN ('running','finished') AND updated_at>=?`)
          .all(c.owner_id,c.turn_id,c.opportunity_after);
        for (const a of candidates) {
          const receipt = JSON.parse(a.receipt ?? '{}');
          const stage = goals.find(g => g.id === a.goal_id)?.stages.find(s => s.id === a.stage_id &&
            s.owner_thread_id === c.owner_id && s.scope_key === a.scope_key);
          if (!stage || !matches.has(stage.task_id) || !a.actual_turn || a.actual_turn === c.turn_id ||
              receipt.control_action_key !== a.action_key || !receipt.work_evidence_ref) continue;
          matches.get(stage.task_id).push({task_id:stage.task_id,continuation_key:a.action_key,
            new_turn_id:a.actual_turn,work_evidence_ref:receipt.work_evidence_ref});
        }
        if (!tasks.length || [...matches.values()].some(actions => actions.length !== 1)) continue;
        const actions = [...matches.values()].flat(), first = actions[0];
        this.db.prepare("UPDATE watchdog_cases SET phase='resolved',resolution_key=?,resolution=? WHERE case_key=?")
          .run(c.recovery_key,JSON.stringify({disposition:'running',evidence_ref:first.work_evidence_ref,
            new_turn_id:first.new_turn_id,work_evidence_ref:first.work_evidence_ref,
            reconciled_at:new Date(this.now()).toISOString(),
            reconciliation:{kind:'matching_actual_continuations',actions}}),c.case_key);
        continue;
      }
      const action = this.db.prepare('SELECT * FROM continuation_actions WHERE action_key=?').get(resolution.continuation_key);
      if (!action || action.owner_thread_id !== c.owner_id) continue;
      const receipt = JSON.parse(action.receipt ?? '{}');
      let evidence;
      if (['running','finished'].includes(action.state) && action.actual_turn && action.actual_turn !== c.turn_id && receipt.work_evidence_ref) {
        evidence = { kind: 'actual_execution', turn_id: action.actual_turn, evidence_ref: receipt.work_evidence_ref };
      } else if (action.state === 'finished') {
        const goal = this.progress.goals().find(g => g.id === action.goal_id);
        const stage = goal?.stages.find(s => s.id === action.stage_id && s.owner_thread_id === c.owner_id);
        if (stage?.state === 'complete' && stage.completion_evidence_ref)
          evidence = { kind: 'accepted_stage_completion', goal_id: goal.id, stage_id: stage.id, evidence_ref: stage.completion_evidence_ref };
      }
      if (evidence) this.db.prepare("UPDATE watchdog_cases SET phase='resolved',resolution=? WHERE case_key=?")
        .run(JSON.stringify({ ...resolution, reconciled_at: new Date(this.now()).toISOString(), reconciliation: evidence }), c.case_key);
    }
  }
  select(registry, limit = 4) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new Error('Watchdog inspection batch must be between 1 and 4 owners');
    this.reconcileContinuations();
    const round = Math.floor(this.now() / 300000);
    const prior = this.db.prepare('SELECT owners FROM watchdog_rounds WHERE id=?').get(round);
    if (prior) return { round_id: round, owners: JSON.parse(prior.owners) };
    const raw = registry.task_registry?.items ?? {};
    const accepted = t => !!(raw[t.id]?.authorization_message_id || raw[t.id]?.source_message_ids?.length || raw[t.id]?.source_user_message_id || raw[t.id]?.originating_human_source?.message_id || /^actual_human|^manual_direct/.test(raw[t.id]?.authorization_mode ?? ''));
    const tasks = new Map(registeredContinuationCandidates(registry).filter(t => t.authorized && accepted(t) && !t.hold && !/meeting|standup|daily_plan|scheduled/.test(raw[t.id]?.role ?? '') && raw[t.id]?.existing_driver_owns_step !== true).map(t => [t.id, t]));
    for (const g of this.progress.goals().filter(g => !g.complete)) for (const s of g.stages.filter(s => s.state !== 'complete')) {
      const held = raw[s.task_id]?.hold === true || /implementation_hold|human_hold/.test(raw[s.task_id]?.status ?? '') || ['human_hold','native_approval'].includes(s.blocker?.kind);
      if (!held) tasks.set(s.task_id, { id: s.task_id, owner_thread_id: s.owner_thread_id, authorized: true });
    }
    const groups = new Map();
    for (const t of tasks.values()) {
      const owner = t.owner_thread_id; if (!owner) continue;
      // Apply after combining both sources: a progress goal cannot bypass a hold or service driver.
      if (this.protection(registry, t.id, owner)) continue;
      const entry = groups.get(owner) ?? { thread_id: owner, host_id: raw[t.id]?.host_id ?? raw[t.id]?.owner_host_id ?? 'local', task_ids: [] };
      entry.task_ids.push(t.id); groups.set(owner, entry);
    }
    const all = [...groups.values()].sort((a,b) => a.thread_id.localeCompare(b.thread_id));
    const cursor = this.db.prepare('SELECT last_owner FROM watchdog_cursor WHERE id=1').get().last_owner;
    const ordered = [...all.filter(o => o.thread_id > cursor), ...all.filter(o => o.thread_id <= cursor)];
    const followupIds = this.db.prepare("SELECT DISTINCT owner_id FROM watchdog_cases WHERE phase IN ('open','queued') ORDER BY opportunity_after LIMIT 2").all().map(x => x.owner_id);
    const urgent = all.filter(o => followupIds.includes(o.thread_id)).slice(0, Math.min(2, limit));
    const sweep = ordered.filter(o => !urgent.some(x => x.thread_id === o.thread_id)).slice(0, limit - urgent.length);
    const owners = [...urgent, ...sweep].map(o => ({ ...o, task_ids: o.task_ids.sort() }));
    this.db.prepare('INSERT INTO watchdog_rounds VALUES (?,?,NULL)').run(round, JSON.stringify(owners));
    if (sweep.length) this.db.prepare('UPDATE watchdog_cursor SET last_owner=? WHERE id=1').run(sweep.at(-1).thread_id);
    return { round_id: round, owners };
  }
  observe({ round_id, snapshots = [], coordinator_snapshot, registry }) {
    const round = this.db.prepare('SELECT * FROM watchdog_rounds WHERE id=?').get(round_id);
    if (!round) throw new Error('Watchdog round is not registered');
    this.reconcileContinuations();
    if (round.observed_at != null) return { duplicate: true, outbox: this.outbox() };
    const seen = [];
    for (const selected of JSON.parse(round.owners)) {
      const owner = { ...selected, task_ids: selected.task_ids.filter(id => !registry || !this.protection(registry, id, selected.thread_id)) };
      if (!owner.task_ids.length) { seen.push({ owner: owner.thread_id, reason: 'protected_scope' }); continue; }
      const o = snapshots.find(p => p.thread?.id === owner.thread_id);
      if (!o || o.error || !fresh(o.checked_at, this.now())) { seen.push({ owner: owner.thread_id, reason: 'unknown_or_stale' }); continue; }
      if (!idle(o) || o.background_job_running === true || o.hold === true || o.existing_driver === true) { seen.push({ owner: owner.thread_id, reason: 'preserve_busy_job_hold_or_driver' }); continue; }
      let caseKey = `continuation-gap:${hash([owner.thread_id, o.latestTurn.id, owner.task_ids])}`;
      let c = this.db.prepare('SELECT * FROM watchdog_cases WHERE case_key=?').get(caseKey);
      if (!c) {
        // A smaller unfinished set is already covered by the same unresolved
        // idle-turn input. Keep its immutable scope instead of adding another alert.
        c = this.db.prepare(`SELECT c.* FROM watchdog_cases c LEFT JOIN mail m ON m.item_key=c.recovery_key
          WHERE c.owner_id=? AND c.turn_id=? AND c.phase IN ('open','escalated') AND c.resolution_key IS NULL
            AND (m.item_key IS NULL OR (m.kind='recovery' AND m.state IN ('pending','in_batch')))
          ORDER BY json_array_length(c.tasks),c.created_at,c.case_key`).all(owner.thread_id,o.latestTurn.id)
          .find(candidate => { const covered = JSON.parse(candidate.tasks);
            return covered.length > owner.task_ids.length && owner.task_ids.every(id => covered.includes(id)); });
        if (c) caseKey = c.case_key;
      }
      if (!c) {
        const recoveryKey = `${caseKey}:recovery:1`;
        const payload = { watchdog_case: caseKey, owner_thread_id: owner.thread_id, host_id: owner.host_id, task_ids: owner.task_ids,
          observed_turn_id: o.latestTurn.id, observed_at: o.checked_at, event: 'continuation_recovery',
          text: 'Native owner is terminal/idle while accepted work is indexed as unfinished. Reconcile original scope, remaining acceptance, actual jobs/holds/drivers and pending control receipts; unknown jobs are NOT absent jobs. Repair durable progress and perform the ordinary guarded eligible continuation at this safe boundary. Do not send a probe-only round, create a new owner, fake human input, change permissions or duplicate an existing/uncertain dispatch. Call mailbox op=watchdog_resolve before ACK; sent ACK is not actual recovery.' };
        this.db.prepare("INSERT INTO watchdog_cases(case_key,owner_id,turn_id,tasks,phase,recovery_key,recovery_payload,created_at,opportunity_after) VALUES (?,?,?,?,'open',?,?,?,?)")
          .run(caseKey, owner.thread_id, o.latestTurn.id, JSON.stringify(owner.task_ids), recoveryKey, JSON.stringify(payload), this.now(), this.now());
        c = this.db.prepare('SELECT * FROM watchdog_cases WHERE case_key=?').get(caseKey);
      }
      if (c.phase === 'resolved' || c.phase === 'escalated') { seen.push({ owner: owner.thread_id, reason: c.phase }); continue; }
      if (c.phase === 'blocked' || c.phase === 'protected') {
        if (c.phase === 'blocked' && (!c.next_check_at || this.now() < c.next_check_at)) continue;
        const generation = c.generation + 1, key = `${caseKey}:recovery:${generation}`;
        const payload = { ...JSON.parse(c.recovery_payload), recheck_generation: generation, prior_blocker: JSON.parse(c.resolution).reason };
        this.db.prepare("UPDATE watchdog_cases SET phase='open',generation=?,recovery_key=?,recovery_payload=?,opportunity_after=?,resolution_key=NULL WHERE case_key=?")
          .run(generation, key, JSON.stringify(payload), this.now(), caseKey);
        c = this.db.prepare('SELECT * FROM watchdog_cases WHERE case_key=?').get(caseKey);
      }
      const opportunity = this.db.prepare("SELECT id,snapshot FROM batches WHERE lane='coordinator' AND state='finished' AND created_at>=? AND finished_at<=? ORDER BY finished_at LIMIT 1").get(c.opportunity_after, this.now());
      if (opportunity && fresh(coordinator_snapshot?.checked_at, this.now()) && idle(coordinator_snapshot)) {
        const admitted = JSON.parse(opportunity.snapshot).items?.some(i => i.key === c.recovery_key) === true;
        const payload = { workflow_health: true, watchdog_case: caseKey, source_recovery_key: c.recovery_key,
          owner_thread_id: owner.thread_id, task_ids: JSON.parse(c.tasks), eligible_coordinator_batch: opportunity.id,
          recovery_in_batch: admitted, health_reason: admitted ? 'recovery_unhandled' : 'queue_admission_gap',
          text: (admitted ? 'A recovery remained unhandled/unstarted after its completed coordinator batch.' :
            'A queued recovery was not admitted to the completed coordinator batch. Inspect queue priority and retry rotation before attributing this to the owner.') + ' Inspect this case, source receipts and concrete blocker in the existing maintenance owner; repair the workflow without becoming a second task-state writer. Use coordinator mailbox for operational changes. Do not directly wake workers, bypass permissions, replay uncertain starts or add a scheduler. If human action is truly required, queue the precise blocker once.' };
        this.db.prepare("UPDATE watchdog_cases SET phase='escalated',escalation_payload=? WHERE case_key=?").run(JSON.stringify(payload), caseKey);
      }
      seen.push({ owner: owner.thread_id, case_key: caseKey });
    }
    this.db.prepare('UPDATE watchdog_rounds SET observed_at=? WHERE id=?').run(this.now(), round_id);
    return { inspected: seen, outbox: this.outbox() };
  }
  outbox() {
    const result = [];
    for (const c of this.db.prepare("SELECT * FROM watchdog_cases WHERE phase IN ('open','queued','escalated')").all()) {
      if (!this.db.prepare('SELECT 1 FROM mail WHERE item_key=?').get(c.recovery_key)) result.push({ key: c.recovery_key, lane: 'coordinator', kind: 'recovery', payload: JSON.parse(c.recovery_payload) });
      if (c.escalation_payload) {
        const payload = JSON.parse(c.escalation_payload);
        const key = `${payload.source_recovery_key}:health`;
        // Honor older case-only keys while letting a genuinely new recovery generation escalate once.
        const existing = this.db.prepare("SELECT 1 FROM mail WHERE lane='maintenance' AND kind='workflow_recovery' AND json_extract(payload,'$.source_recovery_key')=?").get(payload.source_recovery_key);
        if (!existing) result.push({ key, lane: 'maintenance', kind: 'workflow_recovery', payload });
      }
    }
    return result;
  }
  resolve({ case_key, recovery_key, disposition, evidence_ref, continuation_key, new_turn_id, work_evidence_ref, reason, resume_condition, next_check_at, wait_condition, human_hold = false, registry }) {
    if (!evidence_ref) throw new Error('Watchdog resolution needs actual evidence');
    const c = this.db.prepare('SELECT * FROM watchdog_cases WHERE case_key=?').get(case_key);
    if (!c || c.recovery_key !== recovery_key) throw new Error('Watchdog recovery generation changed');
    let phase;
    if (disposition === 'queued') {
      const a = this.db.prepare('SELECT owner_thread_id,state FROM continuation_actions WHERE action_key=?').get(continuation_key);
      if (!a || a.owner_thread_id !== c.owner_id || a.state === 'finished') throw new Error('Queued recovery needs a durable matching continuation');
      phase = 'queued';
    } else if (disposition === 'running') {
      if (!new_turn_id || new_turn_id === c.turn_id || !work_evidence_ref) throw new Error('An ACK or active badge is not resumed work');
      phase = 'resolved';
    } else if (disposition === 'complete') {
      if (this.progress.unfinishedForOwner(c.owner_id)) throw new Error('Remaining goal stages are incomplete');
      phase = 'resolved';
    } else if (disposition === 'protected') {
      if (!reason || !registry || !JSON.parse(c.tasks).every(id => this.protection(registry, id, c.owner_id))) throw new Error('Recovery scope is not protected by the current registry or goal');
      // Suppress this diagnostic without completing work; selection resumes if the protection is released.
      phase = 'protected';
    } else if (disposition === 'blocked') {
      if (!reason || !resume_condition || !human_hold && !(Date.parse(next_check_at) > this.now())) throw new Error('A real blocker and future resume check are required');
      const previous = c.resolution ? JSON.parse(c.resolution) : null;
      const retryDelay = 300000 * (previous?.reason === reason ? Math.min(12, 2 ** Math.min(c.generation - 1, 4)) : 1);
      if (!human_hold && Date.parse(next_check_at) < this.now() + retryDelay) throw new Error('Repeated blocker rechecks require bounded exponential backoff');
      phase = 'blocked';
    } else throw new Error('Unknown watchdog disposition');
    this.db.prepare('UPDATE watchdog_cases SET phase=?,opportunity_after=?,next_check_at=?,resolution_key=?,resolution=? WHERE case_key=?')
      .run(phase, this.now(), next_check_at ? Date.parse(next_check_at) : null, recovery_key,
        JSON.stringify({ disposition, evidence_ref, continuation_key, new_turn_id, work_evidence_ref, reason, resume_condition, human_hold, wait_condition }), case_key);
    return { case_key, phase, native_dispatch_performed: false };
  }
  canAck(caseKey, recoveryKey) { return this.db.prepare('SELECT resolution_key FROM watchdog_cases WHERE case_key=?').get(caseKey)?.resolution_key === recoveryKey; }
  status() { return this.db.prepare('SELECT case_key,owner_id,turn_id,phase,generation,recovery_key,created_at,next_check_at,resolution FROM watchdog_cases ORDER BY created_at').all(); }
}
