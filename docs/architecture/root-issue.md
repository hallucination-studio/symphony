# Root Issue 模型

状态：Phase 1 目标设计。本文只定义 Linear 中持久化的工作流事实。

## 结构

```text
Root Issue
└── Cycle Issue
    ├── Plan Issue
    ├── Work Issue 1
    ├── Work Issue 2
    ├── ...
    └── Verify Issue
```

Root 是用户需求和最终 PR 的单位。Cycle 是完成该需求的一次尝试。Plan、Work、Verify 是 Cycle 的直接子 Issue，并分别使用以下 kind label：

```text
symphony:kind/root
symphony:kind/cycle
symphony:kind/plan
symphony:kind/work
symphony:kind/verify
```

Linear 原生 Issue ID 是唯一标识。description 只保存人可读内容，不保存 Symphony JSON、隐藏标记、Handoff、diff 或运行时状态。

Conductor 创建的空 Cycle shell 使用固定 title `Symphony Cycle`。title 不从 Root
title/description、模型输出、运行配置或任意 metadata 推导，也不编码 identity、attempt、
runtime state 或 correlation；Cycle identity 仍只使用 Linear 原生 Issue ID。

## 生命周期

```text
Root:  Todo -> In Progress -> In Review -> Done
Cycle: Planning -> Executing -> Verifying -> Succeeded
       Planning | Executing | Verifying -> Canceled
Stage: Todo -> In Progress -> Done | Failed | Canceled
```

- 一个 Root 最多有一个 active Cycle。
- `Todo` 是 Plan、Work、Verify 唯一可执行状态；terminal Stage 不重开或重跑。
- 当前 Cycle 失效时，先将它设为 `Canceled`，再创建 successor Cycle。
- 只有已验证 commit 创建 PR 后，Root 才能进入 `In Review`。
- `Done` 由用户或外部流程在 Linear 中确认，Symphony 不自动设置。

### Mechanical transition table

| Object | From -> To | 唯一触发事实 |
|---|---|---|
| Root | `Todo -> In Progress` | Root 被 admit，且 Cycle shell 已创建并回读成功 |
| Cycle | create as `Planning` | admitted Root 没有 active Cycle，且 `StartCycle` 通过 fresh precondition |
| Plan | `Todo -> In Progress` | Plan tool dispatch 前 fresh facts 仍满足 target/parent/kind/status |
| Plan | `In Progress -> Done` | Plan Handoff 为 `completed`，且 fresh read 得到唯一合法 Plan、至少一个 Work、唯一 Verify 和完整 DAG |
| Cycle | `Planning -> Executing` | Plan 为 `Done` 且 fresh DAG 合法 |
| Work | `Todo -> In Progress` | Work tool dispatch 前自身为 `Todo`，且全部依赖 Work freshly `Done` |
| Work | `In Progress -> Done` | Work Handoff 为 `completed`，且 fresh Linear read 为 `Done` |
| Cycle | `Executing -> Verifying` | 全部 required Work freshly `Done`，immutable commit 已创建且 revision 回读一致 |
| Verify | `Todo -> In Progress` | Verify tool 的 revision 等于 fresh HEAD 和 Cycle immutable revision |
| Verify | `In Progress -> Done` | Verify Handoff 为 `passed`，且 revision 和 fresh Git facts 一致 |
| Cycle | `Verifying -> Succeeded` | Verify freshly `Done` 且 verified revision 被接受 |
| Root | `In Progress -> In Review` | 同一 verified revision 已 push，唯一 PR read-back 的 head 相同 |
| Any active Stage | `In Progress -> Failed` | 对应 Handoff 为 `failed` 或 `inconclusive`，且该 terminal status 写入并回读成功 |
| Any active Stage | `Todo | In Progress -> Canceled` | `CloseCycleAndReplan` 或 shutdown cancellation 已被 fresh precondition 接受并回读 |
| Active Cycle | `Planning | Executing | Verifying -> Canceled` | 当前 Stage 已 terminal/canceled，且 `CloseCycleAndReplan` 通过 fresh precondition |
| Root | `In Review -> Done` | 仅由用户或外部流程写入，Conductor fresh read 后只执行回收 |

timeout、boundary unavailable、`acceptance_unknown`、`precondition_failed` 和
`readback_mismatch` 本身都不推进 lifecycle。Conductor fresh read 后将实际 observation
交给 `RootReconcill`；无法证明 terminal mutation 已发生时保持当前事实并 fail closed。
`canceled` Handoff 只有在 Stage `Canceled` 被 fresh read 确认后才是 terminal。

## Plan 与 DAG

Conductor 只创建空 Cycle。Plan Performer 负责在 Linear 中创建并回读：

1. 一个已完成的 Plan Issue。
2. 至少一个 Work Issue 和一个 Verify Issue。
3. 完整、无环的 Work 依赖关系。
4. Verify 对全部 required Work 的依赖关系。

Conductor 不从 Plan 文本生成或修补 DAG，只重新读取并验证 parent、kind、status 和 relation。

当前 active Cycle 的 **required Work** 是该 Cycle 下全部且仅有的、parent 直接指向该
Cycle、带 `symphony:kind/work` 且 identity 唯一的 Work Issue。Plan Handoff 中的
`work_issue_ids` 必须与这个 fresh read 集合完全相等；集合外的 Issue 不能被暗中忽略，
集合内的 Issue 也不能因 Handoff 缺失而变为 optional。任一 Work kind/parent/identity
含糊、依赖指向 Cycle 外或依赖图不完整/有环时，Plan 不可接受并关闭 Cycle 后重新 Plan
或停止。

一个 Work 只有在自身为 `Todo` 且全部依赖 Work 为 `Done` 时才能执行。全部 required Work 为 `Done` 后，Conductor 才能创建 commit 并调用 Verify。

## 事实权威与变化

Linear 的 Issue、status、parent、label、relation 和 description 是工作流事实；Git 的 worktree、diff、commit 和 PR 是代码交付事实。

Linear 或 Git 发生变化后，Conductor 重新读取当前值并计算内存 diff。`RootReconcill` 决定继续当前 Cycle、关闭后重新 Plan，或停止。Conductor 不解释变化，也不把历史事件重放为动作。
