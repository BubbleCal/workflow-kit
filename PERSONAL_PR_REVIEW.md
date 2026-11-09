# Personal inspection before external PR review delivery

Before sending a PR for external review, its original implementation owner must
notify Yang in the main chat and wait for explicit clearance when any of these
is true: breaking change, format change, broad impact, or high risk. This applies
across repositories and to existing PRs that have not yet been sent for review.
Judge the actual diff and consequences, not only labels or line count. A label
indicating breaking/format change also triggers the rule; removing a label or
calling a change ordinary is not a substitute for inspection.

The owner records a short current-head assessment, including the affected users,
interfaces, persisted/wire formats, and the reason for the impact/risk judgment.
Do not manufacture an exception for routine work. PR creation stays draft;
implementation, proportionate validation, CI, automatic Gatekeeper and feedback
repairs continue. A Ready transition used for that internal gate does not grant
external delivery. Explicit task-specific draft holds still take precedence.

When the PR is concrete and reviewable, the owner proactively sends one concise
decision card to the configured main chat: original task ID, PR link, what changes,
why personal inspection is needed, affected scope, validation and remaining risk.
Ask Yang to inspect it and explicitly permit external review delivery. A sent
notification, elapsed time, CI, Gatekeeper or another reviewer's approval is not
Yang's clearance. This is a narrow exception to the on-request inbox; routine
progress stays quiet. Preserve all existing Functions and task-specific holds.

## Existing guarded delivery API

`PR_REVIEW_CHANNELS.json.personal_review` is the instance policy. All `pr_ready`,
`review_decision` and `slack_pr` evidence includes `pr_impact`:

```json
{
  "pr_url": "https://github.com/owner/repo/pull/123",
  "head_sha": "<current full head SHA>",
  "checked_at": "<fresh ISO timestamp>",
  "owner_thread_id": "<original owner, equal to executor_thread_id>",
  "evidence_ref": "<saved actual diff and full label evidence>",
  "reason": "<brief affected scope and risk explanation>",
  "breaking_change": false,
  "format_change": false,
  "broad_impact": false,
  "high_risk": false,
  "labels_complete": true,
  "labels": []
}
```

Missing or stale assessment blocks the operation until the owner supplies it;
it does not itself require asking Yang. Prepare, claim and final send each check
fresh evidence. Valid reusable testing remains reusable; the rule does not ask
for additional tests merely to populate an assessment.

Use `kind=review_decision` with the existing stable key
`review-decision:<canonical PR URL>:<head SHA>`, the original task/runtime context,
and `payload.decision_reason=personal_review`. Set `thread_id` and
`source_message_id` from `personal_review`, `pr_url` and `message` to the canonical
PR URL, `expected_head_sha` to the inspected head, and `prompt` to the finished
decision card. Use the existing CI/Gatekeeper/full-feedback guards and
prepare/claim/authorize_review_send/native-send/readback/settle flow documented
in FUNCTIONS_REVIEW_DECISIONS.md. Only the bound original implementation owner
can deliver; no new owner or coordinator. Use one combined card when Functions
and personal-review requirements overlap, not two requests.

Main records Yang's actual personally-reviewed clearance in
`personal_review.authorizations` with `pr_url`, `head_sha`,
`decision=allow_external_review`, `reviewed_personally=true`,
`actual_human_verified=true`, `source_thread_id` (main), `source_message_id`, and
`evidence_ref` to the actual reply. Do not infer this from a bot or another agent.
The owner cannot self-authorize. Clearances bind the inspected PR/head; a different
head or revoked decision cannot silently reuse one. Do not repeatedly notify an
unchanged PR. If the user expressly approves a bounded later adjustment, preserve
that actual scope and verify it when recording clearance for the resulting head.

Main may also verify an actual human reply in a side conversation. Keep its real
`source_thread_id`, `source_turn_id`, message ID and verbatim text; add
`recorded_by_thread_id` equal to main and `source_actor_verified:true` only after
native readback. An agent relay alone is not consent and must not be relabeled
as a human message in main.

From the effective human instruction in the centralized
`PR_REVIEW_CHANNELS.json.review_implies_conditional_merge` rule, explicit human
permission to send a clearly scoped PR/task for external review also permits
conditional merge within that same scope. Do not ask for a separate nonordinary
merge permission. System technical Ready, a notification, automatic approval or
an agent relay is not this human grant. Earlier grants and explicit historical
holds are not bulk promoted or cleared.

Main records each exact PR/head through `runtime/control.mjs`, operation
`record_pr_review_authorization`. Supply task_id/pr_url/head_sha, the exact
source_thread_id/source_turn_id/source_message_id/verbatim_text and fresh
`native_proof` from `codex_app.read_thread`; evidence_ref,
recorded_by_thread_id equal to main, explicit_external_review_permission_verified,
scope_verified, reviewed_personally and authorized_scope={task_id,pr_urls:[url]}.
Read the current policy bytes and pass their SHA-256 as expected_policy_digest.
The original bound implementation task is required. Main must verify the actual
human meaning and resolve scope before recording; one call records exactly one
PR, never every PR in a stack or every task. Use merge_prohibited=true for an
explicit review-without-merge instruction. A paused task remains paused.

The recorder preserves prior records, stores the actual human turn's source_at,
and appends a derived allow_merge/nonordinary_change_accepted record only for
sources at or after the standing rule's effective_at. It links that merge record
to the still-valid review grant and exact PR/head. Revocation, a different PR or
head, or disabling the rule invalidates derived permission. A changed head needs
source-backed revalidation within the actual human-authorized scope, not blanket
inheritance and not an automatic demand for a new independent merge grant.
When reusing a source message at a different head, supply head_revalidation with
from_head_sha, to_head_sha, source_message_id, within_authorized_scope=true, a
fresh checked_at and an actual diff/scope evidence_ref; preserve the older record.
Pre-existing explicit allow_merge records remain intact.

Personal inspection remains a prerequisite for important changes. Functions
still needs its own exact per-PR channel permission; the general rule grants no
channel hold override. At merge, the original owner refreshes current applicable
CI, Gatekeeper, all feedback, valid designated Xuanwo approval, repository rules,
ownership and expected-head. Explicit no-merge holds and pauses take precedence.
No admin bypass, publication or deployment is authorized. Already-sent review
receipts remain intact and must not be reposted.

## Recover an unclaimed card after source context changes

If prepare succeeded but claim rejected a changed task context, preserve the
canonical key and existing card. After the original owner begins its next actual
wake, refreshes the PR/head, full feedback, applicable CI and Gatekeeper, and
records its current assessment, call `runtime/control.mjs` with:

```json
{
  "op": "refresh_review_decision_context",
  "key": "review-decision:https://github.com/owner/repo/pull/123:<head SHA>",
  "owner": "<original owner thread ID>",
  "expected_context": {"contract_rev": 1, "context_rev": 5, "plan_rev": 2},
  "evidence": {"executor_thread_id": "<same owner>", "...": "all current normal decision-delivery evidence"}
}
```

The operation is limited to prepared/deferred, never-claimed actions with zero
attempts, no attempt ID, no receipt, and the same contract. It updates only
`runtime_context`, preserves the original key/task/owner destination/PR/head/card,
and saves an audit trail. An actual running owner wake and a clean current plan
are required. Changed contracts, stale evidence, failed gates or any attempted,
sent or uncertain effect are rejected. Then claim and perform the unchanged
final authorize/send/readback/settle protocol. Refreshing is not a send or review
clearance; never create a suffixed notification key to bypass deduplication.

## Reconcile an already-authorized parent squash restack

The same `record_pr_review_authorization` operation supports
`revalidation_only:true` for the existing active maintenance owner. Record its
actual thread in recorded_by_thread_id; do not impersonate main. This path can
only carry an unrevoked, main-origin personal-review and merge grant for the
same accepted task/PR to a new head after its own bound parent PR was verified
merged. Pauses, decisions, explicit no-merge holds and original ownership remain.

Supply the original genuine native human proof with its original checked_at,
exact source fields, fresh head_revalidation and fresh current_pr evidence with
pr_url/head_sha/head_before/head_after/checked_at/evidence_ref. Also include
repository_path, parent_pr_url, old_parent and new_parent. The API reads Git and
the existing lifecycle ledger: both heads must be direct children of the
verified original parent head and its actual merge SHA. Feature diffs must be
identical after removing only blob identities and hunk coordinates. Whitespace,
paths, modes and binary data remain significant. An arbitrary patch-id match
or a caller's within-scope boolean is insufficient. Original human timestamps
and records are retained, and revoking their scope invalidates the carried grant.

This is authorization bookkeeping only. It does not create an automated review
at a new head or convert a skipped Gatekeeper check into approval. If the current
app skipped review and the required current-head automated review is absent,
keep merge blocked and report the app's exact documented manual trigger. Agent
comments and reviewer requests remain prohibited without actual authorization.
