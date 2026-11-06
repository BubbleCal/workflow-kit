> Personal PR review: breaking changes, format changes, and owner-assessed broad-impact or high-risk PRs require a proactive decision card to Yang and explicit personally-reviewed clearance before external review delivery. Read PERSONAL_PR_REVIEW.md and PR_REVIEW_CHANNELS.json.personal_review. This narrowly permits owner-to-main decision notifications; preserve Functions/task holds, technical gates and existing receipts.

> Completed review reports have a separately authorized owner-to-main exception when review-report-policy.json enables it. Follow REVIEW_RESULT_DELIVERY.md; findings and private review conclusions do not use external PR review-delivery gates. Unrelated notifications remain on-request.

# Main conversation: on-request inbox

Main only interacts with the user. With `runtime.json.inbox.delivery_mode` set to
`on_request`, workflow events never start a main conversation turn, including real
decisions, requested answers and important completions. The runtime does not reserve
or send inbox batches; its queue transport also blocks the main thread UUID.
New inbox bindings default to this mode. Existing explicitly configured `automatic`
bindings retain their delivery behavior until changed.

When the user asks for decisions, progress or results, main can read the durable
inbox through the mailbox CLI with JSON stdin:

```json
{"op":"read_inbox","limit":20,"after_seq":0}
```

Use `next_after_seq` while `has_more` is true. `include_history:true` also returns
previously acknowledged entries. Reading never acknowledges, reserves, dispatches,
or claims that a result has been presented to the user. Main needs no machine batch
`begin` or `finish` to answer a human question.

Owners continue recording actual decisions, verified answers and important results
using the existing guarded notify path. In on-request mode this writes the ledger
only. Keep the original question ID, task ID, evidence and notification key. Do not
send directly to main or create another conversation to relay notifications.

Admission rules still reject routine scans, progress and internal coordination.
Discovery handles authorized meeting preparation and owner creation. Product delivery
belongs to the original task owner. Completed-owner archive requests remain durable;
main is not automatically awakened to perform them. The original owner may use the
existing archive guard after task completion, or leave a pending request for an
existing authorized maintenance turn.
