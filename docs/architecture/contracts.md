# Contracts and Interfaces

状态：Phase 1 目标设计。本文只定义模块间稳定的 public boundary；provider SDK、Codex app-server protocol、MCP transport 和 command process 都是 private implementation。

## Public interfaces

| Interface | 唯一职责 |
|---|---|
| `TaskManageObserverInterface` | 在有界 tick 上 fresh poll Root Tree，并发出 changed-only 完整观察事件 |
| `TaskManageCommandInterface` | 实现通用 Task Manager MCP query/mutation functions 与 fresh read-back |
| `RootReconcillFactoryInterface` | 为一个 Root 和 Root Home 创建 identity-bound `RootReconcill` |
| `RootReconcillInterface` | 接收 bootstrap/diff，运行 ReAct tool loop，返回 quiescent/stop turn outcome |
| `StagePerformerInterface` | 以 `role` 区分的 `PlanPerformerInterface | WorkPerformerInterface | VerifyPerformerInterface` closed family；每个隔离实例只执行自己的 operation，并返回不含 Task Manager mutation 的 typed result |
| `GitWorkspaceInterface` | 实现通用 worktree、status、diff 和 commit operations |
| `DeliveryInterface` | 实现通用 remote ref 和 pull request operations |

这些接口由 caller 拥有。Linear SDK object、Codex event/thread、MCP session、Git process 和 credential 不得跨 public boundary。

## Closed contract families

Phase 1 只需要以下 contract families：

```text
TaskObservationEvent
RootBootstrap | RootFactDiff
TaskSnapshot | GitSnapshot
TaskMcpCall | TaskMcpResult
PlanRequest | WorkRequest | VerifyRequest
PlanResult | WorkResult | VerifyResult
GitToolCall | GitToolResult
DeliveryToolCall | DeliveryToolResult
RootTurnOutcome | RootRuntimeState
```

所有跨 public interface 或 process boundary 的 envelope 都有 `schema_version: 1`、target identity 和 correlation。绑定已创建 runtime 的 envelope 还必须有 `runtime_generation`；pre-runtime 的 `TaskObservationEvent` 用 from/to task digest 描述 observer 相邻两次成功 poll，不绑定 runtime generation 或 accepted baseline。版本不是协商机制；unknown variant、missing identity、非 `1` schema、stale generation 或 capability mismatch 均 fail closed。

Public contract 不得包含 SDK object、credential、raw provider payload、Codex config/session、process/thread/filesystem handle、database record、arbitrary metadata、durable next action、persisted diff 或 persisted tool result。

## Observation contracts

```text
TaskObservationEvent {
  schema_version: 1, root_id, correlation_id, observed_at,
  from_task_digest: digest | null, to_task_digest,
  task: TaskSnapshot, task_changes: ConcreteTaskChange[]
}

RootBootstrap {
  schema_version: 1, root_id, runtime_generation, correlation_id,
  observed_at, task: TaskSnapshot, git: GitSnapshot
}

RootFactDiff {
  schema_version: 1, root_id, runtime_generation, correlation_id,
  from_observation_digest, to_observation_digest,
  task_changes: ConcreteTaskChange[], git_changes: ConcreteGitChange[]
}

RootRuntimeState {
  schema_version: 1, root_id, runtime_generation,
  thread_id, accepted_observation_digest, in_flight_correlation | null
}
```

`TaskSnapshot` 和 `GitSnapshot` 是 fresh read 的不可变规范化结果。`TaskObservationEvent` 首次观察使用 `from_task_digest: null`、完整 snapshot 和空 changes；后续只在 digest 改变时发出，并包含相对上次完整 polling observation 的 concrete changes。事件可以按 Root 合并为最新完整 snapshot，不作为 action replay；合并后 Conductor 不要求 event `from_task_digest` 等于 runtime accepted digest，而是从完整 snapshot 重新计算 Root-facing diff。

`ConcreteTaskChange` 只允许 `issue_created | issue_archived | field_changed | relation_added | relation_removed`；`field_changed` 的 field 只允许 `status | title | description | parent | labels | delegate | priority`。diff 不包含任何 workflow interpretation。

task observation digest 只描述 polling baseline 上的相邻观察；runtime observation digest 验证同一 generation 内 accepted observation 的连续性。digest 不能恢复旧 snapshot。`RootRuntimeState` 是 Root Home 中唯一由 Symphony 管理的 continuity payload，并使用 atomic replace。

## Task MCP contracts

每个 MCP function 都有独立 typed input/output schema。list function 使用 cursor pagination；mutation input 含 exact target identity、partial desired fields 和 fresh expected revision。provider-specific optional bag 或 arbitrary metadata 均不允许。

```text
TaskMutationResult {
  outcome: applied | not_applied | precondition_failed |
           acceptance_unknown | readback_mismatch,
  correlation_id, target_identity, fresh_resource?, concrete_diff?, sanitized_reason?
}
```

MCP schema 只暴露 [Task Management](task-management.md#generic-mcp-functions) 中列出的通用 functions，不暴露 Symphony lifecycle commands。`precondition_failed` 是 tool result，不是 process-level error。

## Performer results

三个 Performer 只返回其 role 的工作结果：

```text
PlanResult {
  outcome: completed | failed | canceled,
  proposed_plan, proposed_work_items, proposed_relations, verification_intent
}

WorkResult {
  outcome: completed | failed | canceled,
  work_issue_id, workspace_changed, checks, sanitized_summary
}

VerifyResult {
  conclusion: passed | failed | inconclusive,
  verify_issue_id, revision, checks, sanitized_summary
}
```

Performer result 不含 provider receipt，不创建或更新 Issue，也不推进 lifecycle。Root Reconcill 根据 result 和 fresh facts 决定后续精确 MCP calls。result 不写入 Root Home；只有被 Task Manager/Git fresh read 确认的状态才是事实。

调用 Work 前，Root Reconcill 必须从 fresh complete Root Tree 确认 Work Issue 属于当前 Root/Cycle，并在每次 `WorkRequest` 中提供该次调用观察到的完整、bounded、identity-unique 当前 Cycle Work Issue authority set；`work_issue_id` 必须属于该 set。每个 Issue 的 normalized facts 放入对应 request，但 authority set 不进入 Performer prompt。Task Manager-free、Cycle-bound Work Performer 不重新查询 ownership；同一实例和 thread 可以依次接受 fresh authority 新增的 Work Issue。每次调用使用 fresh correlation。`completed` Work 必须有已知 `workspace_changed` 和至少一个全部通过的 check；`canceled` Work 的 workspace 状态必须为 `null`；`failed` 可以保留 partial checks，但不能把未知 workspace 状态变成事实。

Verify Performer instance 绑定一个 Verify Issue 和一个 revision，只能用 read-only workspace capability 检查该 target。`passed` 必须 exact coverage 全部 requested checks 且全部通过；`failed` 必须至少有一个失败 check；缺少确定证据时使用 `inconclusive`。P6 Performer boundary 绑定 request、prompt、schema 和 read-only cwd；cwd/HEAD 与 revision 的 Git precondition 和调用后的 fresh read-back 由 `GitWorkspaceInterface` owner 负责，见 [Git and Delivery](git-worktree-delivery.md)。

## Turn outcomes and errors

`RootTurnOutcome` 只表示本轮控制结果：`quiescent | stopped | timed_out | canceled`。它不表达开始、继续、关闭、重跑、完成或交付等 Symphony 领域动作。

Public boundary error 是 closed union：

```text
invalid_contract | stale_generation | capability_denied | timed_out |
canceled | boundary_unavailable | acceptance_unknown | readback_mismatch
```

错误带 identity、correlation 和 sanitized reason，不携带 raw payload、credential、command line 或可能包含 secret 的 stack。

## Fresh read-back rule

所有 Task Manager、Git 和 Delivery mutation 后都必须重新读取同一 exact identity。只有 fresh state 与请求结果一致时，对应的 runtime accepted facts 才能前进；polling observation baseline 仍只由 observer 的完整成功 poll 推进。并发变化产生 `precondition_failed` 或 concrete diff，交回 Root Reconcill 再次 ReAct；Conductor 不替 Root 选择重试、替代 target 或 workflow transition。
