# PR review delivery windows

All times use Asia/Shanghai. The actual user instruction on 2026-11-07 adds a weekly blackout from Saturday 00:00 inclusive until Monday 11:00 exclusive. Resume Monday at 11:00, after refreshing current head, applicable CI, Gatekeeper, full feedback, personal clearance and duplicate-send receipts. Retain the daily blackout from 03:00 inclusive until 10:00 exclusive on other weekdays.

The same guard applies to review-intended draft-to-ready transitions, private PR decision cards, and canonical Slack PR URL delivery. Implementation, tests, repairs and internal review continue. Already-delivered PRs retain the existing conditional merge rules. This rule grants no new external messages, merges, releases or deployments.

`pr-review-window.json` is the instance source. `runtime/review-window.mjs` computes merged daily and weekly blocked intervals. Control prepare, claim and final authorize_review_send enforce it, including a permit issued just before Saturday midnight. Deferred actions use the next allowed time without a new timer; their original owners recheck evidence before acting. Never reuse an expired permit or resend an uncertain operation.

Human source: 01a1b4ac-acea-7030-935e-c63fdac21fdd, main chat 01a197b9-ab89-7fd1-8652-67004d517495: “以后每周周末停止送审, 周一早上11点之后才重新开启”.

## Scoped weekly exceptions

An actual human may authorize a temporary `scoped_weekly_exceptions` entry in
pr-review-window.json. It requires id, actual_human_verified, source_message_id,
evidence_ref, exact task_ids, valid_from, valid_until, waive_weekly_blackout=true
and retain_daily_blackout=true. Each action must also match a current PR binding
in that task's native contract (or accepted catalog if no native contract exists).
The exception subtracts only that interval from the weekly blackout. Daily
03:00–10:00, technical/feedback/personal-review gates and all other holds remain.
Prepare, claim, final authorize_review_send and lifecycle each recheck scope/time;
a permit expires no later than the exception. No timer or duplicate send is added.
Use control review_window with task_id and payload.pr_url for the scoped result;
global review_window still reports the global restriction. Unknown/unbound PRs,
other tasks, expired exceptions and later weekends retain the ordinary rule.
