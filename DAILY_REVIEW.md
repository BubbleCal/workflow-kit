# Daily workflow maintenance

Use the fixed date/window in the immutable mailbox batch and the saved checkpoint for that same item key. Scheduled reviews use reports/YYYY-MM-DD; manual work uses a finding suffix. Do not confuse same-date manual completion with a daily audit.

Review evidenced queue delay, missed continuations, duplicate attempts, project routing, stale state, delivery delay, permission failures and user notification noise. Distinguish actual measurements from unknowns. There is no requirement to invent a problem or change code every day.

Implement proportionate reversible workflow-local fixes with a backup and meaningful validation. Preserve active jobs, original owners, model/permission settings, source restrictions, pending receipts and scheduling choices. Use the smallest adequate check; do not repeat unrelated benchmarks or turn maintenance into product implementation.

The existing maintenance role owns this work. A twenty-minute soft budget is a safe checkpoint boundary. Finish with processed_keys only for completed batch items; otherwise save the same checkpoint and finish with processed_keys=[]. Queue result mirrors to the coordinator. No direct messages to workers or control chats, no registry/decision/Notion edits by maintenance, and no new scheduler.

Reports include evidence, applied changes, tests, limits and rollback path. Keep routine results quiet. A necessary user decision or important requested completion is queued once through the coordinator.

An instance may configure interval_minutes and first_due_at in
daily-review/config.json. The interval applies to all automatically delivered
maintenance, including recovery and queued manual addenda. New inputs cannot
bypass it; pending inputs share one bounded batch. Running work continues.
If begin returns begun=false with a cadence deferral, end without auditing or
calling finish. Accepted transport receipts and original input keys are retained.
Periodic reports use payload.report_key so repeated same-day runs never overwrite
one another. Missing this optional setting retains the legacy daily schedule.
