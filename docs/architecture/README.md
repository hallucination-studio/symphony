# Symphony Phase 1 架构

状态：目标架构提案。本文定义第一期要实现的产品边界，不表示当前代码已经符合该设计，也不隐含任何迁移或兼容方案。

## 唯一目标

用户把一个 Linear Root Issue 委托给配置的 agent actor 后，Symphony 将它交付为一个可审查的 PR：

```text
Task Manager 定时 fresh poll Root Tree 并产生观察事件
-> Conductor 从最新完整 snapshot 产生相对 accepted baseline 的具体事实 diff
-> Root Reconcill 通过 ReAct 决定下一步
-> Root Reconcill 调用通用 Task Manager MCP、Performer、Git 或 Delivery tool
-> Conductor 执行机械边界工作并 fresh read-back
-> Root Reconcill 继续当前 Cycle，或关闭它并创建 successor Cycle
-> exact revision 通过 Verify 后交付 PR
-> Root 进入 In Review
```

未委托给配置 actor 的 Root 不执行。Phase 1 的产品是这条自主开发闭环，不是通用智能项目管理平台。

## 核心分工

| 角色 | 负责 | 不负责 |
|---|---|---|
| Task Manager / Git | 保存任务图与代码交付事实 | 保存模型会话、diff 或下一步决策 |
| `TaskManageObserver` | 定时 fresh read Root Tree，检测事实变化并发出完整观察事件 | 依赖公网 webhook、解释变化或决定工作流动作 |
| Task Manager MCP | 暴露 provider-neutral 的 Issue、关系、状态与标签查询/写入函数 | 暴露 Symphony 生命周期命令或解释 Cycle |
| Conductor | 串行调度、fresh snapshot、相邻事实 diff、runtime 隔离、MCP fencing、读回与进程生命周期 | 解释需求、选择 Issue mutation、决定继续或重跑 Cycle |
| `RootReconcill` | 解释最新事实，选择精确 tool call，并独占所有工作流与 Cycle 决策 | 绕过工具边界、把 transcript 或 tool result 当作持久事实 |
| Plan / Work / Verify Performer | 分别返回规划、代码执行和验证的 typed result | 修改 Task Manager 或决定 Root 的下一步 |

Root Reconcill 是唯一的语义决策者。Conductor 是机械执行器，不包含 Root/Cycle/Stage 领域状态机。

## 一次推进

```text
startup/polling Task observation
-> fresh Git snapshot，并以最新完整 Task snapshot 对齐 accepted baseline
-> 完整 bootstrap 或相对 accepted baseline 的具体相邻 diff
-> Root Reconcill ReAct turn
-> 一个通用 tool call
-> fresh precondition、执行、fresh read-back
-> typed tool result 回到同一个 Root Reconcill
```

`precondition_failed` 是正常的并发观察结果。它回到 Root Reconcill 触发重新观察和推理，不会升级为 Conductor 进程故障。任何 mutation 都只有在 fresh read-back 后才能成为新的 accepted fact。

## Phase 1 边界

| 方面 | 做 | 不做 |
|---|---|---|
| Task Manager | Linear 定时 Root Tree polling 和 Linear-backed 通用 MCP 是第一版唯一实现 | 公网 webhook intake；向 Codex 暴露 Linear 原生 skill、SDK object 或 provider-specific payload |
| Cycle | 最多一个 active Cycle；Root 可继续修改，或关闭后创建 successor 并重新 Plan | Conductor 自动判定 Cycle 失效；重开 terminal Cycle |
| 执行 | Plan、Work、Verify role 隔离；同一 Cycle 的 Work Item 串行执行 | Performer 直接写任务；Work subagent、并行 Work、跨模型编排 |
| 调度 | 一个 Conductor 串行处理多个 Root | 并发 Root、抢占、公平调度、多个 Conductor |
| 运行时 | 每个 Root 独占 Root Reconcill、process、thread、accepted baseline 和 Root Home | 共享、池化、fork 或跨 Root 复用运行时资源 |
| 持久化 | Task Manager 和 Git 保存外部事实；Root Home 只保存最小 thread continuity | workflow database、durable diff/next action/tool result、事件 replay |
| 交付 | 一个 Root 生成一个 exact-revision PR，并进入 `In Review` | 自动 merge、自动设为 `Done`、处理 PR review/rejection |
| 替换策略 | 直接删除旧模块与旧测试，再实现唯一新路径 | adapter、fallback、双读写、兼容 decoder、迁移逻辑或旧路径保留 |

## 文档所有权

- [Task Management](task-management.md)：定时 Root Tree observation、fresh snapshot/diff、通用 MCP 与 Linear provider boundary。
- [Root Issue](root-issue.md)：Root、Cycle、Stage 和 DAG 的持久事实及 Cycle 可变规则。
- [Conductor](conductor.md)：机械调度、事件循环、per-Root runtime 与 restart。
- [Root Reconciliation](root-reconciliation.md)：Root ReAct、tool surface 和唯一语义决策权。
- [Performer](performer.md)：Codex CLI、双 Home、三个 role 和 thread 隔离。
- [Git Worktree Delivery](git-worktree-delivery.md)：通用 Git/Delivery tools、exact revision 和 PR。
- [Contracts](contracts.md)：模块接口、closed contract 和 fresh read-back 规则。
- [Roadmap](roadmap.md)：hard-cut 实施顺序与黑盒完成标准。

Phase 1 范围与非目标只由本文定义。其他文档只描述各自拥有的设计，不另建 ADR、任务账本或第二套架构说明。
