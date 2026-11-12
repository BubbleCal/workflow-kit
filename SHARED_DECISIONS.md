# Keep the existing Notion decision page current

Main owns the shared decision projection at `instance.json.delivery.notion_page_id`.
This is the existing 工作待决清单, not the durable knowledge base or Outcomes.
Owner-managed delivery did not revoke this responsibility.

Whenever main presents a genuine pending decision or processes Yang's answer,
update the same page in that turn. This includes personal/Functions PR cards.
Reconcile actual human answers, current owner evidence and PR delivery/completion
before writing: a sent card or stale `needs_decision` label alone is insufficient.
Use the original T ID and concrete subject; never create another D sequence.

Keep the current section short: question, recommendation, material tradeoff and
PR/report link. Remove answered, superseded or completed questions from that
section and retain a concise recent-resolution entry. Do not list routine CI,
provider, dependency or owner-handled technical waits as human decisions. Preserve
manual notes, unrelated content and historical evidence; clearly label old snapshots.

Use `control.mjs` prepare/claim/tool/settle with `kind=notion_sync`,
`task_id=shared-decisions`, `operation=update_page`,
`projection_kind=shared_decisions`, the configured exact page ID and a saved
`native_request` using targeted `update_content` or `insert_content` on that page.
Main is the executor. Evidence includes the normal fresh authorization/policy
fields plus `content_changed=true`, `manual_content_preserved=true`,
`decision_sources_verified=true` and `shared_decision_evidence_ref` pointing to
saved source reconciliation and fetched page. These guards do not authorize
main to change another owner's outcome row, send a PR, merge or deploy.

Save the intended update and actual Notion receipt before settling. If writing
fails or is uncertain, preserve the pending projection and report the exact gap;
do not claim the page is current or blindly retry an ambiguous write. The next
main decision/reply turn first reconciles that pending update. Do not introduce
a coordinator, recurring scan, new page or timer.
