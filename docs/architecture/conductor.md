# Conductor

状态：Phase 1 目标设计。Conductor 是静态、机械、串行的 runtime host，不是 Symphony workflow state machine。

## 职责

Conductor 负责：

- 承接 changed-only `TaskObservationEvent`；startup 立即 poll，此后按有界间隔持续 fresh observation。
- 串行选择 Root；任意时刻最多运行一个 Root Reconcill turn。
- 消费 observation 中的完整 Task snapshot、fresh read Git snapshot，维护 accepted in-memory baseline，并计算 concrete adjacent diff。
- 创建、暂停、重建和回收 per-Root runtime。
- 向 Root app-server 暴露 capability-scoped Task Manager MCP、Performer、Git 和 Delivery tools。
- 对每个 tool call 校验 schema、root ownership、runtime generation、correlation、capability 与 fresh precondition。
- 执行 provider/process 边界调用，fresh read-back，并把 typed result 交还 Root Reconcill。
- 管理 cancellation、timeout、late-output fence、structured logs 和 sanitized terminal process failure。

Conductor 不解释 Root/Cycle/Stage 状态，不计算 DAG readiness，不选择 target Issue，不决定继续或关闭 Cycle，不自动重跑 Plan，也不把 Performer result 翻译成任务 mutation。

## Mechanical event loop

```text
await_observation
-> align_latest_task_snapshot
-> fresh_git_snapshot
-> bootstrap_or_concrete_diff
-> run_root_turn
-> validate_and_serve_one_tool_call
-> fresh_read_back
-> run_root_turn | park_root | stop_root

fresh_done -> retire_root -> await_observation
```

这些是 runtime transition，不是 workflow transition。同一 Root 尚未处理的 polling observations 可以合并，但只能保留最新完整 snapshot；不能只合并一步 diff。Conductor 从 runtime accepted baseline 到该最新 snapshot 生成 Root-facing concrete diff，不 replay 中间 observation，也不从 polling cadence 推导 workflow 动作。

Root 返回 `quiescent` 时 runtime 停在 accepted facts 上等待新的 changed observation。Root 返回 `stopped` 或发生真正 process-level failure 时，Conductor 停止推进并记录 sanitized 可操作原因。`In Review` Root 保留 runtime 但不占执行槽；Task Manager fresh observation 确认 `Done` 后只触发资源回收。

## Fresh precondition semantics

tool dispatch 前的 fresh precondition 只验证机械安全：identity 属于当前 Root、generation/correlation 当前、capability 已声明、expected revision 匹配、资源可唯一定位。它不判断这个 mutation 在 Symphony 语义上“应该”发生。

read 与 write 之间的正常外部变化返回：

```text
precondition_failed + fresh resource/concrete diff
```

Conductor 将结果送回同一 Root Reconcill 继续 ReAct。它不会退出进程、重建 runtime、关闭 Cycle 或替 Root 重试。只有 transport/process 崩溃、contract/capability 违规、无法 sanitize 的 boundary corruption 等才是 process-level failure。

## Discovery, admission, and configuration

每次 polling observation 都只 admit 同时满足以下 fresh facts 的 Root：

- 位于配置的单一 Linear workspace/team，且 kind 为 `symphony:kind/root`。
- delegate 精确等于配置的 agent actor；未委托或委托给其他 actor 时不运行。
- Root status 是 `Todo | In Progress`；`In Review` 只保留观察，`Done` 只回收。
- active Cycle 不超过一个，Root Tree identity/ancestry 唯一。
- repository identity 和 base branch 从启动配置唯一解析，且没有跨 Root worktree/head ownership 冲突。

Conductor 按 `(priority, created_at, issue_id)` 稳定排序，但只 admit 一个可执行 Root。eligibility 缺失、重复或冲突时 fail closed，并留下 sanitized reason；它不修改 Task Manager 来修复 admission。

启动配置只包含 Task Manager/Linear API、bounded polling interval、workspace/team/agent identity、Root-to-repository routing、base branch、program-data path、Performer Home、Codex executable、MCP capability 和 delivery endpoint。配置只在进程启动时解析验证，不从 Issue description、Profile、Podium 或 arbitrary metadata 推导；不包含 webhook URL 或 signing secret。

## Per-Root runtime

每个 Root 独占：

```text
RootReconcill object
private Codex app-server process and thread
runtime generation and tool capability set
accepted Task/Git observation baseline
Root Home
```

Root Home 位于：

```text
<program-data>/root-reconcills/<root-id>/
  symphony/state.json
```

`state.json` 只保存 Root identity、runtime generation、thread identity、accepted observation digest 和 in-flight correlation 等最小 continuity。它不保存 Task/Git snapshot、Cycle/DAG mirror、next action、diff、tool result 或 Performer result，也不使用 workflow database。

Root `Done` 后，Conductor 先停止 turn/process，撤销 tool capability，隔离旧 generation 与 late output，验证 Home owner，再删除且只删除该 Root Home。Performer Home 和其他 Root Home 不受影响。

## Restart

进程启动或内存 baseline 丢失后只有一个 restart path：

1. 验证 `state.json` owner/identity，隔离其中的 in-flight correlation 和全部旧输出。
2. 由 startup immediate poll 产生完整 Task observation，Conductor fresh read Git facts；identity、active Cycle、worktree、branch、HEAD 或 PR 有歧义时保留事实并 fail closed。
3. 创建递增 generation 和全新 Root thread，atomic replace `state.json`。
4. 向新 thread 发送当前完整 `RootBootstrap`，以该 observation digest 建立唯一 baseline。

旧 thread 不恢复、不继续、不 replay，也不构成第二执行路径。旧 transcript、command、tool result、digest 或 event 都不能重建 workflow。完整 bootstrap 是 restart 的正式输入；Phase 1 不提供 compatibility、fallback 或 alternate restart behavior。
