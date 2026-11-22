# T3-native workflow

T3 is the only execution control plane for an installed T3 instance. Use native
threads, runs, queues, asynchronous questions, PR watches, schedules and thread
controls. Do not start a second runtime, scheduler, polling loop or wake relay.
Read the installed `t3-workflow.json` first: source/admission/service pauses and
scoped migration resumptions take precedence over standing role instructions.
A workflow refactor is not permission to resume collectors or product work.

## Standard roles

Every installed instance has two required conversations: **Main**
(`roles.main`, on-demand status and manual dispatch) and the **Decision & Report
Inbox** (`roles.decision_report_inbox`, `决策与汇报`, pinned). Create and bind the
Inbox at installation and initialize `decision-inbox.json`; follow
DECISION_REPORT_INBOX.md. `t3 status` lists `missing_standard_roles` and exits
2 until both exist. Discovery and Maintenance remain optional services enabled
only by actual human authority. Task owners queue decisions and substantive
completions to the Inbox; they do not open native Ask cards.

## Human approval scope

Follow the instance's latest verified direct human approval policy. Under
`t3_three_category_approval_v1`, ask only for breaking/format changes, possible
negative Enterprise-user effects (including temporary regressions/index rebuild),
or Slack messages/GitHub comments. Ordinary accepted work, Ready and eligible
merge needs no separate personal-inspection answer. Existing applicable grants
are reusable. Broad/high-risk flags alone are not a fourth human approval class.
Missing impact evidence is owner investigation; technical CI/review/repository
approval/feedback/head checks remain automatic waits, not human waiver requests.
Explicit task stops, accepted scope, unknown-effect dedup and source/service
pauses remain effective. This policy grants no unrequested production operation.

`approval_policy_record` installs the exact direct human three-category policy
through the public ledger; only actual designated Maintenance can do so. The
content-addressed source/proof is checked on each native PR gate without editing
archived policies. `pr_binding_record` lets the actual original owner record its
native PR/full-head association without a human grant. After binding,
`pr_authorization_get` returns the standing policy for ordinary work; no fake
personal-review record is written. Use that returned source evidence reference
and fresh policy version for check/claim. Impact assessment adds the boolean
`enterprise_negative_impact` alongside `breaking_change`/`format_change`, with
exact current PR/head/owner, complete labels and a concrete assessed reason.

Only the actual three categories need `pr_authorization_record`: v3 accepts
`approval_categories` (`breaking_change`, `format_change`,
`enterprise_negative_impact`, `slack_message`) with a direct original-owner human
answer naming the exact PR/head and the accepted categories. No personal-review
claim is needed: e.g. `允许 format-change` or `允许发送 Slack 消息`.
Multiple categories use `、`.
These are adapter examples, not permission to require magic words from Yang;
retain the actual native answer and use ordinary judgment outside the optional
adapter rather than asking him to repeat an already clear instruction.
Category grants append by actual message identity; existing v1/v2 grants and
proofs remain immutable and composable. An accepted format risk does not grant
an Enterprise regression or outbound message. GitHub comments remain owner-native
with actual human permission; the PR action adapter does not implement comments.

## Execution and ownership

Follow the instance's actual human test-location policy. Under
`correctness_ci_performance_vm_v1`, correctness suites and their builds run in
project CI at the exact task head; performance experiments and benchmark builds
run on managed VMs. Do not use a local unit/property/integration test or executable
"probe" as an exception. Keep local work to editing, static checks, log/evidence
inspection and orchestration. Reuse valid completed results; route pending stages
without blindly restarting healthy compile work. Prevent a local compile's
automatic benchmark stage from launching locally. Record exact CI run/head and
VM/source/binary/architecture/resource/cache/concurrency provenance; keep output
validity/recall checks in benchmarks without replacing correctness CI. Reuse
compatible available task-managed VMs and preserve resource/cleanup/access and
product gates. Do not replay completed work just to change its recorded location.

Each independent task has one original ordinary owner thread. Preserve its
project, provider, model/options, effective Full access, contract, historical
holds and uncertain action receipts. A native creation/send ACK is not evidence
of execution, product completion, acceptance, merge, release or deployment.

Main handles Yang's on-demand status and manual dispatch. The Decision & Report
Inbox carries owner decisions and important reports to Yang. Discovery classifies,
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

### Review follow-up after feedback without approval

When Yang requests a PR comment or REQUEST_CHANGES and has not approved the PR,
the original review owner remains responsible after the authorized feedback is
actually posted. Read back the real comment/review and save its remote ID/URL,
head and time as the follow-up anchor. Sending feedback completes that action,
not the review task. Use native Auto-settle behavior Never for this unfinished
follow-up; preserve one existing watch or bind a missing native PR watch to that
same owner. No replacement review thread, Main relay or new runtime is needed.

Consume already available author replies and revised heads before starting a
watch: otherwise its baseline can hide an event that already happened. Wake for
another genuine Ready-for-review transition, re-request or author-ready signal,
or a substantive reply to Yang's feedback. Initial non-draft state alone is not
"ready again"; unrelated bot/CI comments are not an answer. Verify exact author,
comment/thread linkage, event time and current head, then review the relevant
reply/delta and report the conclusion in the original owner thread. Do not
repost the same feedback or infer approval from a reply, resolution flag or CI.
New outbound replies/comments still need applicable actual human permission.

If feedback remains unresolved after reassessment, keep the original watch and
continue this loop. Stop on actual approval completing the review scope, PR
closure/merge, or explicit human stop/dismissal, preserving remaining accepted
work where relevant. A provider turn ending or feedback send is not Settle.
On a watch wake, reuse the existing watch; rearm only after native readback shows
it actually stopped and the same accepted follow-up still needs monitoring.

Current native watch documents comments/reviews, CI and conflicts as wake events.
It does not guarantee a wake for an isolated draft-to-ready or re-request event.
On each actual event, inspect real readiness as well as replies. Record a missing
readiness-only wake as a native capability gap; do not claim guaranteed coverage,
invent an idle job, install a source collector or add polling/relay timers.

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

Before ending on a wait, identify the exact condition, current state, event
that can change it and responsible actor. Consume an already satisfied condition
and continue now. An unresolved terminal failed/cancelled/skipped check is not
pending work (source-backed nonapplicable skips need no retry):
classify its actual cause, then perform an authorized bounded fix, targeted retry
or review request, or give the existing producer the exact corrective handoff.
Read back the real action and new run/request before claiming progress. Reconcile
unknown effects and existing requests before retrying; do not repeat an unchanged
failure or ask Yang for a routine technical waiver. If the necessary producer is
external or access is unavailable, state the exact actor/action still missing.
Continue independent work while preserving genuine dependency and approval gates.

Gatekeeper may skip duplicate review because a designated reviewer already
approved. Read the check's actual explanation and use its supported reviewer-
request path when renewed review is required. SKIPPED is not current-head
approval. Preserve repository rules, designated approvals and complete semantic
feedback assessment; retained approval requires applicable real evidence.
Requesting review does not permit an unauthorized bot-trigger comment.

A PR watch cannot wake at a clock-only delivery-window boundary. If the exact
window is already open, refresh head/gates and act now. For a future genuinely
time-only hold, the original owner creates or reuses one native once schedule
bound to itself at the actual timezone-qualified next eligible instant, with
freshSession=false and stable task/head/due identity. Verify native binding,
enabled state and due time; cancel an obsolete occurrence. On wake, recheck the
condition and current scope. This is a finite time-bound continuation, never a
recurring PR poller or Maintenance relay; use a PR watch for actual PR events.
Before reporting native scheduling unavailable, discover the tools and attempt
the documented tool once; tools can load late. If the API is unavailable, inspect
the supported native Scheduled tasks UI when accessible. Reconcile an existing
exact owner/due schedule before any creation. If neither supported route works,
record the actual errors and the capability gap; never claim a schedule exists
from prompt text, invent an RPC, or install a replacement scheduler.

Do not treat a PR watch as a guaranteed dependency-completion handoff. Its
documented wakes cover checks, feedback and conflicts; a dependency can become
merged with watching=false without starting the consumer's next turn. For an
already authorized dependency between existing owners, the producer delivers
one native message to the exact consumer when the required artifact is usable
or the prerequisite actually merges. Include the artifact/head/base, real
validation, remaining holds and a stable event-specific request ID. Read back
delivery; an ACK is not consumer execution. This is a bounded handoff within
the accepted task graph, not permission for discovery, new owners, a local
outbox/relay, or a timer. The consumer reconciles that evidence and continues
its own scope; do not wait for an already delivered PR or require an entire
producer task to finish when its usable artifact is sufficient. Without a
supported native completion edge or an authorized producer, record the exact
capability gap rather than claiming the watch guarantees continuation.

Reuse the actual compatible dependency PR/artifact, not a permanently assigned
upgrade gate. One task owner does not mean every consumer must wait for that
owner to produce an equivalent dependency. Read current ownership and human
routing decisions, keep one writer for the chosen branch, and preserve each
consumer's own acceptance scope. When that dependency merges, transfer the wait
to the real remaining publication/adoption step; do not leave a consumer settled
or waiting on a merged PR. Protect unfinished consumers with Auto-settle Never.

T3 alone controls Ask/Inbox, Working, Snooze and Settle. Use Settle only for
actually completed delivered scope or an explicit human attention decision;
never use it to hide a dependency wait or unanswered choice. Preserve manual
pins, snoozes and running owners. See `T3_ATTENTION.md`.

When accepted scope extends beyond a linked PR's merge/closure, disable automatic
settlement for that original thread using native **Auto-settle behavior -> Never**
and verify the checked setting. Keep it until the actual scope is delivered;
then the owner explicitly Settles. Native `unsettle` alone is insufficient across
messages in T3 0.1.9: dispatch clears its active override. A per-thread Never
setting persists and prevents both merge and inactivity auto-settlement. Do not
change global settings, unlink real PR evidence, pin tasks or add a local runtime
to simulate this protection. Full details and capability limits are in
`T3_ATTENTION.md`.

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

The actual affirmative answer determines permission. In instances without the
later three-category policy, review-only records have
`conditional_merge:false` and cannot claim merge even if other gates pass or an
older general policy derives merge from review. The later three-category policy
independently permits ordinary in-scope merges, without modifying that old
review-only grant; risky changes and explicit prohibitions remain gated.
Ambiguous/negative language
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

Before escalating a tool failure, use the available read-only documentation,
logs and relevant implementation to establish what failed and what recovery is
actually supported. Do not invent a client button, promise that a new turn will
clear a stop, or ask for screenshots when existing evidence can answer the
question. Respect an explicit Computer Use stop: end UI work as instructed;
do not bypass it with another UI tool, altered state or fabricated turn identity.
Any later authorized recovery must be verified with the normal supported tool
before declaring the original owner unblocked. Keep service failure, account
authentication, technical permissions and product authorization distinct.

Before asking a human to unblock an investigation, read the complete available
source and existing owner/artifact evidence, and prepare the smallest useful
reproduction within scope, executing it through the instance's CI/VM policy.
A missing original script is not itself a
blocker when the reported query/data shape can be reconstructed. Ask for only
the specific material fact that still prevents meaningful work; a request to
contact someone is an external action and still needs applicable authority.

Before presenting a performance regression as a product tradeoff, check the
accepted goal and causal mechanism. Failure to deliver an intended invariant
(for example, fewer final partitions rather than merely fewer intermediate
runs) is unfinished engineering to investigate, not automatically a risk for
Yang to accept. Preserve actual risk gates for residual tradeoffs. Performance
delivery should lead with the requested baseline, comparable conditions and
representative workload; name hardware, storage/cache, concurrency and actual
execution path. Perfect recall on nearly identical scoring domains or tied
results does not establish candidate sufficiency on skewed workloads. Check the
weakest assumption with the closest meaningful counterexample, rather than
making Yang discover a missing baseline or non-discriminating dataset. Reuse
sound existing evidence; this is not a requirement to rerun every benchmark.

Preserve task-scoped native standing grants and routes as such. A human answer
that authorizes qualifying review delivery or all PRs in that owner is not
necessarily a one-head/one-message grant; read the exact scope and later changes.
Index genuine source evidence and reuse it, while retaining actual risk,
destination/content and dedup conditions. Neither an optional adapter's sample
wording nor an older narrower grant requires another Ask when a later applicable
human answer already permits the action. This does not authorize arbitrary
Slack messages, GitHub comments, other owners or product scope.

Before handing a measured regression back as a choice, investigate obvious
bounded mitigations within the accepted goal (for example, rebuild instead of
reusing an increasingly deleted index, or remove duplicate hot-path work).
Explain which alternatives were ruled out and why the remaining tradeoff needs
human judgment. Do not turn every intermediate candidate into another adoption
question or require Yang to choose routine engineering steps. This is not an
unbounded optimization mandate: preserve genuine residual Enterprise-risk
decisions and explicit human deferral.
Assess actual format/API semantics rather than the changed path alone. If a
repository gate is path-triggered, inspect its documented exception and the
owner's actual authority before presenting it as a human blocker. For example,
a supported PMC waiver for a format-neutral documentation correction is not a
waiver of real format changes or mandatory repository approvals.

Company-message digests must reconcile an apparent action request with the
canonical native owner and its current result before labelling it as needing
Yang's action. An already accepted investigation is work in progress, not a new
request to accept it. Keep the dated source fact, link the existing owner and
name only the actual residual human action. If identity or status cannot be
verified, state that uncertainty. Reconciliation does not grant source polling,
outbound replies or new task admission beyond the service's own authority.

When answering whether a benchmark ran, lead with its actual state: not started,
building, measuring, failed or completed. CI success, VM allocation, prepared
scripts and an administrative acknowledgement are not measurement results.
Name the tested workload/head and distinguish old results from the requested
new run. Keep an unrelated administrative reply brief so it does not obscure
the active task's next step; do not add routine progress messages or restart a
healthy build merely to provide a result.

For comparative findings, deliver the named alternatives, their differences,
decision-relevant measurements and recommendation together. Prefer a compact
comparison or chart when it makes the choice clearer; keep test details in
linked evidence when Yang requests conclusions. Do not make successive jargon
explanations substitute for the requested complete comparison.

An explicit instance-local human request may enable recurring Maintenance health
and improvement work independently of paused Discovery/admission. Follow its
actual cadence and reuse the existing original-owner native schedule; never
create a replacement conversation or parallel timer. Verify project, bound
thread, enabled state, interval and freshSession by native update/list readback.
Keep the prompt and instance config synchronized with that exact authority.

For an authorized native worktree or implementation-project owner outside the
instance root, explicitly name the absolute grouping-root instructions, config
and contract in its handoff. Filesystem inheritance is not evidence that it
received active instance policies. Link current time-bounded operational routes
with their authority and expiry; actual authentication/session state still needs
verification. Preserve the original scope, account limits and security stops.
This supplies context, not new task admission or another workflow runtime.

For an implementation task waiting on a named delivery reviewer, verify that a
real pending reviewer request exists, or that an applicable review already
satisfies the gate. Inspect request history and the exact reviewed head before
requesting again. A Ready PR, description mention or active PR watch does not
send that request. Within the original delivery authority and window, issue a
missing supported reviewer request and verify readback; do not substitute a
comment, relax approval, ask for routine start permission or blindly duplicate
an uncertain request. Preserve genuine risk/outbound holds and designated review.

A repair of blocked dispatch requires an existing human creation grant, a topic
and contract already selected by its authorized direction owner, and fresh native
deduplication/unknown-effect reconciliation. Preserve the source owner's actual
model/options and Full access when using an available native transport, record
the real agent performing the repair, bind one ordinary isolated owner, and
verify its config and actual reception. Return the exact receipt to the direction
owner; keep research in the new execution owner. Preserve the original failed
capability evidence. Successful dispatch through another authorized native
transport does not prove the source role's tools recovered. Keep this a bounded
repair, without enabling global admission, new topics or another task runtime.

Keep incremental audit cursors monotonic for each native thread. An empty page
or null nextPosition preserves the prior successfully covered position; it does
not reset it to zero. If a checkpoint regressed, recover the highest evidenced
boundary from its checkpoint chain before classifying new human input. Exclude
duplicate historical reads from intervention counts. Validate every saved cursor
against that recovered boundary. Persist receipts in bounded batches so a tool
host restart cannot turn an unrecorded read into claimed coverage. These are
coverage records, never a second task runtime or a reason to replay actions.

Each authorized health occurrence checks actual tasks/runs, pending questions,
deliveries/unknown receipts, native waits, schedule health and original scope.

Keep one current condition per wait-checkpoint record, with its matching head,
actor/event, evidence and age calculated at the stated observation time. Move
satisfied conditions into history. When the remaining condition changes, establish
its own evidenced start or record duration_unknown; do not inherit a release or
clock wait's age, kind, head or verdict into a new review, risk or provider block.
Link prior snapshots rather than carrying conflicting old fields into the current
record. These records describe evidence and never change native task state.

Keep the finite Maintenance occurrence separate from the accepted product task.
A bounded recovery handoff limits Maintenance's intervention; it does not turn
the original owner's contract into one test or one small fix per health pass.
After consuming a completed CI/build result, continue runnable work in the
accepted scope until an actual dependency, explicit hold or completion applies.
Do not list remaining engineering as a passive wait with no event or actor.
A CI/review wait blocks its dependent steps; useful independent preparation or
analysis should continue without extra work, experiments or status placeholders
manufactured just to appear busy. Preserve actual scope and technical/risk gates.

Directly implement evidenced proportionate workflow fixes with appropriate
validation; repair already-authorized owner handoffs without taking product
ownership. Preserve healthy work, explicit stops, models and current human
approval boundaries. Do not turn a health pass into source collection, global
admission, a status-repair poller, service replay or a new product task. Write one
dated concise local report and end; routine updates do not go to Main. Native
schedule registration proves configuration, not a future successful occurrence.

For a failed provider turn, inspect its exact terminal error and the original
owner's native queue before attempting recovery. A disconnected response stream
does not mean its commands or external actions failed. Reconcile completed jobs,
artifacts and uncertain effects first; preserve successful outputs and queued
callbacks. Within an existing maintenance repair grant, use at most one stable-ID
continuation for that concrete failure, in the same owner and settings. Verify
actual execution afterward. Do not replay callback commands, cancel useful queue
items merely to clear them, restart a healthy job, or repeat an unchanged failed
recovery. Repeated failure is an evidenced capability problem, not a retry loop.

If the exact failure is the provider's automatic compaction request, prepare a
durable checkpoint from current source, scope, human authority, holds, worktree,
jobs and action receipts before recovery. One supported same-thread
`freshContext` continuation can preserve native history and owner settings
while replacing the failed provider context. Do not clear healthy context,
invent missing authority, change models or create a replacement task. Verify
real execution afterward; if the same failure recurs, record the blocker.

For a prepared cross-owner handoff left by a failed turn, a saved request or
printed JSON is not delivery. Reconcile its stable ID against actual target
messages, queue and receipts. Within the existing maintenance handoff grant,
deliver a verified, still-applicable handoff once to the existing canonical
owner, identifying the actual sender and source. Do not replay an unknown
delivery, take over the failed producer's work or retry its context repeatedly.

When preserving a healthy CI run delays a prepared fix, record the exact run and
the next action after it terminates. Once terminal, that old run is no longer a
reason to withhold the already-authorized fix's validation. A watch on a different
PR is not an Actions-completion wait. Use a supported native event if available;
otherwise record the specific wake gap without inventing a timer or poller.

Serialize public ledger CLI invocations against the same instance. Even a
read operation may perform supported schema setup on opening the ledger;
concurrent invocations can report `database is locked`. Preserve the error and
retry a confirmed read sequentially. For an action claim or unknown write,
reconcile its exact key/receipt before retrying; never infer no effect from a
lock message or bypass the public interface.

When the instance's human authority includes intervention review, each health
pass also reads actual user interventions, preceding owner context/available
authority, and subsequent responses/outcomes since its last verified coverage
checkpoint. Distinguish avoidable workflow faults, necessary human decisions
and insufficient evidence. Judge the possible autonomous step against facts and
scope available then; new requirements or proactive human questions alone are
not owner failures. A native user/server label alone is not sufficient actor
proof: known agent administrative request-closures may render with that label.
Retain exact exclusions and source provenance; do not count them as Yang's
intervention or authority, and do not reject genuine server-delivered answers
as a class. Fix the smallest reusable cause, validate it, preserve real
Ask/permission gates, and record exact source references, cause, change and
coverage gaps. Save minimal local cursors; later passes verify recurrence and
effectiveness. Do not hide questions, widen authority or count fewer Ask messages
as proven improvement; a configured review prompt is not an executed review.

Enabled sources run one finite scan per actual native Discovery occurrence.
Pagination/coverage cursors are source evidence, not an execution scheduler.
Queue material changes once to their exact authorized native owner using native
idempotency; retain unknown receipts. Never publish into a retired runtime,
resume an old provider session or replace a running owner. Respect disabled
sources and historic exact-thread bindings. Maintenance performs useful work
once in its actual native occurrence, writes a concise health report and ends.
No routine messages to Main. No relay timer or new service conversation.
