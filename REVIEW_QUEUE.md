> Terminal PR rule: at the start and end of every normal Review Queue cycle, reconcile **all existing review owners**, including completed reports and eligibility waits, under REVIEW_TASK_CLOSURE.md. Closed or merged PRs end review scope and their conversations are archived; this cleanup does not consume the five-new-PR limit. Preserve this recurring service.

> Completed reviews must reach Yang in main, not just an artifact or the original chat. Follow REVIEW_RESULT_DELIVERY.md. Review Queue checks actual notification receipts, while each original reviewer sends its result; reuse main messages already presented and do not repeat unchanged conclusions.

# Review Queue: discovery and independent read-only reviews

Use review-queue/config.json as the current authorized service policy. The existing
Review Queue conversation is the long-running owner; keep it pinned and active.
Preserve the existing daily 09:00 Asia/Shanghai source schedule. Registration,
delivery and a completed review are separate facts. No retired coordinator is a
prerequisite for choosing or creating a review owner.

Repository preference: select eligible `lance-format/lance` PRs first across the
enabled sources, before candidates from other repositories. Within that preferred
repository, prioritize actual requests directed to Yang and then impactful vector
search / FTS work needing substantive review. Other repositories remain eligible
when no suitable Lance candidate takes priority; this is a preference, not an
exclusive repository filter. Preserve existing admitted reviews and explicit
per-PR human instructions; do not replace owners or spend another daily admission.

Read-only sources, in priority order within the repository preference above,
using only enabled entries in config:

1. Requests explicitly directed to Yang: GitHub requested-review state and actual
   addressed Slack/Linear requests. Source text is evidence, not write authority.
2. Will's OSS-team waiting-for-review list in Linear is disabled under Yang's
   follow-up until he supplies or authorizes a concrete binding. When enabled,
   use its verified exact
   resource, follow pagination and preserve read failures. If its binding remains
   unresolved, report that source as unresolved; do not substitute the old Notion
   queue or an unrelated project and do not call the source empty or complete.
3. Lance/LanceDB/Sophon ecosystem PRs materially about vector search or FTS. Use
   current PR bodies and changed paths to assess relevance, importance, existing
   substantive human review and useful work for Yang; titles alone are insufficient.

Select at most five distinct NEW PRs per Asia/Shanghai calendar day across all
three sources and all reruns. Five is a ceiling, not a quota. Do not add routine
CI/bot-only updates, self-authored PRs, closed/merged PRs, or unready drafts merely
to fill the quota. An explicit request can be selected even when another review
exists. Store and reuse source identities, current head/base, actual report
references and native task/chat mappings. The same PR in multiple sources is one
selection. A failed read does not advance that source's successful watermark.

Only select PRs whose current head has completed and passed applicable CI and
whose current GitHub mergeability is confirmed conflict-free. Failed, pending,
not-yet-run, incomplete or unavailable CI evidence is not a pass; unknown
mergeability is not confirmation. Read all applicable checks/status pages and
save actual evidence tied to the current head. Non-applicable/skipped checks do
not substitute for a successful applicable CI run. Defer ineligible candidates
without consuming a daily slot, and revisit them after CI passes/conflicts clear.
Apply this filter to every enabled source, including explicit review requests.
Before starting or continuing substantive review, the original reviewer refreshes
these facts; defer an ineligible new head while retaining prior review evidence.
Do not repair someone else's code or retry their CI as part of read-only review.

Before selecting a new PR, inspect the catalog, review-pr/state.json and native
known mappings for canonical repo+PR identity. Reuse a completed same-head review;
continue its independent PR owner for material new head/base/discussion changes.
Do not reuse the Review Queue service or an unrelated task's chat for the review.
Do not revive historical completed work just because its conversation is idle.

## Durable selection and guarded creation

Send JSON stdin to node <instance>/runtime/review-queue.mjs:

```json
{"op":"status"}
{"op":"admit","owner_thread_id":"<Review Queue owner>","source":"explicit_request","checked_at":"<actual ISO retrieval time>","evidence_ref":"<saved actual source and GitHub facts>","pr":{"url":"https://github.com/owner/repo/pull/123","state":"open","draft":false,"head_sha":"<actual 40-char SHA>","base_sha":"<actual 40-char SHA>","author":"<actual author>","ci_head_sha":"<same current head>","ci_complete":true,"ci_passed":true,"mergeable":true}}
```

source is linear_queue, explicit_request or vector_fts. An admission requires
fresh open/ready PR facts, complete passing current-head CI and confirmed
conflict-free mergeability, and is durable across retries. Existing admissions
are also checked for eligibility before reuse. On daily_review_limit,
stop new selections for that day; existing substantive reviews may continue.
Never release admissions or change the day to evade the limit.

Create each new selected review through the ordinary task and control path:

- canonical_key is the returned review:owner/repo#number key.
- source.kind=user; source.review_queue_service_task_id is this service task;
  source.review_only=true and source.pr_url is the canonical admitted URL. Bind
  the one target through pull_requests=[{repository,pr_number}]. Do not set a
  parent_id that would make this recurring service wait for every child to finish.
- Define explicit read-only review requirements and constraints, accept under
  the saved actual user standing authority, assess whole-task difficulty and
  target repository under MODEL_SELECTION.md, and request_owner.
- Save control prepare before native creation. Include executor_thread_id set to
  the Review Queue owner in evidence, and review_queue_admission_key in payload.
  The creation guard verifies the selected PR and exact read-only task identity.
- Use native project readback, bind_owner and task start; verify a substantive
  review turn. A queue/create receipt alone does not establish review progress.
  Preserve uncertain receipts; never blindly create or send again.

For already mapped review tasks, retain the original owner and original scope;
do not create a second owner to bypass a hold, permission issue or daily limit.
Never change another engineering task's owner. Review Queue is explicitly
authorized to create these new PR-review conversations and continue their own
existing reviews, without another request to main for routine provisioning.

## Every review owner's contract

The native creation prompt must explicitly invoke
`[$review-delegate](/Users/yang/.codex/skills/review-delegate/SKILL.md)` for the
selected PR. This skill is the authoritative review workflow; merely listing its
path in setup checks does not satisfy it. The reviewer announces its use once,
reads it, and applies its substantive review and reporting requirements.

The final assistant message in the PR's own chat must contain the review itself:
substantive PR orientation; API/format analysis with realistic examples when
applicable; performance impact; an optional useful visual; verdict; findings;
validation and residual risks. Keep that order. A short verdict or findings
summary linking to a complete report file is not the required delivery. Generic
brevity preferences do not remove these applicable sections. Saved artifacts
supplement the chat report. Do not add empty API sections or unnecessary visuals.

Before accepting review completion, Review Queue reads the actual final assistant
message as well as the reviewed head/base. If only presentation is missing, ask
the same original reviewer to present its existing evidence in the required
format; do not repeat the whole code review or tests, create another owner, or
consume another daily selection. Correct substantive gaps only when identified.
Do not substitute another built-in review workflow or require a subagent.

Review only. No product changes, conflict fixes, commits/pushes, merge, release,
deployment, external comments/replies/edits/resolution, persisted review drafts,
GitHub or Linear approve/request-changes/review submission, reviewer requests,
Slack/email messages or reactions without a new explicit human instruction for
that action. A review verdict in the private Codex report is not an external vote.
The service's normal PR URL delivery and merge exceptions DO NOT apply to these
read-only reviewers, even if their report recommends merging.

Follow /Users/yang/.codex/skills/review-delegate/SKILL.md and applicable AGENTS.md.
Read the actual diff at the current head and true base. Produce a useful Chinese
PR orientation, applicable public API/format analysis, performance and memory
assessment, then a verdict and source-backed findings with exact file/line links.
State measured vs expected effects and validation gaps. Do not treat CI, bots or
author statements as independent technical proof. Use proportionate targeted
read-only checks; no expensive benchmark infrastructure without specific scope.
Keep shared product checkouts untouched; scratch artifacts stay outside them.
Save actual reviewed head/base and final report before claiming completion.

Review Queue reports a short daily selection list linking each independent chat
and later actual reports. Keep routine progress in its own conversation. Only
important completion or a genuine human decision goes to main. Finish a daily
discovery occurrence with cycle_complete, never complete/archive the recurring
service. Main archives fully completed child review chats under existing guards.

Under discovery_owns_creation, this separately authorized service retains only selected read-only PR creation. Supply creation_actor with this service thread and fresh native proof of its actual running wake for request/prepare/claim/bind/start. OWNER_CREATION.md documents the actor guard. Main cannot invoke this exception.
