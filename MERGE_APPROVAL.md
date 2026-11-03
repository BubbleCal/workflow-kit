# Approval validity and conditional merge

A review's commit is the commit actually reviewed, not necessarily the PR's
current head. A later push does not by itself dismiss that review. Preserve the
real review ID, author, state and commit; never relabel an old review as current.
The designated approver and existing external-write scope remain instance policy.

The ordinary exact-head approval path is unchanged. If approved_head_sha differs
from current_head_sha, prepare and claim require approval_review_id plus an
approval_verification snapshot. Use complete native source reads, or the existing
logged-in read-only CLI when connector metadata lacks commits/rules:

```sh
node runtime/fetch-merge-approval.mjs --repo owner/repo --pr NUMBER --output observations/merge-approval.json
```

Pass the file's actual JSON object as evidence.approval_verification. The collector
does not merge, change rules, refresh credentials, or assess semantic findings.
A 404/error reading protection is unknown, not proof that no rule applies.

The snapshot binds pr_url, head_sha/head_before/head_after and
base_ref/base_before/base_after. checked_at must be within 60 seconds and
an evidence_ref is required. reviews_complete=true means all review pages were
read; reviews retain REST id, user.login, state, commit_id and submitted_at.
The most recent decisive designated review must be APPROVED and match the supplied
approval_review_id/approved_head_sha. A later COMMENTED review does not revoke
approval by itself; its content still goes through the full feedback ledger.
A dismissed/latest changes-requested review cannot resurrect an older approval.

Current GitHub review_decision must be APPROVED and merge_state_status CLEAN.
rules contains complete=true, base_ref, checked_at, evidence_ref, the GraphQL
matched branch_protection (object or explicit null), and all active branch_rules
from REST rules/branches. This retained-review exception requires that matching
classic/ruleset protections do not dismiss stale reviews or require approval of
the latest reviewable push. Unknown rule settings cannot use this exception.
An actual current-head approval can satisfy those stronger rules through the
ordinary path. If stronger rules apply to an older review, report the actual
rule and reconcile its current-push approval requirement; do not claim the review
was dismissed or manufacture a new approval. This scoped exception does not
attempt to infer complex reviewable-diff equivalence.

Keep required_checks_pass, repository_rules_satisfied, mergeable, current-head
validation/technical review, current complete all-author feedback disposition,
original authorization/hold and admin_override=false checks. GitHub APPROVED or
CLEAN does not erase a material COMMENTED/inline/issue finding or prove required
CI passed. Re-fetch current evidence before claim and immediately before merging;
use the immutable payload expected_head_sha in the native conditional merge.
A moved head requires re-evaluation. Preserve claimed/uncertain prior attempts
and inspect actual destination state before a linked retry. Only the coordinator
performs a merge; maintenance only changes and verifies the workflow.

Reference: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
