# Continuation fallback on the existing dispatcher

This protocol adds bounded recovery to
the existing stage-continuation repair. It uses no new scheduler or worker owner.

The ten-minute trigger calls watchdog_targets. A durable cursor selects at most
four accepted, unfinished owners per pass, combining registry candidates with
registered goal stages. This bounds inspection work, not engineering concurrency.
Five-minute slots are persistence identities independent of the ten-minute trigger. Repeated selection in the same slot is idempotent. The trigger reads
only compact native status/latest-turn snapshots for those owners, alongside the
three control/maintenance snapshots, and passes watchdog_round_id to mailbox plan.
Up to two slots revisit unresolved recovery cases; the remaining sweep advances
its durable cursor. Repeated identical blockers back off from five minutes to at
most one hour; a real human hold waits for its source change.

An idle terminal owner with indexed remaining work creates one persistent
continuation-recovery case even if no worker result event exists. Active or
approval-waiting owners, observed jobs, holds and existing drivers are preserved.
Unknown job/permission/dependency state is a reconciliation request, never proof
that restarting work is safe. The dispatcher never sends to engineering owners.
The persisted case outbox is re-flushed after a crash without changing its key.

## Coordinator recovery

Handle recovery items before broad intake. Verify the original human scope,
remaining acceptance, real jobs/holds, stage dependencies and existing control
receipts. Use STAGE_CONTINUATION.md to repair the concrete plan and perform the
normal guarded continuation once. Do not add a preparation-only turn where actual
permitted work can proceed. No replacement chat, fake human_input or native
permission change is authorized by the recovery event.

Before ACK, call watchdog_resolve with case_key, recovery_key, disposition and
evidence_ref. Supported dispositions:
- queued: continuation_key must refer to a matching durable continuation. This
  preserves the work but is not successful execution; further missed opportunity
  can escalate until actual start is verified.
- running: new_turn_id must differ from the detected old turn and work_evidence_ref
  must prove actual work, not an ACK or repetitive status commentary.
- blocked: reason, resume_condition and future next_check_at are required. Use a
  measured job/dependency/access recheck interval; human_hold=true may wait for a
  real human change without a timer. Recheck the evidence instead of renewing stale
  text. This does not permit repeatedly retrying the same failed side effect.
- complete: actual scope completion evidence is required and no registered owner
  goal may remain unfinished. Do not close a parent merely because a child merged.
- protected: close a false-positive diagnostic with reason and evidence_ref only
  when the current registry/goal independently confirms every affected task is
  held, archived, or owned by an existing control/service driver. This does not
  complete or archive any goal. Text-valued holds count as explicit holds. The
  detector filters these scopes after combining registry and progress sources,
  and checks again at observation. A released protection permits a new recovery
  generation; it does not permanently hide unfinished work.

A recovery ACK without this disposition fails. A blocked recheck gets a new stable
generation only when its recorded due time arrives. A queued continuation becomes
resolved when its durable action records actual execution, or that exact stage
has an accepted completion with evidence. Reconcile before choosing inspection
targets and observing a round: actual work normally changes the owner turn, so
the detector must not require seeing the old idle turn again. A sent receipt or
a finished action without execution/accepted-stage evidence is insufficient.
Retiring this diagnostic never completes the parent goal or hides its remaining
stages. Existing uncertain dispatches remain subject to normal reconciliation,
never blind retries.

If the same idle gap remains after a coordinator batch created after the recovery
opportunity has finished, and the coordinator is idle, one workflow-health case
goes to the existing maintenance lane. A busy coordinator or elapsed time alone
does not count as that opportunity. The immutable payload records whether the
exact recovery key was included in that batch: health_reason=queue_admission_gap
means it was not offered; recovery_unhandled means it was offered but remained
unhandled/unstarted. Do not blame an execution owner for queue starvation.
Existing batch priority and retry rotation make room for aged recovery inputs.
Maintenance diagnoses the failure and queues
operational corrections; it does not become another registry writer. Human action
is requested only for an actual irreducible blocker, once per meaningful change.

Before reserving or authorizing a maintenance health delivery, recheck the case's
durable disposition. A resolved/protected case or an explicitly recorded current
blocker supersedes its unsent health item. Keep the original immutable payload
and a superseded_health receipt with the actual resolution evidence; do not wake
maintenance for an already handled recovery. Unknown cases and sending/sent/
uncertain/running batches are preserved. If the case later starts a new recovery
generation and misses another eligible round, it may escalate once under that
generation's key. Historical case-only health keys still deduplicate their
original generation.

Manual maintenance addenda and health cases remain durably queued while another
maintenance turn runs. Only scheduled daily-review items coalesce across days.
Never drop a new actual human request as previous_review_unfinished.

## Engineering guidance

New guarded dispatch/create payloads receive engineering-principles.mjs guidance
in their actual execution prompt. It preserves source text, project/model fields
and immutable old actions. It applies real workloads/storage constraints, actual
product maturity/consumers, first-principles design including in-scope breaking
changes, and minimal sufficient validation/fallbacks. It adds no preparation
phase or blanket compatibility/approval gate. Existing live jobs are not broadcast
new prompts; apply guidance at the next necessary dispatch.

Resolved unsent health diagnostics are retired atomically before watchdog observation
can reopen a due recovery generation. Preserve the old generation and disposition
in superseded_health. This includes reserved-unsent batches, while sending, sent,
uncertain and running batches remain untouched. New genuine missed generations
retain their own escalation keys; retiring an old alert does not close the task.

## Actual execution before explicit recovery binding

A separate accepted result may start the same authorized continuation before the
recovery item is consumed. Reconciliation can retire that old diagnostic without
an explicit queued binding only when EVERY task in the case has exactly one
matching durable continuation: same owner, preflight_turn equal to the detected
old turn, matching goal/stage/task/scope, same-key guarded transport receipt,
a different actual_turn with work_evidence_ref, running/finished action state,
and action evidence recorded no earlier than this generation's opportunity.
Ambiguous matches, partial task coverage, another task/turn, old-generation
records and send-only/uncertain-without-work evidence leave the case untouched.

Save the action/turn/work-reference mapping and resolution_key for that exact
recovery generation. This proves that the old idle gap was followed by actual
execution; it does not assert the owner's current native status or complete the
original task. Preserve all remaining goals and actual jobs. The original source
mail still requires normal coordinator ACK; automatic diagnostic retirement does
not consume it. Unsent health can then retire under the existing rules; already
sending/running health stays with its current batch. No worker message or new
schedule is part of reconciliation. Human-only correction paths without matching
continuation evidence still require the coordinator's explicit disposition.

## Shrinking task sets on the same terminal turn

If some tasks leave the selected set while the owner and terminal turn are
unchanged, first look for an unhandled open/escalated case whose original task
set strictly contains all selected tasks. Reuse the smallest covering case (then
oldest stable identity). Its recovery source must still be pending/in-flight or
awaiting outbox flush, with no current resolution_key. Preserve its exact original
scope, payload and deduplication keys; later health cites that original scope.

A new task or different turn still produces its own case. Do not reuse an explicit
queued, blocked, protected or resolved disposition: a wait accepted for a broader
scope must not hide an independently actionable subset. Existing duplicate rows
and in-flight batch snapshots are not rewritten; the coordinator reconciles them
from current task evidence. Coalescing does not authorize dispatch, retirement,
archival or completion, or bypass current holds/drivers/permissions.
