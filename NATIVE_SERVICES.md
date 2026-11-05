# Optional ordinary service tasks

Delivery and maintenance are ordinary catalog tasks with one owner each. They
are optional, not mandatory control roles. A native instance uses `threads.main`
and optional `threads.discovery`; `runtime.json` has no legacy `control_lanes`.

For a migrated service, register and accept its original scope, bind the verified
existing owner, then adopt a contract with `service_lane` (`coordinator` for
compatibility delivery inputs, or `maintenance`) and a bound `schedule_sources`
entry. Configure `runtime.json.service_tasks` with lane-to-task-ID mappings.
Registration starts no cycle. Keep the task paused until the user resumes it.
The existing program maps eligible immutable mailbox inputs to one native task
wake. It never separately sends a legacy control-batch message. Pending writes,
uncertain receipts and previous project acceptance are preserved.

A service owner:

1. Uses ordinary native proof to `begin`, then reads its task checkpoint.
2. Reads `service_batch_ready`, then calls `runtime op service_begin` with
   `task_id`, `owner_thread_id`, `wake_id` and `batch_id`. Only that actual running
   native wake can claim the exact reserved batch. Queue acceptance is insufficient.
3. Handles only the returned fixed inputs within the batch budget. Delivery uses
   all existing current-head, CI, feedback, approval, review-window and external
   write guards. Maintenance follows its actual report window and scoped request.
4. Uses existing mailbox `record_progress`, `ack` and `finish` for actual inputs.
   It preserves unprocessed work, healthy jobs and original source receipts.
5. Records `cycle_complete` with acceptance evidence, then finishes the ordinary
   task wake. The program rejects cycle completion while its batch is unfinished.
   Finishing a cycle does not complete the ongoing service or its product goals.

Maintenance keeps `daily-review/config.json` and its minimum start interval,
including queued addenda. Unchanged delivery inputs keep their bounded reoffer
cooldown. Optional `service_inputs` are explicitly authorized standing duties
such as existing calendar upkeep; each has id, lane, interval_ms, authorization_ref
and a scoped payload. They coalesce while unprocessed and add no separate timer.
Source discovery belongs to the configured discovery role, not delivery intake.

A migration is complete only after verifying catalog ownership, task/receipt
preservation, current role bindings and queue compatibility. Leave service/task
modes and native schedules paused when requested; do not infer a resume from
successful migration. Never reset a database to undo outside actions.
