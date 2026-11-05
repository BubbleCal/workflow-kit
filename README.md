0.8.0 completes the removal of the delivery coordinator in native instances. Each original task owner handles its authorized delivery; the main conversation handles user decisions and completion archival, and optional discovery includes authorized calendar preparation scheduling. Read [OWNER_DELIVERY.md](OWNER_DELIVERY.md).

# Independent Workflow Kit

0.7.0 新增持久化的一次性和固定周期调度，支持漏触发合并、忙碌时合并/跳过、暂停/取消和每轮独立验收。它复用原任务负责人和原生队列；使用方法见 [SCHEDULES.md](SCHEDULES.md)。

0.7 completes paused native-layout migration, keeps one execution owner per independent task, and supports optional delivery/maintenance as ordinary tasks. Existing installations preserve their layout, original owners and receipts during upgrade; do not run init over existing state. See REACTIVE.md.

0.7.0 使用主对话、可选的后台发现 Agent，以及按需建立的普通任务负责人。自主探索是自带的普通任务，和开发、研究、项目工作包共用目标、计划、原生队列、证据和验收机制。

- 主对话可以直接讨论、调查、接收工作和处理决策。需要独立执行的任务进入统一账本。
- 后台发现 Agent 只读取已启用来源的变化，关联已有任务或登记候选。Linear、Slack、Notion 分别可选，默认全部关闭。
- 探索负责人读代码、论文、博客或运行获准的实验，输出发现、没有可行动发现，或证据不足。探索不占用发现 Agent。
- 大项目可以登记子工作包、依赖和多个 PR。反馈到具体负责人，项目负责人承担集成验收；单个 PR 合并不代表项目完成。

后台 Node 程序使用 Codex 原生 queue 提交事件，App 管理会话、执行和审批。它不直连 App Server，不恢复会话、不启动回合、不改模型或权限。队列接收与实际执行分开验证。没有 npm 依赖，需要支持 node:sqlite 的 Node.js；本版验证环境为 Node.js 26.4.0。

## 直接发给安装 Agent

填写两个占位符后，在目标 Mac 的 Codex 中发送：

```text
请在当前 Mac 为下面的项目安装这份独立工作流，完成原生绑定和验证。
项目名称：<项目名称>
项目目录：<实际绝对路径>

读 README.md、START-HERE.md、ROLE_PROMPTS.md、WORK_TASKS.md、DISCOVERY.md、POLICY.md，以及项目适用的 AGENTS.md。先核验已有实例；不要覆盖已有账本或另建重复实例。默认使用 native 布局，不安装旧四角色或十分钟触发器。

复用当前对话为主对话，并核验项目归属和 cwd。保留我选择的模型、推理和权限。Linear、Slack、Notion 来源默认全部关闭；仅按我另行给出的来源范围启用。只有启用来源时，这条安装请求才授权创建一个独立的后台发现对话。

初始化自带探索任务并保留为草稿。为该项目建立任务范围、预算和验收后再执行。候选发现不是实施授权。不要把安装请求当成创建任意执行对话的许可；我给出一次性自动建任务授权时，保存它的实际范围和原文，之后按规则复用，不重复确认。

运行隔离测试、doctor，并按 REACTIVE.md 核验当前电脑原生队列空闲和忙碌消费；如需测试对话，此请求授权创建一个只做队列验证的临时对话，验证后归档。核验后安装并启动本地原生队列服务。不要用产品任务、外部发言、合并或云资源创建做安装测试。

完成后给出主对话链接、实例目录、角色和来源实际状态、自带探索任务编号、验证证据，以及未启用的选项。不要把队列接收、旧版本证据或保存的 binding 当成当前环境实际执行成功。
```

## 命令入口

```sh
node workflow.mjs init --name project-b --project-root '/absolute/project'
node workflow.mjs bind --file observations/native-bindings.json
node workflow.mjs runtime init
node workflow.mjs doctor
node workflow.mjs task list
node workflow.mjs sources list
node workflow.mjs test
```

安装只要求已核验的主对话；不需要 registry.json、decisions.json 或旧四个角色。所有本地实例数据均被 Git 忽略，各电脑、项目和授权独立。

任务协议见 [WORK_TASKS.md](WORK_TASKS.md)，来源协议见 [DISCOVERY.md](DISCOVERY.md)，队列验证和执行见 [REACTIVE.md](REACTIVE.md)。旧实例迁移见 [START-HERE.md](START-HERE.md)。历史四角色安装说明保存在 [LEGACY_INSTALL.md](LEGACY_INSTALL.md)，仅用于显式的 init --legacy。

本版实现和验证了本地任务/发现协议与连接器读取计划，未配置真实 Linear、Slack、Notion 账号或进行线上来源采集验收。启用每个来源时仍须验证当前工具权限、范围和分页。历史原生队列实测范围见 [NATIVE_QUEUE_VALIDATION.md](NATIVE_QUEUE_VALIDATION.md)。
