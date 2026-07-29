# Phase 1 Roadmap

状态：目标实施顺序。产品范围与非目标由[架构总览](README.md#phase-1-边界)定义，本文不扩展该边界。

## 实施顺序

1. **接口与运行时外壳**：建立 Linear、Root Reconciliation、Performer、Git 和 Delivery 的 caller-owned interfaces，不让 SDK object、token、process handle 跨 public boundary。
2. **Per-Root ReAct**：创建独立 Root Home、private `CodexReconcill`、app-server process/thread 和 `state.json` continuity，支持 bootstrap、内存 diff、三个 Performer tool 与 closed RootDecision。
3. **Plan 与 DAG**：创建 Cycle shell；Plan 通过 Linear skill 持久化 Plan、多个 Work、Verify 和依赖关系；Conductor 重新读取并验证。
4. **Work**：创建 Root worktree；按 DAG readiness 逐个执行 Work；同一 Cycle 复用一个 Work thread，每个 Work Item 使用一个 turn。
5. **Verify 与交付**：全部 Work 完成后创建 commit；Verify 检查该 revision；通过后 push、创建 PR，并将 Root 设为 `In Review`。
6. **串行多 Root 与回收**：当前 Root 进入 `In Review` 后处理下一个 Root；Linear 确认 `Done` 后只回收对应 Root runtime 和 Root Home。

每一步先用受控 fixture 验证接口和状态转换；最终闭环必须通过真实 Linear、Codex app-server、Git remote 和 PR 边界验证。

## 完成标准

Phase 1 完成必须同时证明：

1. 一个 Root 能生成包含多个 Work 的 DAG，并按 Plan -> Work* -> commit -> Verify -> PR 完成。
2. 同一 Cycle 的多个 Work Item 使用同一个 Work thread 的不同 turn。
3. 执行中修改 Root 或子 Issue 后，实际 diff 会到达 `RootReconcill`，且它能继续当前 Cycle 或关闭后重新 Plan。
4. Verify、push 和 PR head 指向同一个 commit。
5. 一个 Conductor 能串行交付两个 Root，且两者的 Root object、process、thread 和 Home 不共享。
6. Root `Done` 后只删除对应 Root Home；其他 Root Home 和 Performer Home 不受影响。

未通过这些真实边界检查前，不得声称 Phase 1 已跑通。
