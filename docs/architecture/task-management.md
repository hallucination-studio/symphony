# Task Management

状态：Phase 1 目标设计。本文拥有 Task Manager 的 provider-neutral 边界、webhook ingress、fresh snapshot/diff 和 MCP tool surface。Linear 是第一版唯一 provider implementation。

## 两个边界

Task Manager 集成拆成两个互不替代的边界：

| Boundary | 输入 | 输出 | 职责 |
|---|---|---|---|
| `TaskManageWebhook` | provider webhook request | `WakeRoot` | 验证来源、去重、解析受影响 identity，并唤醒对应 Root |
| `TaskManageCommand` | generic MCP function call | typed result + fresh read-back | 查询或修改 Issue graph，不解释 Symphony workflow |

Linear webhook payload 不是任务事实，也不直接进入 Root prompt。`TaskManageWebhook` 可以使用 payload 中的 provider event/Issue identity 定位 Root，但必须通过 fresh query 验证 ancestry、delegation 和当前值。重复事件只产生幂等 wake；Phase 1 不增加 polling、event replay 或第二条 intake path。

```text
Linear webhook
-> validate signature and event identity
-> resolve affected Root from fresh provider reads
-> enqueue/coalesce WakeRoot(root_id)
-> Conductor serially reads a complete snapshot
```

未委托给配置 agent actor 的 Root 不会进入执行槽；delegation 的新增、移除或变化只负责唤醒，实际 eligibility 由 fresh snapshot 确认。

## Snapshot 与具体 diff

`TaskSnapshot` 是某个 Root 在一个时点的规范化完整任务图，包含 Root、其 Cycle/Stage descendants、相关 relations，以及这些对象的 identity、revision、status、title、description、parent、labels、delegate 和 priority。SDK object、raw webhook、credential 和任意 provider metadata 不得进入 snapshot。

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

Linear SDK、webhook payload、OAuth token、workspace/team objects、raw state/label records 和 provider error 只存在于 private Linear implementation。所有外部数据在边界处验证并规范化；所有错误在离开边界前 sanitize。

Codex 不获得 Linear 原生 skill、SDK、token 或任意未声明 provider operation。Phase 1 只有一个 Linear webhook implementation 和一个 Linear-backed Task Manager MCP implementation；不提供 compatibility adapter、fallback command、dual path 或 migration behavior。
