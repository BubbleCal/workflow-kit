> Main notifications must pass INBOX_POLICY.md. Do not write raw answer/decision/important_completion messages to bypass control evidence, and do not escalate routine technical progress or already-authorized setup as a human decision.

# Complete delivery by the original task owner

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

After completion, finish the task wake. The runtime sends one important completion
to main with an archive_request. Main may archive that finished owner after fresh
native idle/no-pending-input evidence and the normal archive guard, using its own
thread UUID as executor and the completed task's runtime_context. Main does not
perform product delivery. Do not require unfinished legacy bookkeeping stages when
the authoritative native task has all acceptance and delivery obligations complete.

Routine updates remain in task evidence and bound pages. Use inbox only for actual
user decisions, requested answers or important completion. Do not send cross-chat
messages, open URLs to wake owners, or change selected windows/models/permissions.

Repeated generations of the same lifecycle obligation remain separate pending events, but their counter, detection time and snapshot-file location do not invalidate an otherwise unchanged plan. Checkpoint and explicitly decide their disposition as usual. Actual source changes still mark the task dirty; existing human-decision waits are preserved.

## Repeated reminders during a verified wait

An already-handled lifecycle obligation with unchanged semantic facts stays in the durable input queue while the original owner has a clean, unexpired, source-verified wait. It does not trigger another model turn. The existing runtime loop releases it when that wait, its fact versions or the underlying condition changes or expires. New heads, findings and unhandled obligations are not suppressed. This does not remove the bounded expiry fallback or change CI-progress wake rules.
