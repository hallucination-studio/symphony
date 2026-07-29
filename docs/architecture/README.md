# Symphony Phase 1 架构

状态：目标架构提案。本文定义第一期要实现的产品边界，不表示当前代码已经完成迁移。

## 唯一目标

用户创建一个 Linear Root Issue，Symphony 将它交付为一个可审查的 PR：

```text
Root Issue
-> Conductor 创建 Cycle
-> Plan 在 Linear 中创建 Plan、Work*、Verify 和 Work DAG
-> Work 按 DAG 修改代码
-> Conductor 创建 commit
-> Verify 验证该 commit
-> Conductor push 并创建 PR
-> Root 进入 In Review
```

Phase 1 的产品是这条自主开发闭环，不是通用智能项目管理平台。

## 核心分工

| 角色 | 负责 | 不负责 |
|---|---|---|
| Linear / Git | 保存工作流事实与代码交付事实 | 保存模型会话或下一步决策 |
| Conductor | 重新读取事实、计算内存 diff、串行调度、管理 worktree、commit、push 和 PR | 理解需求、制定 Plan、写代码或判断验证结果 |
| `RootReconcill` | 根据最新事实决定继续 Cycle、关闭后重新 Plan、交付、等待或停止 | 亲自执行 Plan、Work、Verify，或直接操作 Linear / Git |
| Plan / Work / Verify Performer | 分别规划、编码和验证，并返回 typed Handoff | 决定 Root 的下一步或把 Handoff 当成事实 |

Conductor 是静态、机械的状态机。每个 Root 有一个独立的 `RootReconcill`，它是系统中唯一解释需求变化并决定下一步的 ReAct 角色。

## 一次推进

```text
Conductor 重新读取 Linear + Git
-> 计算完整 bootstrap 或相对上次已接受事实的内存 diff
-> RootReconcill 选择 plan | work | verify，或返回 RootDecision
-> Conductor 校验前置条件并执行一个机械动作
-> Performer 返回 Handoff
-> Conductor 再次读取 Linear + Git
-> 将实际 diff 交回 RootReconcill
```

Handoff 只是一次调用的 typed response，不是事实。任何 Linear / Git 写入只有在 Conductor 重新读取并确认后才能驱动下一步。需求或执行事实发生变化时也走同一条路径；Conductor 不解释变化，也不自动修复 DAG。

## Phase 1 边界

| 方面 | 做 | 不做 |
|---|---|---|
| 交付 | 一个 Root 生成一个已验证 PR，并进入 `In Review` | 自动 merge、自动设为 `Done`、处理 PR review/rejection |
| 工作流 | 一个 Cycle 内依次执行 Plan、DAG Work、exact-commit Verify | Human Action、Finding、审批、waiver |
| 执行 | 同一 Cycle 的 Work Item 共用一个 Work thread，逐 turn 完成 | Work subagent、并行 Work、多个 writer |
| 调度 | 一个 Conductor 串行处理多个 Root | 并发 Root、抢占、公平调度、多个 Conductor |
| 运行时 | 每个 Root 独占 Root Reconcill、private Codex Reconcill、process、thread 和 Root Home | 共享、池化、fork 或跨 Root 复用这些资源 |
| 持久化 | Root Home 的 `state.json` 只保存 thread continuity | workflow SQLite、queue、checkpoint、DAG mirror、next action、Handoff 或 diff 持久化 |
| 集成 | Linear、Git 和 Codex CLI `app-server` | Provider SDK、第二 Provider、Profile UI、Podium workflow UI |
| 恢复 | 重启后重新读取事实；无法证明安全时停止并给出原因 | 复杂 replay/repair、自动重建 worktree、精确 cost 恢复 |

Root 使用程序管理的独立 Root Home；Plan、Work、Verify 使用用户提供的另一个 Performer Home。Root 进入 `In Review` 后保留运行时；Linear 确认 `Done` 后，Conductor 先停止并隔离该 Root 的进程、turn 和迟到输出，再删除对应 Root Home。Performer Home 不受影响。

## 文档所有权

- [Root Issue](root-issue.md)：Linear 中的 Root、Cycle、Stage 和 DAG 事实。
- [Conductor](conductor.md)：机械状态机、串行调度和 per-Root runtime 生命周期。
- [Root Reconciliation](root-reconciliation.md)：Root ReAct 的输入、工具、决策和禁止行为。
- [Performer](performer.md)：Codex CLI、双 Home、三个 role 和 thread 隔离。
- [Git Worktree Delivery](git-worktree-delivery.md)：worktree、commit、exact-revision verify、push 和 PR。
- [Contracts](contracts.md)：模块接口、typed Handoff 和重新读取规则。
- [Roadmap](roadmap.md)：实施顺序和 Phase 1 完成标准。

Phase 1 的范围与非目标只由本文定义。其他文档只描述各自拥有的设计，不重复扩展产品范围。
