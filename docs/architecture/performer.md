# Performer

状态：Phase 1 目标设计。Plan、Work、Verify 是由 Conductor 调用的三个独立 Codex CLI `app-server` role。

## 两类 Codex Home

```text
Root app-server:
  CODEX_HOME=<program-data>/root-reconcills/<root-id>/

Performer app-server:
  CODEX_HOME=<user-supplied-performer-home>/
```

Root Home 由 Symphony 创建和回收，只属于对应 `RootReconcill`。Performer Home 由用户提供，供 Plan、Work、Verify 使用，永不随 Root 删除。两类 Home 的 canonical path 必须不同。

Symphony 只管理 Root Home 中的 `symphony/state.json`，不读取、复制或改写 Codex 自己的 auth、config、session 或 SQLite 文件。

## CLI boundary

Root 和 Performer 都通过已安装 Codex CLI `app-server` 的本地 stdio JSONL/JSON-RPC 接口运行。Codex transport、CLI event、thread object 和 process handle 都封装在 private implementation 内。

外层 workflow 只看到 `RootReconcillInterface` 和 `StagePerformerInterface`，不存在 public `CodexGateway`。

## 三个 role

| Role | 做 | 不做 |
|---|---|---|
| Plan | 理解 Root / Cycle；通过 Linear skill 创建并回读 Plan、Work*、Verify 和 DAG；返回 `PlanHandoff` | 修改代码 |
| Work | 每个 turn 完成一个 ready Work；修改对应 Root worktree；运行局部检查；更新并回读 Work；返回 `WorkHandoff` | 修改 DAG、commit、push、创建 PR |
| Verify | 只检查指定 immutable revision；更新并回读 Verify；返回 `VerifyHandoff` | 修改或修复代码 |

三个 role 使用独立 prompt，不能互相替代，也不决定 Root 的下一步。

## Thread 模型

- 每个 Cycle 分别创建 Plan、Work、Verify thread。
- 三类 thread 互不共享，也不跨 Root 或 Cycle 复用。
- 同一 Cycle 的全部 Work Item 共用一个 Work thread，每个 Item 使用一个独立 turn。
- Root Reconcill thread 与全部 Performer thread 隔离。
- Conductor restart 后不恢复旧 Root thread。它隔离旧 generation，并以 fresh
  `RootBootstrap` 创建新 generation 的 Root thread；这是唯一 restart path。
- 已经开始但未被 fresh Linear / Git read-back 接受的 Performer turn 不恢复、不重放。
  对应 Stage 保持实际状态，由新 Root thread 基于 bootstrap 选择关闭 Cycle 后重新 Plan
  或 `Stop`。

## Secret boundary

Linear credential 只存在于 private Linear integration boundary：Conductor 的 `LinearGatewayInterface` implementation，以及调用 Linear skill 时的 Performer secret boundary。它不进入 role prompt、turn text、Handoff、Root app-server、Root Home、`state.json`、Linear 内容、Git、日志或任何 public contract。

Performer 返回前回读自己声称写入的 Linear 事实；Conductor 随后仍会独立重新读取，并以实际事实为准。
