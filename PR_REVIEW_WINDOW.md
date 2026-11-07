# PR review delivery windows

All times use Asia/Shanghai. The actual user instruction on 2026-11-07 adds a weekly blackout from Saturday 00:00 inclusive until Monday 11:00 exclusive. Resume Monday at 11:00, after refreshing current head, applicable CI, Gatekeeper, full feedback, personal clearance and duplicate-send receipts. Retain the daily blackout from 03:00 inclusive until 10:00 exclusive on other weekdays.

The same guard applies to review-intended draft-to-ready transitions, private PR decision cards, and canonical Slack PR URL delivery. Implementation, tests, repairs and internal review continue. Already-delivered PRs retain the existing conditional merge rules. This rule grants no new external messages, merges, releases or deployments.

`pr-review-window.json` is the instance source. `runtime/review-window.mjs` computes merged daily and weekly blocked intervals. Control prepare, claim and final authorize_review_send enforce it, including a permit issued just before Saturday midnight. Deferred actions use the next allowed time without a new timer; their original owners recheck evidence before acting. Never reuse an expired permit or resend an uncertain operation.

Human source: 01a1b4ac-acea-7030-935e-c63fdac21fdd, main chat 01a197b9-ab89-7fd1-8652-67004d517495: “以后每周周末停止送审, 周一早上11点之后才重新开启”.
