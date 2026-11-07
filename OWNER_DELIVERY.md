> Personal PR review: breaking changes, format changes, and owner-assessed broad-impact or high-risk PRs require a proactive decision card to Yang and explicit personally-reviewed clearance before external review delivery. Read PERSONAL_PR_REVIEW.md and PR_REVIEW_CHANNELS.json.personal_review. This narrowly permits owner-to-main decision notifications; preserve Functions/task holds, technical gates and existing receipts.

> Independent review owners proactively deliver substantive completed conclusions to main under REVIEW_RESULT_DELIVERY.md and review-report-policy.json. Save the complete report first and verify the actual notification receipt. Private review-result delivery grants no external review or implementation authority.

> Main notifications must pass INBOX_POLICY.md. Do not write raw answer/decision/important_completion messages to bypass control evidence, and do not escalate routine technical progress or already-authorized setup as a human decision.

# Complete delivery by the original task owner

Before creating any PR, including a draft, read the branch-ownership rule in
TASK_OWNERSHIP_AND_PR_GATES.md. When the instance applies Yang's rule, stacked PRs
may contain only his feature branches. Development may depend on another owner's
branch, but PR creation waits for that PR to merge and for rebasing onto main.

Before Slack PR delivery, read REVIEW_ROUTING.md and the instance's configured
route policy. If scoped routing is configured, include current-PR
`evidence.review_routing` at prepare, claim and final send authorization.

In native owner-delivery mode there is no coordinator or delivery-service chat.
The original owner implements and delivers its own accepted task. The main chat
handles user discussion, decisions and important completions; discovery reads
configured sources and maintains already-authorized meeting-preparation schedules.
Maintenance runs at its configured interval and only handles workflow health.

This changes responsibility, not external authorization. Read the instance's
NATIVE_POLICY.md. Keep all existing user holds, excluded work, allowed repositories,
canonical PR URL channel, review window, readiness, CI, feedback, Gatekeeper,
approval and expected-head merge guards. Never reply to Slack or submit comments,
reviews, approvals, reviewer requests or emails under delivery authority.

For an `owned_followthrough` event, the immutable original payload and source key
are evidence. Older text saying to send to a coordinator is superseded. Use current
checkpoint/decide, then act under the returned runtime_context. Never submit the
same input back to the historical coordinator lane. Unknown external receipts
still need reconciliation; do not resend them.

Use the existing `runtime/control.mjs` JSON API for prepare/claim/settle. Include
`evidence.executor_thread_id` equal to your own bound thread UUID when preparing
PR ready, Slack URL, merge, own Notion result update or archive. Claim with `owner`
equal to that UUID. Existing permission, scope and publication gates still apply.
A prepared/deferred action is not a send receipt; refresh stale action context and
cancel only proven-unsent attempts before preparing a distinct recovery action.
Immediately before ready or Slack URL sends, use `authorize_review_send`.

For lifecycle progress, record the actual native decision that consumes the exact
lifecycle event, then call control `lifecycle_resolve` with key, generation,
disposition="progress", owner_thread_id, native_decision_id and evidence_ref.
No coordinator batch or legacy progress record is needed. The decision must match
the current owner, context and plan and consume that exact source generation.
Receipt and typed-wait dispositions retain their existing API. For a release-route
successor, persist plan.dependency_delivery and dependent plan.steps with
release_step values upstream_release, automatic_fork_sync, consumer_adoption and
integrated_acceptance. Product completion still requires all contract acceptance.

Update only your task's existing bound Notion outcome/decision rows, using the
shared control guard so page writes serialize. Preserve other tasks, manual notes,
IDs and historical measurements. An assessment-only task gains no product-change
or PR-publication authority. A disabled external integration is not a blocker.

## Reusable knowledge owned by the task owner

When authorized by the instance, the original owner must update important,
reusable conclusions in the user knowledge base as part of result delivery.
Read OWNER_KNOWLEDGE.md and knowledge-base.json. Prefer an existing topic, retain
evidence and applicability, and verify the actual Notion update. This separate
knowledge-capture authority does not broaden managed outcome-row permissions.

## Linear issue state owned by the task owner

When the instance's actual user authorization permits Linear state maintenance,
the original execution owner keeps its bound issue states aligned with real work.
This is part of delivery, not a separate coordinator or documentation task.

- At substantive work start, move Backlog/Todo to the team's In Progress state.
  Assignment, setup, a queued turn or a plan alone does not prove work started.
- Use In Review when the implementation has been delivered for review under the
  applicable gates. A draft PR alone is not In Review. Active repairs return to
  In Progress; a valid review wait may remain In Review.
- Waiting for CI repairs, a dependency, a release or required adoption is not
  completion. Use an existing Blocked state when the team has one; otherwise keep
  In Progress and preserve the exact wait in the task's own checkpoint.
- Use Done only after the entire issue's actual acceptance and authorized delivery
  are complete. A child PR merge or automatic GitHub issue transition is not enough
  when required consumer adoption or integration remains. Correct a premature Done
  when the original issue demonstrably has unfinished authorized work.
- Read the actual issue, assignment, team states and current work evidence before
  a transition. Change only the state of the exact issue bound to this owner and
  assigned to the authorized user. Preserve manual holds, cancellations, scope and
  reassignment; reconcile a conflicting human decision rather than overwriting it.
- Check at substantive start, material phase changes and completion, using existing
  turns. Avoid no-op writes, extra polling timers and waking completed chats merely
  for bookkeeping. Read back successful changes and save the issue ID, previous
  state, new state, reason, evidence and receipt in the task's existing checkpoint.
  Failed or uncertain writes remain explicit follow-ups; do not claim they synced.
- This authority is for issue state only. It does not authorize comments, replies,
  descriptions, assignee/project/priority changes, or modifying another owner's
  ticket. A status API failure does not stop independent engineering work.

After completion, finish the task wake. The runtime records one important completion
and its archive_request in the durable inbox. In on-request mode this does not send
a message or start main. The original owner can perform its own archive through the
existing archive guard after finishing, with fresh idle/no-pending-input evidence.
If archival cannot yet proceed, preserve the request for authorized maintenance;
do not wake main or mark the archive request fulfilled without its native receipt.

Routine updates remain in task evidence and bound pages. Use the guarded inbox for
actual decisions, requested answers or important completion; INBOX_POLICY.md defines
on-request reading. Do not send cross-chat messages or open URLs to wake owners.

Repeated generations of the same lifecycle obligation remain separate pending events, but their counter, detection time and snapshot-file location do not invalidate an otherwise unchanged plan. Checkpoint and explicitly decide their disposition as usual. Actual source changes still mark the task dirty; existing human-decision waits are preserved.

## Repeated reminders during a verified wait

An already-handled lifecycle obligation with unchanged semantic facts stays in the durable input queue while the original owner has a clean change-driven wait on the same facts. It does not trigger another model turn. The existing runtime loop releases it when relevant facts, the underlying condition or the plan change. Source expiry remains a diagnostic, without an owner turn. New heads, findings and unhandled obligations are not suppressed. Real timed review windows retain their deadline behavior. Known next-action times use OWNER_WAITS.md.

## Substantive result followthrough

Before completing a substantive assessment, benchmark or research result, use RESULT_FOLLOWTHROUGH.md to record evidence and bounded structured followups (or an explicit no-actionable-finding conclusion). Original owners retain their own delivery; discovery handles only result intake and guarded independent-owner setup under its existing interval. Finite assessments stay complete. Explicit holds and external-action boundaries remain binding.

When no useful next step is possible, follow `OWNER_WAITS.md`: report the exact
PR/event condition, and include a timezone-qualified `next_action_at` when the
next useful time is known or reasonably estimated. Runtime retains inputs and
coalesces them at that time rather than messaging the owner early.

For change-driven waits, the latest explicit wait may follow a separate continue
assessment that consumed lifecycle inputs. This still holds unchanged reminder
generations. Freshness-only CI/Gatekeeper verification inputs also remain inside
runtime while an acknowledged wait covers the same observed PR head. Evidence
expiry does not prove a source change. Actual changed source facts, new findings,
new heads and unhandled substantive obligations retain their event path; refresh
all technical gates when useful action becomes possible.
