# Conductor

状态：Phase 1 目标设计。Conductor 是静态、机械、串行的 runtime host，并拥有 approved Cycle 内唯一的确定性的 Cycle 状态机。

## 职责

Conductor 负责：

- 承接 changed-only `TaskObservationEvent`；startup 立即 poll，此后按有界间隔持续 fresh observation。
- 串行选择 Root；任意时刻最多运行一个 Root semantic turn 或一个 Cycle mechanical action。
- 消费完整 Task snapshot、fresh Git snapshot，维护 accepted in-memory baseline，并计算 concrete adjacent diff。
- 创建、暂停、重建和回收 per-Root runtime，以及隔离 Root/Plan/Work/Verify contexts。
- 向 Root app-server 暴露 boundary-scoped Task Manager、read-only code inspection 和 acceptance/delivery tools。
- 在 Cycle `In Progress` 后创建 Plan、一次性物化 Work/Verify DAG、推进 Stage、创建 exact commit、调用 fresh Verify，并进入 `Awaiting Acceptance`。
- 对每个 effect 校验 schema、Root/Cycle ownership、runtime generation、correlation、capability、sealed revision 与 fresh precondition。
- 管理 cancellation、timeout、late-output fence、structured logs 和 sanitized terminal failure。

Conductor 不解释需求、架构或验收标准，不创建设计，不修改 sealed Markdown，不决定 exact revision 是否满足用户目标，也不在失败后设计 successor。它的全部选择必须由 closed state、sealed graph 和 typed result唯一确定。

## Serial event loop

```text
await_observation
-> align_latest_task_snapshot
-> fresh_git_snapshot
-> choose one eligible Root boundary or approved Cycle action
-> execute one fenced action
-> fresh_read_back
-> continue | park_root | expose_terminal_failure
```

同一 Root 尚未处理的 polling observations可以合并，但只能保留最新完整 snapshot；不能只合并一步 diff。Conductor 从 runtime accepted baseline 到该最新 snapshot 生成 Root-facing concrete diff，不 replay 中间 observation。

`In Review` Root 保留观察但不占执行槽；Task Manager fresh observation 确认 `Done` 后只触发资源回收。

## Mechanical Cycle state machine

Cycle `Draft` 只由 Root Reconcill review。`Draft -> In Progress` 是 seal 和一次性执行授权；Conductor 只接管 fresh read 已确认的 `In Progress` Cycle：

```text
validate sealed Cycle specification
-> create and run one isolated Plan
-> validate Plan contract
-> materialize and seal Work/Verify graph exactly once
-> execute ready Work Items in stable topological order
-> fresh status/diff -> create and read back exact commit
-> start one fresh Verify context at that revision
-> passed: Awaiting Acceptance
-> failed/inconclusive/ambiguous: Failed
```

多个 Work Items 必须在同一个 Cycle-bound Work thread 中用不同 turns 串行执行。Plan、Work、Verify 互不共享 context；Verify 永远不复用 Plan/Work thread。Conductor 不使用 fork 构造任何 role context。

Plan 通过表示 typed shape、Markdown、boundedness、DAG、coverage 和 no-new-decision validation 通过，不是 Conductor 对计划质量作语义判断。Plan failure、Work failure、Verify failure、partial graph materialization、sealed fact mutation、lost in-flight context 或无法唯一 read-back 都按 closed table 进入 terminal `Failed`；Conductor不修补、不重做设计、不向当前 Cycle 追加 Work。

`Awaiting Acceptance` 将执行权交回 Root Reconcill。只有 Root Reconcill 可以基于 exact revision 把它变为 `Succeeded | Rejected`。成功后 exact delivery 是由 accepted revision 决定的机械效果；失败或拒绝后的 successor 设计仍只属于 Root Reconcill。

## Mechanical Task Manager authority

Conductor 通过 private、Cycle-scoped capability 使用 provider-neutral `TaskManageCommandInterface`。它只能：

- 在一个 approved Cycle 内创建一个 Plan Issue。
- 根据一个已验证 PlanResult 一次性创建 Work/Verify Issues 与 dependency relations。
- 按 closed transition table 更新该 Cycle 和 Stage statuses。
- fresh read-back 自己刚执行的 exact mutation。

它不能修改 Root description/ADR、Cycle description、已物化 Stage description、sealed relations、delegate、priority 或其他 Root/Cycle。Root Reconcill 与 Conductor 使用不同 capability；Performer 不获得任何 Task Manager capability。

## Fresh precondition semantics

dispatch 前的 fresh precondition 验证 identity ownership、generation/correlation、capability、expected revision、seal digest 和唯一资源。Root boundary 的正常并发变化返回：

```text
precondition_failed + fresh resource/concrete diff
```

结果回到同一个 Root Reconcill 重新观察。Cycle machine 遇到冲突时只 fresh read 一次并重新计算唯一机械 transition；若 sealed specification、graph 或 in-flight ownership 已变化，Cycle fail closed，而不是请求模型选择修补或重试。

## Discovery, admission, and configuration

每次 polling observation 只 admit 同时满足以下 fresh facts 的 Root：

- 位于配置的单一 Linear workspace/team，kind 为 `symphony:kind/root`，delegate 精确等于配置 actor。
- Root status 是 `Todo | In Progress`；`In Review` 只观察，`Done` 只回收。
- 最多一个 non-terminal Cycle，Root Tree identity/ancestry 唯一。
- repository identity 和 base branch 从启动配置唯一解析，没有跨 Root worktree/head ownership 冲突。

Conductor 按 `(priority, created_at, issue_id)` 稳定排序。eligibility 缺失、重复或冲突时 fail closed，并留下 sanitized reason；它不修改 Task Manager 来猜测修复 admission。

启动配置只包含 Task Manager/Linear API、bounded polling interval、workspace/team/agent identity、Root-to-repository routing、base branch、program-data path、Performer Home、Codex executable 和 delivery endpoint。配置只在进程启动时解析验证，不从 Issue description 或 arbitrary metadata 推导，也不包含 webhook URL 或 signing secret。

## Per-Root runtime

每个 Root 独占：

```text
RootReconcill object and private Root app-server process/thread
Cycle machine generation and role-specific Performer processes/threads
accepted Task/Git observation baseline
Root Home
```

Root Home 位于：

```text
<program-data>/root-reconcills/<root-id>/
  symphony/state.json
```

`state.json` 只保存 Root identity、runtime generation、thread identities、accepted observation digest 和 in-flight correlation 等最小 continuity。它不保存需求、ADR、Cycle/DAG mirror、next action、diff、prompt 或 Performer result；这些内容只能从 fresh Task/Git facts 重建或被判定为不可恢复。

Root `Done` 后，Conductor 先停止 turn/process，撤销 capability，隔离旧 generation 与 late output，验证 Home owner，再删除且只删除该 Root Home。Performer Home 和其他 Root Home 不受影响。

## Restart

进程启动或内存 baseline 丢失后只有一个 restart path：

1. 验证 `state.json` owner/identity，隔离其中的 in-flight correlation 和全部旧输出。
2. 由 startup immediate poll 产生完整 Task observation，并 fresh read Git facts。
3. 创建递增 generation 和全新 Root thread，atomic replace `state.json`。
4. 向新 Root thread 发送当前完整 bootstrap。
5. 任一 non-terminal approved Cycle 若不能由 live matching generation 证明全部 role context、seal 和 accepted execution evidence，fresh read 后机械标记该 Cycle `Failed`；这包括丢失 evidence correlation 的 `Awaiting Acceptance`，且不续跑或猜测接受未知 context。

旧 thread 不恢复、不继续、不 replay。旧 transcript、tool result、digest 或 event 都不能重建 workflow；当前 Cycle 的 sealed Markdown 与 Task/Git facts是唯一恢复输入。Phase 1 不提供 compatibility、fallback 或 alternate restart behavior。
