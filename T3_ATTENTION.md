# Decisions in the original owner thread

Yang confirmed this direction on 2026-11-12: a task keeps one original execution
owner and one discussion thread. The owner asks for decisions in its own thread
and uses native Inbox attention. Do not create decision threads or side chats.
Main handles Yang's on-demand project status questions and manual dispatch; it
does not relay decisions or receive unsolicited owner progress summaries.

## Attention and execution

| Attention state | Meaning for Yang | Owner behavior |
| --- | --- | --- |
| Inbox | A question, requested result or concrete failure needs attention | Ask in the original thread; continue independent authorized work |
| Working | Work or a real monitored dependency is progressing | Continue within scope without routine messages to Main |
| Snoozed | Defer attention until the chosen time | Preserve unanswered choices and continue independent work |
| Settled | This item has been handled or dismissed for now | Do not infer approval, completion or cancellation |

Inbox is a native sidebar grouping of ordinary threads, not a separate decision
object. A ledger attention value does not move the native thread.

Use a native asynchronous question in the owner thread when available
(`request_user_input_async` in the Codex harness). The latest owner message and
question should explain the concrete choice, context, options and tradeoffs,
recommendation, evidence, blocked step and what can continue. It must be readable
without scrolling through old logs. Several genuine choices can have separate
stable case IDs in this same thread.

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
human decision/action must be a native respondable question in its original
owner thread. Verify `t3_pending_request` returns the exact request and read it
back. Codex `request_user_input_async` produces a message-type request that can
remain pending after the turn ends. A closed/cancelled question with no answer
does not resolve the business choice. Reconcile current human messages before
repairing a genuinely open choice; do not restore an obsolete question. Preserve
manual/permanent pins and intentional snoozes. Do not auto-pin for attention.
An explicit human dismissal or snooze is an attention decision; do not
automatically reopen it just because no business option was selected. Reopen
only when the user asks, the case materially changes, or new evidence requires
a new concrete decision within scope.

Clarification is different from dismissal. If Yang asks for an explanation and
the old Ask is cleared when that new message arrives, answer the explanation
first, then leave one current native Ask for the unresolved business choice.
Reuse the case/evidence and allow further discussion or deferral; do not turn a
clarification into approval or leave the owner looking done without its open
decision. Check for an existing live request before asking again.

An unfinished task waiting on CI, a designated approval or a PR dependency uses
one native `watch_pull_request` per real dependency and original owner. Consume
existing feedback first, register only a missing watch, then end the turn as the
tool directs. Preserve an existing watch across wakes. In T3 0.1.9, an open
watched PR contributes awaited background work, which keeps the thread in
Working even while its last provider run is completed. A completed run and
business completion are distinct; do not change run history to alter the shelf.

Real commands/delegates/cross-owner work must use their supported native wait
contracts. `t3_background_wait` only supports Claude and must not be invoked as
a Codex fallback. If a genuine wait has no supported representation, report the
exact gap; do not add sleep loops, polling, dummy tasks or fake running state.
The Working shelf is a per-device UI setting; native state evidence cannot prove
that a particular device has it enabled. A real completed task with a delivered
result can be Settled; dependency waits, unanswered input and paused ongoing
services are not business complete.

Source: [T3 thread sidebar semantics](https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/docs/user/thread-sidebar.md).

## Owner decision loop

1. Resolve routine uncertainty and reversible implementation choices yourself.
   Ask Yang for an actual decision, scope change or concrete unresolved failure.
2. Ask directly with the native asynchronous question tool in the original
   owner's thread. Give concise evidence, options, recommendation, blocked step
   and what can continue. Read back its exact pending request. No local runtime
   registration/checkpoint/decision operation is needed before asking.
3. Discuss follow-ups in that thread. Clarification, silence and a preselected
   option are not approval. Keep the unresolved choice visible unless Yang
   explicitly deferred/dismissed it. Do not create side chats or relay via Main.
4. Apply the direct human answer only to its exact scope/head, preserving other
   holds. The message already reaches this owner; never send it back as a new
   turn. If a durable decision index helps, optional ledger `decision`/`answer`
   records exact native provenance and revisions without running anything.
5. Read actual T3 status. In detached native mode the local `attention` operation
   is disabled, and recorded outcomes/old labels cannot set a native shelf.
   Preserve native waits, snoozes and manual pins. Report important results in
   the owner thread and Settle only when the actual accepted scope is done.
