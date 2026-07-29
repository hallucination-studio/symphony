# Root Reconciliation

状态：Phase 1 目标设计。每个 Root Issue 对应一个独立的 ReAct `RootReconcill`。

## 边界

Root identity 在实例创建时绑定。一个实例只处理一个 Root，并独占自己的 private `CodexReconcill`、app-server process、thread、observation baseline 和 Root Home；这些资源不能 rebind、share、pool、fork 或跨 Root 复用。

`RootReconcill` 接收完整 bootstrap 或最新 Linear / Git diff，解释当前事实，并选择如何推进用户目标。它是系统中唯一做这类语义决策的角色。

## ReAct loop

```text
Observe: 完整 bootstrap 或实际 diff
Reason:  判断当前 Root 应如何推进
Act:     调用 plan | work | verify，或返回 RootDecision
Observe: Handoff 校验结果和重新读取后的实际 diff
```

Root 通过 Conductor 提供的 tools 间接调用 Performer：

```text
plan(cycle_issue_id)
work(work_issue_id)
verify(verify_issue_id, revision)
```

Conductor 在 dispatch 前重新读取事实，校验目标属于当前 Root、状态允许执行、Work 已 ready、Verify revision 匹配。tool handler 不做语义推理。

## RootDecision

Phase 1 的决策集合是 closed union：

- `StartCycle`：当前没有 active Cycle，创建 Cycle shell。
- `ContinueCycle`：接受变化，继续当前 Cycle。
- `CloseCycleAndReplan`：取消当前 Cycle，创建 successor Cycle。
- `DeliverVerifiedRevision`：交付已验证 revision 并将 Root 设为 `In Review`。
- `Wait`：当前没有可执行动作，等待新事实。
- `Stop`：无法安全继续，停止并给出可见原因。

Conductor 用最新事实再次校验决策前置条件。校验失败时不执行原决策，只返回新的实际 diff。

## 禁止行为

`RootReconcill` 不得生成 Plan 或 DAG、修改代码、执行 Verify、直接调用 Linear / Git、commit、push 或创建 PR。它也不得绕过三个 Performer role，或把 model transcript、Handoff、next action 当作持久事实。
