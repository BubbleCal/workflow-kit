> Completed review reports have a separately authorized owner-to-main exception when review-report-policy.json enables it. Follow REVIEW_RESULT_DELIVERY.md; findings and private review conclusions do not use external PR review-delivery gates. Unrelated notifications remain on-request.

# Human-facing notifications only

Main receives only real human decisions, answers to an actual user question, and
important verified completion. It is not an execution coordinator or a destination
for owner provisioning, source scans, CI progress, delivery retries or routine
workflow health. Do not relabel such inputs as action_required or answer.

Use control `prepare(kind="notify")` with the existing evidence guards:
- decision/action_required needs material change and an actual human action;
- answer needs the original question_message_id and verified source/owner answer;
- important_completion needs actual completion evidence.

The mailbox validates the corresponding durable notify action even for direct
mailbox writes. A raw kind label or user_notification_required flag is insufficient.
Rejected inputs are recorded as suppressed without waking main. Native whole-task
completion and actual unaccepted catalog candidates have their own exact ledger
bindings. Already-authorized meeting preparation and owner creation are handled
by discovery under their scoped standing policy and never become human decisions.

Main remains free to discuss, investigate and answer the user. Automatic inputs do
not instruct it to dispatch, perform delivery, repair the workflow or chase owners.
Completed-owner archival remains the existing bounded completion follow-up.
