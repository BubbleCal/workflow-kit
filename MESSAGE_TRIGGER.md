# Runtime-authored message trigger

The runtime prepares immutable messages; the dedicated trigger verifies native
state, sends those exact messages and reconciles execution. Yang's 2026-11-12
instruction removes per-run item/time caps and authorizes existing-owner recovery.
The installed authorization is runtime.json/message_trigger/recovery_authorization_ref.
The existing automation runs every ten minutes. Discovery retains its fifteen-minute
start gate; maintenance retains its eight-hour cadence.

## Process the complete work set

Use node /absolute/instance/workflow.mjs runtime trigger --file <request.json>.

1. Save a genuine self read_thread proof and call op=run. If allowed=false, end.
   Otherwise process the complete result of op=pending: messages, unresolved,
   executions and discoveries. There is no item count or fifty-second deadline.
   Refresh the self proof as needed; its actual native turn must remain active.
2. Check every executions entry with its read_arguments. Active owners are left
   alone. For an ended/failed turn obtain includeOutputs=true and enough output
   to retain the exact complete incoming delivery. Call op=watch with wake_id,
   native_proof and fresh actor_proof. Actual native evidence, not a running ledger
   label, decides whether execution ended. A different native turn is preserved.
3. Check every discoveries entry the same way and use op=watch_discovery with
   batch_id/generation. Recovery preserves the source snapshot, pages/cursors,
   coverage and owner-creation receipts. Normal scheduling still enforces the
   discovery start gate. Never invent completed source coverage or effects.
4. Handle every unresolved receipt. If its exact incoming message is found, use
   observe and then watch/watch_discovery for a terminal run. If there is no
   delivery proof, never resend or expire the claim merely because time passed.
   For a claimed attempt known to have stopped before sending, read its original
   sender_turn_id from this trigger's history. Complete terminal sender history
   must end at the exact successful claim command, with no later send. Only then
   call release_unsent with id, attempt_id, sender_turn_id, sender_native_proof,
   owner_native_proof, evidence_ref and fresh actor_proof. The original owner must
   still be at the quiescent preflight turn. The runtime retains the old attempt.
   Unknown outcomes stay unresolved; record the exact blocker and continue others.
5. For every pending message read the named target. Ordinary messages require an
   idle/notLoaded owner with a completed, error-free latest turn. For notLoaded,
   attach the actual list_threads(mode=history,archived=false) page containing
   the exact local thread/cwd as active_listing. Do not navigate the UI.
6. Call prepare with id/native_proof/actor_proof. Get a second fresh target proof,
   then claim with id/digest/native_proof/actor_proof. Only send=true authorizes
   one native send_message_to_thread with the returned arguments unchanged.
   Owner proofs must be at most fifteen seconds old and the second must be newer.
   Refresh proofs throughout a long invocation; never refresh old timestamps.
7. Save the entire native return before another action, then settle the exact
   id/attempt_id with native_result/evidence_ref/actor_proof. Read the target with
   includeOutputs=true and call observe. Only a distinct actual native turn with
   the exact sender and prompt proves execution. An ACK or same-turn steering
   does not. Owner autonomy may bind begin automatically from actual execution.
8. Read pending again to pick up new recovery messages or arrivals. Process every
   eligible new message. Track visited IDs and disposition per invocation: skip
   busy, paused, decision-bound, not-yet-due or unresolved entries after recording
   their blocker, rather than polling them in a tight loop. Finish when no new
   eligible work remains. A blocked owner never stops processing other owners.

Keep summaries compact and save full proofs under observations/message-trigger/
<native-trigger-turn>/. Do not dump entire histories into the working context.
Do not create another timer, coordinator, task/chat, or change models/permissions.
Do not perform product work, external comments/reviews, Slack/email or deployment.
Routine completion is quiet; preserve actual decision/completion notification rules.

## Recovery semantics

watch uses the same exact-delivery terminal verification as manual runtime recover,
including native_trigger, native_followup and already-consumed native_queue runs.
If a valid wait/decision/completion was recorded, it closes the execution without
reopening that outcome. An unfinished ordinary completed turn or an exact native
Bad Request may receive one distinct continuation for that actual ended turn.
The runtime authors it and includes instructions to read saved results and existing
jobs first. Healthy builds, edits and completed experiments are retained.

Failed-state sends are allowed only for that runtime-recorded recovery, under the
actual standing human authorization, for the same original owner and failed turn.
Ordinary messages never bypass a failed target. Repeated failures back off between
invocations; they do not create a same-run retry loop. Unknown errors, interrupted
work, explicit pauses, real human decisions and uncertain external effects remain
protected. Fixed service batches retain their specialized recovery protocol.

Recovery preserves original transport receipts and never claims an unconsumed
queue was consumed. Discovery recovery never advances coverage. Reconciliation
and sending remain separate; a recovery report is not product acceptance.

Native send has no atomic idle-only predicate. Two observations reduce the race
with a new human turn; actual readback detects missing starts or same-turn steering.
Preserve uncertainty rather than replaying an ambiguous send. The trigger never
opens/selects a chat. The old queued-chat loader retains its separate configurable
ten-minute keyboard/mouse-inactivity condition.
