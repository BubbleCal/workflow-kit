> Authorized calendar preparation is accepted and scheduled directly by discovery. Read MEETING_PREPARATION_INTAKE.md; pass full event details as meeting to classify. Inspect calendar_followups on every scan and finish their owner binding and timer setup under the saved rule. Do not send these existing-authority steps to main.

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

若包含 exact prompt 的发现回合已终止却未 finish，主对话/既有维护可用 discovery
op=recover，传 batch_id、generation、实际最新终态 native_proof、effects_reconciled=true
及证据。守卫要求 owner 空闲、原消息确实被消费且无未对账效果；保留全部页游标和
水位，关闭原投递回执，再由原队列产生下一 generation。不得清空批次或伪造成功。

## Follow existing Slack threads

搜索用于发现新事项，已关联未完成任务的线程还必须持续读取后续回复。原消息带过
@Yang 后，同线程的部署追问等新回复不要求再次 @Yang；仍需核对实际工作关联，
不能把无关讨论当成执行授权。

用 discovery op=watch_thread 登记 source_id（原 Slack 来源）、task_id、channel_id、
thread_ts（根消息）、relevant_user_id、professional_relevance=true、identity_verified=true
和实际线程/任务 evidence_ref。它复用已启用来源的授权和原 owner，每十分钟由现有
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

任务候选和已接收但无 owner 的任务用持久通知送主对话；普通无变化扫描静默。自主探索报告直接给父任务，发现角色不参与研究结果处理。

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
