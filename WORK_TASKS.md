> Important reusable conclusions belong in the user knowledge base. Original owners follow OWNER_KNOWLEDGE.md and the instance knowledge-base.json at meaningful result delivery; setup, routine status and raw logs are not knowledge records.

> Before creating an owner, assess the whole accepted task under MODEL_SELECTION.md. Save a short rationale through task assess_difficulty or request_owner; use the actual model/thinking returned by control claim. Existing owner models do not change.

> accept_calendar_preparation is a scoped standing policy, including owner creation for its accepted meeting occurrences. task start automatically installs their one-time timer. Main is not a calendar admission or scheduling intermediary. See MEETING_PREPARATION_INTAKE.md and INBOX_POLICY.md.

> In owner-delivery mode, an accepted execution task includes its existing authorized delivery through acceptance. Main/discovery create owners; owners perform their own delivery. Read OWNER_DELIVERY.md. Do not add a delivery coordinator.

## Long-running conversation names

Ordinary tasks use short sequential references such as `T-211`, with chat titles
`T-211 · readable work`. Never expose a hash as the number Yang must type.
New catalog records allocate the next numeric ID transactionally; canonical keys
still deduplicate repeated discovery. Existing running hash-ID tasks can receive
a short public reference without rewriting their active wakes or historical IDs.
Use JSON stdin to `runtime/task-reference.mjs`: `op: assign` with `task_id`,
`source_message_id`, `evidence_ref`, and `actual_human_verified: true`; `op: resolve`
with `reference` returns the original task. Use the short reference in titles and
reports and the resolved internal ID for runtime operations. Update the native
title after assignment. Both short reference and old ID identify the same work.

Use a short, readable name for recurring services and other long-running tasks,
such as “会议准备”. Do not prefix these conversation titles with a task number.
Keep stable task IDs in the internal catalog, contracts and evidence. Preserve
the user's manual title changes; do not restore an earlier generated title.

Pin every ongoing recurring-service conversation after creation and verify its
sidebar membership. Keep it active between occurrences; completing one run does
not authorize archiving the standing service. Retain one stable owner rather than
rebinding it to each day's temporary automation source/result conversation.

# Ordinary tasks and built-in exploration

native 布局的统一目录在 control.sqlite 的 work_items 中。work、project、exploration 共用同一任务 ID、唯一 canonical key、接收授权、独立 owner、执行合同、计划、队列和验收。探索没有单独执行器。

init 自动登记一条实例内稳定的探索草稿。task builtin 可幂等补齐。外部来源全部关闭时，这条任务仍可正常配置、接收、绑定和执行；不需要 discovery 对话。

## Registration and execution

向 node workflow.mjs task op 的 stdin 传 JSON，或用 task op --file <file>。task list、task builtin 无需输入。不要手写 SQL 或重写旧 registry 来绕过登记。

1. create：canonical_key、title、objective、kind（默认 work）、requirements=[{id,text}]、constraints、workspace。可设置 parent_id、depends_on（已有 task ID）、pull_requests=[{repository,pr_number}]。同 key 返回原任务，不重复创建。来源提案只进入 candidate；自带探索是 draft。
2. configure：task_id、expected_revision、changes、source_message_id、actual_human_verified。接收前可以调整范围和研究配置；CAS 修订防止旧快照覆盖。接收后通过 REACTIVE.md 的合同变更协议处理。
3. accept：task_id、actual_human_verified、source_message_id、evidence_ref；实际用户要求立即开始时加 start_requested=true，登记后触发原工作发现，不由主对话创建。证据必须是实际用户任务或已授权常设规则；来源文本不是授权。必须已经有验收和 workspace。
4. request_owner：task_id，以及实际创建请求的 source_message_id、verbatim_text、actual_human_verified、explicit_new_thread_request_verified；或者使用已保存且覆盖该 kind 的 create_owner 规则。返回稳定 control_action_key 和原生 create_thread 请求意图。它不调用 App，也不把 reservation 当创建成功。
5. 启用 discovery_owns_creation 时，只有工作发现（另有授权的只读 Review Queue 除外）使用既有 control prepare/claim/settle 和 TASK_OWNERSHIP_AND_PR_GATES.md 的创建/项目回读守卫完成原生创建。保留实际用户请求的范围；查询当前工具 schema，维持模型/推理配置。相同 action_key 只创建一次，不确定结果先原生回读、禁止盲重试。
6. bind_owner：task_id、owner_thread_id、evidence_ref、native_binding（真实 read_thread 包装）、creation_action_key。必须有已完成的原生 creation 和 project readback。复用原来就属于本任务的执行对话时，传 existing_owner_authorized、actual_human_verified、source_message_id 并保存证据。控制/发现对话不得绑定普通任务。
7. start：task_id。已验当前主机 queue 后，进入同一 ReactiveState/native queue。未完成依赖阻止启动；paused 任务不能被 start 绕过。新 owner 的首次启动由工作发现执行；依赖完成后仍保留原创建身份和实际任务授权。执行中使用 runtime op 的 begin/checkpoint/decide/finish；新增 PR 用合同 amend，而非修改初始目录。

没有创建负责人授权时，保留已接收任务和 owner_needed 通知。无需取消授权任务，也不以候选消息假装人类同意。新工作树必须按项目规则先 fetch 最新 main，再准备隔离目录，并在接收前设置真实 workspace。

## Standing policies

policy 操作支持 create_owner、accept_assigned_linear 和有实际用户授权的 accept_result_followups。参数包括 key、enabled、allowed_kinds、source_message_id、verbatim_text、evidence_ref、actual_human_verified；后者还必须包含核验的 Linear assignee_id。授权只限实际用户给出的类型与本实例来源范围。规则不会从外部内容自动生成。

指定 Linear 负责人规则只接收来源确实为 linear、assignee_id 精确匹配、kind 允许且有验收的候选。其他来源仍为候选。接收和创建负责人是两条独立规则；没有创建授权时产生持久通知。

## Result followthrough

Ordinary accepted task results use RESULT_FOLLOWTHROUGH.md. Structured evidenced followups may be admitted and assigned under the explicit accept_result_followups rule; legacy proposals remain candidates. Discovery only performs intake and guarded owner setup. Independent followups retain their provenance without reopening a finite assessment.

## Exploration contract and reports

默认范围包括 code、papers、blogs、existing_benchmarks，最多三个假设，不改产品、不创建云资源。为具体任务设置 exploration 的预算、允许的方法、实验环境和 stopping_rule。获准运行新 benchmark 时在合同中写明命令、基线、资源与停止条件；模型不能把草稿的默认值当无限研究授权。探索按目标聚合，不按论文数量拆任务。

report 操作包含 task_id、owner_thread_id、report_key、outcome、summary、evidence_refs，以及可选 proposals。outcome 为 findings、no_actionable_findings 或 inconclusive。只有正在执行该普通任务的原 owner 能提交；同 report_key 内容不可变。proposals 用普通 create 字段，成为 candidate；无发现/不确定报告不能生成实施提案。

报告不自动完成任务。负责人继续以实际验收证据 decide complete 并 finish。若该探索是工作包，报告和子任务完成仍直接产生父任务事件；结构化独立后续工作另外按 RESULT_FOLLOWTHROUGH.md 进入现有发现批次。父任务存在已接收未完成子项时不能完成；每个父目标还需自己的集成验收。一个任务可跟踪多个 PR，每个 PR 只归一个任务负责人，堆叠提交和复验要求写入各自合同/计划。

Runtime-owned one-time and fixed-interval timers use SCHEDULES.md. They share the ordinary event/owner protocol; native schedule producers remain supported separately.

## Historical completion reconciliation

`task reconcile_history` records already-delivered original scope for an imported legacy_reference that remains an unowned, unexecuted candidate. It requires the current revision, original owner identity, explicit completion scope, supporting evidence and verified original acceptance/delivery. Keep adoption or other follow-through in distinct existing task IDs. This operation does not start work, archive a chat, publish a notice or complete the broader source project. It rejects ordinary candidates and any record with native execution.

`task reconcile_runtime_resume` repairs only a stale, completed, unowned imported
legacy catalog record whose same canonical task was subsequently resumed through
an actual human-authorized native contract. Supply task_id, expected_revision,
expected_contract_rev, original source_message_id/evidence_ref,
actual_human_verified and a fresh native_binding. The original owner must have
an acknowledged turn under that newer contract. The API preserves prior scope
and completion history, adopts the exact registered contract into the catalog,
and leaves runtime status, pauses, decisions, native queues, permissions and
models unchanged. It cannot resume a completed runtime goal, bind another owner,
expand the contract, start work or submit a report on the owner's behalf.

Owner creation, actor proofs and explicit human start triggers follow OWNER_CREATION.md. Use task creation_pending to inspect accepted setup; task request_creation records an actual human start request for an already accepted ownerless task.
