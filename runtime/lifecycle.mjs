import { createHash } from 'node:crypto';
import { reviewWindowAt, REVIEW_WINDOW } from './review-window.mjs';
import { readDependencyPolicy, forkRoute, releaseSuccessorVerified } from './dependency-provenance.mjs';
import { ciFailures } from './ci-state.mjs';

const stable = v => JSON.stringify(v && typeof v === 'object' ? Array.isArray(v) ? v.map(x => JSON.parse(stable(x))) : Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(stable(v[k]))])) : v ?? null);
const hash = v => createHash('sha256').update(stable(v)).digest('hex').slice(0, 24);
const required = (v, name) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} is required`); };
const fresh = (at, now, age = 20 * 60000) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now + 5000 && now - Date.parse(at) <= age;
const revisionOf = ({ snapshot_ref, ...state }) => hash(state);
export const prKey = (repository, number) => `${repository}#${number}`;

// This ledger determines the next obligation; existing control guards still
// authorize every external action and original owners remain the only writers.
export class LifecycleLedger {
  constructor(db, { now = () => Date.now(), readOnly = false, unacknowledged = () => new Set(), deliveryMode = 'slack', dependencyPolicy = readDependencyPolicy } = {}) {
    this.db = db; this.now = now; this.unacknowledged = unacknowledged; this.deliveryMode = deliveryMode; this.dependencyPolicy=dependencyPolicy;
    if (!readOnly) db.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle_prs (
        pr_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        authorization_ref TEXT NOT NULL, readiness TEXT, snapshot TEXT, feedback_updated_at TEXT,
        retired INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lifecycle_intents (
        intent_key TEXT PRIMARY KEY, pr_key TEXT NOT NULL, action TEXT NOT NULL,
        revision TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
        due_at INTEGER NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER,
        resolution TEXT);`);
  }
  track({ repository, pr_number, task_id, owner_thread_id, authorization_ref, readiness }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !Number.isSafeInteger(pr_number) || pr_number < 1)
      throw new Error('Exact PR identity required');
    for (const [k,v] of Object.entries({ task_id, owner_thread_id, authorization_ref })) required(v, k);
    const key = prKey(repository, pr_number), old = this.db.prepare('SELECT * FROM lifecycle_prs WHERE pr_key=?').get(key);
    if (old && (old.task_id !== task_id || old.owner_id !== owner_thread_id)) throw new Error('PR already has a different canonical owner/task');
    if (readiness && (!/^[a-f0-9]{40,64}$/.test(readiness.head ?? '') ||
      !readiness.validation_ref || !readiness.technical_review_ref)) throw new Error('Readiness needs exact-head validation and technical review');
    this.db.prepare(`INSERT INTO lifecycle_prs VALUES (?,?,?,?,?,NULL,NULL,0,?)
      ON CONFLICT(pr_key) DO UPDATE SET readiness=COALESCE(excluded.readiness,lifecycle_prs.readiness),updated_at=excluded.updated_at`)
      .run(key, task_id, owner_thread_id, authorization_ref, readiness ? stable(readiness) : null, this.now());
    return { tracked: true, pr_key: key };
  }
  observe(snapshot, { feedbackCollected = false } = {}) {
    const key = prKey(snapshot.repository, snapshot.pr_number);
    if (!this.db.prepare('SELECT 1 FROM lifecycle_prs WHERE pr_key=?').get(key)) return { tracked: false };
    if (!fresh(snapshot.checked_at, this.now(), 60000) || !snapshot.evidence_ref ||
      !/^[a-f0-9]{40,64}$/.test(snapshot.head_sha ?? '') || !['open','closed','merged'].includes(snapshot.state) ||
      typeof snapshot.draft !== 'boolean' || !Number.isFinite(Date.parse(snapshot.updated_at))) throw new Error('Fresh exact-head PR lifecycle snapshot required');
    if (snapshot.state === 'merged' && (!snapshot.merged_at || !snapshot.merge_sha)) throw new Error('Merged state needs merge evidence');
    const old = this.db.prepare('SELECT snapshot FROM lifecycle_prs WHERE pr_key=?').get(key);
    const previous = old.snapshot ? JSON.parse(old.snapshot) : null;
    if (previous && Date.parse(previous.checked_at) > Date.parse(snapshot.checked_at)) throw new Error('Out-of-order PR snapshot');
    const stateChanged = !previous || ['state','head_sha','draft'].some(k=>previous[k]!==snapshot[k]);
    const saved = { ...snapshot, ...(snapshot.ci === undefined && previous?.head_sha === snapshot.head_sha && previous.ci ? {ci:previous.ci} : {}), state_revision:(previous?.state_revision ?? 0)+Number(stateChanged) };
    this.db.prepare('UPDATE lifecycle_prs SET snapshot=?,feedback_updated_at=CASE WHEN ? THEN ? ELSE feedback_updated_at END,updated_at=? WHERE pr_key=?')
      .run(stable(saved), Number(feedbackCollected), snapshot.updated_at, this.now(), key);
    return { observed: true, pr_key: key };
  }
  feedback(repository, number, head) {
    const s = this.db.prepare('SELECT * FROM feedback_snapshots WHERE repository=? AND pr_number=?').get(repository, number);
    if (!s || s.head !== head || !fresh(s.checked_at, this.now())) return { state: 'unknown', items: [] };
    const items = this.db.prepare(`SELECT i.item_key,i.digest,a.disposition FROM feedback_items i
      LEFT JOIN feedback_assessments a ON a.item_key=i.item_key AND a.digest=i.digest AND a.head=?
      WHERE i.repository=? AND i.pr_number=? ORDER BY i.item_key`).all(head, repository, number);
    return { state: items.some(i => !i.disposition) ? 'unassessed' :
      items.some(i => i.disposition === 'needs_scope_decision') ? 'decision' :
      items.some(i => i.disposition === 'actionable') ? 'repair' : 'clear', items };
  }
  inspect(key) {
    const w = this.db.prepare('SELECT * FROM lifecycle_prs WHERE pr_key=?').get(key);
    if (!w || w.retired) return { state: 'retired', action: null };
    const s = w.snapshot ? JSON.parse(w.snapshot) : null, readiness = w.readiness ? JSON.parse(w.readiness) : null;
    const base = { pr_key: key, task_id: w.task_id, owner_thread_id: w.owner_id, authorization_ref: w.authorization_ref,
      head: s?.head_sha ?? null, artifact_revision:s?.state_revision ?? 0, snapshot_ref: s?.evidence_ref ?? null };
    const answer = (state, action, details = {}) => ({ ...base, state, action, ...details });
    if (!s || !fresh(s.checked_at, this.now())) return answer('observation_due', 'refresh_pr');
    const releaseRoute=forkRoute(this.dependencyPolicy(),s.repository);
    if (releaseRoute) return answer(s.state==='closed'?'closed_unmerged':'release_route_required','reconcile_release_route',{release_route:releaseRoute});
    if (s.state === 'merged') return answer('merged', 'decide_after_merge', { merge_sha: s.merge_sha });
    if (s.state === 'closed') return answer('closed_unmerged', 'resolve_closed');
    const ci = ciFailures(s,this.now());
    if (ci.unknown) return answer('ci_observation_due','refresh_ci');
    const failureVersion = hash(ci.failures);
    const ciHandled = ci.failures.length && this.db.prepare(`SELECT 1 FROM lifecycle_intents
      WHERE pr_key=? AND action='triage_ci' AND state='resolved'
        AND json_extract(payload,'$.head')=? AND json_extract(payload,'$.failure_version')=?`).get(key,s.head_sha,failureVersion);
    if (ci.failures.length && !ciHandled) return answer('ci_failed','triage_ci',
      {artifact_revision:0,failure_version:failureVersion,failed_checks:ci.failures});

    if (w.feedback_updated_at !== s.updated_at) return answer('feedback_due', 'refresh_feedback');
    const feedback = this.feedback(s.repository, s.pr_number, s.head_sha);
    const feedbackVersion = hash(feedback.items);
    if (feedback.state === 'unknown') return answer('feedback_due', 'refresh_feedback');
    if (feedback.state === 'unassessed') return answer('feedback_unassessed', 'assess_feedback', { feedback_version: feedbackVersion });
    if (feedback.state === 'decision') return answer('feedback_scope_decision', 'decide_feedback', { feedback_version: feedbackVersion });
    if (feedback.state === 'repair') return answer('changes_required', 'repair_feedback', { feedback_version: feedbackVersion });
    if (this.deliveryMode === 'local') return readiness?.head === s.head_sha && readiness.validation_passed === true && readiness.technical_review_passed === true ?
      answer('local_delivery','deliver_local') : answer('readiness_unknown','obtain_readiness');
    const url = `https://github.com/${s.repository}/pull/${s.pr_number}`;
    const sent = this.db.prepare(`SELECT action_key FROM actions WHERE kind='slack_pr' AND state='sent'
      AND json_extract(payload,'$.message')=? AND json_extract(payload,'$.expected_head_sha')=? LIMIT 1`).get(url,s.head_sha);
    const uncertain = this.db.prepare(`SELECT action_key FROM actions WHERE kind IN ('slack_pr','pr_ready','merge')
      AND state IN ('claimed','uncertain') AND (json_extract(payload,'$.message')=? OR json_extract(payload,'$.pr_url')=?) LIMIT 1`).get(url, url);
    if (uncertain) return answer('delivery_uncertain', 'reconcile_delivery', { control_action_key: uncertain.action_key });
    if (s.draft && this.db.prepare(`SELECT 1 FROM actions WHERE kind='pr_ready' AND state='sent'
      AND json_extract(payload,'$.pr_url')=? AND json_extract(payload,'$.expected_head_sha')=?`).get(url,s.head_sha))
      return answer('observation_due', 'refresh_pr');
    if (s.draft || !sent) {
      if (!readiness || readiness.head !== s.head_sha || readiness.validation_passed !== true || readiness.technical_review_passed !== true)
        return answer('readiness_unknown', 'obtain_readiness');
      const window = reviewWindowAt(this.now(), REVIEW_WINDOW);
      if (window.blocked) return answer('review_window', null, { due_at: window.next_eligible_at });
      return answer('ready_undelivered', 'deliver_review', { draft: s.draft });
    }
    if (ciHandled) return answer('ci_disposition_recorded',null,{failure_version:failureVersion,delivery_receipt:sent.action_key});
    return answer('review_delivered', 'check_merge', { delivery_receipt: sent.action_key });
  }
  reconcile() {
    const output = [];
    for (const { pr_key } of this.db.prepare('SELECT pr_key FROM lifecycle_prs WHERE retired=0 ORDER BY updated_at').all()) {
      const next = this.inspect(pr_key);
      const revision = revisionOf(next), key = `lifecycle:${pr_key}:${revision}`;
      this.db.prepare("UPDATE lifecycle_intents SET state='superseded',resolved_at=? WHERE pr_key=? AND revision<>? AND state IN ('pending','waiting')")
        .run(this.now(), pr_key, revision);
      if (!next.action) continue;
      const old = this.db.prepare('SELECT * FROM lifecycle_intents WHERE intent_key=?').get(key);
      if (old?.state === 'resolved') continue;
      if (old?.state === 'waiting' && old.due_at > this.now()) continue;
      if (old?.state === 'waiting' && this.unacknowledged().has(`${key}:${JSON.parse(old.payload).lifecycle_generation}`)) continue;
      if (old?.state === 'pending') {
        const payload = JSON.parse(old.payload);
        output.push({ key: `${key}:${payload.lifecycle_generation}`, lane: 'coordinator', kind: 'event', payload });
        continue;
      }
      const generation = old ? JSON.parse(old.payload).lifecycle_generation + 1 : 1;
      const payload = { ...next, event: 'pr_lifecycle_action', lifecycle_key: key, lifecycle_generation: generation,
        detected_at: new Date(this.now()).toISOString(),
        text: 'Execute this concrete lifecycle obligation under existing scope/owner/control gates. A generic waiting note does not acknowledge it. Use lifecycle_resolve with actual receipt, durable progress or a verified typed wait.' };
      this.db.prepare(`INSERT INTO lifecycle_intents VALUES (?,?,?,?,?,'pending',?,?,NULL,NULL)
        ON CONFLICT(intent_key) DO UPDATE SET state='pending',payload=excluded.payload,resolved_at=NULL`)
        .run(key, pr_key, next.action, revision, stable(payload), this.now(), this.now());
      output.push({ key: `${key}:${generation}`, lane: 'coordinator', kind: 'event', payload });
    }
    return output;
  }
  resolve({ key, generation, disposition, evidence_ref, control_action_key, progress_resolution, wait }) {
    required(evidence_ref, 'lifecycle resolution evidence');
    const row = this.db.prepare('SELECT * FROM lifecycle_intents WHERE intent_key=?').get(key);
    if (!row) throw new Error('Unknown lifecycle obligation');
    if (JSON.parse(row.payload).lifecycle_generation !== generation) throw new Error('Lifecycle generation changed');
    if (['resolved','superseded'].includes(row.state)) return { resolved: true, state: row.state };
    const current = this.inspect(row.pr_key);
    if (revisionOf(current) !== row.revision) {
      this.db.prepare("UPDATE lifecycle_intents SET state='superseded',resolved_at=?,resolution=? WHERE intent_key=?")
        .run(this.now(), stable({ evidence_ref, disposition: 'state_changed', generation }), key);
      return { resolved: true, state: 'superseded', next: current };
    }
    let state = 'resolved', due = this.now(), waitProof;
    if (disposition === 'receipt') {
      const a = this.db.prepare('SELECT * FROM actions WHERE action_key=?').get(control_action_key ?? '');
      const p = a ? JSON.parse(a.payload) : {};
      if (!a || a.state !== 'sent' || a.task_id !== current.task_id ||
        p.expected_head_sha !== current.head || row.action !== 'deliver_review' || a.kind !== 'slack_pr' ||
        p.message !== `https://github.com/${row.pr_key.replace('#','/pull/')}`) throw new Error('Exact delivered PR receipt required');
    } else if (disposition === 'progress') {
      if (!['resolve_closed','decide_after_merge','decide_feedback','obtain_readiness','repair_feedback','triage_ci','reconcile_delivery','deliver_local','reconcile_release_route'].includes(row.action) ||
        progress_resolution?.verified !== true || !progress_resolution.task_ids?.includes(current.task_id))
        throw new Error('Actual task-bound progress disposition required');
      if (['repair_feedback','triage_ci'].includes(row.action) && progress_resolution.task_complete === true)
        throw new Error('Material feedback or CI failure needs a successor or verified wait, not task completion');
      if (row.action==='reconcile_release_route' && !releaseSuccessorVerified(progress_resolution.goals,current.task_id,current.release_route))
        throw new Error('Persist the released-upstream, automatic-sync, consumer-adoption and integrated-acceptance successor path');
      if (['decide_after_merge','deliver_local','reconcile_release_route'].includes(row.action) || row.action === 'resolve_closed' && progress_resolution.task_complete === true)
        this.db.prepare('UPDATE lifecycle_prs SET retired=1 WHERE pr_key=?').run(row.pr_key);
      else if (!['resolve_closed','triage_ci'].includes(row.action)) { state = 'waiting'; due = this.now() + 10 * 60000; }
    } else if (disposition === 'wait') {
      if (wait?.pr_key !== row.pr_key || wait?.head !== current.head) throw new Error('Wait must belong to this exact PR/head');
      const result = this.checkWait(wait);
      if (!result.valid) throw new Error(`Invalid lifecycle wait: ${result.reason}`);
      waitProof = result.proof;
      state = 'waiting'; due = Date.parse(wait.next_check_at);
    } else throw new Error('Receipt, progress or a verified wait is required');
    this.db.prepare('UPDATE lifecycle_intents SET state=?,due_at=?,resolved_at=?,resolution=? WHERE intent_key=?')
      .run(state, due, this.now(), stable({ disposition, evidence_ref, control_action_key, generation, wait, wait_proof:waitProof, progress_resolution }), key);
    return { resolved: true, state, due_at: due };
  }
  checkWait(condition) {
    if (condition?.kind !== 'pr' || !condition.pr_key || !condition.head) return { valid: false, reason: 'typed_exact_PR_wait_required' };
    const next = this.inspect(condition.pr_key);
    if (next.head !== condition.head) return { valid: false, reason: 'head_changed' };
    const w = this.db.prepare('SELECT snapshot FROM lifecycle_prs WHERE pr_key=?').get(condition.pr_key);
    const s = w?.snapshot ? JSON.parse(w.snapshot) : null;
    let valid = false;
    if (condition.expected === 'review_window') valid = next.state === 'review_window';
    if (condition.expected === 'approval_pending') valid = next.state === 'review_delivered' && s.approval_state === 'pending' &&
      s.approval_head === s.head_sha && !!s.approval_evidence_ref;
    if (condition.expected === 'ci_pending') valid = next.state === 'review_delivered' && s.checks_state === 'pending' &&
      s.checks_scope === 'required' && s.checks_head === s.head_sha && !!s.checks_evidence_ref;
    const due = Date.parse(condition.next_check_at);
    valid &&= Number.isFinite(due) && due > this.now() && due <= this.now() + 3600000;
    return { valid, reason: valid ? 'verified_wait' : next.state, next,
      proof:valid?{snapshot:s,state:next.state,delivery_receipt:next.delivery_receipt}:null };
  }
  canAck(key, generation) {
    const r = this.db.prepare('SELECT state,resolution,payload FROM lifecycle_intents WHERE intent_key=?').get(key);
    if (!r) return false;
    const resolution = JSON.parse(r.resolution ?? '{}');
    return r.state === 'superseded' || ['resolved','waiting'].includes(r.state) && resolution.generation === generation &&
      (resolution.disposition !== 'wait' || this.checkWait(resolution.wait).valid);
  }
  status() {
    const intents = this.db.prepare("SELECT intent_key,pr_key,action,state,due_at,created_at,resolved_at,payload FROM lifecycle_intents WHERE state<>'superseded' ORDER BY created_at").all();
    const pending = intents.filter(x=>x.state==='pending');
    return { prs: this.db.prepare('SELECT pr_key,task_id,owner_id,retired,updated_at FROM lifecycle_prs').all(),
      intents:intents.map(({payload,...row})=>({...row,detected_at:JSON.parse(payload).detected_at})),
      metrics:{pending_count:pending.length,oldest_pending_ms:pending.length?Math.max(...pending.map(x=>this.now()-Date.parse(JSON.parse(x.payload).detected_at))):0,
        meaning:'Detection-to-disposition queue age, not engineering execution time or measured throughput improvement'} };
  }
}
