# Native installation and migration

安装请求与授权以实际用户消息为准；文档本身不授予创建对话或运行任务的权限。可复制请求见 README.md。

1. 核验项目目录、适用 AGENTS.md、Node 的 node:sqlite，以及 Codex 原生项目和对话工具。复用匹配实例；已有状态不得重新 init。
2. 新实例运行 node workflow.mjs init --name <name> --project-root <path>。默认 native 布局，只生成本地配置和一条探索草稿，不创建 App 对话或定时任务。
3. 用原生工具核验实际项目、主对话、cwd。按需在已有授权下创建可选 discovery 对话。保存真实回读，写入 bindings 文件：

```json
{
  "project_id": "<verified project ID>",
  "threads": {"main": "<actual main conversation UUID>"},
  "thread_workspaces": {"main": "/actual/conversation/cwd"},
  "native_verified": true,
  "evidence_ref": "observations/native-project-and-chat-readback.json"
}
```

4. 运行 node workflow.mjs bind --file <file>，再 runtime init。仅在已启用外部来源时增加 threads.discovery 和其 thread_workspaces.discovery。绑定只是保存核验记录，doctor 不执行在线探测。
5. 按 REACTIVE.md 进行当前主机的 queue-verify；真实验证应覆盖空闲消费和忙碌时不打断当前回合。已有证据只有当前 CLI/App/主机仍一致时才能复用。运行 node workflow.mjs test 和 doctor。
6. 按实际安装授权运行 runtime service install（macOS）或 runtime run。没有来源和 active 任务时服务保持无扫描。来源配置、任务接收和负责人绑定分别使用 DISCOVERY.md、WORK_TASKS.md 的协议。
7. 交付真实状态和证据。来源读取、Slack PR 发送、Notion 写入、ready 和 merge 是不同配置；启用读取不会启用写入。

## Existing four-role instances

旧实例保持兼容，不在启动时隐式迁移。先停止旧 runtime 和十分钟调度，核验没有在途控制批次或不确定外部动作。保护工程任务、作业、原始回执及旧 registry。

一个负责人只绑定一个独立未完成任务。旧实例若有共享负责人，保留各 T 编号，先按实际用户的新建授权建立独立负责人；旧 owner 保存范围释放 checkpoint，经过现有 create/claim/settle 和原生回读后，用 runtime op transfer_owner 迁移暂停任务。已完成项只保留历史，不新建 owner。迁移命令拒绝未处理的共享负责人；不会通过合并任务规避唯一性。

在实际迁移授权下保存 migration.json，包含 actual_human_verified、source_message_id、legacy_scheduler_paused、scheduler_evidence_ref、native_verified、evidence_ref、相同 project_id、threads.main 和 thread_workspaces.main；可选 discovery 同绑定格式。执行：

```sh
node workflow.mjs migrate --file observations/migration.json
node workflow.mjs doctor
```

命令备份 instance.json，导入已登记 rt_tasks 的原负责人和合同，保留任务模式、队列回执和旧文件，更新主对话通知目标，导入旧候选/历史记录并保留原授权边界。旧 control_lanes 自动移除；需要继续的交付/维护职责按 NATIVE_SERVICES.md 登记为普通任务。它不会修改或归档原生角色、停用 App 定时任务或擅自接管旧任务。未迁移任务需逐项核验后登记，原调度不得与新执行器同时驱动同一任务。再次检查 runtime 队列配置和迁移输出，再按实际授权恢复服务。

旧四角色从零安装必须显式使用 init --legacy，并只遵循 LEGACY_START_HERE.md 和 LEGACY_ROLE_PROMPTS.md。
