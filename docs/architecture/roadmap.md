# Phase 1 Roadmap

状态：目标实施顺序。产品范围与非目标由[架构总览](README.md#phase-1-边界)定义；执行拆解不是架构 source of truth。

## Hard-cut sequence

1. **Architecture checkpoint**：冻结 Task Manager polling observation/MCP、concrete diff、Root ReAct、mutable Cycle 和 black-box acceptance contracts。
2. **Remove retired runtime**：硬删除旧 Symphony domain state machine、dynamic Linear skills/tools、compatibility code、fallback path 和绑定旧架构的大型 tests。
3. **Task Manager foundation**：实现 generic contracts/MCP schemas，以及第一版唯一 Linear command/query provider。
4. **Polling observation**：实现 Linear 定时 Root inventory/Tree fresh reads、changed-only complete observation、accepted baseline 与 concrete adjacent diff。
5. **Root ReAct runtime**：实现 per-Root Codex runtime、capability-scoped MCP loop、normal precondition conflict handling 和 Root-owned Cycle choice。
6. **Performer isolation**：实现不写 Task Manager 的 Plan/Work/Verify typed results，并由 Root Reconcill 执行 exact task mutations。
7. **Git and delivery**：实现 generic Git/Delivery tools、worktree ownership、immutable commit、exact-revision Verify/push/PR。
8. **Serial lifecycle**：实现多 Root 串行 scheduling、restart、In Review parking、Done cleanup 与 late-output fencing。
9. **Black-box E2E**：只通过外部 Linear 和 built Conductor 证明整个闭环。

每一阶段只保留一条实现路径；不设置 old/new cutover、adapter、fallback、dual read/write 或 migration phase。

## Black-box acceptance

最终 E2E runner 使用 repository-local ignored `.env`，但绝不打印、记录、持久化或复制其中的 token。runner 只允许：

1. 使用 human fixture token 在 Linear 创建、委托、修改和清理自己的 Root fixtures。
2. 使用 production configuration 启动/停止 built Conductor process。
3. 通过 Linear public boundary 查询 Root/Cycle/Stage/relation 最终事实用于验收。

runner 不得 import Conductor private/unexported modules，不得调用 Root Reconcill、Task Manager MCP、Codex、Git、push 或 PR internals，也不得替 Conductor 执行任何产品 mutation。未正确 delegate 的 Root 必须保持不运行；delegate 后下一次 scheduled fresh observation 才能触发执行。

## Completion standard

Phase 1 完成必须同时证明：

1. 一个 delegated Root 通过 generic Task Manager MCP 生成 Cycle、Plan、多个 Work、Verify 和完整 DAG。
2. Root/sub-Issue/relation 的真实修改形成 concrete diff；Root Reconcill 能继续当前 Cycle，或关闭它并创建 successor Cycle 重新 Plan。
3. precondition race 返回 Root Reconcill 后能够重新推理，且 Conductor 进程保持健康。
4. 同一 Cycle 的多个 Work 使用同一 Work thread 的不同 turns；Cycle replacement 不复用旧 threads。
5. Verify revision、pushed remote revision 和 PR head 完全相同，随后 Root 才进入 `In Review`。
6. 一个 Conductor 串行处理两个 Roots，runtime/process/thread/Home 不共享；Root `Done` 只删除对应 Root Home。
7. black-box E2E 仅创建/观察 Linear fixtures 并启动 built Conductor，所有产品效果都来自 Conductor 本身。

上述真实边界证据和 `make test-all` 未全部通过前，不得声称 Phase 1 跑通。
