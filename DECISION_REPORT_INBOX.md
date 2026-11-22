# Decision & Report Inbox (`决策与汇报`) — standard role

Every installed T3 instance has a **Decision & Report Inbox** conversation. It is a
standard role, created at installation together with Main. Not optional. Yang
adopted this design on 2026-11-22 after running it in production. It replaces
per-owner native Ask cards for task decisions.

## Roles

| Role | Config key | Purpose |
| --- | --- | --- |
| Main (`工作中心`) | `roles.main` | Yang's ad-hoc questions, status lookups and manual dispatch only |
| Decision & Report Inbox (`决策与汇报`) | `roles.decision_report_inbox` | The single place where owners queue decisions and important reports for Yang |
| Discovery / Maintenance | `roles.discovery`, `roles.maintenance` | Optional services, enabled only by actual human authority |
| Task owners | ledger owner binding | One original owner per independent task |

The Inbox is a service role: it never becomes a product execution owner. It must
be a separate conversation from Main. Pin it in the T3 sidebar.

## Installation (required)

1. Create one conversation in the instance project titled `决策与汇报`. Use the
   instance default model for interface work, or a model Yang chooses. Give it
   Full access and pin it.
2. Read it back natively. Record the binding in `t3-workflow.json`:

   ```json
   "roles": {
     "main": {"thread_id": "<main>"},
     "decision_report_inbox": {
       "thread_id": "<inbox>",
       "pinned": true,
       "protocol_ref": "<kit>/DECISION_REPORT_INBOX.md",
       "state_ref": "<instance>/decision-inbox.json"
     }
   },
   "attention": {"decision_location": "decision_report_inbox"}
   ```

3. Initialize `<instance>/decision-inbox.json`:

   ```json
   {"schema_version": 2, "updated_at": null, "active_item": null,
    "open_decisions": [], "pending_completions": [],
    "recent_forwarded": [], "recent_settled": []}
   ```

4. `node workflow.mjs t3 status --instance <instance>` reports
   `missing_standard_roles: []`. It exits 2 while the Inbox is missing.

An instance installed before this role existed should add it when Yang asks for
the upgrade. Do not move or answer existing legacy Asks. Leave genuine unanswered
ones until Yang answers or migrates them.

## Owner rules (Codex and Antigravity)

- Do not call `ask_question` / `request_user_input_async` in a task thread for
  product, review or three-category authorization choices. Use
  `request_secret` only for a literal credential or PIN.
- Send one deduplicated handoff to the Inbox with
  `t3_thread_send(mode: "queue")`, never `steer` or `restart`. Keep live PR
  watches, stay unsettled, finish independent work and end the turn.
- Push only these four events. Keep routine progress silent: draft PRs, CI runs,
  lint fixes, retries, VM allocation and intermediate notes.
  1. `decision`: a genuine choice that needs Yang.
  2. `completion`: a substantive result, such as a merged PR, a final benchmark
     verdict or a finished investigation. State what was done, the measured
     effect, the practical impact and the caveats.
     When an upstream PR only matters after downstream adoption (for example
     release → fork sync → consumer upgrade), its merge is a milestone. Report
     completion after the adoption, or list the propagation steps you still
     own. Give the disposition of every still-open linked PR.
  3. `review_ready`: a finished PR or document review with a recommendation for
     Yang's action.
  4. `hard_blocker`: an unrecoverable blocker. Try self-service authorized
     login first; an Inbox must bounce a bare "please log in" back to the owner.

```text
[INBOX_HANDOFF]
kind: decision | completion | review_ready | hard_blocker
event_key: <stable-unique-key>
task_id: <task / PR id>
owner_thread_id: <exact sender threadId>
title: <short subject>
background: <1-2 plain sentences>
summary: <what is blocked or completed; measured results and impact>
options: <decision/review_ready only: 1 (recommended) / 2 with tradeoffs>
links: <PR / issue / absolute report path>
```

## Inbox rules

1. Read `decision-inbox.json`. Deduplicate by `event_key` across all lists.
   Update an existing item only for a material change.
2. Serialize the queue to avoid flooding Yang. Store `decision`,
   `review_ready` and `hard_blocker` in `open_decisions`, and `completion` in
   `pending_completions`. If `active_item` is set, reply with at most one quiet
   queue-ack line. Otherwise pick the next item (open decisions first, FIFO), set
   `active_item` and present only that one, in plain Chinese, with clickable
   links:
   - decision / review / blocker: 任务与背景 · 为什么现在要你定 · 选项与建议
     (`1 / 2 / 3`, recommended first) · 回复方式.
   - completion: 完成了什么 · 结果与实测效果 · 实际影响与遗留项 · 确认方式
     (`确认 / ok / settle`, or follow-up instructions).
   End with a one-line footer of the remaining queue.
3. On Yang's reply:
   - Answer follow-up questions yourself from the owner thread and its reports,
     without resolving the item.
   - Resolved decision: forward Yang's verbatim answer, its timestamp and its
     scope to `owner_thread_id` with `t3_thread_send(mode: "queue")`. Move the
     item to `recent_forwarded` with the receipt.
   - Confirmed completion: `t3_thread_organize(action: "settle")` the owner, then
     move the item to `recent_settled`. If Yang adds follow-up work, forward it
     instead of settling.
   - Present the next queued item in the same reply. Set `active_item: null` when
     both queues are empty.
4. Boundaries: the Inbox does not edit product code, open or merge PRs, run
   builds or benchmarks, post to Slack or GitHub, or create replacement owners.
   Its only native writes are queue forwards to the canonical owner and settle
   after an explicit confirmation.

## Ledger behavior

When `roles.decision_report_inbox` is bound, the ledger defaults
`attention.decision_location` to `decision_report_inbox`. Then:

- A recorded `decision` is discussed in the Inbox. Its owner must already be
  bound.
- `answer` accepts the actual human message only from the Inbox or the original
  owner. An Inbox answer prepares one `t3_thread_send` queue delivery to the
  owner. An in-thread owner answer is recorded without a second turn.

An explicit `owner_thread` setting keeps the old per-owner Ask behavior for a
legacy instance.

## Maintenance

Maintenance reads `decision-inbox.json` on each pass. An owner with an open or
pending item is waiting on Yang legitimately: do not settle it, flag it as stalled
or duplicate it. Reconcile an item marked forwarded whose owner never ran.
Reconcile a finished owner that never reported, with one bounded continuation to
the canonical owner.
