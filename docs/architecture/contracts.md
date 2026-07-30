# Contracts and Interfaces

状态：Phase 1 目标设计。本文只定义模块间稳定的 public boundary；provider SDK、Codex app-server protocol、MCP transport 和 command process 都是 private implementation。

## Public interfaces

| Interface | 唯一职责 |
|---|---|
| `TaskManageWebhookInterface` | 接收并验证 provider webhook，解析并发出 Root wake |
| `TaskManageCommandInterface` | 实现通用 Task Manager MCP query/mutation functions 与 fresh read-back |
| `RootReconcillFactoryInterface` | 为一个 Root 和 Root Home 创建 identity-bound `RootReconcill` |
| `RootReconcillInterface` | 接收 bootstrap/diff，运行 ReAct tool loop，返回 quiescent/stop turn outcome |
| `StagePerformerInterface` | 执行 `plan`、`work`、`verify`，返回不含 Task Manager mutation 的 typed result |
| `GitWorkspaceInterface` | 实现通用 worktree、status、diff 和 commit operations |
| `DeliveryInterface` | 实现通用 remote ref 和 pull request operations |

这些接口由 caller 拥有。Linear SDK object、Codex event/thread、MCP session、Git process 和 credential 不得跨 public boundary。

## Closed contract families

Phase 1 只需要以下 contract families：

```text
WakeRoot
RootBootstrap | RootFactDiff
TaskSnapshot | GitSnapshot
TaskMcpCall | TaskMcpResult
PlanRequest | WorkRequest | VerifyRequest
PlanResult | WorkResult | VerifyResult
GitToolCall | GitToolResult
DeliveryToolCall | DeliveryToolResult
RootTurnOutcome | RootRuntimeState
```

所有跨 public interface 或 process boundary 的 envelope 都有 `schema_version: 1`、target identity、`runtime_generation` 和 correlation。版本不是协商机制；unknown variant、missing identity、非 `1` schema、stale generation 或 capability mismatch 均 fail closed。

Public contract 不得包含 SDK object、credential、raw provider payload、Codex config/session、process/thread/filesystem handle、database record、arbitrary metadata、durable next action、persisted diff 或 persisted tool result。

## Observation contracts

```text
WakeRoot {
  schema_version: 1, root_id, provider_event_id, received_at
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

`TaskSnapshot` 和 `GitSnapshot` 是 fresh read 的不可变规范化结果。`ConcreteTaskChange` 只允许 `issue_created | issue_archived | field_changed | relation_added | relation_removed`；`field_changed` 的 field 只允许 `status | title | description | parent | labels | delegate | priority`。diff 不包含任何 workflow interpretation。

digest 只验证同一 generation 内 accepted observation 的连续性，不能恢复旧 snapshot。`RootRuntimeState` 是 Root Home 中唯一由 Symphony 管理的 continuity payload，并使用 atomic replace。

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

## Turn outcomes and errors

`RootTurnOutcome` 只表示本轮控制结果：`quiescent | stopped | timed_out | canceled`。它不表达开始、继续、关闭、重跑、完成或交付等 Symphony 领域动作。

Public boundary error 是 closed union：

```text
invalid_contract | stale_generation | capability_denied | timed_out |
canceled | boundary_unavailable | acceptance_unknown | readback_mismatch
```

错误带 identity、correlation 和 sanitized reason，不携带 raw payload、credential、command line 或可能包含 secret 的 stack。

## Fresh read-back rule

所有 Task Manager、Git 和 Delivery mutation 后都必须重新读取同一 exact identity。只有 fresh state 与请求结果一致时，observation baseline 才能前进。并发变化产生 `precondition_failed` 或 concrete diff，交回 Root Reconcill 再次 ReAct；Conductor 不替 Root 选择重试、替代 target 或 workflow transition。
