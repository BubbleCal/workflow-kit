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
