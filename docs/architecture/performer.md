# Performer

状态：Phase 1 目标设计。Plan、Work、Verify 是由 Conductor Cycle state machine 调用的三个机械 Codex CLI `app-server` roles，不是 Root Reconcill 的 subagents。

## 两类 Codex Home

```text
Root app-server:
  CODEX_HOME=<program-data>/root-reconcills/<root-id>/

Performer app-server:
  CODEX_HOME=<user-supplied-performer-home>/
```

Root Home 由 Symphony 创建和回收，只属于对应 Root Reconcill。Performer Home 由用户提供，供三个 roles 使用，永不随 Root 删除。两类 Home 的 canonical path 必须不同。

Symphony 只管理 Root Home 中的 `symphony/state.json`，不读取、复制或改写 Codex 自己的 auth、config、session 或 SQLite files。

## Authorization boundary

Root 和 Performer 都通过已安装 Codex CLI `app-server` 的本地 stdio JSONL/JSON-RPC boundary 运行。Codex transport、CLI event、thread object 和 process handle 封装在 private implementation 内。Performer 不获得 Task Manager MCP、Linear 原生 skill、provider credential、commit 或 delivery capability。

默认权限是：

| Role | 用户代码 | 本地写权限 |
|---|---|---|
| Root Reconcill | Root repository/code directory read-only | 自己的 Conductor-managed Root Home |
| Plan | 不挂载用户代码；只接收 Markdown input | 无 native tool write |
| Work | 当前 Root canonical worktree read/write | 该 worktree 内 process-owned scratch |
| Verify | exact-revision worktree read-only | 调用独占、结束后删除的 scratch |

这是使用 stock Codex 构成的授权契约，不宣称是自定义 whole-host confinement。部署必须 fail closed：pin 并验证支持的 Codex CLI version，禁用 MCP、remote control、remote environments、network、project instructions、skills、apps、plugins、hooks、web search 和额外 permission request；thread/start 与每个 turn 都显式重复 environment、cwd、workspace roots 和 approval policy，不能依赖用户默认值或 project trust。

read-only capability 仍显式排除 secret-bearing paths，包括 `.env*`、private key、credential store、provider auth 和 repository remote credential configuration。Work shell environment 不继承 app-server 的 `CODEX_HOME`、provider API key 或其他 ambient credential。任何 role 都不能把可疑 secret material 放入 prompt、Markdown、result 或 log。

## Context contract

每个 role 的 semantic input 都是 bounded Markdown，不接受 Root transcript、另一个 role transcript、hidden JSON、Task Manager SDK object 或 arbitrary metadata：

| Role | 唯一 context input | Output |
|---|---|---|
| Plan | sealed Cycle description Markdown 与该 Cycle 固定的 Root ADR Markdown snapshot | typed `PlanResult`，其中 Work/Verify descriptions 和 traceability 都是 Markdown |
| Work | sealed Cycle description Markdown 与当前 Work Issue description Markdown | typed execution evidence；一个 turn 只处理一个 Work Issue |
| Verify | sealed Cycle description Markdown、Verify Issue description Markdown、exact revision；运行在 fresh isolated context | typed read-only verification evidence |

Plan 只把已批准的 architecture、feature 和 code design 分解成 Work DAG 与 Verify intent。它不能读取代码补做 Define，不能新增设计决策；信息不足时返回 `failed`，当前 Cycle terminally fails。

Work 按 description实现并运行 focused checks，不修改 Task Manager/DAG，不 commit、push 或创建 PR。Verify 只检查指定 revision，不修改或修复代码。所有 sanitized handoff、description、summary、领域知识和 acceptance evidence 都使用 Markdown。

## Thread model

- Plan、Work、Verify 使用明确创建的 isolated contexts，不使用 fork。
- 每个 Cycle 创建一个 Plan context、一个 Work thread，并为 Verify 创建一个 fresh isolated context。
- 同一 Cycle 的全部 Work Items 共用一个 Work thread，每个 Item 使用独立 turn；这是唯一允许的跨 Work Item context continuity。
- Plan 和 Verify 不复用 Work thread，也不读取 Root Reconcill transcript。
- 不跨 Root 或 Cycle 复用任何 Performer thread；successor Cycle 获得全新 contexts。
- Cycle terminal 后取消并 fence 未完成 turn；late output 永不接受或 replay。
- Conductor restart 不恢复、不继续或 fork 旧 Performer thread；任何 non-terminal approved Cycle 若无法由 live matching generation 证明其 context 和 accepted evidence，均 fail closed。

## Result semantics

Performer result 是一次调用的 typed evidence，不是外部事实，也不自行推进 lifecycle。Conductor只做 closed structural validation、执行 exact mechanical mutation 并 fresh read-back；它不把自然语言 summary解释成 transition。

Plan `completed` 只表示 execution graph contract 合法。Work `completed` 必须有确定的 workspace state 和通过的 requested checks。Verify `passed` 必须覆盖全部 requested checks 且绑定 exact revision；证据不足必须是 `inconclusive`，不能猜测通过。

## Secret boundary

Task Manager、delivery 与 Git remote credentials 只存在于各自 private boundary，不进入 role prompt、turn text、result、Root Home、Task Manager content、Git content 或 logs。Performer只能接收完成 role 所需的 sealed Markdown、worktree/revision capability 和 sanitized context。
