const fresh = (at, now) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now + 5000 && now - Date.parse(at) <= 60000;
const text = value => typeof value === 'string' && !!value.trim();

// The review's commit is historical evidence. A different current head needs
// GitHub's current decision and the applicable rules, not a rewritten review SHA.
export function retainedApprovalReasons(payload, evidence, now) {
  const s = evidence.approval_verification;
  if (!s) return ['retained_approval_evidence_required'];
  const reasons = [], need = (ok, reason) => { if (!ok) reasons.push(reason); };
  need(s.pr_url === payload.pr_url && s.head_sha === payload.expected_head_sha &&
    s.head_before === s.head_sha && s.head_after === s.head_sha &&
    text(s.base_ref) && s.base_before === s.base_ref && s.base_after === s.base_ref,
    'retained_approval_PR_or_head_changed');
  need(fresh(s.checked_at, now) && text(s.evidence_ref) && s.reviews_complete === true && Array.isArray(s.reviews),
    'fresh_complete_approval_source_required');
  need(s.review_decision === 'APPROVED' && s.merge_state_status === 'CLEAN', 'GitHub_current_approval_not_accepted');
  const reviews = (Array.isArray(s.reviews) ? s.reviews : []).filter(r =>
    r.user?.login?.toLowerCase() === evidence.approver?.toLowerCase() && r.state !== 'COMMENTED' && r.state !== 'PENDING');
  need(reviews.every(r => ['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(r.state) &&
    Number.isFinite(Date.parse(r.submitted_at)) && Date.parse(r.submitted_at) <= now + 5000), 'approval_review_order_unknown');
  reviews.sort((a,b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at) || String(b.id).localeCompare(String(a.id), 'en', { numeric:true }));
  const review = reviews[0];
  need(review?.state === 'APPROVED' && text(String(evidence.approval_review_id ?? '')) &&
    String(review.id) === String(evidence.approval_review_id) &&
    /^[a-f0-9]{40,64}$/.test(review.commit_id ?? '') && review.commit_id === evidence.approved_head_sha,
    'latest_designated_approval_missing_or_mismatched');
  const rules = s.rules;
  need(rules?.complete === true && rules.base_ref === s.base_ref && fresh(rules.checked_at, now) &&
    text(rules.evidence_ref) && Array.isArray(rules.branch_rules) &&
    (rules.branch_protection === null || typeof rules.branch_protection === 'object' && !!rules.branch_protection),
    'current_applicable_review_rules_required');
  const protection = rules?.branch_protection;
  if (review?.commit_id !== s.head_sha && protection !== null) need(protection?.dismissesStaleReviews === false && protection?.requireLastPushApproval === false,
    'retained_approval_requires_current_push_review');
  for (const rule of Array.isArray(rules?.branch_rules) ? rules.branch_rules : []) {
    if (review?.commit_id !== s.head_sha && rule.type === 'pull_request') need(rule.parameters?.dismiss_stale_reviews_on_push === false &&
      rule.parameters?.require_last_push_approval === false, 'retained_approval_requires_current_push_review');
  }
  return [...new Set(reasons)];
}
