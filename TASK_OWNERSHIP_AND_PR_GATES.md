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

## Branch ownership before creating a PR

Follow the instance's actual user policy for dependency ownership. Under Yang's
rule, every unpublished feature branch in a stacked PR chain must belong to Yang.
Check the entire chain back to main, not just the immediate parent. The branch's
actual PR/task ownership must support that conclusion; a branch-name prefix,
shared repository, write access or copying somebody else's branch is not proof.

Development may start on another person's unmerged branch in the task's own
isolated branch/worktree. Do not modify that person's branch. When the work depends
on their unmerged PR, do not create a PR yet, including a draft, stacked PR or a PR
targeting main whose diff still contains that unmerged dependency.

Wait for the other person's PR to merge into main. Fetch the latest main, rebase
the task's own changes onto it, resolve any resulting conflicts and run the
appropriate validation. Then create the PR against main. A closed-unmerged PR,
approval or successful CI does not satisfy this prerequisite. Merely retargeting
the PR to main does not replace the rebase or remove dependency commits.

Before creating any PR, the owner records its target, the unmerged dependency
chain and actual branch/PR owners in the existing task checkpoint. If ownership
is unknown or a dependency belongs to someone else, keep the implementation as
branch work until the dependency is merged. Do not create a new approval request
for waiting that is already required by this rule.

Recheck dependencies before ready, review delivery and merge. Reuse an existing
PR and its history when correcting prior work; do not create duplicates or edit
another owner's PR. Preserve any explicit instructions for existing PRs. Existing
noncompliant work stays out of further delivery until its dependency and base
are corrected; this rule alone does not instruct closing or deleting old PRs.

## Ready and review delivery

Read PERSONAL_PR_REVIEW.md. Breaking changes, format changes and owner-assessed
broad-impact or high-risk PRs must first reach Yang in the main chat for personal
inspection and explicit clearance before external review delivery. Every PR has
a short current-head impact assessment. Keep existing Functions/task holds and
all technical gates; a private decision card is not permission to send externally.

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
Verify the real repository app/trigger surface first. A repository without a
configured Gatekeeper does not wait for a nonexistent approval. Empty reviews,
skipped checks or absent workflow files alone do not establish that an external
GitHub App is unconfigured. The central `PR_REVIEW_CHANNELS.json` stores
`gatekeeper_applicability.repositories` with source-backed `configured` or
`not_configured` declarations; repositories without verified declarations retain
the required/unknown gate. A current observed Gatekeeper check/review or unknown
configuration contradicts an old absence declaration and blocks this path.

Use control op `record_gatekeeper_applicability` with a fresh exact native human
source, accepted original task/bound PR, stable actual PR/head context and
`expected_policy_digest`. `mode:repository,status:not_configured` requires an
explicit repository-owner configuration declaration. This uses ordinary PR
reads and the actual human source; it does not require repository-admin APIs.
The API preserves all unrelated authorizations and records source provenance.
For delivery, keep the full fresh gatekeeper PR/head/review/semantic evidence,
but replace the absent bot identity with
`applicability:{status:"not_configured",policy_source_message_id:"actual-source"}`.

For an explicit human one-PR waiver, `mode:review_exception` also requires one
`authorized_scope.pr_urls` entry and its exact `head_sha`. Delivery selects
`applicability:{status:"explicit_review_exception",policy_source_message_id:"actual-source"}`.
It applies only to external review for that PR/head, never merge or a later head.
No path grants CI, full-feedback, personal/Functions/channel, designated-approval,
repository-rule, release or deployment permission. Changed/unknown configuration
must be reconciled with the owning source, never inferred from missing output.

The currently observed
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

## Verified repositories without hosted CI

Follow NO_HOSTED_CI.md for the narrow source-backed absence contract. Empty
checks alone still fail. Keep actual local validation, fresh exact repository/
head/base/rules/workflow evidence and independent Gatekeeper/merge requirements.

## Human review permission and conditional merge

Read PERSONAL_PR_REVIEW.md and the centralized review_implies_conditional_merge
rule. From its effective human instruction, actual explicit permission for a
clearly identified PR/task to enter external review also permits the same scope
to merge after all current gates pass; do not request a second independent merge
permission for nonordinary changes. Main records exact PR/head provenance through
record_pr_review_authorization. Ready status, a delivered card or automatic
approval is not human permission. Preserve personal inspection, explicit merge
holds/pauses, Functions per-PR channel authorization, Xuanwo approval, CI,
Gatekeeper, complete feedback, repository rules, ownership and expected-head.
A changed head requires checking actual authorized scope. No other PR/stack,
release or deployment authority is implied, and old holds are not bulk cleared.
