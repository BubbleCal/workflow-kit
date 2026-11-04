# Native queue validation

本次使用用户明确授权的临时桌面对话验证，完成后通过原生工具归档并回读确认。原始工具导出、回执、时间和真实 thread ID 留在本机 observations/native-queue-live，未放入可复用实例配置。

环境：macOS；Codex CLI 0.166.0-alpha.5.1；已安装桌面 App 的 bundle ID 为 com.openai.codex，版本 26.1027.61615，build 24141。测试跨 2026-11-04 至 2026-11-05（Asia/Shanghai）。

| Case | Actual operation | Verified outcome |
| --- | --- | --- |
| Idle desktop thread | Native queue submission without resume | A separate native turn consumed the exact message once and returned its unique marker |
| Busy desktop thread | Queue during an observed active 30-second wait | The original turn completed normally; a different queued turn started afterward |
| Adapter idle and busy cases | Repeat both cases through NativeQueue.enqueue | Exact queue receipts and native readbacks passed validateQueueCompatibility |
| Receiver execution proof | Read an actual active queued turn through desktop tools | Exact prompt, thread, cwd and current-turn proof passed verifyExecutionProof |
| Cleanup | Archive after the last test turn completed | Native archived-thread listing confirmed the temporary conversation |

测试没有启动或连接独立 App Server，没有调用会话恢复/回合启动接口，没有使用 queue 的 --resume 或 --remote 参数，没有改变模型、推理强度或权限配置，也没有进行项目写入、PR 操作或外部消息发送。

此证据支持当前本机环境的队列消费边界，不代表生产 P95、所有平台兼容性或任务推理质量。没有刻意触发原生审批弹窗；代码不接收或代答审批，仍由桌面 App 处理。App 关闭、离线、升级后或其他机器需要重新核验相应行为。

自动测试中的 CLI/原生读回替身只验证回归和状态机，不替代上述真实桌面证据。发布记录的 tested_sources_digest 绑定最终测试过的源码，队列验证原始文件保持本机私有。
