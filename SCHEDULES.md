# Durable runtime schedules

运行时定时器与 GitHub、原生 schedule producer 共用事件账本和 owner queue。它只产生到期事件；执行、研究方向和验收仍由原任务负责人承担。实例默认没有启用的运行时定时器。

## Time and overlap semantics

- kind=once 在 start_at 到期一次；kind=interval 从 start_at 锚点起每 interval_ms 触发。间隔为一分钟到 365 天。
- start_at 必须是带 Z 或显式 UTC offset 的 ISO 时间；timezone 保存并验证 IANA 时区。2026-11-06T09:00:00+08:00 和 2026-11-06T01:00:00Z 表示同一时刻。
- interval 是固定经过时长。跨夏令时仍是指定毫秒数，不能把 24 小时间隔说成“当地每天固定钟点”。本版不支持 cron、日历月或自动夏令时墙钟调整。
- 停机、睡眠或暂停错过多次触发时，默认合并为最新的一轮，保存 first_due_at、due_at 和 occurrences。计时器仍按原锚点前进，不从实际完成时重新计时。
- overlap=coalesce（默认）：上一轮尚未验收，或 owner 有已排队/运行/不确定的唤醒时，保持一个 pending 轮次，后续到期合并进去。overlap=skip：这些到期项记为 skipped，之后不补跑。
- 每个任务最多一个 admitted/running 定时轮次；同一 owner 的不同任务继续使用原共享队列。任务暂停、execution_hold、待人工决定、未处置事件和其他执行者边界仍生效。

## Register through the ordinary task path

1. 先有实际用户授权的任务、范围、预算、验收和原 owner。新任务的 task create/configure 可设置 schedule_sources=["runtime:research"]、trigger_only=true；自带探索草稿也走相同操作。
2. 需要只在定时到期执行时使用 trigger_only=true。task accept/bind_owner/start 后，它会保持等待，注册或启动 runtime 不会提前执行。已有任务用 runtime amend 保存实际用户合同变更，不手改 SQL。
3. 通过原生队列验证后保持该任务 active，按下面方式登记时间。create 可在 shadow/paused 模式登记，但不会绕过任务模式启动。登记幂等，配置和授权必须一致；修改时间用 cancel 后新的明确 schedule ID。
4. 现有 App 原生定时任务继续使用 runtime-schedules.json 和 runtime op schedule_event。本版不会自动停用、迁移或重建它们。一个任务仍绑定原生来源时，拒绝再添加运行时计时器，以免双重触发；迁移需先核验旧触发已停止并更新合同。

向 node workflow.mjs schedule op 的 stdin 传 JSON，或用 schedule op --file <file>。以下是格式示例，所有标识及授权证据都必须来自实际实例和用户消息：

```json
{
  "op": "create",
  "id": "runtime:research",
  "task_id": "<registered task ID>",
  "kind": "interval",
  "start_at": "2026-11-06T09:00:00+08:00",
  "interval_ms": 86400000,
  "timezone": "Asia/Shanghai",
  "overlap": "coalesce",
  "source_message_id": "<actual user schedule request>",
  "evidence_ref": "<saved original instruction>",
  "actual_human_verified": true
}
```

一次性任务使用 kind=once 并省略 interval_ms。create 只登记到期事件，不创建 App 对话、定时 automation 或新执行者。运行已有 runtime run/service 即可计时。

## Inspect, pause and cancel

- node workflow.mjs schedule list 列出计划。schedule op 的 get 操作传 id，返回配置及全部轮次。
- pause、resume、cancel 操作传 id、expected_revision、source_message_id、evidence_ref、actual_human_verified。旧 revision 不可覆盖新状态。
- pause 保留尚未接收的 pending 轮次；resume 按原锚点合并漏掉的触发。cancel 将 pending 轮次记为 cancelled，终止后续触发；cancelled/finished 计划不能重新启用。
- **已原子写入任务事件账本的 admitted 轮次属于已接收执行。暂停/取消计划会返回 accepted_runs_preserved，保留这些轮次和原生回执，不中断当前工作。** 如需停止这轮实际工作，使用任务现有暂停/人类指令流程。不能将已投递或不确定的消息重标为未发送。

## Per-run evidence and completion

轮次经过 pending → admitted → running → completed。admitted 只证明事件入账，running 需要真实原生 read_thread 的 begin 证明；等待用户或外部条件时，该轮可以跨多个 wake 持续保持未完成。

checkpoint.schedule_runs 提供当前 run_id 和时刻。用 run_id 组成报告/结果键，记录本轮实际证据。探索 task report 自动绑定当前 run_id；重复使用其他轮次的相同报告键会因内容不一致被拒绝。

本轮完成时 decide disposition=cycle_complete，提交每条验收对应的当前证据，再 finish。运行时将 decision_id、contract/context/plan 版本、验收、证据和实际 wake 保存到本轮结果。cycle_complete 保持计划启用；complete 表示整个任务目标结束，会停止这个任务的后续定时计划，并取消尚未接收的轮次。

创建计划、推进 next_at、生成轮次与写事件使用同一 SQLite 事务，崩溃不会留下已推进时间却没有事件的空洞。原生发送仍使用既有持久回执，不能据队列接收推断执行完成。
