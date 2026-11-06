# PR review channel routing

An instance may set `delivery.slack_routing_file` to a JSON policy file relative
to its root. The policy has `schema_version:1`, the actual authorizing
`source_message_id`, `default_channel_id` matching the instance default, and
`routes:[{scope,channel_id}]`. Scope `default` is reserved for ordinary PRs.
Without this optional setting, the instance retains its single configured channel.
A configured missing or invalid file never silently restores single-channel routing.

Before `slack_pr` prepare, claim and `authorize_review_send`, the original owner
classifies the actual current PR feature scope and supplies:

```json
{
  "review_routing": {
    "scope": "lancedb_functions",
    "verified": true,
    "pr_url": "https://github.com/owner/repo/pull/123",
    "head_sha": "<actual current head>",
    "evidence_ref": "<saved scope assessment from the current PR/task>"
  }
}
```

This object is inside `evidence`, alongside the existing CI, feedback and
technical-review evidence. Use `scope:"default"` for unrelated work. Repository
name or the generic source-code word "function" does not establish feature scope.
The payload's `channel_id` must match the selected route. All three gates reread
the policy, including for previously prepared actions. Existing readiness,
canonical-URL-only, head, blackout, feedback and already-announced checks remain.
Do not resend an already delivered URL merely because its route changed.

# Scoped human delivery holds

An explicit human pause of a product's PR review delivery is recorded on that
route in PR_REVIEW_CHANNELS.json as delivery_hold with active, source_message_id,
and evidence_ref. Keep the route's destination. Prepare, claim and final send
authorization reread this rule and reject delivery while the hold is active.
Do not redirect to another channel or request a review through another medium.
Only a subsequent explicit human instruction releases the hold; it has no timeout.
An explicit decision for one PR may instead be recorded in `pr_authorizations`:
the exact canonical `pr_url`, existing `scope`, chosen `channel_id`,
`actual_human_verified:true`, `source_message_id` and `evidence_ref`. That entry
overrides only the matching PR's hold and channel. It does not reclassify the PR
or release other PRs; all current-head and delivery guards still apply. See
FUNCTIONS_REVIEW_DECISIONS.md for the original-owner follow-through.
Coding, testing, technical review and feedback repair can continue. A delivery
hold is not a task pause or a revocation of already-authorized merge handling.

When a route also has decision_delivery enabled, follow
FUNCTIONS_REVIEW_DECISIONS.md for the explicitly authorized private decision card
to main. The Slack hold stays active. This uses control kind=review_decision and
does not enable the ordinary automatic inbox or reuse a Slack-send permit.
