# Deterministic delivery, continuation and waiting

Enable this contract only for the current instance under the user's actual setup
or upgrade authorization. Preserve existing roles, scope and external-write gates.

## Cutover

New tables are additive. `mailbox transition_status` shows the contract version.
After reading this guide and registering the current PRs, activate with JSON
stdin: `{"op":"activate_transitions","source_message_id":"ACTUAL_USER_MESSAGE_ID","actual_human_verified":true}`.
Every reserved batch captures its version. Existing batches continue version 1;
new batches use version 2. Keep all queued actions, receipt keys, jobs and owners.
Do not migrate by replaying already delivered PRs or declaring parent tasks done.

## PR facts produce obligations

The coordinator registers each deliverable once through control.mjs
`lifecycle_track`: repository, pr_number, task_id, owner_thread_id and the original
authorization_ref. Optional readiness contains exact `head`, `validation_ref`,
`technical_review_ref`, `validation_passed=true`, `technical_review_passed=true`.
Paths alone are not passing validation. Ownership cannot silently move.

Use connected GitHub reads to build the current snapshot, or the existing-account
read-only fallback:

```sh
node runtime/fetch-pr-state.mjs --repo owner/repo --pr NUMBER --output observations/pr-state.json
```

Then control `lifecycle_observe` takes snapshot_file or snapshot. Required facts:
repository, pr_number, head_sha, state (open/closed/merged), draft, updated_at,
checked_at and evidence_ref; merged also needs merged_at and merge_sha. A failed
read is unknown, never closed or an empty feedback feed. The lightweight collector
collects current-head individual check runs and commit statuses as observed CI,
without inferring required-check policy or approval. Follow CI_FAILURES.md for
partial failures, exact-job deduplication and legitimate package waits. Open and
closed-unmerged state facts older than 20 minutes require refresh. A validated
merged fact with exact merged_at and merge_sha is durable for post-merge scope
disposition; cache age alone cannot supersede that obligation. Existing external
gates still require their own fresh checks immediately before an operation.

`feedback_ingest` now also consumes the collector's `pr` metadata and binds the
full feedback read to the PR updated_at. Changed metadata requires a fresh feedback
read, and changed bodies/head require semantic reassessment. Unchanged assessments
are reused. `feedback_assess` and observations recompute durable obligations.
The same ten-minute mailbox plan recomputes them from saved facts for every active
watched PR, regardless of the engineering chat's active/idle badge.

The next actions are explicit:
- refresh_pr / refresh_feedback: obtain missing or expired owning-source facts.
- assess_feedback: interpret unassessed all-author feedback under REVIEW_FEEDBACK.md.
- repair_feedback / decide_feedback: route valid findings to the original owner,
  or record the exact scope decision. COMMENTED findings remain significant.
- obtain_readiness: inspect current-head validation and technical review; reuse
  valid evidence. Do not wake a busy owner or add a preparation-only phase.
- deliver_review: use existing pr_ready/slack_pr gates and the review window.
  Read actual receipts for this exact head and preserve the existing PR/head
  idempotency keys. A new review head requires its own readiness and the existing
  explicit delivery gate; an old-head receipt cannot prove current delivery.
  A prior ready receipt with a stale draft snapshot
  causes a metadata refresh, never a blind repeat of the ready transition.
- check_merge: inspect approval validity for the current PR (MERGE_APPROVAL.md), required checks and repository rules,
  then use the existing conditional merge guard when eligible.
- refresh_ci: refresh incomplete, stale or mismatched individual CI source facts.
- triage_ci: classify new failed/cancelled current-head checks even on drafts or
  while other checks run. Save a concrete repair or verified wait; do not just
  wait for approval or all jobs to finish. Same-head failure identities deduplicate
  across polls and draft changes. Completed triage preserves required merge gates.
- resolve_closed: stop waiting for merge. Decide whether to reopen, replace,
  supersede, abandon within original scope, or seek a real human decision.
- decide_after_merge: record remaining adoption, publication or acceptance work,
  or verified original-contract completion. Merge alone never closes the parent.
- reconcile_delivery: preserve claimed/uncertain external effects and reconcile
  the existing attempt before any retry.

`control lifecycle_plan` reports and queues concrete actions; `lifecycle_status`
shows their durable state. Process successive actionable transitions of the SAME
PR within the current batch and five-minute budget; do not wait an extra tick for
each small read/assessment step. New unrelated inputs remain outside the batch.
Obligations use stable semantic identities; changed poll times/file paths do not
create new work. A real reopen, new head or later due recheck has its own identity.

## Acknowledgement requires a real disposition

Lifecycle mailbox items include lifecycle_key and lifecycle_generation. Use
control `lifecycle_resolve` with key, generation and evidence_ref:

- `disposition=receipt`, control_action_key: a matching sent canonical-URL action.
  Current state may already have moved forward; the old obligation then retires
  with an evidenced superseded disposition.
- `disposition=progress`: first call mailbox record_progress for this EXACT
  lifecycle event with ack=false. Then pass progress_event_key to lifecycle_resolve.
  It reads the actual progress event and task binding, not a caller's success flag.
  Closed/merged outcomes need scope disposition or successors. Repairs need a
  durable original-owner action/real wait, not an ACK pretending execution began.
- `disposition=wait`: supply the typed PR condition below. A free-text waiting note
  does not satisfy this operation. Failed required CI must be triaged first.

Finally mailbox ACK/finish verifies the recorded lifecycle disposition. A stale
wait cannot be acknowledged as still valid. Already resolved pending diagnostics
are retired before admission; in-flight batches are preserved. Due rechecks do
not change the generation while its previous source item is unacknowledged.

## Close a merged PR from its current refresh item

If this fixed batch contains refresh_pr, perform the actual same-PR read and
lifecycle_observe normally. A resulting decide_after_merge item may fall outside
the immutable batch; do not add it to the snapshot or fake its progress record.
Instead record_progress(ack=false) for the ORIGINAL refresh event, covering its
actual source task and the accepted completion or concrete remaining successors.
Parent/project completion is not required to retire an already merged PR watch.

Use control lifecycle_resolve with the original key/generation,
disposition=progress, progress_event_key equal to that original key:generation,
evidence_ref, and expected_head_sha plus expected_merge_sha from the verified
merged read. The runtime requires that the current action is decide_after_merge,
that the exact PR's merged snapshot was read within 60 seconds, and that the real
progress event covers its task. Refresh again if the source read aged while
recording progress; retain the exact head/merge binding. This explicit path can
resolve an original refresh already superseded by that same observation.

Wrong task/source/head/merge, unmerged state, stale proof or a governed mirror
route cannot use this path. Other transition types keep their existing behavior.
After acceptance, retire only this PR watch and supersede its remaining queued
lifecycle intents. Existing mailbox payloads/batches, parent goals and control
side-effect receipts remain unchanged. ACK the original event normally; ordinary
pending-diagnostic reconciliation retires redundant queued same-PR notices.
No new merge/ready/Slack/archive operation occurs, and uncertain external actions
still require their own normal reconciliation.

## Every owned result has a next step

Use kind=worker_result, task_id, owner_thread_id and evidence_ref for meaningful
terminal work. Version 2 also recognizes legacy event packets with task+owner,
regardless of their event-name spelling. Accepted results require record_progress
before ACK. The disposition must cover the source task; an explicit "remaining
work" result cannot be consumed by claiming every goal complete.

A result leads to a concrete pending action, an actually running turn/job, a
verified blocked condition, a scoped decision, or accepted completion/no-go.
Original stages and scope remain protected by ProgressLedger. Research can finish
with a justified conclusion; do not invent implementation or production acceptance.
Tests passing alone is not whole-goal completion.

A ready_pr/pr_ready/ready_for_review result also requires record_progress.artifacts
to bind its actual deliverable before ACK. Each artifact has kind=pr,
role=deliverable, repository, pr_number, task_id, owner_thread_id, and optional
readiness as above. These must match the recorded task/owner and original grant.
Dependency or reference PRs are not deliverables. Existing active workers receive
the reporting contract only at the next otherwise-needed dispatch; no broadcast.

## Existing completed-assessment envelopes

For the existing kind=event, event=assessment_complete producer, the combination
assessment_complete=true, nonempty task_id/thread_id and report or evidence_ref
identifies an owned assessment when owner_thread_id is absent. Version-2 batches
use that thread_id as the source owner without rewriting the immutable packet.
Generic recipient/thread fields, incomplete assessments and missing evidence do
not get this interpretation. Canonical owner fields retain their existing meaning;
version-1 in-flight batch contracts remain unchanged.

These results receive urgent owned-result priority and cannot ACK without actual
source-task progress. At least one recorded stage must retain that source task
and owner. Declared task_complete=false, resource_cleanup_complete=false or a
nonempty remaining_required list prevents consuming the result as all-goals-done:
persist the concrete remaining cleanup/delivery step or a verified wait. An
assessment answer may be delivered while resource closure remains; do not rerun
measurements or convert optional design recommendations into implementation.
New producers should use kind=worker_result, owner_thread_id, evidence_ref and
current_task_complete=false whenever actual task obligations remain.

## Verifiable waiting

For a new or changed blocked stage in version 2, blocker.condition is mandatory.
Unchanged legacy stages survive a different stage's update, but the invariant
sweep creates a separate wait_reconciliation item for their missing evidence.
For a version-2 watchdog recovery, disposition=blocked also needs wait_condition.

PR condition: `{kind:"pr",pr_key:"owner/repo#123",head:"...",expected:"approval_pending",next_check_at:"..."}`.
Allowed expected values are approval_pending, ci_pending and review_window.
The ledger verifies open/current head, readiness/delivery and nonblocking full
feedback, or the actual review-window rule. Approval waits need snapshot
approval_state=pending, approval_head matching head_sha and approval_evidence_ref.
CI waits need checks_state=pending, checks_scope=required, checks_head matching
head_sha and checks_evidence_ref from the actual required-check evaluation.
Unknown fields do not become successful observations. next_check_at is in the
future and no more than one hour away. The resolved wait preserves its fact proof.

Other conditions refer to facts recorded with mailbox wait_observe. Required:
fact_key, kind, subject, data, observed_at, expires_at, evidence_ref. Facts must be
from an actual source read within one minute. External facts expire within one
hour; record a new real observation to renew them, not a rewritten reason.

- dependency: data={requirement,available}; wait condition repeats the exact
  subject and requirement. Only available=false is a valid dependency wait.
- job: data={job_id,state}, with an exact resource subject. Only pending/running
  of that same job can justify waiting. Completion/failure requires a next step.
- access: data={available}; only verified unavailability justifies waiting.
- human: data={source_message_id,actual_human_verified:true,pending,decision_id},
  subject=decision:D-ID; or data with task_id and hold=true, subject=task:T-ID.
  The checker also reads the current decision/registry hold, so an answered
  question invalidates an old pending fact. Explicit holds may wait without expiry.

Generic condition: `{kind:"dependency",fact_key:"pin-api",subject:"sophon:lance",requirement:"JsonQuery accessors"}`.
Expired, mismatched or changed facts create one wait_reconciliation event per
goal/stage/condition/fact-version. Refresh the fact and use mailbox wait_resolve with
batch_id/event_key/evidence_ref if the same wait is still valid. Otherwise update
the stage to its concrete successor through record_progress. Do not guess jobs
are absent, replace owners or repeatedly wake an active worker to refresh status.

## Priority and invariant sweep

New coordinator batches prioritize actual human input, material feedback/closed-PR
handling and CI triage, review delivery/merge and stage results, then due waits/recovery and
configuration, then intake/projection. Waiting items gain priority every 30
minutes; human input remains first and preserves its own order. Within an equal
non-human priority, order by last completed-batch opportunity or original enqueue
time. Returning an unprocessed prefix cannot indefinitely exclude the next
waiting item. Unsent reservations do not count; historical finished snapshots
provide durable rotation without rewriting events. The existing fixed input batch and soft work
budget remain; neither is a concurrent engineering-task limit.

Every existing plan checks all cached watched PRs, blocked goal predicates and
accepted unfinished tasks without a remaining recorded stage,
not just the four native-owner snapshots. No external source/network read occurs
in the dispatcher. Missing/stale sources become concrete read obligations for the
coordinator. Native owner scans, user holds, approval UI, receipts, unique worktree
ownership and all external communication rules still gate actual execution.

## Optional external integrations

If instance.json disables external Slack delivery, open ready PRs produce
deliver_local instead. Record actual local delivery and task-bound progress before
resolving that obligation. This does not enable Slack, merging, Notion, or a new
notification channel. Original task acceptance remains separate.

Owned terminal results enter the urgent non-human operational tier immediately, without waiting thirty minutes for aging. Human input stays first, equal-priority rotation remains, and original progress/ACK/side-effect guards still apply. No concurrency or dispatch-count cap is introduced.
