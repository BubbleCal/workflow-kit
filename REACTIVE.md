# Desktop-owned native queue runtime (0.4.0)

workflow-kit 负责事件、事实、目标合同、计划和动作回执。Codex 桌面 App 始终负责会话、排队、执行、模型、权限及审批。

后台投递只调用固定的 `codex queue --thread <UUID> --message <text>`。没有 `--resume`、`--remote`、模型或权限覆盖，也没有 App Server 客户端、socket、会话恢复、回合启动或审批处理器。原生队列会把忙碌会话的消息留到当前回合完成后处理。

## 从 0.3.x 升级

先停止旧 workflow-kit runtime，不停止或重启 Codex 桌面 App / App Server。前台运行的 runtime 用 Ctrl+C；安装了本实例服务时使用下面命令。旧版可能已有发送结果不确定或运行中的回执，先保存它们，不能清空。

```sh
node workflow.mjs runtime service stop
git pull --ff-only
node workflow.mjs test
node workflow.mjs runtime init
```

若从未安装服务，略过 service stop。工作区有修改时先检查，不覆盖。保留 instance.json、registry、全部 SQLite、决策、回执和 worktree。

runtime init 将旧配置备份为 runtime.json.pre-native-queue.*，写入 schema 2 的 native_queue 配置，并将原 active 任务改为 paused。它保留事件、计划、历史动作和原负责人，不把旧发送重标为未发送。如果旧 runtime PID 仍存活，迁移被拒绝。旧 adapter 配置不会被重新执行。

同版本重复 init 不覆盖配置。runtime.json 及备份属于本机，不提交 Git。

## 先验证实际桌面消费

```sh
node workflow.mjs runtime probe
```

probe 仅核验安装的 CLI 版本和 queue 命令，明确返回 desktop_consumption_verified=false。它不读取或加载任何会话。旧的 probe --task 已移除。

在用户明确授权的临时测试对话上，通过桌面 App 的原生工具完成两项测试：

1. 空闲测试：原生 wait_threads 证明旧回合完成，再通过 NativeQueue.enqueue 提交唯一测试文本；原生 read_thread 必须显示新独立回合消费该消息，且只返回一次预期标记。
2. 忙碌测试：原生读回证明会话 active；原回合执行一个短等待，期间 enqueue 第二条消息。原回合应正常完成，排队消息随后在不同回合执行，不中断、不重复、不出现占用错误。

测试消息不得执行项目操作。保留原生队列回执、实际工具读回、时间和唯一标记。创建临时可见任务仍需用户明确请求，验证后按授权归档。不要用模拟记录代替实际 App 测试。

把真实导出保存到 observations/native-queue-proof.json：

```json
{
  "schema_version":1,
  "source":"codex_app.read_thread",
  "cli_version":"<actual NativeQueue.probe cli_version>",
  "host_fingerprint":"<actual NativeQueue.probe host_fingerprint>",
  "checked_at":"<actual retrieval time in ISO format>",
  "cases":[
    {"name":"idle","receipt":"<NativeQueue.enqueue result object>","message":"<exact submitted text>","expected_reply":"<unique reply>","before":"<actual wait_threads poll object>","readback":"<actual complete read_thread result>"},
    {"name":"busy","receipt":"<result object>","message":"<exact submitted text>","expected_reply":"<queued reply>","busy_expected_reply":"<original turn reply>","minimum_busy_ms":30000,"before":"<active wait_threads poll>","readback":"<read_thread result containing both turns>"}
  ]
}
```

示例中的对象占位符必须替换为真实工具对象，不能保留字符串。readback 应保留完整 userMessage、final answer、turn ID、状态和时间。`NativeQueue` 从 runtime/native-queue.mjs 导出；其 enqueue 结果只表示入队，不表示执行。

```sh
node workflow.mjs runtime queue-verify --file observations/native-queue-proof.json
```

校验会核对本机/CLI、精确消息、唯一消费、原回合未中断以及先后顺序，并持久保存证据哈希。没有实际 idle/busy 消费证据，不能启用 active。换机器、CLI 或桌面 App 更新后，应重新验证；CLI 版本或证据内容不匹配时拒绝启用。

原始证据文件和真实 thread ID 留在实例 observations，不随源码发布。VALIDATION.json 只记录本次验证的汇总和边界。

## 登记与启用已有任务

从实际用户目标、registry 和原生工具读回填写 templates/reactive-task.example.json，保存为 observations/adopt-task.json。保持原 task ID、owner、canonical key、project ID、实际 worktree、授权来源、验收和约束。

```sh
node workflow.mjs runtime op --file observations/adopt-task.json
node workflow.mjs runtime run --once
node workflow.mjs runtime status
```

首次登记是 shadow，只采集和展示事件，不发队列消息，也不修改旧反馈账本。

启用时用桌面原生 read_thread 获取负责人的真实身份和目录，附在 mode 请求中：

```json
{
  "op":"mode","task_id":"T-001","mode":"active",
  "source_message_id":"<actual user activation message>","actual_human_verified":true,
  "native_binding":{
    "source":"codex_app.read_thread","checked_at":"<actual retrieval time>",
    "readback":"<actual native result object>"
  }
}
```

切换还要求旧协调批次、续接和不确定发送已对账。身份读回不负责抢占会话；active owner 也可接收队列消息，实际执行时机由桌面 App 决定。工作流不假装知道原生后台作业或审批已结束。

```sh
node workflow.mjs runtime op --file observations/activate-task.json
node workflow.mjs runtime run
```

需投递重要通知时，把本实例 inbox 的实际 read_thread 结果包装为同样的 source/checked_at/readback 对象：

```sh
node workflow.mjs runtime bind-inbox --file observations/inbox-native.json
```

inbox 也使用原生队列，保留原有通知批次与回执。已入队不意味着通知已经展示。未迁移任务继续旧流程；0.2.22 的人类输入立即触发器仍服务 legacy 任务，active/paused 任务不会多走一次旧 dispatcher。

## 执行负责人协议

收到 workflow-event 后，不把机器消息当成新的用户授权。使用桌面 App 原生 read_thread 读取**自己当前执行回合**，保留完整 queued userMessage。不能用截断内容或自己构造的 turn 代替读回。

向安装目录入口的 stdin 传 JSON：

```sh
node /absolute/instance/workflow.mjs runtime op < /absolute/instance/observations/request.json
```

begin 请求包含 task_id、wake_id，以及 native_proof={source:"codex_app.read_thread", checked_at:<实际取回时间>, readback:<完整结果对象>, evidence_ref:<真实记录>}。只有正确 owner、worktree、精确原生消息和正在执行的回合才可 begin。随后调用 checkpoint 读取最新合同、计划、范围排除、事实和事件；消息排队期间可能已有新信息。

decide 继续支持 continue/revise/wait/needs_decision/complete。提交 owner_thread_id、wake_id、expected_context_rev、expected_plan_rev、reason、evidence_refs；方案变更附 plan={assumptions,steps}。每一步的 requirement_ids 必须覆盖原合同要求，旧计划保留为 superseded。只有真实用户来源能用 amend 改合同。观察到反例、持续失败无进展或评审意见时，重新判断下一步。

PR 用 feedback_status/feedback_assess 完整判读当前 head 的所有反馈，沿用 REVIEW_FEEDBACK.md。合理意见可触发修复；不合理意见应有证据和理由。外部副作用继续走原 control 守卫，payload.runtime_context 使用 decide 返回的 action_context。新事实和新计划使旧动作上下文失效。CI、无托管 CI 的来源证明、审批、送审窗口、范围排除全部保留。

当前 App 权限、用户停止意图及实际作业状态仍由原执行者在原生环境核验。队列投递不是工程启动许可。保护正在运行的作业，不因机器通知重启工作。原生审批留在桌面 App 中处理。

需要等待时，wait 包含当前 facts 的 subject/version、expires_at（Unix 毫秒，最多一小时）、resume_condition 和已有 typed condition。可用 pr、review_request、dependency/job/access/human。GitHub review_request 需要当前 requested_reviewers、完整反馈和 CI 事实，不依赖 Slack 回执，也不绕合并规则。执行者/采集器用 publish、wait_observe 报告作业或来源变化；后台不再读取原生终端列表。

本次处置结束时再次 decide，然后 finish。ready 状态还有可执行工作时不能直接 finish；complete 必须逐项保存真实验收证据。收到原生消息、begin、回合结束和目标验收是不同事实。

主对话可以直接读证据、讨论和回答问题。已有工程任务的写操作保留给原 owner，不为小追问强制创建新任务。只展示必要选择、请求的答案和重要完成。

## 回执、恢复与服务

rt_wakes 区分 reserved、claimed、queued、running、finished、uncertain。native queue ID 是入队回执；只有原生当前回合证明才能进入 running。进程崩溃、超时或无法识别输出时保留 uncertain，不能自动重投。后续事实合并到原任务；已有 queued/running/uncertain 消息时不创建第二次投递。

后台不再订阅会话生命周期，也不自行恢复终止会话。原负责人、主对话或原生维护轮次用桌面 read_thread 核对未收尾回合，再提交 recover 的 native_proof 和结果 evidence_ref。完整消息确实被消费且对应 turn 已结束时才能对账；其他不确定副作用仍需先解决。未找到消息不等于未投递。旧 direct-driver 回执必须这样核实，不能改成新的队列回执。

暂停 mode=paused 停新投递，但不能撤销已经交给 App 的消息。原生接收者看到 paused 后不继续工程工作。回退 legacy 前先处置在途队列和回执，持久 handoff 交回原 mailbox；确认 pending_handoffs 清空后再停服务。不要通过恢复旧数据库回滚外部动作。

```sh
node workflow.mjs runtime service install
node workflow.mjs runtime service status
node workflow.mjs runtime service stop
node workflow.mjs runtime service start
```

服务只管理 workflow-kit 本身，不控制 Codex 的 daemon 或桌面 App。日志位于 observations/runtime。默认每秒处理本地事件，open PR 健康轮询 30–60 秒，来源失败退避；这些不是生产延迟保证。App 关闭、离线、审批中或有排队工作时，CLI 入队成功不代表即时执行。

## 验证范围

本次实际验证了桌面 App 的空闲消费、忙碌顺序消费及真实当前回合证据校验。自动化测试覆盖原有守卫、队列回执、未知发送、先消费后 ACK、计划修订、旧配置迁移与跨实例隔离。原生 CLI 测试替身只用于回归，不冒充真实桌面测试。

对于正式项目，先迁移一个已有任务，观察新反馈是否改变下一步，以及被反例推翻的方案能否调整。实际任务质量和延迟需要项目验收；不能用测试数量替代这些结果。
