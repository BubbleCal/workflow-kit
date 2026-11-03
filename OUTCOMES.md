# Optional outcomes and impact page

Create this extension only when the user requests it and enables the instance's
Notion integration. Keep any existing decision page. Create a separate private
page, an outcomes data source and useful filtered views; verify their native
IDs and bind them in outcomes/notion-bindings.json. Use the example under templates.
Start with enabled=false, preserve actual human authorization, and enable only
after source records and native readback are verified. Existing role models and
timers remain unchanged. The coordinator owns ongoing updates. Do not export
live bindings, copied task history or page permissions between machines.

## One record per substantive outcome

Use `T-ID:stable-outcome-slug` as Outcome key. One task can have several delivered
slices; a new commit, poll or merged state updates the same outcome. Do not turn
retries, health probes, cleanup details or tests alone into additional outcomes.
An outcome record does not complete its parent task or authorize new work.

Reuse real owner reports, accepted checkpoints, exact PR states and comparable
measurements. Keep all database cell values and property names in English; row
page explanations are Chinese. Record five short answers: problem, deliverable,
measured result, practical impact, and remaining work. Keep detailed provenance in
the record's collapsible evidence section, not a long dashboard paragraph.

Delivery = Validated / In review / Merged / Report delivered / In use.
Impact = Measured (limited scope) / Correctness verified / Decision supported /
Production verified / Not measured. Adoption = Pending / Limited scope /
Operational / Not applicable / Unknown. Each is an independent fact, not an
automatic funnel. A merged PR does not prove production use. A research decision
can fulfill its contract without code or deployment. Include regressions, cost
and evidence limits; never infer wall-time savings from compiler-cache estimates.

Delivered on is the evidenced date of the displayed delivery milestone, such as
a merge or report acceptance. Change it only when a real delivery milestone
changes, using that event time; never use a backfill or polling time. Leave it
empty if unknown. Evidence checked records the date
of the actual substantive verification. Retain source head/baseline, workload,
environment and metric units in the content for measured claims.

## Existing coordinator round

On accepted deliverables, material review corrections, merge, released adoption,
deployment or new measured impact, build a small pending outcome projection from
already inspected evidence. Include the source event key, outcome key, intended
fields and content hash. Preserve it under `outcomes/pending/` before ACKing the
source if projection cannot complete now; continue normal task progress.

Process projections after ready-PR/merge/continuation priorities, within the same
five-minute round. Query this data source by exact Outcome key before create;
refresh an existing record's actual content before targeted update and preserve
all user notes/unmanaged blocks. Keep the row's actual parent and the local
mapping consistent. Uncertain creation must be reconciled by exact key before
retrying. Save returned IDs and receipt immediately, before another write.

Use the existing mailbox `kind=event` with a stable
`outcome_projection:<source-event>:<outcome-key>` key if a projection remains.
Do not enqueue a new event on every poll, reset an unprocessed projection, scan
all prior chats every round or add a timer. Mark failed syncs explicitly; local
evidence survives and independent work proceeds. Only meaningful new decisions
or important outcomes use existing inbox notification rules. Backfill does not
repeat notifications for previously reported work.

The initial three views are Recent deliveries (rolling seven days), Validated
results (grouped by project), and Awaiting adoption. Undated records remain in
the latter views and the full Outcomes database. Actual view IDs are bound locally.

## Required write guard

Use control.mjs `kind=notion_sync`, prepare/claim/tool/settle, with the current
policy and fresh source authorization, `content_changed=true` and
`manual_content_preserved=true`. External tool permissions remain authoritative.

- Root page content: `operation=update_page`, `page_id` is the bound root, no
  `data_source_id`. Preserve all database/view tags and the 我的备注 section.
- New row: `operation=create_outcome`, `page_id` is the bound root,
  `data_source_id` is the bound data source, `task_id` and `outcome_key` match.
  Evidence requires `outcome_evidence_verified=true`,
  `existing_records_checked=true`, `existing_record_found=false`. Native
  create_pages uses that data source as parent. Save its mapping immediately.
- Existing row: `operation=update_outcome`, `page_id` is the registered row,
  same `data_source_id`, `task_id`, `outcome_key`, and verified outcome evidence.
  Native update_page targets that exact row. Prefer targeted edits.

The guard reloads bindings at prepare and claim; a newly found duplicate or
disabled binding blocks the action. It permits neither comments, deletion,
sharing, schema expansion nor writes to an unrelated page/database. New instance
setup requires new explicit bindings and empty state; never export these live IDs.
