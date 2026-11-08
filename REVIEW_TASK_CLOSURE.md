# Close reviews when their PR ends

Yang's actual instruction `01a1aff3-98da-79d1-bbce-6dd70bd008a8` (2026-11-06)
ends a single-PR **review task** when that exact GitHub PR is merged or closed.
An unfinished review or eligibility wait can end without further review/tests.
Save the terminal PR evidence and preserve reports, findings, plots and history.
Do not claim unfinished review steps were performed, that findings were fixed,
or that closed-unmerged code was delivered. Do not invent a successor review.
This does not close implementation tasks or the recurring Review Queue service.

Review Queue checks all existing reviews at the start and end of each normal
cycle, even after the five-new-PR daily limit. Original reviewers also check PR
state before doing further review. Use `runtime/review-queue.mjs` with JSON stdin:

```json
{"op":"closure_targets"}
```

Fetch each exact PR from GitHub. An open PR is not terminal. For a terminal PR,
read the original native chat and saved result. Do not wake it to repeat review.
An active turn/job, queued input, uncertain action, actual unfinished cleanup or
undelivered substantive report must first be reconciled by its existing owner.
PR closure supersedes further review/fixing/re-review and open review findings;
it does not authorize interrupting a job or throwing away results.

Once quiescent, call `op=complete_closed_review` with task_id,
executor_thread_id (main, Review Queue or original reviewer), and:

- `pr`: canonical url, state (`closed` or `merged`), head_sha, closed_at,
  checked_at and evidence_ref; merged also needs actual merge_sha/merged_at.
- `native_proof`: fresh `codex_app.read_thread` tool envelope, checked_at and
  evidence_ref. Reconcile interrupted work explicitly with evidence.
- `underlying_job_running:false`, `queued_input:false`,
  `pending_delivery:false`, `pending_cleanup:false`, `resources_preserved:true`
  and a saved completion `evidence_ref`.

The supported operation stores the terminal evidence, completes and retires only
that review, resolves its waits and preserves old decisions/contracts/reports.
It refuses live wakes and prepared/claimed/uncertain actions. It does not mutate
GitHub or archive the native chat itself.

Before archiving, follow TASK_COMPLETION_DELIVERY.md: the terminal review result
and its actual scope/impact must have reached Yang in main. Review Queue may
report its saved terminal closure; do not wake a finished reviewer to repeat an
already presented result. A closed PR does not imply the review was performed.

Then use normal control prepare -> claim -> native set_thread_archived -> settle,
with `kind:archive`, `purpose:review_pr_terminal`, the above user source ID and
fresh current runtime_context. All normal archive guards remain, including
quiescence, result delivery, no pending work, protected chats and actual readback.
Review Queue has this narrow authorization to archive these terminal review
owners only. Verify native archived membership and retain the receipt. If a
receipt is uncertain, read the target before retrying. Do not archive the service.
An unsent saved closure stays in closure_targets so the next cycle can finish it.
After native readback, use `op=confirm_archive` with task_id, executor_thread_id,
and native_proof (`source:codex_app.list_threads`, request with
`mode:history,archived:true`, checked_at, actual readback and evidence_ref).
This also reconciles an already user-archived chat without sending another archive
operation; actual archived-list membership is required.

Already-delivered conclusions do not need another notification. If a new review
conclusion exists, deliver it under REVIEW_RESULT_DELIVERY.md before closure.
This policy grants no comments, votes, review requests or implementation rights.
