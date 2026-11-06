# Functions PRs: let Yang decide in the main chat

When the instance's lancedb_functions route enables decision_delivery, a ready
Functions PR is delivered privately to its configured main thread for Yang's
decision. This is the only scoped exception to an on-request main inbox. Keep
automatic Slack delivery held. Do not enable unrelated automatic notifications.

The original implementation owner performs this delivery. Continue coding,
testing and valid feedback repairs. A draft or unfinished validation is not a
ready decision. Complete current applicable CI, Gatekeeper approval, technical
validation and full feedback assessment first. Keep the review blackout and
dependency rules. No new reviewer, engineering owner or coordinator is created.

Use the existing control.mjs JSON API with kind=review_decision:

- key: review-decision:<canonical PR URL>:<current head SHA>.
- task_id: the original registered task, whose contract lists this exact PR.
- payload: thread_id and source_message_id from decision_delivery, pr_url,
  message equal to that canonical URL, expected_head_sha, current runtime_context,
  and prompt containing the finished decision card.
- evidence: the same current validation, CI, Gatekeeper, dependency and feedback
  evidence used for review delivery, plus executor_thread_id, already_notified=false,
  and verified review_routing for lancedb_functions at this exact PR/head.

Prepare, claim with owner equal to the implementation thread, then call
authorize_review_send with operation_not_started=true. Only send=true permits
calling native send_message_to_thread with the returned native_arguments. Omit
model/thinking. Save the tool result immediately, verify the actual message with
read_thread, and settle with sent/uncertain and evidence_ref. Never blindly resend
an uncertain action. Reuse the stable key; do not change it to bypass deduplication.

The prompt identifies itself as a finished Functions review-decision notification,
not a new human instruction. Include the original T ID, canonical PR link, a
brief description of its user impact, validation/CI/Gatekeeper status and any
remaining limitation, then a clear recommendation and the decision Yang needs
to make. Do not include lengthy implementation details or internal guard commands.
Main presents this card; no workflow-batch begin/finish protocol applies.

After actual delivery, save a human-decision wait while independent work continues.
Do not send the same card again each cycle. Material head/readiness changes may
justify an updated card, which must identify what changed. A new head is not by
itself a reason to repeat an unchanged question. Yang's response applies only to
its stated PR/scope; it does not automatically resume all Functions channel sends.
No decision means no automatic external review delivery. This notification is
not itself authorization to send a Slack message, merge or deploy.
