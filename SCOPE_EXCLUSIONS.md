# User exclusions within a task

A user may remove one workstream while the rest of the task continues. The
coordinator remains the only writer of registry.scope_restrictions and goals.
Never turn a scoped stop into a whole-task hold, a passed check or implicit
permission to bypass repository rules.

Each restriction has a stable key, task_id, status=excluded, source_message_id,
verbatim_text and evidence_ref from the actual native user message. Bind exact
`targets.stages` entries `{goal_id,stage_id}`, `targets.scope_keys` and
`targets.pr_urls`. Include an empty pr_urls array when no PR is excluded.
Existing blocked stages with scope_excluded_by_user=true,
automatic_followup_allowed=false and the exact same user evidence_ref remain
protected while their explicit targets are being recorded. No word matching in
stage names, PR titles or prompts classifies scope.

New dispatch/create actions for a partially restricted task must declare their
actual remaining scope in scope_keys, either in the immutable payload or fresh
action evidence. Evidence allows an existing prepared action to be rechecked
without rewriting its payload. Inspect the actual prompt/goal first: a label
cannot reauthorize excluded work. A matching excluded scope or exact PR fails
prepare, claim and final review-send authorization. Unclassified dispatch is
held for coordinator classification, not another human permission request.
Unmapped PR scope reports scope_binding_required until exact targets or source
classification are available; it is not labelled a user exclusion of that PR.

Record a quiescent excluded stage as state=skipped with
scope_exclusion={key,source_message_id,evidence_ref}, bound to the current
restriction. Do not set completion_evidence_ref. Completed historical stages
remain complete with their original evidence. Active or reserved/sent/uncertain
starts cannot be erased by a skip; preserve and reconcile the original work and
receipts at a safe boundary before recording the terminal skipped state.

Skipped scope is not passed and does not satisfy a depends_on requirement.
Reconcile real dependencies explicitly; independent pending stages remain
eligible. Whole-goal completion still needs actual remaining-contract acceptance
and completion evidence, plus scope_acceptance_ref when exclusions are present.
A skipped stage cannot be silently reopened; a new actual authorization creates
a new scoped stage while preserving the old record.

Scope exclusion has no expiry. Expired CI/access/dependency facts cannot revive
it. Wait and watchdog reconciliation omit the excluded stage while retaining
independent work, active-job protection and existing recovery dispositions.
Excluded PRs create no new lifecycle operation; native PR state, historical
observations and claimed/uncertain external receipts remain intact. Required CI,
full semantic feedback, designated approval and expected-head merge checks still
apply to every permitted PR operation.

Lifting a restriction requires status=released, a different actual
resumed_by_message_id and resumption_evidence_ref. Merely changing a timestamp,
waiting predicate, boolean or status without that new source does not lift it.
There is no automatic PR close, branch/resource deletion, job cancellation,
publication, scope transfer or new scheduler associated with an exclusion.
