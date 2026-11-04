const fresh = (at, now, age) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now + 5000 && now - Date.parse(at) <= age;

// CI applicability is an explicit source-backed selection. The gate never
// turns a missing/skipped check or a generic green summary into CI success.
export function reviewStageReasons(kind, payload, evidence, now, age = 60000) {
  if (!['pr_ready', 'slack_pr'].includes(kind)) return [];
  const url = payload.pr_url ?? payload.message, head = payload.expected_head_sha;
  const ci = evidence.applicable_ci, reasons = [];
  const phase = kind === 'pr_ready' ? 'pre_ready' : 'pre_delivery';
  if (!ci || ci.pr_url !== url || ci.head_sha !== head || ci.head_before !== head || ci.head_after !== head ||
      !fresh(ci.checked_at, now, age) || !ci.evidence_ref || !ci.policy_ref || ci.complete !== true || ci.phase !== phase ||
      !Array.isArray(ci.checks) || !ci.checks.length || ci.checks.some(c => !c.id || !c.name || c.head_sha !== head ||
        typeof c.applicable !== 'boolean' || !c.applicable && (!c.exclusion_reason || !c.applicability_ref))) {
    reasons.push('fresh_complete_applicable_CI_evidence_required');
  } else if (!ci.checks.some(c => c.applicable) || ci.checks.some(c => c.applicable &&
    (c.status !== 'completed' || c.conclusion !== 'success'))) reasons.push('current_applicable_CI_not_passed');
  if (kind === 'pr_ready') return reasons;
  const g = evidence.gatekeeper;
  if (!g || g.pr_url !== url || g.head_sha !== head || g.head_before !== head || g.head_after !== head ||
      !fresh(g.checked_at, now, age) || !g.evidence_ref || !g.semantic_assessment_ref ||
      g.identity?.verified !== true || g.identity.kind !== 'github_app' || !g.identity.login || !g.identity.app_id ||
      !g.identity.evidence_ref || g.reviews_complete !== true || !Array.isArray(g.reviews)) {
    reasons.push('fresh_verified_Gatekeeper_surface_required');return reasons;
  }
  const login = value => String(value ?? '').replace(/\[bot\]$/, '').toLowerCase();
  const reviews = g.reviews.filter(r => login(r.user?.login ?? r.author?.login) === login(g.identity.login));
  if (reviews.some(r => !r.id || !Number.isFinite(Date.parse(r.submitted_at)))) {
    reasons.push('Gatekeeper_review_identity_or_order_unknown');return reasons;
  }
  reviews.sort((a,b) => Date.parse(b.submitted_at)-Date.parse(a.submitted_at) || String(b.id).localeCompare(String(a.id)));
  const last = reviews[0];
  // The observed app uses COMMENTED reviews with this explicit verdict header.
  // Full review/inline semantics are still independently enforced by FeedbackLedger.
  const approved = last?.state === 'APPROVED' || last?.state === 'COMMENTED' &&
    String(last.body ?? '').trim().split('\n')[0].trim() === '✅ **Gate recommendation: approve.**';
  if (!last || last.commit_id !== head || !approved) reasons.push('current_head_Gatekeeper_approval_required');
  return reasons;
}
