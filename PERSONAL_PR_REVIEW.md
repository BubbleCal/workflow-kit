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

Explicit permission to merge a nonordinary change is separate from review
delivery. Main records it in `PR_REVIEW_CHANNELS.json.merge_authorizations` with
the exact `pr_url`, `head_sha`, `decision:allow_merge`,
`nonordinary_change_accepted:true` and the same verified human provenance.
It releases only that PR/head's nonordinary-change restriction. Full feedback,
designated human approval, CI, repository rules, ownership, no-admin and
expected-head guards still apply. Review permission alone never permits merge;
neither permission authorizes publication, deployment or another PR in a stack.

After clearance the original owner refreshes the normal review gates and delivers
the canonical URL once to the authorized destination. Functions scope holds need
their own matching `pr_authorizations` entry under FUNCTIONS_REVIEW_DECISIONS.md;
one explicit user reply may authorize both, but neither is assumed. No new merge,
release or deployment authority is granted. Already-sent receipts remain intact;
this rule does not repost PRs or retrospectively undo review delivery.

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
