# T3-native workflow operating profile

This profile runs new work through T3's native threads, runs, queues, questions,
scheduled tasks and shelves. It does not start the Codex Desktop runtime or
import its existing tasks. Instance configuration lives in `t3-workflow.json`;
the durable task/decision index is `t3-workflow.sqlite` beside it.

## Roles and autonomy

- Main is Yang's entry point. Record the actual human request, the desired
  outcome and acceptance, then send directly to Discovery using T3's native
  `t3_thread_send`, `mode: "queue"`, and a stable `clientRequestId`.
- Discovery reuses an existing task/owner by canonical identity. For an accepted
  new independent task it creates one ordinary owner with the configured model,
  reasoning and effective Full access, verifies the native project/config/run,
  and binds it. A create ACK is not execution. Do not create parallel writers.
- Owners investigate, implement, test, repair routine failures, try reasonable
  alternatives and follow through inside the accepted scope. Do not ask Yang
  to approve routine implementation choices. Full access must be a native
  setting, not a sentence in the prompt. Preserve explicit product holds.
- Maintenance audits this instance every 480 minutes using one native schedule
  bound to its own existing thread. It reconciles actual runs and unknown
  effects, repairs local workflow faults and records meaningful remaining
  blockers. No trigger chat or timer-based message relay is necessary.

All source collectors are initially disabled to prevent duplicate discovery
alongside the original live instance. With no enabled sources, Discovery has
no idle scanning schedule. Enabling a source requires verified account/scope
and an explicit handoff of its polling responsibility. Normal human requests
can already be dispatched directly. Do not reopen or migrate old Codex tasks
merely because T3 is installed.

## Task registration and original owner

Run from this checkout:

```sh
node workflow.mjs t3 ledger --instance /Users/yang/.codex/workflow-t3 --file /absolute/path/operation.json
```

Each operation is an atomic local transaction. Use `op: "pending"` to inspect.
`register` requires `canonical_key`, `objective`, `requirements`, `workspace`,
`project_id`, `source_message_id`, `verbatim_text` and `native_proof`:

```json
{"source":"t3code.mcp.t3_thread_read","evidence_ref":"/absolute/path/saved-native-read.json"}
```

Save the exact complete `t3_thread_read` result, optionally as
`{"call":{"tool":"t3_thread_read","args":{}},"response":{}}`.
The ledger reads this file itself. It accepts an actual untruncated
`createdBy: "user"` message from Main, not an MCP/provider-authored message.
Known installation relays are not new product authority, including text pasted
through the UI by the installer. Do not relabel those messages as human.

Replay with the same canonical contract reuses the same task. Task IDs are
`T3-001`, etc. `bind_owner` requires the task ID, original `thread_id`,
`environment_id` and actual native owner readback. It checks the project,
ordinary MCP-created owner and effective Full access, and preserves the first
binding. Scope changes require a recorded discussion, not silent replacement.

The ledger is a local provenance/decision index, not a replacement scheduler
or another execution coordinator. T3 owns execution and run persistence.

## Inbox decisions without blocking independent work

Follow `T3_ATTENTION.md`. Keep Working folded. A real human decision needs one
stable case, with context, options, recommendation, evidence and the exact
blocked step. Continue independent work; when nothing useful remains, end the
turn with a real event/deadline dependency rather than busy polling.

`op: "decision"` records `task_id`, stable `case_id`, `question`, `options`
(`id`, effect/tradeoff), `recommendation`, `evidence_refs`, `blocked_steps`,
`independent_steps`, exact `scope`, and optional `discussion_thread_id`.
Use one ordinary decision discussion for the same question when needed under
the user's requested inbox design; reuse it, do not spawn a new chat per poll.
That chat discusses the choice and returns its answer; it is not a second
engineering owner. Important results and unresolved failures remain visible.

`op: "answer"` requires the case ID, `expected_revision`, selected `option_id`
and exact actual human message proof from Main or that case's discussion.
It prepares one immutable native-send payload for the original owner. Invoke
the returned native tool once and record the exact result with `op: "settle"`,
`delivery_key`, `outcome: "sent"`, and `native_result`. If a send outcome is
unknown, record `outcome: "unknown"`; reconcile the native message/run before
any retry. Never infer delivery from latest activity alone.

Record actual owner consumption with `op: "observe"`, the delivery key, native
send `receipt` (threadId/messageId/runId), and exact owner `native_proof`.
The original message and run must match; accepted is not executed or business
complete. A changed case advances revision and preserves its old answer and
delivery; an answer to an old revision cannot apply to the new question.

`op: "attention"` sets the local case attention to Inbox/Working/Snoozed/Settled;
Snoozed additionally requires a future `until`. These are recorded intentions:
use supported T3 UI controls for the actual shelf, never edit T3's database.
Snooze does not pause the owner. Settled without an answer grants nothing.
Answer preparation moves the case to Working, not automatically Settled.
Settle the attention item after the result is actually visible or explicitly
dismissed. Business completion, merge authority and archival remain distinct.

## Operational verification

Read actual native role runs and configuration after setup. A maintenance
schedule must read back the correct boundThreadId, 28800000 ms interval,
freshSession=false and enabled=true. Audit collector credentials separately
from tool visibility. Keep original receipts and ambiguous failures intact.

No arbitrary target/receipt cap per cycle. Process the current finite workset;
checkpoint genuine remaining work if a native execution budget ends. A failed
turn is not running merely because an old ledger row says so. Reconcile exact
native terminal state before resuming; repeated Bad Request requires diagnosis
and a durable failure, not endless sends or replacement chats.

T3 Desktop and a background service cannot concurrently own the same home.
An installed launch agent is not proof that it serves that home. Do not kill
active agents or delete ownership locks to force a handoff. Use a quiescent
official local-environment/service transition and verify the UI reconnects.
