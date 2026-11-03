const bad = new Set(['failure','timed_out','cancelled','action_required','stale','startup_failure']);
const fresh = (at, now) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now + 5000 && now - Date.parse(at) <= 20*60000;

// Observed failures trigger triage, not automatic retries or merge permission.
export function ciFailures(snapshot, now) {
  const ci = snapshot.ci;
  if (ci && (ci.complete !== true || ci.head_sha !== snapshot.head_sha || !fresh(ci.checked_at,now) ||
      !ci.evidence_ref || !Array.isArray(ci.checks) || ci.checks.some(c=>!c || !['check_run','status'].includes(c.kind) || c.head_sha!==snapshot.head_sha || !c.id || !c.name || c.status==='completed' && !c.conclusion)))
    return { unknown:true, failures:[] };
  const failures = (ci?.checks ?? []).filter(c => c.kind === 'check_run' ?
    c.status === 'completed' && bad.has(c.conclusion) : c.kind === 'status' && ['failure','error'].includes(c.conclusion))
    .map(c=>({kind:c.kind,id:String(c.id),name:c.name,conclusion:c.conclusion,completed_at:c.completed_at??null,url:c.url??null}))
    .sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id));
  if (!failures.length && snapshot.checks_state === 'failed' && snapshot.checks_scope === 'required' &&
      snapshot.checks_head === snapshot.head_sha && snapshot.checks_evidence_ref)
    failures.push({kind:'required_summary',id:snapshot.head_sha,name:'required checks',conclusion:'failure',url:null});
  return {unknown:false,failures};
}
