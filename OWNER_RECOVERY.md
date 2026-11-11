> Authorized idle-only loading: follow IDLE_DESKTOP_WAKE.md and the actual instance policy. Only the runtime may open an already-queued chat after the configurable input-idle threshold (currently ten minutes); active/unknown activity remains queue-only. This narrows older blanket no-navigation wording; recovery agents must not issue their own UI navigation or duplicate messages.

> Owner recovery runs before source reads. `discovery begin/plan` returns a fixed
> `owner_health` target set when due; observe it even if chat-history pagination or
> another provider is blocked. The batch cannot finish/checkpoint without these
> observations. Queued and uncertain owners take priority over healthy running
> owners; the configured 30-minute per-owner cadence is unchanged. For an idle or
> notLoaded terminal owner with a known unconsumed queue, use the standing-policy
> guarded native recovery hint once, then confirm the real turn and work. Failed or
> uncertain hints remain blockers and are not retried. Main is never a recovery relay.

# Verify actual owner progress

Use the configured Codex discovery scan and regular maintenance audit;
do not create another scheduler or engineering owner. The actual standing request
is saved in the instance's OWNER_RECOVERY_POLICY.json. External observations never
expand the original product scope or authorize publication/deployment.

At each Codex source scan, run `runtime op` with `{"op":"health_targets","limit":8}`.
Read the returned owners using native `wait_threads` with `timeoutMs:0`. If that tool returns an App error, use native `read_thread` with `turnLimit:1`; owner health does not depend on history pagination. Persist
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

For verified idle or notLoaded terminal owners, prefer a distinct recovery hint with intent
`resume_queued_owner` and key `resume-input:<task_id>:<queue_id>`. It references
the existing wake and the real standing authorization; it does not copy or requeue
the work. Tell the owner to process its existing queued message normally and
continue authorized work, not to end after an acknowledgement. The native tool
can deliver that hint into the queued message's new turn. If a terminal turn
contains the exact original prompt but never began/finished its wake, reconcile
that consumed turn through `recover`, then invoke ordinary queue delivery once.
Do not mark this case recovered from the tool's threadId response alone.

The same explicit-human recovery may resume an already-admitted maintenance
service wake. It preserves the exact existing wake, queue and fixed input batch;
it does not admit a new maintenance cycle or shorten its cadence. Normal native
begin and service_begin still verify the actual owner/turn and immutable batch.
Other service lanes remain excluded from this recovery path.

Do not enable automatic use of that surface unless actual non-UI consumption has
been verified on this host and the standing rule permits it. A tool error such as
`Cannot steer ... without an active turn id` remains a client blocker, not recovery.
Keep it visible and report the smallest real human action when no permitted
background path works. Never open chat URLs, activate windows, call direct App
Server RPC, reset queue receipts or send repeatedly to force progress.

`running` proves consumption only when the native turn matches the running wake.
Record actual commands/PR work before reporting a recovered task as progressing.
Task completion still requires every original acceptance and delivery obligation.

When an existing source scan or maintenance audit finds a Linear state mismatch,
compare the bound issue with actual owner evidence and route one deduplicated
follow-up to that owner under OWNER_DELIVERY.md. Do not treat Backlog as proof of
no work, or Done as proof of whole-task completion. Preserve valid waits and
completed-owner archival; do not add another polling service or make discovery
the ticket-state writer.


For a tool-based recovery turn, read native `read_thread` with `includeOutputs:true`
so the exact `codex_app.send_message_to_thread` delegation output is retained. Use
normal runtime `begin` for the original task and wake. It accepts that exact hint
only when the matching guarded recovery action has a successful native receipt.
This records execution through recovery without claiming the original queue item
was consumed; the original message and queue ID are retained. Later delivery of
that old wake skips execution when another turn already owns or finished it.

## Binding an authenticated human relay

A controlled human_input relay is not a literal native human userMessage. Do not
forge it or weaken report/creation guards. `runtime op reconcile_followup` accepts
the existing sent correction/steering action_key, task_id, source_message_id,
actual_human_verified, evidence_ref, expected_context_rev, expected_wake_id and
expected_queue_id (null only if no open wake). Supply fresh original-owner
native_proof with includeOutputs=true and an untruncated native functionCallOutput
for the exact action sender/prompt, plus human_authorization containing the
original actual codex_app.read_thread source proof. The human message ID, thread,
turn and verbatim text must agree with the previously guarded sent action.

The API preserves the sole writer, current contract, holds, jobs and old queue
receipt. An unconsumed old execution is superseded with queue_consumed=false; a
late delivery skips quietly. An active actual relay turn gets an acknowledged
normal report/decide/finish wake. An already ended relay gets ended_unresolved
evidence and normal subsequent continuation, without redoing historical effects.
Uncertain sends, mismatched/expired proofs and competing running wakes fail closed.

For the existing discovery owner use `discovery op begin_followup` with exact
batch_id, generation, expected_mail_key and the same action/source/proofs. Only
its actual active native relay can begin the original batch. No replacement
batch/chat or weaker creation actor is allowed. A still-unsent mailbox delivery
is superseded with its immutable input retained; accepted/uncertain receipts are
left untouched, and late original queue turns skip. prepare_owner/claim/bind/start
still require fresh native actor/project proofs and actual owner execution.


Follow OWNER_CONTINUATION.md: a phase report or negative experiment does not
complete an authorized unfinished goal. Continue bounded independent work, retain
actual jobs/waits, and request only a material human-only decision. Conditional
holds use their original wording and observable release predicate; unconditional
pauses and all external-action gates remain. Record remaining goal and next step.


Scoped state reconciliation uses `task op reconcile_completed_projection` only
when the latest actual decision is the original whole-scope completion and every
later pending event is an evidenced source-only update. Supply the exact context
revision, completion ID, original wake/queue IDs, fresh quiescent owner proof,
cleanup evidence and one explicit disposition per source event. New human
commands, material decisions, changed acceptance, pauses, uncertain effects and
shared-owner queues are protected. Supersession retains the original unconsumed
queue receipt; a late delivery skips without replaying work. Result delivery and
archival still require their existing independent guards.

`task op reconcile_review_workspace` corrects only an accepted original read-only
review's catalog/contract workspace to its verified native project placement.
Supply both revisions, original owner, actual maintenance authority and fresh
quiescent native proof. It changes no PR scope or permissions and does not
re-run or complete the review on its owner's behalf.

For a proven schedule registration failure caused by an outdated prompt hash,
first reconcile the binding to the actually authorized instruction. Then
`runtime op recover_schedule_event` takes `schedule_id`, `expected_prompt_sha256`,
`original_request_file`, `original_failure_file`, `evidence_ref` and verified
`human_authorization` with matching source thread/turn/message/verbatim fields.
It validates the original captured producer turn at its original capture time;
it never refreshes proof timestamps or fabricates a producer. The normal dated
occurrence key deduplicates replay and preserves original trigger time, owner,
schedule, pauses and execution guards.


## Stable host identity and legacy evidence

On macOS, queue and desktop capability proofs bind to a SHA256 of the actual
IOPlatformUUID and user home, rather than the network-dependent hostname. The raw
hardware UUID is never exported. A changed machine, home or CLI still invalidates
capability evidence; unavailable hardware identity fails closed.

An acknowledged maintenance owner may explicitly run
`node workflow.mjs runtime migrate-host-binding --file <request.json>` with genuine
human authorization, fresh current-turn native proof, the expected runtime-file
digest, and original queue/desktop evidence paths. Migration validates both proofs
against the actual current legacy host and installed CLI before binding them to the
stable identity. It preserves immutable originals, digests, all observations and
original verification times. This records an identity migration, not a fresh native
loading trial. A mismatched legacy host requires new genuine evidence instead.
`restore_desktop:true` restores only an already-authorized idle-only policy; the
configured input-idle threshold, exclusions and all task holds remain intact.


Runtime-authored direct messages are tracked by rt_trigger_messages under MESSAGE_TRIGGER.md. Do not resend a pending native receipt or an uncertain trigger attempt. A distinct native turn with the exact original trigger delegation is required for begin/recovery; old Codex queue receipts are retained and never silently converted.


Discovery may use a single guarded human_input intent resume_discovery_batch for the exact original sent native queue/batch/generation when its actual owner is quiescent. Include fresh native identity/unarchived proof and genuine human_authorization. Stable key: resume-discovery:<batch_id>:<generation>:<queue_id>. This is a distinct setup hint, never a queue replay or a consumption claim. The receiver uses begin_followup with the exact incoming delegation. If that hint actually ended before begin, discovery op recover_unstarted_followup requires its real completed native proof, original human source, effects_reconciled:true and no acknowledged run for that generation; it checkpoints the same source batch and retires only the original delivery with the queue receipt preserved. Coverage never advances from this administrative recovery. Normal discovery/trigger processing performs the next generation under the existing cadence.

For an already-running authorized original-owner correction with a stale needs_decision projection, runtime reconcile_followup may use projection_only:true, the exact expected_decision_id, fresh full incoming native proof and original human_authorization. It requires no competing wake and a newer sent original-task instruction. This binds only actual execution: the existing task row, decision, contract, waits and external holds remain unchanged; it grants no delivery permission and sends no message to the active owner.


Native trigger discovery begin is acknowledged from its exact registered sender/input and recorded native creation run; it does not require an old Codex queue receipt. Its unbatched source input remains trigger_pending until actual source finish/checkpoint settlement. Health reports execution_started for genuine followup/trigger turns while queue_consumed is reserved for actual native_queue consumption.

### Failed manual continuation

A `native_followup` wake can end with a failed native turn while its runtime row
still says running. `runtime op recover` verifies the exact recorded sent human
action and untruncated incoming delegation, including a terminal `systemError`,
then records ended_unresolved without claiming old queue consumption or completion.
Preserve healthy background jobs and source edits. A fresh, explicitly authorized
human correction may reach an exact terminal Bad Request owner using
`terminal_failure_proof`, expected/actual turn IDs and `native_resume_only:true`;
automatic dispatch remains blocked. Missing, stale, active or different-turn
evidence cannot authorize this path. Never loop retries after another failure.
