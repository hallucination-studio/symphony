# Symphony Phase 1 架构

状态：目标架构提案。本文定义第一期要实现的产品边界，不表示当前代码已经符合该设计，也不隐含任何迁移或兼容方案。

## 唯一目标

用户把一个 Linear Root Issue 委托给配置的 agent actor 后，Symphony 将它交付为一个可审查的 PR：

```text
Task Manager 定时 fresh poll Root Tree 并产生观察事件
-> Root Reconcill 在 Define 中只读检查用户代码，形成完整 Root requirement 与 Root ADR
-> Root Reconcill 创建并 review Cycle Draft
-> review 通过后把 Cycle 设为 In Progress，同时 seal 本次尝试的 Markdown 规格
-> Conductor 用确定性的 Cycle 状态机运行 isolated Plan
-> Plan 通过 closed validation 后一次性物化并 seal Work/Verify DAG
-> Conductor 在一个 Work thread 中按多个 turns 串行执行全部 Work Items
-> Conductor 创建 exact revision，并在 fresh Verify context 中只读验证
-> Cycle 进入 Awaiting Acceptance
-> Root Reconcill 对 exact revision 做只读验收
-> 接受后交付 exact-revision PR；拒绝或失败后只能创建 successor Cycle
-> Root 进入 In Review
```

未委托给配置 actor 的 Root 不执行。Phase 1 的产品是这条自主开发闭环，不是通用智能项目管理平台。

## 核心分工

| 角色 | 负责 | 不负责 |
|---|---|---|
| Task Manager / Git | 保存 Root/Cycle/Stage、Markdown 规格、关系、状态和 exact revision 等外部事实 | 保存模型 transcript、临时 diff 或隐藏下一步决策 |
| `TaskManageObserver` | 定时 fresh read Root Tree，检测事实变化并发出完整观察事件 | 依赖公网 webhook、解释需求或决定代码设计 |
| Task Manager boundary | 为 Root semantic boundary 和 Conductor mechanical boundary 提供 provider-neutral query/mutation 与 fresh read-back | 向 Codex 暴露 Linear SDK、credential 或未受限 mutation |
| `RootReconcill` | Define Root、维护 Root ADR、创建和批准 Cycle Draft、验收 exact revision、决定是否创建 successor | 写用户代码、执行 Stage、修改 sealed Cycle 或在 Cycle 内调整 DAG |
| Conductor | 串行调度、fresh snapshot、权限隔离，以及批准后 Cycle 的确定性状态机、状态推进、DAG 物化、commit、Verify 和交付边界 | 解释需求、选择架构、修改 sealed 规格或做语义验收 |
| Plan / Work / Verify Performer | 分别把批准设计分解成执行图、实现一个 Work Item、验证 exact revision | 修改 Task Manager、改变 Cycle 设计或决定 Root 下一步 |

Root Reconcill 只在 Cycle 边界拥有语义决策权。Cycle 一旦批准，Conductor 只依据 sealed facts 和 closed results 机械推进；它拥有领域状态机，但不拥有领域判断。Performer 是机械执行者，不写 Task Manager。

## 两个推进边界

Root semantic boundary：

```text
fresh Root/Git facts
-> Define 或 review Cycle Draft
-> approve and seal | accept | reject | create successor | wait
-> exact generic Task/Delivery call
-> fresh read-back
```

Cycle mechanical boundary：

```text
approved Cycle observation
-> validate sealed specification
-> Plan -> materialize sealed DAG
-> Work turns -> exact commit
-> fresh Verify
-> Awaiting Acceptance | Failed | Canceled
```

`precondition_failed` 是正常的并发事实。Root boundary 的冲突回到同一个 Root Reconcill 重新观察；Cycle boundary 的冲突由 Conductor fresh read 后按同一 sealed specification 继续唯一合法 transition，无法唯一确认时 fail closed。任何 mutation 只有在 fresh read-back 后才成为事实。

## Phase 1 边界

| 方面 | 做 | 不做 |
|---|---|---|
| Task Manager | Linear 定时 Root Tree polling 和 Linear-backed provider-neutral command boundary 是第一版唯一实现 | 公网 webhook intake；向 Codex 暴露 Linear 原生 skill、SDK object 或 provider payload |
| Define | Root Reconcill 对用户代码只读，产出完整 requirement、领域知识、Root ADR 和验收标准 | 在 Define 中修改代码；把 transcript 当成需求事实 |
| Cycle | 最多一个 non-terminal Cycle；Draft 经 review 后以 `In Progress` seal；任何修改都通过 terminal predecessor 加 successor 表达 | 修改 sealed description、增删 Work、改变 DAG、reopen terminal Cycle |
| 执行 | Plan、Work、Verify context 隔离；多个 Work Items 串行复用一个 Work thread；Verify 使用 fresh context | fork、Work subagent、并行 Work、跨 Cycle thread 复用 |
| 权限 | Root 对用户代码始终只读；Work 对唯一 Root worktree 读写；Verify 对 exact revision 只读并仅写 scratch | Root 或 Plan 写用户代码；Verify 修复代码；Performer 请求额外权限 |
| 调度 | 一个 Conductor 串行处理多个 Root；一个 approved Cycle 由状态机连续推进至边界 | 并发 Root、抢占、公平调度、多个 Conductor |
| 持久化 | Task Manager 和 Git 保存规格与执行事实；Root Home 只保存最小 continuity | workflow database、durable transcript/next action/tool result、事件 replay |
| 交付 | 一个 Root 生成一个 exact-revision PR，并进入 `In Review` | 自动 merge、自动设为 `Done`、处理 PR review/rejection |
| 替换策略 | 直接替换不符合目标架构的模块与测试 | adapter、fallback、双读写、兼容 decoder、迁移逻辑或旧路径保留 |

## 文档所有权

- [Task Management](task-management.md)：定时 Root Tree observation、fresh snapshot/diff、Root 与 Conductor 的 provider-neutral Task Manager capability。
- [Root Issue](root-issue.md)：Define、Markdown 规格、不可变 Cycle、Stage、DAG 和 terminal successor 事实。
- [Conductor](conductor.md)：机械调度、确定性 Cycle 状态机、per-Root runtime 与 restart。
- [Root Reconciliation](root-reconciliation.md)：Define、Cycle approval、exact-revision acceptance 和只读代码权限。
- [Performer](performer.md)：Codex CLI、三个 role、上下文来源、权限和 thread 隔离。
- [Git Worktree Delivery](git-worktree-delivery.md)：Conductor-owned Git/Delivery mechanics、exact revision 和 PR。
- [Contracts](contracts.md)：模块接口、closed contract、Markdown payload 和 fresh read-back 规则。
- [Roadmap](roadmap.md)：hard-cut 实施顺序与黑盒完成标准。

Phase 1 范围与非目标只由本文定义。其他文档只描述各自拥有的设计，不另建 ADR、任务账本或第二套架构说明。
