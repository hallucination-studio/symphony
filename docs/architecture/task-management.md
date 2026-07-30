# Task Management

状态：Phase 1 目标设计。本文拥有 Task Manager 的 provider-neutral 边界、定时 Root Tree observation、fresh snapshot/diff 和 MCP tool surface。Linear 是第一版唯一 provider implementation。

## 两个边界

Task Manager 集成拆成两个互不替代的边界：

| Boundary | 输入 | 输出 | 职责 |
|---|---|---|---|
| `TaskManageObserver` | bounded scheduled tick | `TaskObservationEvent` | fresh read Root inventory/Tree，检测具体事实变化并发出完整观察 |
| `TaskManageCommand` | generic MCP function call | typed result + fresh read-back | 查询或修改 Issue graph，不解释 Symphony workflow |

Symphony 是没有公网 ingress 的本地客户端，因此 Phase 1 不依赖 Linear webhook。`TaskManageObserver` 是唯一 intake：进程启动后立即执行一次 observation，此后按配置的有界间隔串行 fresh poll。每个 tick 从配置 team 中不按 delegate/status 预过滤的 Root inventory，以及已有 polling baseline 的 Root identity 开始，读取完整 Root Tree；这样 delegation/status 的移除和 inventory 变化仍可观察。provider cursor、`updatedAt` 或局部 Issue 不得代替完整 snapshot。

```text
bounded scheduled tick
-> fresh Root inventory + complete Root Tree snapshots
-> canonicalize and compare with the prior polling observation
-> unchanged: emit nothing
-> first/change: emit TaskObservationEvent(current complete snapshot + concrete task changes)
-> coalesce by Root to the latest complete observation
```

polling observation baseline 只用于判断是否应发事件，且仅在某个 Root 的完整 poll 成功后前进；读取不完整或失败时保留旧 baseline 并在下个 tick 重试，不发猜测 diff。事件必须携带当前完整 snapshot 和 digest，不能只携带一步 diff，否则串行调度期间的事件合并会丢失事实。事件中的 changes 和 from/to digest 描述 observer 相邻两次成功 poll；事件被合并后，`from_task_digest` 不要求等于 runtime 已接受的 digest。Conductor 另行维护 runtime accepted baseline，并在消费最新事件时从 accepted baseline 到事件 snapshot 重新计算 Root-facing diff；polling baseline 不能替代 accepted baseline。

未委托给配置 agent actor 的 Root 不会进入执行槽；delegation 的新增、移除或变化由下一次 fresh poll 观察，实际 eligibility 由事件中的完整 snapshot 在 admission 时确认。Phase 1 不提供 webhook fallback、增量 cursor intake、provider event replay 或第二条 observation path。

## Snapshot 与具体 diff

`TaskSnapshot` 是某个 Root 在一个时点的规范化完整任务图，包含 Root、其 Cycle/Stage descendants、相关 relations，以及这些对象的 identity、revision、status、title、description、parent、labels、delegate 和 priority。SDK object、poll cursor、credential 和任意 provider metadata 不得进入 snapshot。

首次运行或 restart 向 Root Reconcill 发送完整 `RootBootstrap`。之后，Conductor 只比较相邻两个 accepted snapshot，生成 closed concrete diff：

```text
issue_created
issue_archived
field_changed: status | title | description | parent | labels | delegate | priority
relation_added
relation_removed
```

diff 只陈述 before/after 事实，不生成 `work_ready`、`cycle_invalid`、`next_action`、`should_continue` 或 `should_replan` 等派生结论。Root Reconcill 独自解释这些变化。无法形成唯一、完整 snapshot 时，Conductor 暂停该 Root 并报告 sanitized boundary error，不猜测缺失事实。

## Generic MCP functions

`TaskManageCommand` 以 MCP tools 暴露通用资源操作。函数名与 schema 不含 Root/Cycle/Plan/Work/Verify 语义：

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

Conductor 为当前 Root 托管或路由 capability-scoped MCP session，Root Codex thread 只连接这组 declared schemas。MCP transport 后面的 Linear implementation 保持 private；Root 不直连 provider。generation、Root ownership、correlation 和 capability 在每次 call 上由 Conductor fence。

所有 list 函数必须显式分页并返回稳定 cursor。调用使用 provider-neutral identity；创建/更新只接受可列举字段。`update_issue` 是 partial update，未提供字段保持不变。mutation 必须携带调用者刚读取到的 target revision 或等价 precondition；关系 mutation 同时约束两个 endpoint identity 和 relation revision（如有）。

Root Reconcill 自己选择确切函数、target Issue、relation、字段和值。例如“关闭当前 Cycle 并重跑”由一组普通 `update_issue`、`create_issue`、`create_relation` 与 Performer calls 表达，不存在一个对应的 Symphony 领域命令。

## Mutation result

每次 mutation 都执行 fresh precondition，并在 provider 调用后 fresh read-back：

```text
applied | not_applied | precondition_failed | acceptance_unknown | readback_mismatch
```

结果包含 correlation、目标 identity、sanitized reason 和可安全返回的 fresh resource/diff。`precondition_failed` 表示目标在 read 与 write 之间发生了正常变化；它必须返回 Root Reconcill 重新推理，不能终止 Conductor 进程。`acceptance_unknown` 只能通过同一 identity 的 fresh read 判定，不能盲目重试 mutation。

accepted baseline 只在 Root Reconcill 接受 fresh observation 后前进。MCP response、provider mutation receipt 或 model transcript 都不是任务事实。

## Provider boundary

Linear SDK、OAuth token、workspace/team objects、raw state/label records 和 provider error 只存在于 private Linear implementation。所有外部数据在边界处验证并规范化；所有错误在离开边界前 sanitize。

Codex 不获得 Linear 原生 skill、SDK、token 或任意未声明 provider operation。Phase 1 只有一个 Linear polling implementation 和一个 Linear-backed Task Manager MCP implementation；不提供 webhook、compatibility adapter、fallback command、dual path 或 migration behavior。
