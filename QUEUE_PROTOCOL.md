# Fixed batches and quiet coordination

Resolve all role IDs from instance.json. Paths are relative to this installation directory. Invoke the relevant runtime/*.mjs with a JSON object on stdin. Never interpolate unsanitized content into shell code.

Only the dispatcher delivers automatic messages to coordinator, inbox and maintenance. It runs one existing ten-minute heartbeat. The deterministic mailbox coalesces reconciliation with a fifteen-minute minimum, handled on the next actual trigger (normally twenty minutes while otherwise idle), represents source intake with intake_due, and admits the daily 05:00 maintenance request. Busy roles receive no automatic messages; new inputs remain durably queued.

Dispatcher sequence: watchdog_targets; compact native snapshots for at most four returned owners plus three lanes; annotate checked_at at actual retrieval time; mailbox plan with watchdog_round_id. For each returned delivery, take a fresh single-target idle snapshot, call authorize_send, and send the exact persisted prompt only if send=true. Record delivery immediately. Unknown outcomes remain uncertain for destination reconciliation. End the turn without waiting on workers or reading project/source systems.

Coordinator sequence: read POLICY.md and the fixed batch; begin; inspect only its snapshot and relevant current evidence. Use control status for deferred/prepared reviews. Process real human input, execution results, recovery, concrete successors and enabled delivery before bounded source intake. New items do not enlarge this batch. A five-minute soft budget ends at a safe tool boundary with finish; unfinished items return to pending. Do not perform deep technical implementation in the coordinator.

Stage events require record_progress before ACK. Recovery events require watchdog_resolve. Current owner work, permissions, jobs and holds remain authoritative. Unknown job state is a reconciliation need, never evidence that a restart is safe. Use STAGE_CONTINUATION.md and CONTINUATION_FALLBACK.md.

Workers enqueue immutable events and end without sending messages to control chats. Use stable keys tied to actual result/head/question identity, not poll timestamps. Include remaining scope and concrete successor or real blocker. Notifications use control prepare kind=notify; the wrapper enqueues and forbids direct send.

The inbox queues exact actual human instructions and ends promptly. It answers status from saved evidence; new technical investigations go to the execution owner through the mailbox. A notification batch is presentation only: begin, show supplied text, finish. Do not answer another machine's queue or turn a notification into implementation.

Maintenance runs a twenty-minute soft batch, changes only workflow-local code/docs and tests within scope, and queues operational results. It must not write coordinator-owned registry/decisions or external services. Ordinary daily audits remain in reports. Only real decisions or meaningful requested completion enter the inbox.

Use existing control prepare/claim/settle, exact current-head guards and native conditional operations for side effects. For slack_pr and pr_ready, authorize_review_send after claim is mandatory; obey its exclusive deadline. No direct non-draft publication or other channel may bypass the review window. External features require this project's explicit bindings and authorization.

Before maintenance admission and final send authorization, the mailbox supersedes health events whose recovery has a durable current disposition. Immutable content and resolution evidence are retained. Already sending/running batches and unknown cases remain untouched. A later recovery generation can escalate once independently.

Follow REVIEW_FEEDBACK.md for all-author PR feedback intake and current-head semantic assessment. Formal COMMENTED and green CI do not imply absence of material findings. Preserve existing implementation scope and repair routes; never post/resolve comments or duplicate a busy owner.

## Unloaded owner recovery

Follow LIVENESS_RECOVERY.md after a local app interruption. Ordinary dispatch can
resume a verified terminal unloaded owner under the same authorization, job,
permission and ownership checks. Do not invent human input or relabel native
status. Scheduler recovery and actual engineering recovery are separate facts.

## Optional outcomes projection

When explicitly configured and authorized, follow OUTCOMES.md to maintain a separate outcomes page from accepted evidence in existing coordinator rounds. Preserve the decision page, task acceptance and manual notes; do not add timers or reporting-only worker messages.

Resolved unsent health diagnostics are retired atomically before watchdog observation
can reopen a due recovery generation. Preserve the old generation and disposition
in superseded_health. This includes reserved-unsent batches, while sending, sent,
uncertain and running batches remain untouched. New genuine missed generations
retain their own escalation keys; retiring an old alert does not close the task.

Follow MODEL_SELECTION.md for explicit native model/effort selection on new
execution chats; requested Fast-off is not an applied setting when the native
creation interface does not expose a tier control.

Explicit human coordinator model changes may carry native_model.model/thinking
in a verified human_command with intent=coordinator_model_change. The target must
be the bound coordinator and user_model_request_verified must reflect an actual
human source read. After the ordinary idle checks, authorize_send returns only
those two supported fields; the dispatcher passes them to the native send tool.
Ordinary events and other lanes cannot change models. Fast/service tier is not
a supported override; never claim it applied from the model choice.

## Version-2 transitions

Follow LIFECYCLE.md for actual PR-state obligations, owned-result disposition, typed
wait evidence, operational priority with aging, and cached-state invariant checks
on the existing dispatcher. Enable only at a verified batch boundary; existing
work and external integration opt-ins remain unchanged.

For explicitly governed dependency mirrors, follow DEPENDENCY_PROVENANCE.md.
Manual mirror PRs are not a substitute for published upstream and verified
automatic synchronization. Keep this optional policy scoped to its own instance.

For merge approval follow MERGE_APPROVAL.md. When the review commit differs from current head, use fresh retained-approval evidence instead of assuming dismissal or rewriting the review commit. Only the existing coordinator merges after ordinary feedback, CI and conditional-head checks. Preserve prior receipts and uncertain attempts.

For fully completed unloaded owners, use the existing guarded archive path with truthful fresh terminal evidence as described in LIVENESS_RECOVERY.md. Do not wake a worker merely to archive it. Preserve unfinished-parent protection and native readback.

Within the same aged priority, rotate unprocessed non-human inputs using their last completed-batch opportunity or enqueue time. Preserve human-command priority/order, fixed batches and receipts. Health distinguishes queue_admission_gap from recovery_unhandled; no extra timer or worker wakeup.

Follow CI_FAILURES.md for current-head individual failed jobs even on drafts or partially running workflows. Exact-task triage records an original-owner successor or typed package/access/job wait before ACK. Preserve existing repairs and unchanged-failure deduplication; triage does not establish green CI or authorize retry/merge.

Recovery diagnostics may retire from a unique actual continuation for every affected task, matching owner, old preflight turn, goal/stage/scope and current-generation execution evidence. Preserve unfinished goals and original source ACK; do not dispatch again. See CONTINUATION_FALLBACK.md.

Owned terminal results enter the urgent non-human operational tier immediately, without waiting thirty minutes for aging. Human input stays first, equal-priority rotation remains, and original progress/ACK/side-effect guards still apply. No concurrency or dispatch-count cap is introduced.

On the same terminal owner turn, a newly observed strict task subset reuses an unresolved covering recovery with an unconsumed source and no current disposition. Preserve original scope/keys; new tasks/turns and explicit queued/blocked/protected/resolved cases remain independent. Existing duplicates are reconciled by the coordinator, not rewritten.

Verified merged PR facts remain durable for post-merge disposition. The current same-PR refresh event can retire that watch after exact-event/task progress plus fresh expected head/merge-SHA validation under LIFECYCLE.md. Preserve fixed batches, unfinished parents, external action receipts and all merge/release guards.

The known assessment_complete envelope may use thread_id as source owner only when canonical owner is absent and explicit completion/task/report evidence is present. Version-2 batches require task/owner-bound progress and preserve declared remaining cleanup. Keep immutable payloads; generic thread targets are not owners. See LIFECYCLE.md.

## Bounded completion admission

Choose that protected result by its last completed-batch opportunity as the first
non-human input, falling back to enqueue time. Mere inclusion later in an
unfinished batch does not consume that early opportunity. Keep ordinary queue
rotation for other positions, human precedence, source-task ACK guards and all
in-flight snapshots unchanged. This improves admission fairness, not a guarantee
of immediate acceptance or permission to restart a worker.

For new version-2 coordinator batches, reserve the first non-human position for
one canonical worker_result or explicitly completed legacy assessment when one
is pending. Choose it using existing retry rotation, so a repeatedly unfinished
result cannot monopolize that position. Human commands retain their order and
precedence; all remaining positions retain ordinary priority, aging and rotation.
This prevents a full aged diagnostic backlog from excluding fresh results.
It does not guarantee acceptance: inspect evidence and record source-task
completion or concrete successors before ACK. Follow this initial result
acceptance before broad recovery scans. Keep existing batch size, soft budget,
in-flight snapshots, native idle checks and task concurrency unchanged.

## Draft observed after a ready transition

A sent ready receipt is historical evidence, not proof that a PR remains ready.
When the exact-head draft snapshot predates that receipt, refresh the source.
When a fresh read after the receipt still shows draft, emit reconcile_draft
instead of repeatedly refreshing or automatically marking ready again.
Inspect actual timeline, actor, review dismissal and full feedback to determine
whether readiness was withdrawn, the receipt disagrees, or an owner repair is
needed. Preserve the reviewer decision and original owner; do not infer that
ready evidence, a prior Slack URL or green CI authorizes reversing the draft.

Resolve with exact-event, source-task record_progress(ack=false), then
lifecycle_resolve(disposition=progress, progress_event_key=that event). Record
a concrete successor or verified wait; neither old delivery receipts nor task
completion satisfy this obligation. The same handled draft episode does not
repeat on each poll. A new head/state transition or ready action retains its
own disposition. Existing CI triage, full-feedback gates and uncertain sends
remain prior checks. The watch/parent goal stay open; a later ready/Slack/merge
operation still needs its ordinary actual authorization and delivery guards.

## Preserve evidenced waits in the owner sweep

Before selecting or observing an idle owner/task, reuse WaitLedger checks for
all its unfinished stages. If every stage is blocked by a currently valid typed
condition, leave its existing job/dependency/review wait alone. Do not interpret
the idle chat as forgotten execution. Missing, expired or changed facts remain
actionable; any independent pending/running stage keeps ordinary reconciliation.
This uses the same source identity, freshness and PR/human rules as wait handling,
not an extra timer or an unchecked existing-driver flag. Previously queued cases,
source ACKs, goals and native jobs remain unchanged; the coordinator reconciles
existing diagnostics through the normal evidenced disposition.

## Task-only choices

Follow TASK_DECISIONS.md. New notifications and inbox presentation use parent T
numbers plus descriptive subjects. Route decision replies with decision_reply
context while preserving verbatim human text and old aliases. Do not invent a
choice when several pending questions match. Existing queued keys/payloads and
receipts remain immutable; a display update is not a new notification or consent.

Follow TASK_OWNERSHIP_AND_PR_GATES.md for actual canonical owner/handoff and
CI/Gatekeeper proof fields. A generic owner_matches flag is insufficient; do not
recycle idle/completed chats. Apply the new gates to undelivered open PRs without
reposting old URLs or toggling ready unnecessarily. No permission/model changes.

## Urgent terminal-owner recovery

Canonical recovery inputs with event=continuation_recovery enter urgent
non-human priority immediately. Do not impose a thirty/sixty-minute aging wait
before reconciling a completed owner with unfinished work. Human inputs retain
precedence, the protected completion-result slot and ordinary retry rotation
remain, and generic recovery/diagnostic priorities are unchanged. Priority only
controls admission; current scope, native jobs/holds, typed waits, uncertainty,
original ownership and guarded dispatch still decide whether work can resume.
No new timer, concurrency limit or automatic restart is introduced.

## Scoped user exclusions

Follow SCOPE_EXCLUSIONS.md. Persist exact actual-user stage/scope/PR bindings;
excluded work cannot revive through expiring waits or automatic recovery. Record
quiescent excluded stages as skipped, never passed. Preserve active/uncertain
receipts, completed history and mandatory CI. Explicit remaining scope lets
independent work continue; only a new actual user source can lift the exclusion.

## Immediate human producer integration

Follow IMMEDIATE_HUMAN_TRIGGER.md. Authenticated actionable human admission now
returns a durable immediate intent and guarded native service-call sequence.
Follow it before ending; original coordinator direct-send prohibition remains.
Busy service intents coalesce, plan watermarks prove actual opportunity, and
uncertain transport receipts remain separate. Pure answers/machine events do not
trigger. Preserve cadence, native settings and existing task ownership.
