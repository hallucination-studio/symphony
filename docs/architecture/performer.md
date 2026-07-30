# Performer

状态：Phase 1 目标设计。Plan、Work、Verify 是由 Root Reconcill 通过 Conductor tool boundary 调用的三个隔离 Codex CLI `app-server` roles。

## 两类 Codex Home

```text
Root app-server:
  CODEX_HOME=<program-data>/root-reconcills/<root-id>/

Performer app-server:
  CODEX_HOME=<user-supplied-performer-home>/
```

Root Home 由 Symphony 创建和回收，只属于对应 Root Reconcill。Performer Home 由用户提供，供三个 roles 使用，永不随 Root 删除。两类 Home 的 canonical path 必须不同。

Symphony 只管理 Root Home 中的 `symphony/state.json`，不读取、复制或改写 Codex 自己的 auth、config、session 或 SQLite files。

## CLI boundary

Root 和 Performer 都通过已安装 Codex CLI `app-server` 的本地 stdio JSONL/JSON-RPC boundary 运行。Codex transport、CLI event、thread object 和 process handle 封装在 private implementation 内。

Root app-server 获得 capability-scoped Task Manager MCP 和其他 declared tools。Performer 不获得 Task Manager MCP、Linear 原生 skill、provider credential 或 delivery capability。

## Three roles

| Role | Input / output | 不做 |
|---|---|---|
| Plan | 读取 Root/Cycle facts，返回 `PlanResult` proposal、Work decomposition、relations 和 verification intent | 创建/更新 Issue，修改代码 |
| Work | 每 turn 执行一个 Root 指定的 Work Issue，修改对应 worktree，运行 focused checks，返回 `WorkResult` | 修改 Task Manager/DAG，commit、push、创建 PR |
| Verify | 只读检查指定 immutable revision，返回 `VerifyResult` | 修改 Task Manager，修改/修复代码，改变 revision |

Performer result 是一次调用的 typed evidence，不是外部事实。Root Reconcill 结合 result 与 fresh snapshot，选择精确 generic MCP/Git/Delivery calls。Conductor 不根据 result 自动推进任何 lifecycle。

## Thread model

- 每个 Cycle 分别创建 Plan、Work、Verify threads。
- 三类 thread 互不共享，也不跨 Root 或 Cycle 复用。
- 同一 Cycle 的全部 Work Items 共用一个 Work thread，每个 Item 使用独立 turn。
- Root Reconcill thread 与全部 Performer threads 隔离。
- Cycle 关闭后，取消并隔离其未完成 Performer turns；successor Cycle 创建全新 threads。
- Conductor restart 创建新的 Root generation/thread；旧 generation 的 output、tool call 和 Performer result 永不接受或 replay。
- 已开始但没有被 fresh Task Manager/Git read-back 接受的动作保持实际外部状态，由新 Root bootstrap 重新决策。

## Secret boundary

Task Manager、delivery 与 Git remote credentials 只存在于各自 private boundary，不进入 role prompt、turn text、result、Root Home、Task Manager content、Git content 或 logs。Performer 只能接收完成 role 所需的 normalized facts、worktree/revision capability 和 sanitized context。
