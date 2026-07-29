# Contracts and Interfaces

状态：Phase 1 目标设计。本文只定义模块之间必须稳定的 public boundary；SDK 和进程协议都是 private implementation。

## Public interfaces

| Interface | 唯一职责 |
|---|---|
| `LinearGatewayInterface` | 发现 Root、读取 Root Tree、执行带前置条件的机械 Linear mutation |
| `RootReconcillFactoryInterface` | 为一个 Root 和 Root Home 创建绑定 identity 的 `RootReconcill` |
| `RootReconcillInterface` | 接收 bootstrap / diff，产生 Performer tool call 或 `RootDecision` |
| `StagePerformerInterface` | 执行 `plan`、`work`、`verify`，返回对应 typed Handoff |
| `GitWorkspaceInterface` | 为一个 Root 准备、读取并 commit 独立 worktree |
| `DeliveryInterface` | push 指定 revision，并创建或读取对应 PR |

这些接口由 caller 拥有。Linear SDK、Codex app-server protocol 和 Git command/process 只能出现在各接口的 private implementation 内。不存在 public `CodexGateway`。

## Closed contracts

Phase 1 只需要以下 contract family：

```text
RootBootstrap | RootObservationDiff
RootToolCall | RootDecision
PlanRequest | WorkRequest | VerifyRequest
PlanHandoff | WorkHandoff | VerifyHandoff
LinearObservation | GitObservation
MutationResult | RootRuntimeState
```

所有 contract 都有 `schema_version`、目标 identity 和 correlation。unknown variant、missing identity、stale runtime generation 或 precondition mismatch 必须 fail closed。

`schema_version` 只版本化跨 public interface 或 app-server process boundary 的
message envelope，Phase 1 唯一接受值为 `1`。Linear description、Git content、
`state.json` 和 private SDK / CLI payload 不属于 public contract schema。版本不是协商
机制；收到非 `1` 值必须停止当前动作并返回 sanitized boundary error。

Public contract 不得包含 SDK object、credential、Codex session/config、process/thread/filesystem handle、database record、arbitrary metadata、DAG mirror、durable next action 或 persisted Handoff。

## Observation and runtime shapes

`LinearObservation` 是一次 fresh read 的不可变规范化结果：Root identity/status、唯一
active Cycle（如有）以及该 Cycle 的直接 Stage identity/kind/status/dependency。它只包含
做机械前置条件判断所需的 Linear 字段，不包含 SDK record 或历史事件。

`GitObservation` 是对应 Root worktree 的 fresh read：repository identity、base/head
branch、HEAD revision、工作区 clean/dirty 与 diff digest，以及匹配 PR 的规范化
identity/state/head revision（如有）。它不包含 credential、command 或 process object。

```text
RootBootstrap {
  schema_version: 1, root_id, runtime_generation, correlation_id,
  observed_at, linear: LinearObservation, git: GitObservation
}

RootObservationDiff {
  schema_version: 1, root_id, runtime_generation, correlation_id,
  from_observation_digest, to_observation_digest,
  changed_linear_facts, changed_git_facts
}

RootRuntimeState {
  schema_version: 1, root_id, runtime_generation,
  thread_id, accepted_observation_digest, in_flight_correlation | null
}
```

`changed_*_facts` 是 closed typed field changes，只描述 before/after scalar 或 identity
集合变化；不得嵌入完整 observation、DAG mirror、Handoff 或 next action。digest 只用于
验证连续性，不能恢复 observation。`RootRuntimeState` 是 Root Home 中唯一由 Symphony
管理的 continuity payload；写入采用 atomic replace，identity、generation 或 schema
不匹配时 fail closed。

## Handoff

三个 Performer 返回 closed typed response：

```text
PlanHandoff   { cycle_issue_id, plan_issue_id, work_issue_ids, verify_issue_id, outcome }
WorkHandoff   { cycle_issue_id, work_issue_id, outcome, workspace_changed }
VerifyHandoff { cycle_issue_id, verify_issue_id, revision, conclusion }
```

- `PlanHandoff.outcome` 只能是 `completed | failed | canceled`。
- `WorkHandoff.outcome` 只能是 `completed | failed | canceled`。
- `VerifyHandoff.conclusion` 只能是 `passed | failed | inconclusive`。

`completed` 只声称 role 已完成调用；`failed` 表示 role 给出 sanitized terminal failure；
`canceled` 表示 turn 在产生可接受结果前被取消。Handoff 不写入 Linear、Git 或 Root
Home，也不代表其中声称的写入已经发生。Conductor 对任一 outcome 都重新读取事实；
Handoff 与 fresh facts 不一致时使用 `readback_mismatch`，不得猜测或补写。

## Boundary errors

Public interface error 是 closed union：`invalid_contract | stale_generation |
precondition_failed | timed_out | canceled | boundary_unavailable |
acceptance_unknown | readback_mismatch`，并带 identity、correlation 和 sanitized reason。
错误不得携带 raw provider payload、credential、command line 或 stack 中的 secret。

## 重新读取规则

外部 mutation 的返回值只表示调用结果：

```text
applied | not_applied | acceptance_unknown | precondition_failed | readback_mismatch
```

Conductor 必须重新读取对应 Linear / Git target。只有实际状态符合预期，accepted baseline 才能前进；否则将完整 observation 或实际 diff 交回对应 `RootReconcill`。
