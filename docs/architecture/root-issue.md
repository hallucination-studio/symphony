# Root Issue 模型

状态：Phase 1 目标设计。本文只定义 Task Manager 中持久化的 Symphony 工作流事实；这些事实由 Root Reconcill 通过 generic MCP functions 读取和修改。

## 结构

```text
Root Issue
└── Cycle Issue 1 (active or terminal)
    ├── Plan Issue
    ├── Work Issue 1
    ├── Work Issue 2
    └── Verify Issue
└── Cycle Issue 2 (successor, when replanned)
```

Root 是用户需求和最终 PR 的单位。Cycle 是完成该需求的一次尝试。Plan、Work、Verify 是对应 Cycle 的直接子 Issue，并使用：

```text
symphony:kind/root
symphony:kind/cycle
symphony:kind/plan
symphony:kind/work
symphony:kind/verify
```

Task Manager 原生 Issue identity 是唯一标识。description 只保存人可读内容，不保存 hidden Symphony JSON、Handoff/result、diff、correlation 或 runtime state。

## Lifecycle facts

```text
Root:  Todo -> In Progress -> In Review -> Done
Cycle: Planning -> Executing -> Verifying -> Succeeded
       Planning | Executing | Verifying -> Canceled
Stage: Todo -> In Progress -> Done | Failed | Canceled
```

这些状态是 Root Reconcill 可观察和修改的 Task Manager facts，不是 Conductor 内部状态机。Root Reconcill 通过 `list_states` 得到 exact provider state identity，再通过 generic `create_issue`/`update_issue` 表达所选 transition。Conductor 只执行 fresh precondition 与 read-back。

- 未委托给配置 agent actor 的 Root 不执行。
- 一个 Root 任意时刻最多有一个 active Cycle。
- active Cycle 指状态为 `Planning | Executing | Verifying` 的非 archived Cycle。
- terminal Cycle 指 `Succeeded | Canceled`；terminal Cycle 保留为历史事实，不 reopen。
- `Done | Failed | Canceled` Stage 不 reopen。需要重新执行时创建 successor Cycle 中的新 Stage identity。
- Root 只有在 exact verified revision 已交付并 read-back 后才能进入 `In Review`。
- Root `Done` 只由用户或外部流程设置；Symphony 不自动 merge 或设置 `Done`。

## Mutable active Cycle

Cycle 第一版允许在 active 期间变化。Root、Cycle、任一 sub-Issue 或 relation 的 fresh diff 到达后，Root Reconcill 可以：

1. **继续当前 Cycle**：保留 Cycle identity，更新精确 Issue 的 title、description、status、labels、delegate、priority 或 parent，并创建/删除精确 relation；也可以增加新 Stage 或 archive 尚未采用的 Stage。
2. **关闭并重跑**：先将仍 active 的 Stage 与当前 Cycle 更新为 terminal，fresh read 确认当前 Root 已无 active Cycle，再创建新 Cycle identity，调用 Plan 并创建新的 Stage/DAG。
3. **等待或停止**：不改写外部事实，等待更多输入或给出无法安全继续的原因。

是否选择其中任何一项只属于 Root Reconcill。Conductor 不从 change type、Stage status、DAG 或 Performer result 推导选择，也不自动修补任务图。

创建 successor 前必须 fresh read 确认旧 active Cycle 已 terminal；若 precondition 已变化，Root Reconcill 接收实际 diff 后重新决定。successor 可以用普通 relation 指向 predecessor，但 Task Manager MCP 不理解 relation 的 Symphony 含义。

## Plan and Work DAG

Plan Performer 返回 task proposal，不写 Task Manager。Root Reconcill 根据 proposal 使用 generic MCP 创建并 read-back：

1. 一个 Plan Issue。
2. 至少一个 Work Issue 和一个 Verify Issue。
3. 完整、无环的 Work dependency relations。
4. Verify 对全部 required Work 的 dependency relations。

active Cycle 的 required Work 是该 Cycle 下全部且仅有的、未 archived、parent 直接指向该 Cycle、kind 为 `symphony:kind/work` 且 identity 唯一的 Work Issues。一个 Work 只有在自身为 `Todo` 且全部 dependency Work 为 `Done` 时语义上 ready；该判断由 Root Reconcill 完成。

Root Reconcill 可以在继续 active Cycle 时改变 Work 集合或 relations，但每次修改后都必须基于 fresh complete snapshot 重新判断 DAG。全部 required Work 为 `Done` 后，它才调用 generic Git tool 创建 immutable commit 并调用 Verify。

## Fact authority

Task Manager 的 Issue、status、parent、label、delegate、priority、relation 和 description 是任务事实；Git 的 worktree、diff、commit、remote ref 和 PR 是交付事实。Performer proposal/result、MCP receipt、polling cursor/event、model transcript 和 in-memory diff 都不是持久事实。

任何人或外部自动化对 Root Tree 的修改都由下一次 scheduled fresh poll 观察，以完整 snapshot 为准形成具体相邻 diff 交给 Root Reconcill；历史 polling event 本身不作为 action replay。
