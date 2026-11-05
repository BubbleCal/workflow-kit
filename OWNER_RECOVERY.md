# Verify actual owner progress

Use the existing ten-minute Codex discovery scan and regular maintenance audit;
do not create another scheduler or engineering owner. The actual standing request
is saved in the instance's OWNER_RECOVERY_POLICY.json. External observations never
expand the original product scope or authorize publication/deployment.

At each Codex source scan, run `runtime op` with `{"op":"health_targets","limit":8}`.
Read the returned owners using native `wait_threads` with `timeoutMs:0`. Persist
the actual tool result and call `health_observe` with task_id and
`native_proof={source:"codex_app.wait_threads",checked_at,readback,evidence_ref}`.
The persisted cursor is the last observation time: owners rotate across bounded
scans. Future schedules, completed tasks, services, pauses and human decisions
are excluded. A valid CI/dependency/job wait is not stalled work.

A native failed/context-window turn can remain falsely marked running. Read that
owner's latest actual turn with `read_thread`, preserving its full queued prompt.
After checking saved work and any outstanding effects, use the existing guarded
`runtime op recover` with the fresh proof. It retains the original receipt and
emits a successor for the same owner. Invoke the normal ReactiveDriver delivery
once and verify a new turn and substantive work. Do not clear history, change
models/permissions, stop healthy commands or claim success from queue acceptance.
After a second distinct context-window failure, save a short checkpoint and use
the authorized fresh-owner handoff path if applicable; do not retry indefinitely
or infer new-chat authority from an error string alone.

For a queued/unconsumed wake, keep the exact queue ID and record it as unresolved.
Reading/acknowledging the diagnostic does not resolve it. After processed health
mail, unchanged unresolved wakes are revisited with bounded 30/60-minute backoff
through the existing audit; a pending health item is not duplicated.

The native send-message tool is an optional recovery surface, not an assumed
working fallback. An explicit human request may use guarded human_input intent
`resume_existing_wake`, with a fresh terminal idle/notLoaded snapshot, the actual
queued wake/queue ID and its exact original prompt. The stable action key is
`resume-execute:<task_id>:<queue_id>`; prepare and claim validate the original owner,
active scope and unconsumed receipt. Supply `native_resume_only:true` and the exact
human source. Preserve the tool result immediately. Never retry uncertain sends.
An old message arriving after recovery skips begin once its wake has a different
actual turn or is terminal; this prevents a second product execution.

For verified cold owners, prefer a distinct recovery hint with intent
`resume_queued_owner` and key `resume-input:<task_id>:<queue_id>`. It references
the existing wake and the real standing authorization; it does not copy or requeue
the work. Tell the owner to process its existing queued message normally and
continue authorized work, not to end after an acknowledgement. The native tool
can deliver that hint into the queued message's new turn. If a terminal turn
contains the exact original prompt but never began/finished its wake, reconcile
that consumed turn through `recover`, then invoke ordinary queue delivery once.
Do not mark this case recovered from the tool's threadId response alone.

Do not enable automatic use of that surface unless actual non-UI consumption has
been verified on this host and the standing rule permits it. A tool error such as
`Cannot steer ... without an active turn id` remains a client blocker, not recovery.
Keep it visible and report the smallest real human action when no permitted
background path works. Never open chat URLs, activate windows, call direct App
Server RPC, reset queue receipts or send repeatedly to force progress.

`running` proves consumption only when the native turn matches the running wake.
Record actual commands/PR work before reporting a recovered task as progressing.
Task completion still requires every original acceptance and delivery obligation.
