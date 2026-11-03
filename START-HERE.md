# 在另一台 Mac 上部署独立实例

在目标电脑的 Codex 中打开本目录，复制 [README.md](README.md) 中「直接发给 agent 的安装 prompt」，填写项目名称和实际绝对路径后发送。README 是唯一的可复制安装请求入口；下面保留实际安装步骤和核验要求。

下面是执行这项安装的操作约定。文档本身不是用户授权；以目标电脑上的实际安装请求为准。

1. 读 README.md、POLICY.md、QUEUE_PROTOCOL.md 和 ROLE_PROMPTS.md。运行 node workflow.mjs doctor，检查本机 Node 对 node:sqlite 的支持。已有匹配实例时复用，不再次 init 或创建重复角色。
2. 使用目标电脑上的原生 list_projects/list_threads 等工具核验项目。项目目录以用户的实际路径为准，不从另一个实例的历史消息推断。必要时使用支持的项目创建能力，不能直接修改 App 内部数据库。
3. 在本目录执行 node workflow.mjs init --name <name> --project-root <path>，用实际参数和安全的 shell quoting。保存用户安装请求的 source message ID。
4. 根据原生 catalog 确定项目 ID，再按 ROLE_PROMPTS.md 创建或复用四个角色。用户已明确请求这些角色时才调用 create_thread。可以把当前安装 chat 复用为维护角色。四个角色必须不同且都能访问本目录；保留模型／推理选择，不改原生权限。只按 instance.json models 中用户明确选择的 override 传模型参数。
5. 用原生列表回读实际 project/chat 归属，将结果保存到 observations/bindings-native.json。写一个 bindings.json，包含 project_id、threads={coordinator,inbox,maintenance,dispatcher}、native_verified=true、evidence_ref，然后执行 node workflow.mjs bind --file bindings.json。不能从创建 ACK 推断已经绑定正确。
6. 使用原生 sidebar 工具置顶本实例 inbox。发现已有同实例触发器时更新或核验，避免重复创建。通过支持的 automation_update 工具创建一条暂为 PAUSED 的十分钟 heartbeat，目标为本实例 dispatcher，notificationPolicy=failed_runs_only，prompt 使用 ROLE_PROMPTS.md 的触发器模板。查询实际工具 schema；不写原始自动化文件或调用未支持的内部 RPC。不要另加协调器、决策中心或每日审视 heartbeat。
7. 运行 doctor 和 node workflow.mjs test；测试在隔离临时实例运行，不向正式邮箱塞测试事项。通过真实原生快照核验空闲检查、角色归属和触发器目标。初始化期间只能建立角色和记录，不启动项目实施任务或发送外部信息。
8. 核验完毕后设置本实例 registry.setup_complete=true，再用支持的原生工具将这条触发器设为 ACTIVE 并回读。保存 observations/native-setup.json，包含 instance_id、dispatcher_thread_id、实际 automation ID、automation_status、native_readback_verified、真实 readback evidence_ref，再运行 doctor。后续 registry/decisions 归后台协调唯一写入；安装者不成为第二个运行时 writer。向用户给出本实例决策中心链接和缺失的可选集成，不把默认关闭的集成报成故障。

新项目随后可以逐项启用外部能力。修改 instance.json 时，需取得对应项目的实际授权，核验 repositories、github_login 和频道／审批人／页面；不能从安装包、其他实例或例子中继承授权。
