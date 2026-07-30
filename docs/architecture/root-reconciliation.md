# Root Reconciliation

状态：Phase 1 目标设计。每个 eligible Root Issue 对应一个独立 ReAct `RootReconcill`，它是 Symphony 唯一的工作流语义决策者。

## 边界

Root identity 在实例创建时绑定。一个实例只处理一个 Root，并独占 private Codex app-server process、thread、accepted observation baseline 和 Root Home；这些资源不能 rebind、share、pool、fork 或跨 Root 复用。

Root Reconcill 接收完整 bootstrap 或最新 concrete diff，解释用户目标、Task Manager facts、Performer results 和 Git facts。它决定要操作哪个 exact Issue/relation、写入哪些字段、调用哪个 Performer，以及何时交付、等待或停止。

## ReAct loop

```text
Observe: RootBootstrap 或相邻 RootFactDiff
Reason:  解释事实并选择一个最小下一步
Act:     调用一个 generic MCP / Performer / Git / Delivery tool
Observe: typed result 与 fresh read-back
...直到 quiescent、stopped、timed_out 或 canceled
```

每次 tool call 都携带当前 runtime generation、correlation、exact target identity 和 capability。Conductor 只验证 schema、identity ownership、generation、capability 和 fresh precondition，不解释调用是否符合某个 Symphony lifecycle。

## Tool surface

Root thread 只获得以下 capability-scoped tools：

- [Task Manager generic MCP functions](task-management.md#generic-mcp-functions)。
- `plan`、`work`、`verify` Performer calls。
- [generic Git 与 Delivery functions](git-worktree-delivery.md#generic-tools)。

Root thread 不获得 Linear 原生 skill、provider SDK、shell、credential 或未声明的内部函数。Task Manager tools 不包含任何 Symphony 领域命令；Root Reconcill 的决定通过一组 exact generic calls 体现，而不是返回 lifecycle enum 给 Conductor 执行。

## Cycle decision

Cycle 第一版不是不可变计划。每次 fresh Root/Cycle/sub-Issue/relation 变化到达时，Root Reconcill 根据当前目标自行选择：

| 选择 | Root Reconcill 的行为 |
|---|---|
| 没有 active Cycle | 创建一个 Cycle Issue，调用 Plan，并用 generic MCP 创建/连接精确的 Stage Issues |
| 继续当前 Cycle | 保留 Cycle identity；按需要更新确切子 Issue/关系，或继续调用 ready Performer |
| 关闭并重跑 | 先把当前 Cycle 及仍 active 的 Stage 更新为 terminal 并 fresh read-back；再创建 successor Cycle、重新 Plan 和重建其子图 |
| 等待 | 不发 mutation，结束为 `quiescent`，等待下一次 changed observation |
| 无法安全继续 | 结束为 `stopped`，给出 sanitized、可操作原因 |

Conductor 不实现上述选择，也不根据 diff 自动取消、修复或重建 Cycle。terminal Cycle 是历史事实，不重新打开；successor 是新 identity。任意时刻最多一个 active Cycle，创建 successor 前必须 fresh read 确认旧 Cycle 已 terminal。

## Conflict handling

fresh precondition 失败表示 Root 推理后外部事实又变化了。tool 返回 `precondition_failed` 和新的 concrete facts，Root Reconcill 重新 Observe/Reason；这不是异常 restart，也不终止 Conductor。`acceptance_unknown` 必须先对同一 identity fresh read，不能直接重复写入。

每轮有明确的 tool/时间预算。预算耗尽、连续无法形成完整 snapshot 或 capability/schema 违规时 fail closed，并把 Root 保留在实际外部状态；不得进入隐藏 retry loop。

## 禁止行为

Root Reconcill 不得绕过 MCP/Performer/Git/Delivery tools，不得访问 provider credential 或 private implementation，不得把 transcript、proposal、tool receipt、diff、next action 当作持久事实，也不得要求 Conductor 执行未在 generic tool schema 中声明的领域动作。
