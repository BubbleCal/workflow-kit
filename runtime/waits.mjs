import { createHash } from 'node:crypto';
const required = (v, name) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} is required`); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);

export class WaitLedger {
  constructor(db, { now = () => Date.now(), checkPr = () => ({ valid: false, reason: 'PR_source_unavailable' }), checkHuman = () => null } = {}) {
    this.db = db; this.now = now; this.checkPr = checkPr; this.checkHuman = checkHuman;
    db.exec(`CREATE TABLE IF NOT EXISTS wait_facts (
      fact_key TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, data TEXT NOT NULL,
      observed_at INTEGER NOT NULL, expires_at INTEGER, evidence_ref TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wait_resolutions(event_key TEXT PRIMARY KEY, evidence_ref TEXT NOT NULL, resolved_at INTEGER NOT NULL);`);
  }
  observe({ fact_key, kind, subject, data, observed_at, expires_at, evidence_ref }) {
    for (const [k,v] of Object.entries({ fact_key, subject, evidence_ref })) required(v, k);
    if (!['dependency','job','access','human'].includes(kind)) throw new Error('Supported typed fact required; PR facts come from the PR collector');
    const at = Date.parse(observed_at), end = Date.parse(expires_at);
    if (!Number.isFinite(at) || at > this.now()+5000 || this.now()-at > 60000) throw new Error('Fresh owning-source fact required');
    if (kind === 'human') {
      if (!data?.source_message_id || data.actual_human_verified !== true || typeof data.pending !== 'boolean' ||
        (!data.decision_id && !(data.task_id && data.hold === true))) throw new Error('Actual registered human decision/hold evidence required');
      if (subject !== (data.decision_id ? `decision:${data.decision_id}` : `task:${data.task_id}`)) throw new Error('Human wait subject must match its registered decision or task');
    } else {
      if (!Number.isFinite(end) || end <= this.now() || end > at+3600000) throw new Error('External wait facts expire within one hour');
      if (kind === 'job' && (!data?.job_id || !['pending','running','complete','failed'].includes(data.state))) throw new Error('Exact job identity and state required');
      if (['access','dependency'].includes(kind) && typeof data?.available !== 'boolean') throw new Error('Availability must be explicitly observed');
      if (kind === 'dependency' && !data.requirement) throw new Error('Dependency needs an exact version, API or other requirement');
    }
    const prior = this.db.prepare('SELECT * FROM wait_facts WHERE fact_key=?').get(fact_key);
    if (prior && (prior.kind !== kind || prior.subject !== subject || prior.observed_at > at)) throw new Error('Fact identity changed or observation moved backward');
    this.db.prepare(`INSERT INTO wait_facts VALUES (?,?,?,?,?,?,?) ON CONFLICT(fact_key) DO UPDATE SET
      data=excluded.data,observed_at=excluded.observed_at,expires_at=excluded.expires_at,evidence_ref=excluded.evidence_ref`)
      .run(fact_key,kind,subject,JSON.stringify(data),at,kind==='human'?null:end,evidence_ref);
    return { recorded: true, fact_key };
  }
  check(condition) {
    if (!condition || typeof condition !== 'object') return { valid: false, reason: 'untyped_wait' };
    if (condition.kind === 'pr') return this.checkPr(condition);
    const f = this.db.prepare('SELECT * FROM wait_facts WHERE fact_key=?').get(condition.fact_key ?? '');
    if (!f || f.kind !== condition.kind || f.subject !== condition.subject) return { valid: false, reason: 'missing_or_mismatched_fact' };
    if (f.expires_at && f.expires_at <= this.now()) return { valid: false, reason: 'evidence_expired', version:`${f.observed_at}:${f.expires_at}` };
    const d = JSON.parse(f.data);
    const valid = ['dependency','access'].includes(f.kind) ? d.available === false &&
      (f.kind !== 'dependency' || condition.requirement === d.requirement) : f.kind === 'job' ?
      d.job_id === condition.job_id && ['pending','running'].includes(d.state) : d.pending === true && this.checkHuman(d) === true;
    return { valid, reason: valid ? 'verified_wait' : 'condition_changed', evidence_ref: f.evidence_ref, version:`${f.observed_at}:${f.expires_at}` };
  }
  validateGoals(goals, previous = [], forceStage) {
    for (const g of goals) for (const s of g.stages ?? []) if (s.state === 'blocked') {
      const old = previous.find(x=>x.id===g.id)?.stages.find(x=>x.id===s.id);
      if (old?.state === 'blocked' && JSON.stringify(old.blocker) === JSON.stringify(s.blocker) &&
        !(forceStage?.goal_id===g.id && forceStage.stage_id===s.id)) continue;
      const result = this.check(s.blocker?.condition);
      if (!result.valid) throw new Error(`Wait ${g.id}/${s.id} needs reconciliation: ${result.reason}`);
    }
  }
  violations(goals) {
    return goals.filter(g => !g.complete).flatMap(g => g.stages.filter(s => s.state === 'blocked').flatMap(s => {
      const result = this.check(s.blocker?.condition);
      if (result.valid) return [];
      const pending=this.db.prepare(`SELECT item_key,payload FROM mail WHERE lane='coordinator' AND state IN ('pending','in_batch')
        AND json_extract(payload,'$.event')='wait_reconciliation' AND json_extract(payload,'$.goal_id')=?
        AND json_extract(payload,'$.stage_id')=? ORDER BY seq LIMIT 1`).get(g.id,s.id);
      if (pending) return [{key:pending.item_key,lane:'coordinator',kind:'event',payload:JSON.parse(pending.payload)}];
      return [{ key: `wait:${g.id}:${s.id}:${hash([s.owner_thread_id,s.blocker?.condition??null,result.reason,result.version??null])}`, lane: 'coordinator', kind: 'event',
        payload: { event: 'wait_reconciliation', goal_id: g.id, stage_id: s.id, goal_revision: g.revision,
          task_id: s.task_id, owner_thread_id: s.owner_thread_id, wait_reason: result.reason,
          text: 'The recorded wait is missing current typed evidence or its predicate changed. Refresh the exact source; persist a valid wait or concrete successor before ACK. Preserve active owners and original scope.' } }];
    }));
  }
  resolve({ event_key, goal, stage_id, evidence_ref }) {
    required(evidence_ref,'actual refreshed wait evidence');
    const stage = goal?.stages.find(s=>s.id===stage_id);
    if (!stage || stage.state==='blocked' && !this.check(stage.blocker?.condition).valid)
      throw new Error('Wait remains invalid; record a concrete successor or refresh owning facts');
    this.db.prepare('INSERT OR IGNORE INTO wait_resolutions VALUES (?,?,?)').run(event_key,evidence_ref,this.now());
    return { resolved: true, event_key };
  }
  canAck(key) { return !!this.db.prepare('SELECT 1 FROM wait_resolutions WHERE event_key=?').get(key); }
}
