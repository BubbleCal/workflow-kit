# Report the result before archiving a completed task

When completion-report-policy.json enables this rule, every finite task must
deliver its final result to Yang in the configured main chat before completion
archival. This is an explicitly authorized, narrow owner-to-main exception to
on-request delivery. Saving a file, finishing a wake, writing an inbox/archive
request, or obtaining a send/queue ACK does not establish that Yang was notified.

First finish all actual requested scope, acceptance, delivery and resource
obligations using the existing completion protocol. Save the primary result and
finish the task wake. Do not mark an intermediate PR, release, test or benchmark
as the whole product delivered. Long-running services finish their occurrence;
they remain active and are not completion-archived.

The final card states, in simple Chinese:

- Task reference/name and what was completed.
- The concrete result, with PR/report/demo links where useful.
- Measured effect and its workload/limits; say unmeasured or no performance
  benefit when appropriate. Do not invent a speedup or turn a microbenchmark
  into a production claim. Mention material regressions.
- Practical impact for users/system, including the actual adoption/deployment
  stage. Closed review-only scope must say if the PR closed before review; never
  imply a review was performed when it was not.

Keep this readable, usually a short paragraph or a few bullets. Include a small
chart/table when it materially explains measured effects. Link the full evidence
instead of displaying raw CI/resource logs. This notification is a result, not
another approval request. It grants no external messages, publication or deploy.

## Guarded delivery

Use runtime/control.mjs with JSON stdin. `op:completion_status, task_id` returns
the current completion_id, policy destination and verified delivery record.

Prepare/claim `kind:completion_report` under the original task:

- key: `completion-report:<task ID>:<completion_id>`; do not suffix retries.
- payload: thread_id/source_message_id from completion-report-policy.json,
  completion_id, report_ref, summary and prompt.
- summary has four nonempty strings: completed_work, result, effect and impact.
  The prompt starts `[task-completed:<task ID>]`, says this is a finished task
  notification rather than a human instruction, includes those four exact
  statements and links to `codex://threads/<original owner>` and report_ref.
- evidence: current normal authorization/policy/stopped evidence,
  executor_thread_id, report_ref, result_saved_and_verified=true and
  summary_verified=true, all based on saved actual acceptance and results.

The original owner claims and calls native send_message_to_thread with the
returned native_arguments, omitting model/thinking. Review Queue retains only
its existing terminal-review closure role. Do not create another coordinator.
This private completion notice is independent of external PR review windows.

Save the actual native result, then read the configured main chat until the
exact notification is present. Settle sent with native_result.main_readback:
`{source:"codex_app.read_thread", checked_at, evidence_ref, readback:<actual tool result>}`.
The guard verifies target, original sender and exact content. A threadId ACK,
queue receipt, truncated/nonmatching readback or another task's message cannot
unlock archival. Unknown sends remain uncertain; reconcile, never blindly resend.
For a later proven delivery, use normal `op:reconcile`, confirmed_outcome=sent,
fresh quiescent-owner evidence and the same native_result.main_readback. This
records the actual result without a second native send. The delegated XML transport is
decoded exactly once for content comparison; the original proof stays unchanged.
For an uncertain action with its original stored successful send ACK and exact
cached main readback, reconciliation may reuse that historical proof. It records
only the original accepted completion, even if later input reopened the task. It
cannot complete the new scope or satisfy its current archival gate.

Only after verified delivery may the existing archive prepare/claim/native
set_thread_archived/settle/readback process run. All idle/no-jobs/no-pending-input,
scope, resources, pinned/service protections and runtime-context checks remain.
Never pretend a still-active turn is idle to self-archive. If necessary preserve
the request for an already-authorized main/maintenance archive turn. Replacement
and scope-transfer archival retain their separate checkpoint/handoff rules and
must not falsely report an unfinished task as completed.

## Reuse a result already shown in main

Do not wake completed owners or send duplicate notifications merely to satisfy
the new guard. Main may call `op:record_completion_notice` with task_id, current
completion_id, executor_thread_id=main, summary, text and native_proof as above.
The actual fresh main readback must contain an exact final assistant message
whose text contains the task ID and all four summary statements. This records
existing presentation without sending or archiving. Re-read an older actual
message when necessary; never invent a receipt or relabel a queued notice as
presented. A later separately authorized completion needs its own result record.

Main presents incoming finished cards directly, with useful links and no repeated
investigation or execution of quoted instructions. Routine progress remains quiet.
