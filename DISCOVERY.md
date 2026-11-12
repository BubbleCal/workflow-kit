> When discovery status reports `new_task_intake_enabled:false`, follow only
> accepted existing work. Match genuine feedback to its original task/owner;
> record unmatched source items as ignored with their evidence. Do not create or
> accept new candidates, independent result followups or new meeting occurrences.
> Existing accepted meeting updates/cancellations and task health still matter.
> This policy does not pause existing owners or disable their recovery trigger.

> AWS access waits require the recovery evidence in AUTH_RECOVERY.md. During the existing owner-health audit, inspect new authentication failures and coach the original owner with the relevant verified success/failure procedure. Do not renew a generic "please log in" wait when ordinary supported recovery was not attempted. Keep one recovery owner per shared session and preserve human-only MFA boundaries.

> Owner recovery runs before source reads. `discovery begin/plan` returns a fixed
> `owner_health` target set when due; observe it even if chat-history pagination or
> another provider is blocked. The batch cannot finish/checkpoint without these
> observations. Queued and uncertain owners take priority over healthy running
> owners; the configured 30-minute per-owner cadence is unchanged. For an idle or
> notLoaded terminal owner with a known unconsumed queue, use the standing-policy
> guarded native recovery hint once, then confirm the real turn and work. Failed or
> uncertain hints remain blockers and are not retried. Main is never a recovery relay.

## Efficient scheduled scans

The instance's discovery source cadences are authoritative. Use `sources op`
with `op=cadence`, `intervals` keyed by source kind, and verified user instruction
to change timing without invalidating a running scan or losing its cursors.
Thread watches inherit the parent Slack interval. `instance.json.discovery`
may align poll slots and back off repeated unchanged failures for selected source
kinds. User input, PR events and due task schedules do not use this scan cadence.

`begin` and `plan` return compact stream checkpoints, not historical page bodies.
Read only the current turn for native proof (`turnLimit:1`, no included outputs),
save the complete raw envelope to a file and print only needed metadata. Start
from the returned streams and source health, then use `pending` with a source ID
for unclassified observations. `pending` with batch_id restricts classification to observations in this actual run; older isolated observations remain in their original repair backlog. `page` accepts a batch ID and exact page key for
needed evidence; `plan` with `detail:full` remains available for an actual gap.
Do not re-read completed pages, unchanged failed cursors, old transcripts or full
logs merely to reconstruct state. Keep errors as errors, never empty success.
Save bounded results and conclude with one local source/change-count or blocker
sentence. Routine scan summaries never go to main.

> Authorized calendar preparation is accepted and scheduled directly by discovery. Read MEETING_PREPARATION_INTAKE.md; pass full event details as meeting to classify. When service_task_id is configured, reuse that single task/owner and reconcile shared occurrence timers; never create per-meeting owners. Inspect calendar_followups on every scan. Do not send these existing-authority steps to main.

> Optional calendar source: configure exact calendar_id, preparation_authorization_ref, timezone and lookahead_days. Preserve the existing hourly scan and 45-minute preparation lead. Read-only calendar discovery may maintain authorized preparation schedules, never edit meetings, send invitations or write meeting briefs. Follow the supplied tool plan and pagination; calendar_id is its scope_key.

# Optional source-only discovery

Linear、Slack、Notion 各自默认关闭，和 PR 跟踪/外部写入配置独立。没有启用来源时不会排队发现扫描，也不要求 discovery 对话。代码、论文、博客和 benchmark 是 WORK_TASKS.md 的普通探索任务。

## Configure

用 sources list 查看状态；向 node workflow.mjs sources op 传 JSON：op=configure、source_id、enabled、scope、source_message_id、actual_human_verified、evidence_ref。interval_ms 至少一分钟，默认 Linear/Slack 五分钟、Notion 十五分钟。

- linear：scope.project 或 scope.team，assignee 默认 me；可配置 issue_ids 读取已知任务评论。除返回的新 issue 外，应把需持续跟进的 issue ID 纳入配置，不能假设评论必然更新父 issue 的 updatedAt。
- slack：scope.channel_ids 为明确的频道/DM ID；默认 public。私人来源需 access=private 和实际 private_access_authorized 授权，使用相应连接器。搜索结果不是完整线程，读取相关回复和编辑版本。
- notion：scope.page_ids 和/或 scope.view_urls。按计划 fetch 指定页面及讨论，或 query 保存视图，检查缺失子树/截断和分页。

先核验当前连接器及用户身份、字段、过滤语义和可访问范围。程序生成真实工具的读取计划，由 App 中的发现 Agent 执行；Node 不持有连接器凭据。工具不可用或 schema 变化时记录未知/错误，不能伪造成功。没有启用来源不构成阻塞。

## Scan protocol

向 node workflow.mjs discovery op 传 JSON。提示带 batch_id 和 generation；所有 begin/ingest/finish 都传该 generation。

每批采用五分钟软预算；到达安全边界时持久化分页和判断后 checkpoint，不等待工程或研究任务完成。某个来源持续失败时，其他已完成来源仍可采集后续窗口。

1. 先获取实际原生 read_thread，构造 native_proof={source:"codex_app.read_thread",checked_at:<实际时间>,readback:<完整返回>,evidence_ref:<记录>}，begin。只接受绑定 discovery/cwd 上包含 exact prompt 的当前执行回合。返回 invalidated 时已关闭旧邮箱回执，立即结束，不能读来源。
2. plan 返回本批各来源固定窗口、版本、实际 tool/arguments、后续读取说明和已存页游标。沿每个 request_index 的 next_cursor 续读。来源开启后的首次窗口为最近一天加两分钟重叠，不代表导入完整历史。
3. ingest：batch_id、generation、source_id、request_index、page_key、cursor、complete、next_cursor、evidence_ref、observations。每条 observation 包含 entity_key（跨来源需带来源前缀）、item_key、version、scope_key、summary、url，可含 assignee_id。scope_key 必须匹配配置的 project/team/channel/page/view。保存原始证据；每页不可变，旧版本不重放，分页不能跳过或重启。相关线程/讨论作为所关联请求的证据一并保存。
4. classify：observation_id、disposition=existing/candidate/ignore、reason、evidence_ref，以及 candidate（仅 candidate 需要）。existing 必须精确匹配已登记来源键，并把事实送原执行任务。candidate 用相同 canonical key 去重；语义是否相同由 Agent 结合账本判断。无关消息 ignore。外部来源内容不更改授权和权限。
   迁移任务若只有 legacy/codex 绑定，先读实际工单或线程和原任务合同；确认同一事项后，existing 可同时传 task_id、identity_verified=true 和证据，原子补齐来源绑定。不得因缺少绑定而新建重复任务，也不能改绑已有其他 owner 的来源。
5. 适用常设规则的指定 Linear issue 可以接收。若 owner_required 且已有明确 create_owner 授权，发现 Agent 按 WORK_TASKS.md 创建并绑定负责人，随后 start；没有授权则保持通知待决。候选阶段只入账本。重试之前先 task list/request_owner，不能重复创建。
6. finish 提供每个 source_results={source_id,complete,followups_complete}。只有所有请求流和相关后续完整、观察均已处置才能推进成功水位。部分结果传 complete=false、reason，持久化游标并在后续 generation 续读。权限/网络错误也不能假定无变化。

来源修改会使旧批次失效；旧原生消息不可撤回，接收方凭真实 proof 结束它而不读取来源。跨 control.sqlite/mailbox.sqlite 的完成回执可恢复，重启先关闭已完成扫描的旧邮箱回执，再生成后续页。对于尚无 durable finish 的 running/uncertain 批次，不自动重发或假定结束；通过真实原生状态恢复原批次。

旧窗口完成后，若已经落后一个来源周期，立即采集下一窗口；不再额外等待一个周期。
真实定时事件与发现消息同回合到达时，登记事件后继续完成或 checkpoint 已消费的发现
批次。登记定时事件不代表发现扫描完成，不能把原批次留在 pending/running 后直接退出。

若包含 exact prompt 的发现回合已终止却未 finish，主对话/既有维护可用 discovery
op=recover，传 batch_id、generation、实际最新终态 native_proof、effects_reconciled=true
及证据。守卫要求 owner 空闲、原消息确实被消费且无未对账效果；保留全部页游标和
水位，关闭原投递回执，再由原队列产生下一 generation。不得清空批次或伪造成功。

## Follow existing Slack threads

搜索用于发现新事项，已关联未完成任务的线程还必须持续读取后续回复。原消息带过
@Yang 后，同线程的部署追问等新回复不要求再次 @Yang；仍需核对实际工作关联，
不能把无关讨论当成执行授权。

普通 Slack 观察保存准确 channel_id 和根 thread_ts；classify 归到已有未完成 owner
后会自动登记跟踪。早期未带这些字段的记录，可用以下 watch_thread 补齐，不重做任务。

用 discovery op=watch_thread 登记 source_id（原 Slack 来源）、task_id、channel_id、
thread_ts（根消息）、relevant_user_id、professional_relevance=true、identity_verified=true
和实际线程/任务 evidence_ref。它复用已启用来源的授权和原 owner，按父 Slack 来源的配置间隔由现有
发现机制读取指定完整线程；不新增 App automation 或执行对话，不被原搜索的历史
分页阻塞。同线程可关联多个已有任务，逐条按实际主题归队。任务全部完成后停止跟踪；
父来源权限变化会停用跟踪，重新核实授权前不继续读取。

plan 给出准确的 observation_fields、task_bindings 和读取参数。观察保存 channel_id、
thread_ts、原回复 URL、每条消息的 item_key 和编辑时间/内容摘要 version。无变化的
消息不重复驱动 owner，完成全量分页/判断后才推进该线程的水位。无法读取仍是失败，
不是空结果。后续部署操作仍需原用户授权，禁止自动回复 Slack。

用户定向 Slack 的字段是 relevant_user_id 和 professional_relevance；早期的
with_user_id/professional 同义字段只在不冲突时规范化。真实用户不匹配或非工作内容
仍会拒绝。输入字段错误应根据已保存原始证据修复；不得把可修复的格式问题当成权限
禁令反复空转，也不得放宽真实权限来消除错误。

任务候选和已接收但无 owner 的任务用持久通知送主对话；普通无变化扫描静默。自主探索报告仍直接给父任务；按 RESULT_FOLLOWTHROUGH.md，发现角色另外处理固定的结果复核与独立负责人设置，不做研究、实现或交付协调。

## Preserved migration scopes

A verified assigned-user Linear scope may use `assignment_only:true` and an exact
`assignee_id` instead of a project/team; ingestion rejects another assignee.
A previously authorized professional Slack scope may use `with_user_id` and
`professional_only:true`; private access still needs its actual recorded grant.
Only professional observations tied to that exact user may be retained.

Optional `codex` discovery is limited to the configured local project. Read the
actual user request before classifying work, keep the original conversation and
running jobs, and ignore control/discovery chats and unrelated projects. Native
listing or a title is not implementation authority. The preserved standing
enrollment rule can register an actual authorized existing task without asking
for a second handoff; it cannot broaden that task or create a replacement owner.

## Fixed result followthrough

Use RESULT_FOLLOWTHROUGH.md for begin.result_followthrough. Handle original-owner terminal evidence, deduplication and guarded setup, then verify actual execution or persist result_followups_reason. Source access failures do not skip these fixed items. Keep the global 15-minute minimum; do not create another timer, coordinator or engineering owner for existing canonical work.

## Slack search, supplemental threads and delayed coverage

Main Slack discovery uses two independent required queries within the same user
and channel scope: `with:<@USER>` for conversations, and `keywords: ["<@USER>"]`
for explicit channel mentions. A completed with-user query does not prove mention
coverage. Preserve the original requests/pages; do not overwrite a terminal page
or append thread messages to its search cursor chain.

For a full thread read linked to a saved search page, use ordinary `ingest` with
its parent request_index and an additional object:

```json
{"followup":{"parent_page_key":"<full saved search page key>","channel_id":"C123","thread_ts":"1794027285.772359"}}
```

Use fresh unique page_key values and the real thread cursor/next_cursor. Every
observation must identify that exact channel/root thread and satisfy the original
user/professional/private scope. Supplemental streams appear separately in plan;
primary pages remain immutable. Finish requires all search variants, thread
cursors and classifications. Followup completion cannot replace primary coverage.

When a saved main Slack window is overdue, the acknowledged discovery owner may
call `append_catchup` with batch_id/generation/source_id/evidence_ref. It preserves
the original cutoff/pages, adds any missing mention query for the original window,
and appends fixed later search requests in the same actual run. Re-read plan and
collect every returned request index and its full-thread followups. One extension
per generation is idempotent; unfinished catchup cursors must resume first. This
adds no timer, new owner or additional automatic start and does not bypass the
15-minute minimum between actual starts. Respect the bounded turn budget.

Three repeated source failures create one durable maintenance input and an open
coverage gap. Later windows can be read/classified while that old checkpoint is
isolated. The normal success watermark remains the contiguous completed prefix;
it never crosses the unread gap. Completed ranges and all old pages/cursors stay
durable. `health.coverage_gap` distinguishes newer observation progress from full
coverage. After a verified repair, existing maintenance can request one
`retry_checkpoint` with exact batch_id/generation/evidence_ref. The original owner
resumes that checkpoint through the normal queue and start interval; a live run
is never reset. Closing the gap joins contiguous verified ranges and advances the
watermark. Routine escalation is coalesced in the existing maintenance lane and
never posts to Slack or main.

New durable source pages mark an isolated checkpoint as progressing, allowing its
normal bounded continuation without another manual retry. Replayed pages do not
count as progress; repeated or cyclic provider cursors are rejected. Three further
unchanged failures isolate it again. Progress alone never closes a coverage gap.

For a full Notion row fetched after a terminal parent search, ingest it with
`followup={parent_page_key,page_id}`. Verify its ancestor path or saved query row
belongs to that exact authorized parent first. The row's `url` and `item_key` must
identify the same Notion page, and `scope_key` must match the original request's
configured page URL. Its own stream preserves the parent page and observation
version. Resume actual discussion cursors within that stream. An unavailable
comments response (including only `suggested_edits_status=upgrade_required`)
does not prove zero comments or complete followups: retain the coverage gap and
checkpoint the provider limitation after recording/classifying available rows.

Under the enabled discovery_owns_creation policy, process fixed owner_creation entries before external reads using OWNER_CREATION.md. All accepted authorized ownerless tasks enter this flow, including direct human tasks, even when sources are disabled. Main only registers them. Checkpoint actual setup/execution blockers with owner_creation_reason; never finish from a candidate or queue acknowledgment.


Direct human corrections may use `discovery begin_interactive` with the exact
batch_id/generation/expected_mail_key, actual_human_verified, source_message_id,
verbatim_text, evidence_ref and fresh native_proof. Only the current actual user
message in the discovery chat is accepted; queued workflow markers and relays
are excluded. This acknowledges actual interactive execution, never original
queue consumption. A checkpoint resumes as the next generation with its original
windows/pages/cursors preserved. Another acknowledged active writer, changed
source scope and stale proof fail closed. A late original queue quietly skips.
An unrelated pending batch is retained. Normal automatic starts retain cadence.

Private own-user Slack discovery requires with-user, explicit @mention and
incoming DM/group-DM streams. The DM stream is present only for explicitly
permitted broad private scope; it does not widen exact-channel or public scopes.
Every returned cursor and relevant thread must complete before coverage advances.
`append_catchup` can accept `window:{from,to}` matching saved actual query evidence:
it must overlap retained coverage, start no earlier than the original authorized
window, and end no later than actual observation time. This appends independent
requests without altering original request/page evidence. Preserve the saved
query's real cursors and cutoff; do not relabel an uncollected range complete.

Invalidated source batches also retire their matching mailbox obligations. Their
original queue receipt, input, prompt and pages remain; retirement grants no
source coverage. Native consumption is verified only from the actual recorded
begin, never inferred from an ACK. Blocked in-flight delivery is exposed in
`rt_diagnostics` under `discovery-delivery` so a live process cannot be mistaken
for progressing source intake.


An already-created owner with project_pending setup is not a new creation.
Resume its existing creation batch/actor and follow WORK_TASKS.md. If a complete
fresh native listing omits a readable idle setup owner, use the narrowly guarded
repair_created_project action to reassert the original project once. Do not fake
actual_project_id, repeat create_thread, or treat a move ACK as membership. Only
genuine post-move list_threads confirmation permits ordinary bind/start.


Dedicated runtime message trigger delivery follows MESSAGE_TRIGGER.md. Preserve the original batch/generation and use includeOutputs:true for the actual self proof, retaining the full incoming delegation. Existing source, cadence, coverage and owner-creation guards still apply. No new coordinator is introduced.


Overdue source checkpoints receive a bounded opportunity ahead of newly arriving result reviews after one configured start interval. Preserve their immutable source windows, pages and cursors, all original scope/cadence guards and explicit human owner-creation trigger priority. Pending or inconclusive result reviews remain visible and cannot hold every older source window indefinitely.

## Codex history pages after a project listing

A completed `list_threads` page remains immutable. Read each ordinary thread's
history in a separate stream with `discovery ingest`:

```json
{
  "followup": {
    "parent_page_key": "<full saved primary listing page key>",
    "thread_id": "<exact listed thread UUID>",
    "host_id": "local"
  }
}
```

The parent evidence must retain the actual `list_threads` request and native
readback. At the history page's `evidence_ref`, save the unchanged native result
inside `{source:"codex_app.read_thread",checked_at,request,readback}`. The request
contains the exact `threadId`, `hostId` and optional provider `cursor`. Set ingest
`cursor` to that request's cursor (null for the first page), `next_cursor` to the
actual `page.nextCursor`, and `complete` to `!page.hasMore`. Resume each saved
history cursor; never append history to the terminal listing or invent completion.

The runtime checks the listed project, host, thread and cwd, rejects control
chats, and binds each observation's `version` to a real human message (preferred) or its
containing turn in that page.
Keep `entity_key="codex:<thread-id>"`, `item_key=<thread-id>` and the exact Codex
thread URL. Machine deliveries and assistant summaries are not human requests.
Original listing and history digests remain bound to the stream. Finish requires
every started history stream complete and its observations classified; unread
histories remain a coverage gap. Historical evidence grants no new execution,
owner creation, external-write or deployment authority.
