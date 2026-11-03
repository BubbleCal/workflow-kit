# Durable stage continuation

This protocol preserves accepted work through stage boundaries.
Use the existing mailbox/control stores, single coordinator and dispatcher. Do
not add a scheduler or wake a busy owner. Inspect progress_status and the
continuation_candidates returned by begin before broad intake/Notion work.

## Atomic result consumption

For a ready PR, completed stage, permission probe or result declaring remaining
work, mailbox ack/finish requires durable remaining-goal disposition. Call
record_progress with batch_id, event_key, authorization_verified=true,
evidence_ref and goals. It saves stage graphs, concrete pending actions and the
source-event receipt in the same transaction as ACK (ack=false saves without ACK).
Budget exhaustion can finish with processed_keys=[]; unconsumed input survives.
Do not relabel a result or mark its parent complete to bypass this requirement.

Each goal has id, authorization_ref, expected_revision, complete and stages.
Each stage has id/task_id/owner_thread_id/scope_key/state/depends_on. Use:
- pending: concrete action and stable step_id, not a generic continue-later note.
- running: actual turn_id or job_id plus running_evidence_ref.
- blocked: blocker.reason/resume_condition/evidence_ref for the affected scope.
- complete: completion_evidence_ref for this stage's acceptance.

Preserve every requested stage across revisions. A new step needs
progress_evidence_ref; resolving an observed start also needs previous_turn_id.
Reconcile reserved/sent/uncertain starts from original native evidence before
changing their step. Whole-goal completion requires every stage complete plus
acceptance_verified=true and completion_evidence_ref. Registered unfinished goals
block ordinary archival of their owner. CI, approval or natural observation is a
separate affected stage, not a blocker for unrelated authorized work.

## One guarded continuation

1. Call continuations with fresh observations: thread_id, status, turn_status,
   turn_id, checked_at, background_job_running, queued_input, existing_driver,
   hold. Unknown/stale state is not permission to start.
2. continuation_claim(key, observation) reserves a candidate, not permission to
   send. Use its key as the existing control.mjs dispatch action key. Perform
   normal fresh prepare/claim/native-send/settle, preserving scope and models.
3. Immediately call continuation_delivery with key, matching control_action_key,
   outcome=sent/uncertain/not_sent and evidence_ref. not_sent additionally needs
   verified_not_sent=true. Unknown delivery stays uncertain; never retry by age.
   A pre-send control failure may release with its proven non-delivery evidence;
   record the exact blocker instead of retrying unchanged evidence.
4. Native wait/read_thread plus a real command, artifact or substantive analysis
   verifies execution. continuation_started takes key, observation, work_turn_id
   and work_evidence_ref. A transport ACK or active badge alone is insufficient.
5. Update the same goal on its next result. Reconcile an ended owner still marked
   running before selecting another stage; do not strand it behind stale state.

## Legacy-task fallback

After a controller crash, continuation_reconcile reads the same-key control
receipt itself. Supply fresh owner_quiescent/verified_at/evidence_ref. Only a
reserved continuation with no guarded action or a still-prepared action returns
to pending. A claimed/uncertain send remains uncertain; never infer non-delivery
from elapsed time. A sent receipt still needs actual execution evidence.

Each bounded coordinator round calls continuation_gaps with fresh observations.
Without tasks it reads the registry as an index, excludes control/service and
explicitly completed work, and flags owned incomplete tasks without structured
progress. Stored authorization is a selection hint: verify actual human scope
before recording a plan or dispatch. Read a bounded owner increment, save its
cursor, and prioritize known idle gaps. Preserve real background jobs and holds.
For an already-ACKed historical event, enqueue one reconciliation event referencing
its source/head and original authorization. Consume that with record_progress;
never replay the old external action or create a replacement owner. A repair
already started is recorded as running with evidence, not dispatched again.

## Narrow read-only continuation

Use execution_mode=read_only_analysis, starts_heavy_work=false and
required_capabilities drawn only from source_read/connector_read. Fresh evidence
must verify available_capabilities, read_only_capabilities_verified=true,
runtime_permission_turn_id, native_permissions_unchanged=true and
native_approval_pending=false, while reporting the real approval_policy/sandbox.
This changes no native tool permission and allows no VM, benchmark, product edit
or terminal network action. Keep unavailable operations as separate blocked
stages; do not claim Never/Full Access falsely.

## Version-2 transitions

Follow LIFECYCLE.md for actual PR-state obligations, owned-result disposition, typed
wait evidence, operational priority with aging, and cached-state invariant checks
on the existing dispatcher. Enable only at a verified batch boundary; existing
work and external integration opt-ins remain unchanged.
