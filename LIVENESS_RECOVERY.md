# Local scheduler and execution recovery

The local trigger, native chat tools and workflow watchdog share the desktop
app-server. An ACTIVE saved schedule does not prove invocations are happening.
The watchdog cannot run while its own trigger is unavailable. No second timer,
daemon, app database edit or unsupported RPC is part of this recovery procedure.

## Diagnose the correct layer

Read recent dispatcher turns and match actual heartbeat source/timestamps. A
manual kick is not evidence that the next scheduled invocation works. Compare
the last native heartbeat with mailbox batch receipts; a coalesced last_tick is
not a record of every ten-minute invocation. Inspect only the relevant local
app connection logs if native calls fail. Preserve the exact observed failure;
a warning attached to a closed connection is not necessarily its root cause.

After a supported user update/restart, verify native calls, two or more actual
scheduled invocations, fixed-batch delivery and then engineering work separately.
Do not restart a now-healthy app, reset queues, kill remote jobs or replay sent or
uncertain actions as a recovery test. An explicit human request can authorize a
single manual trigger through the supported chat tool; inspect its current state
and existing receipt first. This does not authorize a new automatic sender loop.

Official local scheduling prerequisites: keep the computer on and app running.
See https://developers.openai.com/codex/app/automations (fetched November 3, 2026).
If the native backend remains unavailable, record one precise human action with
the observed error. This workflow cannot promise self-recovery while that shared
backend is down. Do not misreport local unit tests as scheduler availability.

## Resume the original owner

The coordinator owns operational recovery. Read the original task and latest
native turn, retain its owner/worktree/VM and reconcile interrupted commands.
Do not use a new human_input event unless an actual human gave that instruction.
Use ordinary dispatch for existing authorized unfinished work.

`notLoaded` means the native owner is not resident; by itself it proves neither
safe quiescence nor a user hold. Runtime dispatch accepts it only with the fresh
matching terminal snapshot and explicit evidence described in runtime/README.md.
An interrupted turn needs an inspected interruption reason and no human hold.
Existing live or unknown jobs, queued input, pending/uncertain dispatch, native
approval, ownership conflict and unavailable runtime capabilities still block
productive dispatch. Recheck immediately before sending. Never fake idle or
native permissions to satisfy the guard.

For unknown jobs, perform bounded read-only reconciliation using the existing
owner's resource/job records and owning tools. If authentication blocks those
reads, use the instance's authorized authentication procedure and existing login owner. Preserve remotely
running commands and checkpoints; SSO refresh failure does not prove job failure.
Human-only MFA remains a real blocker. A healthy remote job is observed rather
than restarted. Once evidence permits continuation, send once to the original
owner, verify the new turn performs work, and record the durable disposition.


## Archive a completed unloaded owner

Ordinary completed-task archival accepts the same verified terminal notLoaded
snapshot as continuation, with the opposite task predicate: the entire task must
be complete. Preserve the real native status, exact thread/turn identity and
fresh checked_at. Verify thread_archived=false, no queued input, pending dispatch,
native approval or live/unknown underlying job, and unchanged native permissions.
An interrupted turn still requires actual interruption reconciliation. Require
saved acceptance evidence, completed result delivery and no pending decision,
delivery or resource cleanup. The control ledger still refuses archival while
any registered goal owned by that chat has unfinished stages.

Prepare and claim recheck these facts; a later active/new turn or stale snapshot
blocks the archive. This does not grant execution permissions or change the
explicit-owner-replacement path. Keep control/service exclusions. Only the
coordinator calls the existing native archive tool, then saves its receipt and
readback; do not send the worker an archive or acknowledgement message. A
subsequent native idle snapshot may use the ordinary path without relabeling.

