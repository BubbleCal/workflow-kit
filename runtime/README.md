# Portable instance bindings

Run commands from this installation directory. Read instance.json first. Native role IDs, project scope, GitHub author, optional review channel/approver and Notion page belong only to this instance. External delivery requires enabled instance features and an allowed repository. Product chat actions require operation_project_verified=true and operation_project_id matching this instance. Never reuse another installation's IDs, state or authorization.

# Durable workflow action control

CONTINUATION_FALLBACK.md defines watchdog_targets/plan integration,
watchdog_status and watchdog_resolve. The existing dispatcher supplies compact
native owner snapshots; deterministic cases/outbox survive missed result events
and process restarts. Recovery ACK requires a durable actual disposition. A
missed eligible coordinator round escalates once to the existing maintenance lane.
New guarded execution prompts include engineering-principles.mjs; existing
immutable actions are never rewritten to add the guidance retroactively.

STAGE_CONTINUATION.md defines the goal/stage ledger in mailbox.sqlite. Consume
stage results with record_progress before ACK; continuation_claim/delivery/started
separate pending work, transport and real execution. Every start still requires
the existing control dispatch guard. Registered unfinished goals block archival.
read_only_analysis admits only freshly verified source/connector capabilities
under the actual native policy, without asserting engineering Full Access.

Daily workflow maintenance uses the same dispatcher and mailbox idle checks.
daily-review/config.json specifies 05:00 Asia/Shanghai; DAILY_REVIEW.md defines
the authorized diagnosis, implementation and validation loop. The maintenance
lane targets the existing setup chat, retains one unfinished day, and catches up
the latest due day after downtime. runtime/daily-review.test.mjs covers the local
cutoff, fixed window, restart deduplication, busy-owner protection and continuation.

This small local control layer applies selected ideas from dsh-superagent at
commit 6337fc823ce20251c8de8085948165c81aaa701e: immutable source events, persisted
side effects, separate work/turn state, and explicit attention. It is an original
implementation for the existing Codex workflow, not a deployment of that runtime.

`control.sqlite` stores source-event deduplication and action receipts. It never
calls a connector, browser, cloud API or worker itself. The background coordinator
supplies fresh owning-source evidence, claims an action, invokes the existing
approved tool, and immediately records the outcome. Registry/Notion remain the
human-readable task/decision projections; SQLite is the action-receipt authority.
Do not store passwords, cloud tokens, one-time codes, or full auth URLs here.

Use Node with built-in node:sqlite (verified v23.11.0). Run the test command from the installation root; it creates isolated fixture instances instead of editing this instance. There are no
new packages, external services, API keys, model changes, or background daemons.
SQLite reports its experimental-API warning on this Node version. Keep this
runtime version available; validate before changing it. Tests use node:test.

## Invocation

Send a JSON object on stdin to:

```sh
node runtime/control.mjs
```

Read-only status also supports:

```sh
node runtime/control.mjs status
```

Do not interpolate unescaped user text into shell commands. Write structured JSON
to a temporary file and redirect stdin, or use a single-quoted heredoc delimiter.
Keep tool receipts in existing observations and refer to their paths/IDs.

## Action sequence

Control-plane routing is now governed by QUEUE_PROTOCOL.md. CLI prepare(kind=notify)
and human_input targeting the coordinator validate and enqueue instead of granting
permission to send. They return queued=true/send_tool_forbidden=true; end the
producer turn, do not claim or call send_message_to_thread. The mailbox dispatcher
is the sole automatic sender to idle control chats. The sequence below continues
to apply to ordinary engineering/PR side effects.

For a technical follow-up, preserve intent=question and the source/result reference
when queueing human_input to the coordinator. Delivery of an ordinary question to
an engineering owner waits until its chat is idle. Verified owner responses use
notify category=answer with question_message_id; evidence must verify the original
question, matching question ID and owner response. An answer is not a task-complete
event and does not change the engineering task's acceptance state.

1. Inspect actual task authorization, current policy, target state and operation
   preconditions. Preserve the source timestamp; never label stale facts fresh.
2. `prepare` takes key, kind, task_id, payload and evidence. Call it **before**
   adding a new key to registry.outbox. The CLI imports legacy registry receipts
   on preparation; an old prepared receipt becomes uncertain, not permission to
   send. A stable key with a changed payload is an error. If already sent or
   cancelled, stop. If an identical prepared action exists, it may be claimed
   after fresh verification; uncertain/claimed actions need reconciliation.
3. Mirror the prepared action to registry.outbox. Obtain fresh preflight evidence
   and call `claim` with key, coordinator owner ID and evidence. Only proceed when
   claimed=true. The returned attempt_id binds the next outcome to this attempt.
   Scope locks are derived from the target: worker chat, PR, inbox, Notion page,
   or host browser. Two processes cannot claim the same action or active scope.
   For slack_pr and pr_ready, claimed=true still forbids the external tool until
   authorize_review_send grants send=true as described below.
4. Invoke the authorized connector/tool immediately. For merge, pass the exact
   guarded expected_head_sha. Do not do unrelated work between claim and action.
5. `settle` immediately with key, attempt_id, outcome and evidence_ref, then mirror
   to registry. Outcomes are sent, uncertain, or not_sent. A timeout after possible
   delivery is uncertain. not_sent requires actual evidence of non-delivery;
   only rejected_before_send/transient_before_send retry, with backoff, at most
   two attempts before a failed hold. Never reinterpret an ambiguous timeout as
   a pre-send error to get a retry.
6. A crash leaves claimed durable. Do not reclaim on elapsed time. Inspect the
   original owner and destination. `reconcile` needs fresh owner_quiescent=true,
   verified_at, an evidence_ref and confirmed_outcome sent/not_sent. A proven
   unsent non-legacy action can return to prepared. Late results from the old
   attempt cannot settle a later attempt. Imported uncertain rows that are proven
   unsent are cancelled; prepare a new explicitly linked recovery key if needed.

The helper does not turn connector calls into distributed transactions. It
cannot atomically fence a user starting a new Codex turn after the last read.
Keep the coordinator single-owner, re-read immediately before dispatch, skip
active/queued/uncertain work, and use native conditional APIs where available.
It is a required workflow check, not an OS/network security boundary.

## PR review delivery window

The actual human restriction in pr-review-window.json blocks review delivery
every day during Asia/Shanghai [04:00,12:00). The runtime reads this persisted
rule at prepare, claim and immediately before send. Invalid configuration fails
closed for review delivery. It does not pause development, tests, internal review,
repairs or existing merge gates.

Use kind=slack_pr for the canonical URL and kind=pr_ready for a draft-to-ready
transition. The latter takes payload={pr_url,expected_head_sha,operation:"mark_ready"}
with the same current-head validation/review/authorization evidence, pr_open=true
and pr_draft=true. Create new PRs as drafts; direct non-draft creation must not
bypass the review-delivery window. Worker milestones queue readiness evidence to
the existing coordinator. New necessary worker dispatches include this rule;
never interrupt running owners merely to broadcast it.

A valid prepare inside the window persists state=deferred and due=noon, returning
deferred=true and send_tool_forbidden=true. This is saved work, not a failure or
human-decision blocker. status exposes deferred_reviews and prepared_reviews,
including earlier prepared actions. Each existing coordinator round checks them;
before noon leave them quiet and do independent work. At/after noon, obtain fresh
head/readiness/hold/dedup evidence and claim the same key. If its head changed,
cancel only the verified unsent old action and prepare the current cycle once;
never mutate its immutable payload or replay a sent URL.

For either review kind, immediately before invoking the external tool call
authorize_review_send with key, attempt_id, owner, fresh evidence and
operation_not_started=true. That last assertion must be true for this attempt.
Only send=true permits the exact returned payload, once, immediately and strictly
before valid_until. A pre-04:00 claim crossing into the window is returned to
durable deferred state. An already authorized attempt is never silently released:
if its outcome is unknown, retain it for normal reconciliation. If a permit
expires before invocation, prove non-delivery and reconcile; never reuse it.
Always settle actual outcomes, including ambiguous ones, without blind retries.

The local runtime cannot atomically transact an external connector call with
wall-clock time. This is the required final workflow gate; callers must not insert
other work between authorization and invocation or invoke after its deadline.
No timer, alternative transport or notification is added for the daily deferral.

## Project placement is part of creation

Before preparing create_thread, use native list_projects and actual user/task
context to resolve the intended project. `resolve_project` accepts that catalog
as projects, host_id, project_id and/or project_label, and source_ref. It fails on
a missing/ambiguous match instead of choosing projectless. Its placement and
native_target fields are the starting values for payload.placement/native.target.
Use projectless=true plus a concrete reason only for deliberate projectless work.
Use staging=true only when a local scratch directory is actually needed; this
keeps the intended project and produces method=move, not projectless intent.

create_thread requires payload.placement={project_id,host_id,method,reason?}:
method=create binds the native project target directly; method=move requires a
projectless native scratch target and a subsequent supported project assignment;
method=projectless explicitly retains project_id=null. Evidence must include
project_resolution_verified=true, project_resolution_ref, intended_project_id,
project_host_id and project_exists=true for a project (or
intentional_projectless_verified=true for null). These are actual catalog/context
facts, not permission-probe flags. No project ID is hard-coded by the runtime.

1. Prepare/claim/create as usual, then settle immediately with native_result set
   to the actual native ACK. sent means the transport side effect happened;
   setup_complete remains false. The durable thread_setups table tracks follow-up.
2. If the ACK is missing its identity or only returns clientThreadId, use
   record_creation after native identity reconciliation. Supply fresh evidence
   with identity_verified=true/evidence_ref; a queued client must match
   evidence.client_thread_id. Never treat a clientThreadId as a real thread ID.
3. Call confirm_creation with key, the exact native list_threads entry as snapshot,
   source=list_threads, verified_at from the actual retrieval, and evidence_ref.
   Thread ID, host and an explicit projectId (including null) must match. A wrong
   project returns setup_complete=false and the exact supported native_move args.
4. Prepare kind=assign_project with creation_key/thread_id/host_id/project_id,
   the same task_id, and fresh membership_observed/actual_project_id,
   owner_thread_id/actual_host_id, project_resolution_verified/intended_project_id,
   project_host_id and destination existence evidence. Claim before calling native
   move_thread_to_project, then settle its ACK. No worker wake or permission change
   is part of this move. Unknown outcomes remain uncertain; inspect membership,
   reconcile receipts, and never blindly retry or create a replacement chat.
5. Repeat confirm_creation from a fresh list_threads observation. Only its
   setup_complete=true result completes setup. A move ACK alone does not. Mirror
   this fact to registry only then. status.pending_thread_setups exposes omissions
   across restarts; reconcile these before ordinary new work. Automatic productive
   dispatch to a newly recorded owner remains blocked while its setup is pending.

Existing creation/assignment receipts are not replayed by this migration. Old
prepared actions lacking placement fail closed: cancel only a verified unsent
prepared action and prepare a revised, explicitly linked key. Already sent or
uncertain creations need identity/membership reconciliation, never duplicate
creation. Historical owners without a new setup record are not mass-moved.
Later intentional membership changes are reported as drift, not automatically
undone using an already-completed creation. Project membership does not satisfy
the separate effective-runtime-permissions gate.

## Other action evidence

All evidence needs verified_at within 60 seconds, scope_authorized=true,
authorization_ref and policy_version=current_policy_version. Automatic actions
also require stopped=false. Verified human_input remains routable after recording
the user's hold, so recording a stop cannot prevent its delivery to the worker.
Missing facts fail closed. Names below are the JSON keys the implementation uses.

- dispatch: thread_status=idle; queued_input, pending_dispatch,
  underlying_job_running, overlapping_owner and existing_driver_owns_step=false;
  work_incomplete, owner_matches and capacity_available=true;
  expected_turn_id=actual_turn_id; owner_thread_id=payload.thread_id.
  The CLI derives both count ceilings from registry.capacity.automatic_limit.
  null means unlimited; the library default is also unlimited, never the old 5.
  capacity_available still requires actual usable resources and does not mean a
  free global task slot. Keep payload.starts_heavy_work and stable payload.run_id
  for receipts. Global counts are optional telemetry when unlimited; supplied
  counts must still be nonnegative integers. A missing explicit configuration
  fails closed instead of silently substituting a former limit. Existing jobs
  and the five-minute coordination budget are preserved.
- human_input: a verified actual human correction/stop/decision can be forwarded
  once to the current owner even if it is active; it is not an automatic continue.
  Require actual_human_message_verified/source_actor_verified/owner_matches=true,
  input_already_delivered=false, payload.source_message_id=source_message_id,
  payload.verbatim_text=source_text, matching owner_thread_id, and a known target
  state (idle/active/awaiting_input). Ordinary intent=question additionally needs
  an idle owner, no queued input/pending dispatch/background job, and matching
  expected_turn_id/actual_turn_id at preflight. Forward only that actual scoped instruction;
  never turn polling or a proposed action into a fake human message.
- create_thread: only a verified human request for new execution chats. Require
  explicit_new_thread_request_verified, matching source_message_id/verbatim_text,
  matching canonical_task_key, ownership_handoff_verified, no overlapping owner,
  duplicate task, running job for that scope, existing driver or pending dispatch.
  Require worktree_isolated, no branch_owner_conflict, and preparation_reused_or_absent.
  The scope lock uses the canonical task key before a native thread ID exists;
  a sent creation for that work blocks another key from creating a duplicate.
  Record create_thread and dispatch against the same durable run identity.
  Active/reserved counts are optional telemetry while unlimited; actual resource
  availability and per-work ownership remain required.
  Persist returned thread/clientThread identity and reconcile uncertain creation
  against the actual app before any retry. Native tool permissions still apply.
- notify: payload.thread_id is the decision inbox; category is decision,
  action_required, important_completion or answer; material_change=true and
  already_notified=false. Decisions/actions need human_action_required=true;
  completions need completion_verified=true. Answers need
  source_question_verified=true, owner_answer_verified=true and matching nonempty
  payload.question_message_id/evidence.question_message_id.
  Routine progress/enrollment/archive housekeeping cannot pass.
- slack_pr: payload contains only the canonical PR URL as message, exact allowed
  channel_id and expected_head_sha; evidence includes matching pr_url/current head,
  configured GitHub-user ownership, open non-draft PR, ordinary change, no material findings,
  current validation and technical review, already_announced=false.
- merge: the same ready-PR facts plus matching payload.pr_url, verified configured-approver
  APPROVED review valid for the current PR, required_checks_pass, repository_rules_satisfied,
  mergeable=true and admin_override=false. If approved_head_sha differs from current
  head, supply approval_review_id and fresh approval_verification as described
  in MERGE_APPROVAL.md. Preserve the actual reviewed SHA.
- archive: idle/turn checks above, matching owner_thread_id,
  task_complete/completion_evidence_saved/important_result_delivered=true;
  pending_decision/pending_cleanup/pending_delivery/control_or_service_chat=false.
  Control chats have an additional hard exclusion. For an unimportant reference,
  important_result_delivered means the result is already durably available and
  no new human-facing delivery is required, not that a new notification was sent.
- auth: current_auth_failure/profile_and_account_verified/external_browser=true;
  human_only_factor_required/other_login_owner=false. payload.host_id binds the
  shared browser scope. Healthy profiles and required human factors do not start.
- notion_sync: exact authorized payload.page_id; content_changed and
  manual_content_preserved=true. Stable section/content hash belongs in the key.
- automation_update: only automation-3/4 prompt edits for the coordinator;
  actual_human_message_verified/source_actor_verified=true, matching
  payload.source_message_id and evidence.source_message_id, matching
  payload.expected_config_hash and evidence.current_config_hash, and
  non_prompt_fields_preserved=true. Keep schedule, status, destination, model,
  reasoning and notification settings; re-read the saved configuration at claim.

Supported maintenance operations: observe (immutable source event with id,
source, task_id, source_time, data); import_legacy; cancel (prepared action only,
with reason); processing (enabled boolean); status. Pausing processing only
prevents new claims; it never stops jobs or workers. Do not use it as a substitute
for user-directed task cancellation. All reconciliation is evidence-based.

## Tests

```sh
node workflow.mjs test
```

Tests cover duplicate events and receipts, two database connections claiming the
same resource, stale turns/policy, active/background-running work, crash recovery,
late outcomes, retry backoff, notification noise, Slack destination/content,
current-head merge approvals, archive obligations, browser ownership and legacy
receipt import. They do not call real external services or alter active tasks.

## Replacement / manual provenance additions

New create_thread actions must set permission_probe_only=true and
starts_heavy_work=false. Productive dispatch requires runtime_permissions_verified,
matching runtime_permission_turn_id, approval_policy=never,
sandbox_mode=danger-full-access, and verified worktree, registry and network access.
Explicit replacement archive uses purpose=explicit_owner_replacement with the
actual human message/text, saved checkpoint SHA-256, an idle frozen owner and
preserved job/resource obligations; it never claims task completion.
Creation carries replacement={old_thread_id, archive_key, prior_creation_key,
checkpoint_sha256}; the ledger binds the latest sent creation to its sent archive.

manual_direct dispatches require a durable manual_task_assignment event with
verified human actor, message text, task and canonical key. Claim checks this
event rather than trusting caller manual_event_verified. Automatic concurrency
and per-run dispatch counts are unlimited; old authorization alone is not a
current manual assignment.

Native unarchive is a separate guarded recovery action, not completed-work archive.
It requires actual human resume text/message, archived quiescent target, no
overlap/pending dispatch, incomplete authorized work and saved resources/checkpoint.
Use archived=false with native set_thread_archived; then route the real human
continuation once. Do not require completion or falsify it to restore a task.

For current explicit human engineering-start instructions, manual_direct with
start_engineering_directly=true may omit the workflow probe phase. The claim must
match a durable human assignment event whose start_engineering_directly is true;
the manual capacity exception alone is insufficient. Native permissions apply.
A true human resume may reach a restored notLoaded original owner only with
explicit_resume_request_verified, thread_archived=false, latest_turn_quiescent,
no pending dispatch and no overlapping owner. This never grants native access.

The single live automatic_limit is null (unlimited); max_new_heavy_concurrency
and max_dispatches_per_run mirror null. The CLI preserves explicit null even if
legacy fields contain stale finite numbers; never use a falsey fallback. Legacy
fields are compatibility mirrors, never separate configuration values.
Passive waits with no live underlying work have no capacity reservation.

The automation_update guard also allows the explicitly authorized
daily-pr-standup-draft prompt refinement with standup_refinement_authorized,
draft_only_preserved and exact_interval_preserved evidence. All non-prompt
fields remain unchanged and current-config hash is rechecked before update.

Read REVIEW_FEEDBACK.md before following PR feedback or attempting an enabled PR delivery/merge. Complete all-author source intake and current-head semantic assessments are mandatory; repeat polls reuse content/head evidence and repair routes.

Ordinary authorized `dispatch` also supports an unloaded terminal owner. Keep
`thread_status=notLoaded` and supply `native_thread_snapshot` with the actual
`thread.id`, `thread.status`, `latestTurn.id/status`, and `checked_at` from a
supported native read (fresh within 60 seconds at both prepare and claim).
The snapshot must match the target and actual turn and be completed, failed or
interrupted without active flags. Require `thread_archived=false`,
`native_approval_pending=false` and `native_permissions_unchanged=true`.
Interrupted turns additionally require `interruption_reconciled=true` and a
nonempty `interruption_evidence_ref` establishing no human stop or unresolved
native approval. All existing job, queued-input, owner, scope, native-permission
and deduplication checks still apply; unknown jobs are not absent jobs. This is
not a human_input action, permission probe or new task. Ordinary completed-task
archive reuses this native quiescence check, while still requiring whole-task
acceptance, delivery/cleanup closure and no unfinished parent goals. See
LIVENESS_RECOVERY.md; do not wake a completed owner merely to archive it.

## Optional outcomes projection

When explicitly configured and authorized, follow ../OUTCOMES.md to maintain a separate outcomes page from accepted evidence in existing coordinator rounds. Preserve the decision page, task acceptance and manual notes; do not add timers or reporting-only worker messages.

## Version-2 transitions

Follow ../LIFECYCLE.md for actual PR-state obligations, owned-result disposition, typed
wait evidence, operational priority with aging, and cached-state invariant checks
on the existing dispatcher. Enable only at a verified batch boundary; existing
work and external integration opt-ins remain unchanged.

TASK_DECISIONS.md documents task-decisions.mjs read-only views, private question
preparation and reply routing. Actual notify/human-input queue preparation and
inbox rendering use this path; only the coordinator saves question/page state.

TASK_OWNERSHIP_AND_PR_GATES.md defines canonical chat checks, scoped checkpoint
handoff, applicable_ci/gatekeeper evidence and actual ready/send gates.
