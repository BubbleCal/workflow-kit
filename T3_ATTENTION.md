# Decisions through the Decision & Report Inbox

A task keeps one original execution owner. Since 2026-11-22, every installed
instance has the standard **Decision & Report Inbox** role (`决策与汇报`,
`roles.decision_report_inbox`); see DECISION_REPORT_INBOX.md. Owners queue
genuine decisions, review conclusions, hard blockers and substantive completions
there as one `[INBOX_HANDOFF]` via `t3_thread_send(mode: "queue")`. They no
longer open native Ask cards in their own thread. The Inbox shows Yang one item
at a time and forwards his answer back to the canonical owner. Main handles
Yang's on-demand project status questions and manual dispatch; it does not
relay decisions or receive unsolicited owner progress summaries. Do not create
other decision threads or side chats.

## Attention and execution

| Attention state | Meaning for Yang | Owner behavior |
| --- | --- | --- |
| Inbox | A question, requested result or concrete failure needs attention | Queue one `[INBOX_HANDOFF]` to the Decision & Report Inbox; continue independent authorized work |
| Working | Work or a real monitored dependency is progressing | Continue within scope without routine messages to Main |
| Snoozed | Defer attention until the chosen time | Preserve unanswered choices and continue independent work |
| Settled | This item has been handled or dismissed for now | Do not infer approval, completion or cancellation |

Inbox is a native sidebar grouping of ordinary threads, not a separate decision
object. A ledger attention value does not move the native thread.

Route task decisions through the Decision & Report Inbox rather than a native
question in the owner thread. Native questions remain only for literal
credentials (`request_secret`) and for legacy instances that explicitly keep
`attention.decision_location: "owner_thread"`. Harness note for those cases:
Codex `request_user_input_async` is non-blocking and survives turn completion,
whereas Antigravity `ask_question` (elicitation) is synchronous and holds the
active run open until answered, queueing subsequent scheduled ticks and PR watch
wakes in that thread. Preserve genuine unanswered legacy Asks without
fabricating answers or interrupting them to clear a queue, and distinguish
`pendingRequestCount > 0` runs from hung turns. Each handoff must explain the
concrete choice, context, options and tradeoffs, recommendation, evidence,
blocked step and what can continue, readable without old logs. Several genuine
choices use separate stable `event_key`s.

T3's native questions/approvals and completion/failure events bring an owner
back from Working. A pending question can coexist with independent work.
Discuss follow-ups in the same thread. If clarification leaves the choice open,
keep the unresolved case visible as a pending native question. If no native
question surface is available, finish with the question in this thread; do not
claim a ledger update changed the UI or install a relay timer.

Use supported native controls for Snooze/Settle. Never edit T3's database or
fabricate a running state to keep a thread under Working. Actual shelf placement
and resumed execution require native evidence; ledger unit tests do not prove
the rendered desktop state.

Yang clarified that pinning is not a substitute for task state. A genuine
human decision/action must be a queued, deduplicated Inbox item (or, for a
legacy owner_thread instance, a native respondable question verified with
`t3_pending_request`). Codex `request_user_input_async` produces a message-type request that can
remain pending after the turn ends. A closed/cancelled question with no answer
does not resolve the business choice. Reconcile current human messages before
repairing a genuinely open choice; do not restore an obsolete question. Preserve
manual/permanent pins and intentional snoozes. Do not auto-pin for attention.
An explicit human dismissal or snooze is an attention decision; do not
automatically reopen it just because no business option was selected. Reopen
only when the user asks, the case materially changes, or new evidence requires
a new concrete decision within scope.

When an exact technical Ask is objectively obsolete, reconcile it instead of
leaving a false request for user action. Verify the original blocker is resolved
from real receipts and completed owner work, and that no business, risk or
outbound decision remains. Prefer the native withdrawal control. If the only
supported control records an answer, explicitly identify it as an agent
administrative withdrawal, never a Yang answer or grant. Preserve native actor
fields, save the original request and factual proof, verify it is no longer
pending, and index the response as excluded from human-authority and
intervention counts. UI failure alone does not prove the blocker resolved.

For an Ask about an exact PR action, read the PR's current open/closed/merged
state before retaining it or merely updating its wording. A manual approve or
merge prompt may become moot after that PR ends; check the original scope and
withdraw only the inapplicable prompt when no real choice remains. Terminal
state takes precedence over a stale `REVIEW_REQUIRED` field. This is not Yang's
approval or proof that broader task acceptance is complete; preserve separate
risk, release and rollout decisions.

When later source evidence clarifies a pending Ask's factual premise, update
the existing candidate and decision context before asking Yang to explain it.
Keep the real choice, source binding and pending request identity. If the public
native interface cannot edit that request, add one concise correction in the
same owner thread and record the capability gap; do not create a second card
or answer/withdraw a genuine choice merely to change its wording. A source
request for approve is evidence of the requested action, not Yang's approval.

Clarification is different from dismissal. If Yang asks for an explanation and
the old Ask is cleared when that new message arrives, answer the explanation
first, then keep the unresolved business choice open as the Inbox's active item
(or one current native Ask for a legacy `owner_thread` instance).
Reuse the case/evidence and allow further discussion or deferral; do not turn a
clarification into approval or leave the owner looking done without its open
decision. Check for an existing live request before asking again.
Lead a risk Ask with one plain sentence naming the change and its purpose,
then its concrete cost, evidence and blocked action. A PR number and migration
cost alone do not explain why the choice matters. Distinguish an expected
benefit from measured performance; an unmeasured benefit must stay labelled as
such. Use project terms where useful, with enough context to answer from the
current card. This improves the question, without replacing actual risk consent.

First verify that the remaining question is a genuine business choice. Reading
already-authorized records or checking an existing alert/PR is routine work,
not a choice to restore after every clarification. Do that work and report the
remaining fact or decision. Do not turn optional scheduling or presentation
preferences into Inbox requests when useful work can proceed with a reasonable
default. Preserve actual product ambiguity, permission needs and explicit holds.
Keep the current question short: name the one remaining action and permission,
link existing evidence, and omit already accepted risk details. A complaint
about repeated authorization questions is not itself outbound permission or an
explicit dismissal; inspect its exact meaning and later answers. Preserve a
real unresolved choice once, rather than either multiplying long Ask cards or
silently hiding the decision to reduce the question count.

An unfinished task waiting on CI, a designated approval or a PR dependency uses
one native `watch_pull_request` per real dependency and original owner. Consume
existing feedback first, register only a missing watch, then end the turn as the
tool directs. Preserve an existing watch across wakes. In T3 0.1.9, an open
watched PR contributes awaited background work, which keeps the thread in
Working even while its last provider run is completed. A completed run and
business completion are distinct; do not change run history to alter the shelf.

Waiting must name a real remaining condition and the event/actor that can
change it. Already-open windows and satisfied dependencies require immediate
continuation after fresh checks. Terminal failed/cancelled/skipped CI requires
cause classification and an actual authorized fix/retry/review request or an
accountable producer handoff; it is not running work. Preserve exact receipts,
deduplication, scope and technical gates. Do not relabel an inert failure as
pending or ask Yang to waive routine checks. See the finite corrective-action
contract in `T3_NATIVE_WORKFLOW.md`.

Clock-only holds require one actual native once schedule in the original owner
at the exact next eligible time, verified and deduplicated by task/head/due.
A PR watch does not supply a clock wake. Act now if the boundary has passed;
never create a recurring PR poller or Maintenance relay to simulate it.

A PR's merge can close its watch without starting a dependent owner's next
turn. For a dependency already authorized between existing owners, use one
native producer-to-consumer handoff on the actual usable artifact or merge,
with exact head/base, evidence, remaining holds and a stable event identity.
Verify delivery and subsequent execution separately. Keep the consumer's own
PR/approval watches where applicable. No polling/relay schedule, duplicate
owner or new product permission follows from this protocol. See the dependency
handoff contract in `T3_NATIVE_WORKFLOW.md`.

Real commands/delegates/cross-owner work must use their supported native wait
contracts. `t3_background_wait` only supports Claude and must not be invoked as
a Codex fallback. If a genuine wait has no supported representation, report the
exact gap; do not add sleep loops, polling, dummy tasks or fake running state.
The Working shelf is a per-device UI setting; native state evidence cannot prove
that a particular device has it enabled. A real completed task with a delivered
result can be Settled; dependency waits, unanswered input and paused ongoing
services are not business complete. When a one-off utility, superseded helper,
or explicitly closed task finishes with no remaining open PR, watch, schedule,
or Ask, its owner should explicitly Settle it so finished items do not pile up
in Inbox; however, do not auto-settle reference research threads that still
carry an open Draft PR or that Yang explicitly unsettled as active reference.

Source: [T3 thread sidebar semantics](https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/docs/user/thread-sidebar.md).

## Prevent premature automatic settlement

A PR review with posted comment/REQUEST_CHANGES and no Yang approval remains an
unfinished follow-up. Its original owner uses native watch and Auto-settle Never,
consumes existing replies first, and reassesses on author reply or genuine renewed
review readiness. Feedback delivery alone is not review completion. Preserve the
watch across unrelated events and further review cycles; do not turn every wake
into an Ask. Only a new actual permission/decision needs Yang. See the review
follow-up contract in `T3_NATIVE_WORKFLOW.md`, including readiness-wake limits.

For an unfinished task whose scope extends beyond a linked PR (including a
dependency PR, combined acceptance or natural-release qualification), use the
native thread context menu **Auto-settle behavior -> Never**. Verify the checked
Never item by reopening that exact thread's menu. This is a per-thread native
setting, not a pin, model change, fabricated wait or local business-state flag.
Keep the setting through wakes and delivery; explicitly Settle only after the
accepted scope and result delivery are complete, or a genuine human dismissal.

In installed T3 0.1.9, native `unsettle` reopens a thread and sets an active
override, but a subsequent message dispatch clears that override. Unsettle alone
does not provide persistent protection across continuation messages. The native
Never setting disables both merge-based and inactivity-based auto-settlement
and survives message dispatch. The current MCP organize tool does not expose
that setting; use the native UI, not a private DB or invented RPC. If unavailable,
record the capability gap and use supported unsettle for the current turn,
without claiming permanent protection. Never install a status-repair poller.

PR merge/closure is a milestone, not proof that all original acceptance is done.
After a genuine dependency handoff, consume current evidence, continue available
work, and bind only actual remaining dependencies. Keep real human decisions in
the Decision & Report Inbox; unsupported non-PR waits remain an explicit gap.

Lead a query-performance update with the client's end-to-end time to receive the
complete result, baseline versus candidate, and the relevant concurrency and
cache state. Add QPS when measured/requested. Identify version and resource
differences before claiming a distributed gain. Operator CPU/stage timings help
explain that result but do not replace it. Reuse available measurements; this
communication check does not authorize extra experiments or resource changes.

For mixed indexed/residual queries, show total and residual rows, residual share,
fragment sizes/counts and actual worker ownership beside the headline result.
Distinguish the task's representative workload from a backlog stress case; do
not generalize a scan/tokenizer hotspot from a large residual fixture to a small
tail. Keep earlier measurements with their actual scope. Use the accepted goal
and current human guidance to choose coverage, rather than inventing a universal
tail percentage or requesting permission for routine fixture selection.

## Owner decision loop

Apply the latest instance human approval scope before issuing a permission Ask.
For the three-category policy, only breaking/format change, possible negative
Enterprise effects, and Slack/GitHub comments need authorization. Ordinary
execution, validation, Ready or eligible merge is autonomous within accepted
scope. Reuse an applicable real grant; do not ask a personal-review question
just because an old snapshot required it. Missing impact evidence is owner work,
not human permission. Genuine missing requirements may still need a substantive
choice. Never relabel a routine permission probe as a product decision.

Reconcile an existing obsolete approval Ask in its original owner using the new
actual human policy. Do not synthesize an answer claiming Yang inspected a head,
approve a risk/message outside its exact grant, clear a still-live category Ask,
or settle unfinished work. Preserve explicit user deferrals and task stops.

1. Resolve routine uncertainty and reversible implementation choices yourself.
   Ask Yang for an actual decision, scope change or concrete unresolved failure.
2. Queue one `[INBOX_HANDOFF]` to the Decision & Report Inbox with
   `t3_thread_send(mode: "queue")`. Give concise evidence, options,
   recommendation, blocked step and what can continue, with a stable
   `event_key`. Keep PR watches, stay unsettled and end the turn. No local
   runtime registration/checkpoint/decision operation is needed first.
3. The Inbox discusses follow-ups with Yang. Clarification, silence and a
   preselected option are not approval. Do not create side chats or relay via
   Main, and do not re-send an unchanged handoff.
4. Apply the forwarded human answer only to its exact scope/head, preserving
   other holds. If a durable decision index helps, optional ledger
   `decision`/`answer` records exact native provenance and revisions without
   running anything.
5. Read actual T3 status. In detached native mode the local `attention` operation
   is disabled, and recorded outcomes/old labels cannot set a native shelf.
   Preserve native waits, snoozes and manual pins. Report substantive results as
   an Inbox `completion`; the Inbox settles the owner only after Yang confirms.
