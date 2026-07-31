# Task Management

状态：Phase 1 目标设计。本文拥有 Task Manager 的 provider-neutral 边界、定时 Root Tree observation、fresh snapshot/diff，以及 Root semantic boundary 与 Conductor mechanical boundary 的 capability rules。Linear 是第一版唯一 provider implementation。

## 两个边界

| Boundary | 输入 | 输出 | 职责 |
|---|---|---|---|
| `TaskManageObserver` | bounded scheduled tick | `TaskObservationEvent` | fresh read Root inventory/Tree，检测具体事实变化并发出完整观察 |
| `TaskManageCommand` | capability-scoped generic function call | typed result + fresh read-back | 查询或修改 Issue graph，并在边界处强制 caller authority |

Symphony 是没有公网 ingress 的本地客户端，因此 Phase 1 不依赖 Linear webhook。`TaskManageObserver` 是唯一 intake：进程启动后立即 observation，此后按配置的有界间隔串行 fresh poll。每个 tick 从不按 delegate/status 预过滤的 Root inventory 和已有 polling baseline 开始读取完整 Root Tree；这样 delegation/status 的移除发生时仍可观察。provider cursor、`updatedAt` 或局部 Issue 不得代替完整 snapshot。

```text
bounded scheduled tick
-> fresh Root inventory + complete Root Tree snapshots
-> canonicalize and compare with prior polling observation
-> unchanged: emit nothing
-> first/change: emit current complete snapshot + concrete changes
-> coalesce by Root to latest complete observation
```

polling observation baseline 只用于判断是否发事件，且仅在完整 poll 成功后前进；它不能替代 runtime accepted baseline。失败时保留旧 baseline。事件必须携带当前完整 snapshot 和 digest，不能只携带一步 diff。事件合并后，`from_task_digest` 不要求等于 runtime 已接受的 digest；Conductor 从 runtime accepted baseline 到最新完整 snapshot 重新计算 Root-facing diff。

未委托给配置 actor 的 Root 不进入执行槽。Phase 1 不提供 webhook fallback、增量 cursor intake、provider event replay 或第二条 observation path。

## Snapshot 与 concrete diff

`TaskSnapshot` 是某个 Root 在一个时点的规范化完整任务图，包含 Root、Cycle/Stage descendants、relations，以及 identity、revision、status、title、Markdown description、parent、labels、delegate 和 priority。SDK object、poll cursor、credential 和任意 provider metadata 不得进入 snapshot。

首次运行或 restart 向 Root Reconcill 发送完整 `RootBootstrap`。之后，Conductor 比较相邻 accepted snapshots，生成 closed concrete diff：

```text
issue_created
issue_archived
field_changed: status | title | description | parent | labels | delegate | priority
relation_added
relation_removed
```

diff 不携带 `should_replan`、架构建议或 successor design。Root Reconcill 在 semantic boundary 解释需求事实；Conductor Cycle machine 可以根据 typed status、identity、relation 和 seal digest 计算机械 readiness，但不得从 description 文本推导 decision。无法形成唯一完整 snapshot 时 fail closed。

## Generic functions

`TaskManageCommand` 只实现 provider-neutral 资源操作：

```text
get_issue
list_issues
list_children
create_issue
update_issue
archive_issue
list_relations
create_relation
delete_relation
list_states
list_labels
```

函数名与 schema 不含 Plan/Work/Verify 执行命令。Root thread 通过 capability-scoped MCP 连接 approved generic schemas；Conductor Cycle machine 从 private typed interface 调用相同资源操作；Performer 不连接该 boundary。Linear implementation、SDK 和 credential 保持 private。

所有 list function 显式分页并返回稳定 cursor。mutation 必须带 caller capability、exact identity、fresh expected revision 或等价 precondition；关系 mutation 同时约束 endpoints 和 relation revision。`update_issue` 是 strict partial update。

## Capability matrix

| Caller | 允许 | 拒绝 |
|---|---|---|
| Root Define/Draft | 更新 Root description/ADR，创建和修正一个 Cycle Draft，review 后把 exact Draft 设为 `In Progress` | 写用户代码、创建 Stage、修改其他 Root、修改 approved Cycle |
| Root Acceptance | 对 `Awaiting Acceptance` exact Cycle 写 `Succeeded | Rejected` 和 bounded Markdown reason；terminal 后创建 successor Draft | 修改 sealed description/DAG、重开 terminal Cycle、执行 Stage |
| Conductor Cycle machine | 在 approved Cycle 创建一个 Plan；一次性物化 PlanResult 的 Work/Verify/DAG；按 closed table更新 statuses | 修改 Root/ADR/Cycle specification，重写 Stage description，改变 sealed graph，创建 successor |
| Performer | query/mutation capability 均为空 | 任何 Task Manager access |

capability 在每次 call 上绑定 Root/Cycle identity、runtime generation、correlation 和允许字段。不存在一个模型可调用的 aggregate lifecycle command；domain transition 只能由 Root boundary 的 exact generic mutation或 Conductor private state machine的一组 exact generic mutations体现。

外部修改 sealed Cycle/Stage description 或 relation不会成为合法扩展。fresh observer 可以报告该事实，但 Cycle machine 必须以 `sealed_spec_changed | execution_graph_invalid` fail closed，而不是吸收变化或让 Root 在当前 Cycle 中调整。

## Mutation result

每次 mutation 都执行 fresh precondition，并在 provider 调用后 fresh read-back：

```text
applied | not_applied | precondition_failed | acceptance_unknown | readback_mismatch
```

结果包含 correlation、target identity、sanitized reason 和可安全返回的 fresh resource/diff。Root call 的 `precondition_failed` 回到 Root Reconcill 重新推理；Cycle-machine call 的 `precondition_failed` 触发一次 fresh state recomputation，无法得到同一 seal 下唯一合法 transition 就 terminally fail。`acceptance_unknown` 只能通过同一 identity 的 fresh read判定，不能盲目重试。

runtime accepted baseline 只在消费者接受 fresh observation 后前进。MCP response、provider mutation receipt 或 model transcript 都不是任务事实。

## Provider boundary

Linear SDK、OAuth token、workspace/team objects、raw state/label records 和 provider error 只存在于 private Linear implementation。所有外部数据在边界处验证并规范化；所有错误在离开边界前 sanitize。

Codex 不获得 Linear 原生 skill、SDK、token 或未声明 provider operation。Phase 1 只有一个 Linear polling implementation 和一个 Linear-backed command implementation；不提供 webhook、compatibility adapter、fallback command、dual path 或 migration behavior。
