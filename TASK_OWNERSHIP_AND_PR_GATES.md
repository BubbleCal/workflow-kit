# Task identity and PR review stages

The actual user rules require one independent canonical task per execution chat.
The same task may continue in its own chat. Idle status, a completed turn/task,
shared repository or expertise does not make another task's chat reusable.
Control prepare and claim compare the requested registered canonical task with
the chat's original native creation receipt. For legacy chats without a creation
receipt, use one unambiguous registered canonical key or a coordinator-maintained
task_chat_bindings entry with canonical_task_key and actual evidence_ref. Missing
or ambiguous identity blocks new dispatch; do not invent aliases or rename a
chat to evade it. Existing running processes are not stopped by this guard.

An explicit mixed-owner correction may use human_input intent
scope_handoff_checkpoint with handoff_task_id/handoff_canonical_task_key and
verified actual human scope-release-only evidence. This permits checkpoint and
release, not further unrelated implementation. For create_thread, scope_handoff
contains the SAME task_id/canonical_task_key, from_thread_id, checkpoint_path and
checkpoint_sha256. Evidence must establish explicit_scope_split_verified,
old_scope_writer_quiescent, scope_write_ownership_released, healthy_jobs_preserved,
job_ownership_handoff_verified and duplicate_execution_owner_exists=false. The
runtime rehashes the real checkpoint at prepare and claim. Keep normal human,
project/native identity, permissions, single-owner and creation dedup checks.
This scoped transfer does not require archiving the old unrelated task chat.
Checkpoint exact worktree/branch/edits/jobs/resources and ownership before creating
the new chat; native project readback and actual productive start remain required.

## Ready and review delivery

New PRs start draft. Current applicable CI must pass before pr_ready. Ready then
triggers the repository's automatic Gatekeeper. Read its complete review/inline
feedback, technically assess it, and repair valid issues in the original owner.
Before canonical URL delivery, both current applicable CI and current-head
Gatekeeper approval must pass. A changed head invalidates old proof. Keep reviewer
draft holds, the existing review blackout, local technical validation/review,
normal Xuanwo approval/rules/expected-head merge gates, and no external replies,
comments, reviews or reviewer requests. Do not contact Gatekeeper to trigger it.

Control prepare, claim and authorize_review_send use pr-review-gates.mjs. Supply
applicable_ci with pr_url, head_sha, matching head_before/head_after, checked_at,
evidence_ref, policy_ref, complete=true, phase=pre_ready or pre_delivery, and the
actual checks. Each check has id/name/head_sha/applicable/status/conclusion.
Applicable checks must be completed/success. An excluded check needs its actual
exclusion_reason and applicability_ref; Gatekeeper that only starts after ready
is not a circular prerequisite for first ready. Missing, pending, failed or
unexpectedly skipped ordinary CI never becomes success. Read the full current
source and determine applicability; do not manufacture an all-green summary.

For URL delivery, also supply gatekeeper with matching PR/head-before/head-after,
checked_at, evidence_ref, semantic_assessment_ref, reviews_complete=true, complete
raw reviews, and identity={kind:github_app,login,app_id,verified:true,evidence_ref}.
Verify the real repository app/trigger surface first. The currently observed
GitHub apps emit COMMENTED reviews with either observed approval header:
`✅ **Gate recommendation: approve.**` or
`⚠️ **Gate recommendation: approve with a non-blocking risk.**`.
Only these exact first-line strings qualify; quoted, conditional, unknown or
negative text does not. An actual APPROVED review is also supported. The latest
matching app review must apply to the exact current head; dismissed, missing,
newer negative or unrecognized verdicts block. This recognizes an explicit
approval, not a waiver of its body or any inline/issue findings. Before delivery,
the coordinator must assess the full current-head feedback, preserve the stated
risk and validation limits, and resolve valid changes or real scope decisions.
The independent FeedbackLedger gate applies at prepare, claim and final send;
unassessed, actionable or decision-required feedback still blocks. Existing CI,
Xuanwo approval, repository rules and conditional-head merge remain separate.

Operation proof must be fresh within60seconds. Lifecycle observation persists the
same applicable_ci/gatekeeper fields and creates verify_review_ci or
verify_gatekeeper obligations before delivery when proof is absent or not passed.
Use actual refreshed evidence or exact-event task progress with a concrete wait
before ACK; neither verification step completes the task. Already-delivered URL
receipts are not reposted merely because this rule was introduced. An old claimed
operation is rechecked at final send; do not reset uncertain effects.

The per-task migration and provider evidence/projection are coordinator work.
A guard implementation is not proof the three new native chats were created or
that a particular PR passed these gates. The source checkpoint and old chat scope
must remain available until the actual native handoff is verified.
