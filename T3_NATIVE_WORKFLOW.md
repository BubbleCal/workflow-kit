# T3-native workflow

T3 is the only execution control plane for an installed T3 instance. Use native
threads, runs, queues, asynchronous questions, PR watches, schedules and thread
controls. Do not start a second runtime, scheduler, polling loop or wake relay.
Read the installed `t3-workflow.json` first: source/admission/service pauses and
scoped migration resumptions take precedence over standing role instructions.
A workflow refactor is not permission to resume collectors or product work.

## Execution and ownership

Each independent task has one original ordinary owner thread. Preserve its
project, provider, model/options, effective Full access, contract, historical
holds and uncertain action receipts. A native creation/send ACK is not evidence
of execution, product completion, acceptance, merge, release or deployment.

Main handles Yang's on-demand status and manual dispatch. Discovery classifies,
deduplicates and dispatches authorized independent work; it does not execute a
review in its service conversation. Clear PR/doc assessments may be admitted
without another creation question only under actual enabled standing authority.
The review owner delivers conclusions and asks before external approval,
feedback or follow-up product edits unless already specifically authorized.

An owner starts with its actual native turn. There is no local `adopt`, `begin`,
`checkpoint`, `decide`, `finish`, `cycle_complete`, queue claim or permission
probe phase. Old imported instructions requiring these runtime operations are
historical. Missing runtime rows do not block already-authorized native work.
Keep concise task evidence at meaningful boundaries and deliver results in the
original thread; routine work needs no ceremony or Main progress digest.

Read source snapshots and original contracts before resuming imported work.
Use the existing migration mapping rather than creating replacement tasks.
Completed tasks stay complete. Only exact human-authorized destination owners
may resume; a paused global admission flag does not revoke their scoped grant.
A service owner receiving handoff cannot restart a paused collector/schedule.

## Waits, decisions and status

Ask a native asynchronous question in the original owner when Yang must choose
or act. Continue independent authorized work. Read the actual pending request;
prose, pins and local ledger labels do not establish native Ask/Inbox state.
Clarification is not approval: preserve one live unresolved business choice,
except where Yang explicitly deferred/dismissed it. No side chat or Main relay.

For a PR dependency use a native `watch_pull_request` bound to the original
owner, preserve existing watches and consume available feedback. End the turn
as the native tool directs. For actual background jobs/delegates use supported
native awaited-work APIs. A provider turn ending does not finish the business
task. Do not invent a timer, process, delegate, polling loop or status to keep
Working. A missing native wait capability is a concrete gap, not a reason to
start a replacement runtime. `t3_background_wait` is not a Codex fallback.

T3 alone controls Ask/Inbox, Working, Snooze and Settle. Use Settle only for
actually completed delivered scope or an explicit human attention decision;
never use it to hide a dependency wait or unanswered choice. Preserve manual
pins, snoozes and running owners. See `T3_ATTENTION.md`.

## Small local evidence layer

The canonical implementation is under `t3/`; shared evidence checks are under
`guards/`. `runtime/t3-*.mjs` paths are compatibility exports for in-flight
callers. The installed native entrypoint does not load ControlStore, ReactiveState,
Mailbox, legacy schedulers, Codex native queue transports or the T3WakeOutbox.
The retained `runtime/` implementation is for separate legacy profiles only.

Use the public entrypoint:

```sh
node workflow.mjs t3 status --instance /absolute/t3-instance
node workflow.mjs t3 ledger --instance /absolute/t3-instance --file /absolute/operation.json
```

Local records index original contracts, owners, direct human evidence, useful
results, source coverage and action receipts. They are not an execution engine
or a second source of native status. In a detached instance `pending` explicitly
marks recorded outcomes as evidence and leaves native state unknown; read T3
for current state. `attention` writes are refused. Owner-thread answer recording
never queues the answer back to its owner. Evidence indexing is optional for
ordinary discussion; it must not become a prerequisite for a native Ask.

`register`/`register_review`/`bind_owner` deduplicate authorized new task contracts
and native owner evidence. They do not run the task. `report` indexes a verified
completed native message, not product acceptance. `decision`/`answer` preserve
exact local human provenance and revisions when a durable decision index helps.
`settle`/`observe` reconcile existing native delivery receipts; they do not set
T3's shelf state. Preserve unresolved historic receipts rather than replaying.

Migrated records remain available through `migration_list`. An exact historical
source lookup uses `source_lookup` with `task_id`, `canonical_key` or `source_key`;
it returns original catalog/source records and actual native mappings without
admitting, waking or resurrecting anything. An unmapped/archived/paused source
is a reconciliation case, never an instruction to manufacture a new owner.

## Instance-local policy and historical receipts

A finite `t3 detach-runtime --instance <root> --file <native-authority.json>`
conversion requires the actual designated Maintenance and direct human reform
instruction. It archives original rules, complete external-action receipts,
source/task indexes and original migration proof bytes inside this instance.
The old runtime must remain stopped/processing off. This conversion starts no
owner, collector, schedule or product action and preserves models/resumptions.

The installed `policy_store` is authoritative for these archived rules. It has
no live dependency on the old runtime's configuration or SQLite database and
never silently falls back if an artifact is missing or changed. Original source
paths/provenance and raw snapshots remain retained. Subsequent policy changes
require their actual human authority; do not resync the retired runtime.

## Product actions stay with their owner

T3 supplies execution and user interaction; the owner still applies the actual
business constraints. Preserve personal review, CI/Gatekeeper/full semantic
feedback, Xuanwo/designated approvals, repository rules, channel holds/routes,
review windows, released dependency provenance and exact expected-head checks.
Native Full access, native status and a new runtime cannot waive those rules.

The thin PR authorization/receipt interface supports
`pr_authorization_record/get`, `pr_action_check/claim/settle/reconcile`. It binds
the exact migrated owner, task/PR/head and direct human answer, preserving real
native actors rather than pretending to be old Main or codex_app. Compatibility
repair authority does not grant other tasks permission. Refer to the original
owner's case evidence for scope and any explicitly resolved historical hold.

Only the actual original owner can claim/settle a product action. Check current
source surfaces and policy digest; assess every feedback item semantically.
`pr_action_check.feedback_status.items` provides actual source keys/digests.
Gatekeeper and full-feedback checks must use the same complete review surface.
Claim immediately before the exact external operation; `send:true` is a single
permit strictly before `valid_until`, not proof of sending. Use stable identities,
save the exact tool response and reconcile unknown outcomes before any retry.
A new key, expired permit or changed head cannot erase duplicate/unknown effects.

Success settlement needs exact raw channel/message/ts or expected-head merge
receipts. Raw envelopes may be preserved in `response`. If a connector cannot
supply verifiable success fields, retain the exact result as uncertain; never
invent its structure. The bounded interface accepts sent/uncertain and cannot
prove non-delivery or unlock an unknown attempt by an owner's assertion.
Maintenance does not take over product sending or merging.

For the Slack connector's normalized `{message_link,message_context}` success
shape, never invent raw `ok/channel/ts/message.text`. The original owner can
settle/reconcile with the unchanged send `receipt_ref` plus
`slack_readback:{source:"slack.read_thread",channel_id,message_ts,evidence_ref}`
from a separate actual read at that exact location. The permalink, normalized
context, requested location, parent timestamp and configured Slack sender must
all match. The currently supported complete parent-message rendering must
contain only the canonical PR URL (plain or standard Slack link) and optionally
the exact connector `Sent using ... ChatGPT` attribution. Extra authored text,
partial/error readbacks and mismatched identities/URLs remain blocked. The raw
send and independent readback stay in the recorded verification without being
rewritten. A missing readback leaves uncertain effects blocked, including new
keys; this operation records existing delivery and must never send it again.

Detailed connector renderings may append a generated PR preview or a terminal
`Reactions: eyes (1), white_check_mark (1)` metadata line. These require an
additional `slack_readback.concise_readback` object with source `slack.read_thread`,
`response_format:"concise"`, the same exact `channel_id`/`message_ts` and a separate
raw `evidence_ref`. Detailed proof still establishes timestamp and configured
sender ID; concise proof must independently show exactly the same canonical
authored URL/attribution and sender label, with complete pagination. A preview
must start immediately after the authored prefix and name that exact PR URL;
reaction metadata must be one terminal line with valid names and positive
counts. Neither label alone authorizes stripping text. Extra authored lines,
mismatched paired reads and malformed metadata leave the original attempt
uncertain with no retry. Both original renderings remain intact in verification.

Native v2 registration uses `pr_authorization_record` with exact task/PR/head,
`decision` (`allow_external_review` or
`allow_external_review_and_conditional_merge`), the original human
`native_proof`/`source_message_id`, and the actual caller's `caller_proof`.
`binding_proof.owner_native_proof` supplies this mapped original owner's native
PR association, and `binding_proof.pr_native_proof` supplies the actual GitHub
PR/full-head result. These replace obsolete runtime enrollment and a frozen
contract's missing PR list. Direct complete web/server human messages qualify;
agent-authored, inherited, truncated and mismatched evidence does not. A separate
T-014-style repair question is not required. Optional `maintenance_authority`
preserves actual Main human repair provenance, never product permission.

The actual affirmative answer determines permission. Review-only records have
`conditional_merge:false` and cannot claim merge even if other gates pass or an
older general policy derives merge from review. Ambiguous/negative language
does not grant permission. An abbreviated inspected head is retained verbatim
and expanded only against verified native PR/full-head evidence; neither source
text nor historical contracts are rewritten. Reuse an existing immutable grant;
save later reads to new evidence paths rather than overwriting its proof files.
First-person confirmations such as “我已看过，允许送审及满足条件后合并”
also carry their explicit conditional scope; they do not require the word
“亲自” or a migration-specific answer. Standard seven-character abbreviated
heads require the same native full-head proof. An administrative withdrawal
explicitly authored by an agent is not a grant even if rendered user/server.

`pr_action_check/claim/settle` also supports `kind:"pr_ready"` with
`payload.operation:"mark_ready"`, exact PR and expected head. This phase checks
complete applicable pre-ready CI and full feedback; it does not require the
Gatekeeper result that starts after Ready. Slack URL delivery still requires
the actual current-head Gatekeeper and complete current feedback. Ready success
settlement requires an exact same-head, same-PR, open/non-draft native result or
readback. A generic ACK is insufficient; unknown effects continue to block
retries and later deliveries until reconciled.

## Sources and maintenance

Enabled sources run one finite scan per actual native Discovery occurrence.
Pagination/coverage cursors are source evidence, not an execution scheduler.
Queue material changes once to their exact authorized native owner using native
idempotency; retain unknown receipts. Never publish into a retired runtime,
resume an old provider session or replace a running owner. Respect disabled
sources and historic exact-thread bindings. Maintenance performs useful work
once in its actual native occurrence, writes a concise health report and ends.
No routine messages to Main. No relay timer or new service conversation.
