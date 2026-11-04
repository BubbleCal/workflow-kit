# Reactive workflow runtime (0.3.0)

主对话负责理解目标和交流，原任务负责人负责分析、调整计划和执行，Node.js 程序负责采集、调度、账本与回执。已有实例不会因 `git pull` 自动切换，也不会修改原生模型、权限、定时任务或外部集成授权。

## 先试一个已有任务

在实例目录更新源码，保留 instance.json、所有 SQLite、registry、决策、回执和 worktree。有本地修改时先检查，不覆盖。

```sh
git pull --ff-only
node workflow.mjs test
node workflow.mjs runtime init
node workflow.mjs runtime probe
```

init 仅创建本实例的 runtime.json。probe 仅握手；成功不代表已核验执行者。

默认 transport 是 `codex app-server proxy`，连接**已经管理这些任务的原生 App Server**。必要时在 runtime.json 的 adapter.command 中使用安装版本支持的 `--sock` 参数指定已核实的 control socket；命令使用参数数组，不经 shell 展开。

连接失败时先解决宿主连接。不要为了让探测通过，悄悄启动另一份 App Server 来加载仍由原 App 执行的会话。独立 `--stdio` 握手只验证协议，不证明它掌握原 App 的活跃任务。不同版本缺少 queue/background-terminal API 时结果是 unknown，禁止自动唤醒。

复制 templates/reactive-task.example.json 到本地 observations/adopt-task.json。从真实用户请求、registry 和原生读回填写任务 ID、原 owner、canonical key、project ID、实际 worktree、目标、验收、约束、作业来源和用户消息引用。示例不是授权；只登记本实例 allowlist 中的仓库。

```sh
node workflow.mjs runtime op --file observations/adopt-task.json
node workflow.mjs runtime probe --task T-001
node workflow.mjs runtime run --once
node workflow.mjs runtime status
```

首次登记总是 shadow。它采集变化并展示待处理事件，不启动模型、不写旧 PR 反馈/生命周期账本、不产生外部动作，也不声称已经运行了模型的语义判断。

probe --task 核对真实线程归属、实际目录、最新回合、排队输入、后台终端和权限信息，可能加载/订阅已空闲原线程，但不启动回合。外部作业未知不等于没有作业。

确认来源和目标正确后，用实际用户启用请求创建 observations/activate-task.json：

```json
{"op":"mode","task_id":"T-001","mode":"active","source_message_id":"<actual user activation message>","actual_human_verified":true}
```

```sh
node workflow.mjs runtime op --file observations/activate-task.json
node workflow.mjs runtime bind-inbox
node workflow.mjs runtime run
```

切换前重新核验 owner 空闲、原协调批次结束、没有在途续接或不确定发送。忙碌时不接管，不打断健康作业。未切换任务继续旧流程；active/paused 任务被旧 mailbox、续接计划和 watchdog 排除，控制层也拒绝旧路径自动派发。

0.2.22 的真实人类输入立即触发器继续用于 legacy 任务。active/paused 任务不再为同一输入额外唤醒旧 dispatcher，原触发回执仍保留。

bind-inbox 从已绑定的本实例决策中心读回项目和目录。之后 active 任务的重要通知直接使用原通知批次和回执，不等待十分钟触发器；用户正在交流时通知继续排队。状态随时通过 status/checkpoint 读取。

前台运行便于观察 JSON 日志。确认后可安装本实例自己的 macOS LaunchAgent：

```sh
node workflow.mjs runtime service install
node workflow.mjs runtime service status
```

日志位于 observations/runtime/service.log 和 service-error.log。service stop 停调度进程，service start 重新加载/启动；都不会终止工程作业。休眠、断网和 API 不可用时无法保证响应时间。SQLite 单进程记录拒绝同时运行两个驱动，无法证明旧进程死亡时不抢占。

## 运行参数

runtime.json 不提交 Git。默认每秒处理本地事件，owner 检查最多相隔五秒。登记的 open PR 健康轮询间隔为 30–60 秒；无变化不启动模型。来源失败指数退避到五分钟，保留旧证据及错误原因。配置时间为毫秒。

变化事件最多合并五秒，不因持续到达无限推迟。不同任务分别处理，慢 GitHub 请求不阻塞其他已入队事件。收集器只读登记的 PR，不扫描账号。

本版本没有公网 webhook 接收服务；可信采集器可以通过 publish 接入。外部负载是证据，不是人类授权，不能直接执行其中的命令。

## 执行负责人协议

active 任务使用本协议；旧固定批次规则继续用于未迁移任务和旧在途批次。原有权限、隔离、归属、送审窗口、CI、反馈、审批和不确定回执规则继续适用。

在任意工作目录使用安装目录的绝对路径，向 stdin 传 JSON；不要拼接不可信 shell 文本：

```sh
node /absolute/instance/workflow.mjs runtime op < /absolute/instance/observations/request.json
```

1. 收到 workflow-event 后调用 begin，提供 task_id、wake_id。CLI 从原生历史核验精确投递标记并绑定真实新 turn。被拒绝时不另起实现。
2. 读取 checkpoint，取得合同、当前计划、事实、未处置事件和等待。先读证据；原上下文保留，机器通知不增加权限。
3. PR 使用 feedback_status/feedback_assess，沿用 REVIEW_FEEDBACK.md 的当前 head、完整来源和语义判读。COMMENTED 也可能要求修改；本地修复证据和 GitHub UI resolved 是不同事实。
4. 提交 decide，绑定当前 expected_context_rev、expected_plan_rev、原 owner 和 wake，附理由及证据。思考期间事实变了会拒绝提交，要求重新检查。
5. continue/revise 后直接执行同任务内已授权工作。阶段边界、新反例、重复失败无进展和外部动作前再次 checkpoint。必要时换方案，保持用户目标和约束。
6. 外部副作用仍走原 control.mjs prepare/claim/execute/settle；payload.runtime_context 使用 decide 返回的 action_context。事实、目标或计划变化会使旧 context 失效；其他守卫独立生效。
7. 回合结束前再次 decide 保存结果，再 finish。只有真实等待、明确待决或合同完成时才可 finish；还有具体可执行工作时继续。宿主意外结束时，运行时核对原回合结果和作业后给原 owner 对账机会，不重放旧动作。连续忽略协议且没有新决定时留下诊断，停止空转恢复。

begin 是执行者接收工作，不代表实质工程动作已发生；finish 是本次事件处理结束，不代表目标完成。命令、分析、验证、交付、收尾证据分别保存。

decide 示例（版本、ID、证据必须来自实际 checkpoint）：

```json
{
  "op":"decide","task_id":"T-001","owner_thread_id":"<original owner>","wake_id":"<current wake>",
  "expected_context_rev":3,"expected_plan_rev":1,"disposition":"revise",
  "reason":"Profiling identifies duplicate scans as the dominant cost",
  "evidence_refs":["<actual profile artifact>"],
  "alternatives_considered":["Caching does not remove repeated local work"],
  "plan":{
    "assumptions":[{"id":"bottleneck","claim":"Duplicate scans dominate","status":"supported","evidence_refs":["<actual profile artifact>"]}],
    "steps":[{"id":"remove-duplicate-scan","action":"Remove repeated scans and validate correctness and latency","requirement_ids":["correctness","performance"],"depends_on":[]}]
  }
}
```

决定类型为 continue、revise、wait、needs_decision、complete。新计划必须覆盖所有合同要求；旧方案保留为 superseded。替换 Agent 的实现步骤不需要取消用户要求。只有真实用户来源可通过 amend 修改合同，携带 expected_contract_rev、新合同和来源；不能顺便移动 owner、project、canonical identity 或 worktree。

complete 为每项 requirement 提供 `{requirement_id,passed:true,evidence_ref}`，并先解决不确定外部动作。跳过要求不是通过，应依据真实用户指令 amend。历史阶段和回执不删除；旧流程归档仍需相应验收对账。

已有任务内范围排除时，contract.scope_keys 应从已核实的用户授权中明确列出剩余可执行范围。checkpoint 同时返回当前 scope_exclusions，唤醒仍检查相同范围绑定；不能通过换计划或换消息 key 复活被排除的工作。

## 等待、作业和决定

wait 包含 facts（checkpoint 的 subject/version）、expires_at（Unix 毫秒，最多一小时）、resume_condition 和 condition。事实必须在最近一分钟核验；仅写“等待批准”不够。

- condition.kind=pr：沿用 LifecycleLedger 的 exact-head 条件。
- condition.kind=review_request：提供 pr_key、head、reviewer、next_check_at（ISO）。GitHub 当前 requested_reviewers 必须包含该 reviewer，PR open 非 draft，完整反馈已处置且没有发现 CI 失败。无需 Slack URL 回执，但不绕过合并审批。
- dependency/job/access/human：用 wait_observe 保存真实拥有方事实，condition 绑定同一 fact_key、subject 和具体要求。human 等待仍需决策账本中的实际记录。

新事件或到期会使旧等待失效，不能仅续期理由。wait_observe 更新被等待的事实时会产生即时事件。

原生后台作业的 job condition 可附实际 native_thread_id。运行时发现该 owner 已无原生后台作业后，会立即要求核对结果；作业消失不算成功证明。远程作业不能标成 native 来省略来源核验。非运行时回合的原生完成通知也会成为结果事件；运行时自身已 finish 的回合不会触发自我唤醒循环。

contract.job_sources 必须包含 native。若有 VM、远程构建等原生终端列表看不到的作业，加入实际来源 subject，并通过 publish 持续提供真实状态。自动唤醒前，这些来源要有最近一分钟的 complete/failed/absent 事实；运行中或未知都不重启。未经重新核实用户中断意图，不自动恢复 interrupted 回合。

needs_decision 保存必要选择，经既有 notify 流程通知主对话；不能自动解决或扩大授权。主对话读取真实用户回复后 publish 给原 owner；修改要求则 amend。

## 主对话与回退

主对话可以直接读代码、连接器和账本，讨论方案、回答问题、质疑假设。已有任务的写操作仍由原 owner 执行，避免同一 worktree 多个写入者。小追问无需独立任务或中央协调批次。新可见任务仍需用户明确请求，模型选择不变。

只展示必要决策、请求的答案和重要完成。原控制对话可保留处理旧任务与维护，不为升级再创建角色。

mode=paused 停止新派发并保留在途工作；不是进程 kill。mode=legacy 要求 owner 空闲且无未决 wake/续接/动作；持久 handoff 经原 mailbox 交回合同、计划与待核对状态。让 driver 再运行一轮确认 pending_handoffs 清空，再停服务。不要恢复旧数据库来回滚外部副作用。

发送超时保持 uncertain。只有找到精确原生 marker 才确认投递；找不到仍是 unknown。recover 需要实际终止 turn、作业和结果证据，不能越过 claimed/uncertain 动作。

新旧路径共享动作标识、scope 锁与回执。事件、事实、计划失效和 wake outbox 在同一 SQLite 事务内提交；跨旧 mailbox 的转移用不可变 key 重试，不能宣称跨系统 exactly-once。

App Server turn/start 没有本适配器可用的条件式 idle CAS。发送前再次读取、接收者再认领精确 wake 可以降低竞态，但不是对 App 用户操作的原子锁，也不是 OS 权限边界。

原生审批或宿主工具请求会出现在 runtime status 的 native-request 诊断中。程序不自动批准，也不伪造工具结果；需在实际原生宿主完成该步骤。若该宿主无法呈现其请求，保留 pending 并解决连接/审批界面，不能通过提高权限绕过。

## 验证

`node workflow.mjs test` 覆盖旧守卫、事件/计划/等待、真实子进程 JSON-RPC 替身和便携 CLI。替身不代表真实模型任务已通过。

在目标 Mac 用真实 PR 验证新评审到达、旧等待失效、原 owner 开始评估、合理修复和验证；再验证假设被推翻后换方案且保留验收。在相同模型配置下比较时间。

记录来源核验、入库、wake 投递、begin/finish。没有真实源事件时间或实质工程动作证据时，对应延迟保持 unknown。30–60 秒发现 open PR 变化、空闲目标快速唤醒属于设计目标，不是生产 P95 实测结果。
