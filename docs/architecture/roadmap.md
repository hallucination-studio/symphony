# Phase 1 Roadmap

状态：目标实施顺序。产品范围与非目标由[架构总览](README.md#phase-1-边界)定义；执行拆解不是架构 source of truth。

## Hard-cut sequence

1. **Architecture checkpoint**：冻结 polling observation、Markdown Root/ADR/Cycle contracts、immutable Cycle、Root boundary semantics 和 Conductor mechanical state machine。
2. **Contract and capability correction**：定义 Root code-read-only authority、Cycle-machine Task/Git authority、sealed specification、one-time Plan materialization 与 closed transition results。
3. **Task Manager foundation**：保留 generic Linear query/mutation 与 polling，增加 Root/Conductor caller capability和 sealed-fact enforcement。
4. **Root semantic boundaries**：实现 code-read-only Define、Root ADR、Cycle Draft review/seal、Awaiting Acceptance review 和 successor creation。
5. **Performer isolation**：实现 no-fork Plan/Work/Verify contexts、Markdown-only handoffs、same-Cycle Work thread reuse 和 fresh Verify。
6. **Mechanical Cycle execution**：实现 approved Cycle 状态机、一次性 DAG materialization、stable Work ordering、status transitions、terminal failure 和 restart fencing。
7. **Git and delivery**：实现 Conductor-owned worktree/commit、exact-revision Verify，以及 accepted revision 的 push/PR/read-back。
8. **Serial runtime**：组合多 Root 串行 scheduling、restart、In Review parking、Done cleanup 和 late-output fencing。
9. **Black-box E2E**：只通过外部 Linear、Git/PR provider 和 built Conductor 证明整个闭环。

每一阶段只保留一条实现路径；不设置 old/new cutover、adapter、fallback、dual read/write 或 migration phase。

## Black-box acceptance

最终 E2E runner 使用 repository-local ignored `.env`，但绝不打印、记录、持久化或复制其中的 token。runner只允许：

1. 使用 human fixture token 在 Linear 创建、委托、修改和清理自己的 Root fixtures。
2. 使用 production configuration 启动/停止 built Conductor process。
3. 通过 Linear、Git remote 和 PR public boundary 查询最终事实用于验收。

runner 不得 import Conductor private/unexported modules，不得调用 Root Reconcill、Task Manager command、Cycle machine、Codex、Git、push 或 PR internals，也不得替 Conductor执行任何产品 mutation。未正确 delegate 的 Root 必须保持不运行；delegate 后下一次 scheduled fresh observation 才能触发执行。

## Completion standard

Phase 1 完成必须同时证明：

1. delegated Root 经过 code-read-only Define，形成 Markdown Root requirement/ADR，创建并 review 一个完整 Cycle Draft，`In Progress` transition seal 本次尝试。
2. Conductor独立运行 Plan，一次性物化多个 Work、一个 Verify 和完整 sealed DAG；approved Cycle 的 description、Work set 和 relations 后续不可修改。
3. 多个 Work 使用同一个 Work thread 的不同 turns；Plan、Work、Verify 不 fork、不共享 context，Verify 使用 fresh context检查 exact revision。
4. Plan/Work/Verify failure、sealed fact mutation、partial materialization 和 lost context 都 terminally fail；Root只在 terminal predecessor 后创建全新 successor。
5. Root Reconcill 对用户代码始终只读，只在 Draft approval 和 Awaiting Acceptance 做语义决策；Performer永不访问 Task Manager。
6. Verify revision、accepted revision、pushed remote revision 和 PR head 完全相同，随后 Root 才进入 `In Review`。
7. precondition race不杀死 Conductor；Root boundary重新观察，Cycle boundary按同一 seal重算唯一 mechanical transition或可见失败。
8. 一个 Conductor串行处理两个 Roots，runtime/process/thread/Home 不共享；Root `Done` 只删除对应 Root Home。
9. black-box E2E仅创建/观察外部 fixtures并启动 built Conductor，所有产品效果都来自 Conductor 本身。

上述真实边界证据和 `make test-all` 未全部通过前，不得声称 Phase 1 跑通。
