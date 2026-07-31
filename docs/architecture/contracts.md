# Contracts and Interfaces

状态：Phase 1 目标设计。本文只定义模块间稳定的 public boundary；provider SDK、Codex app-server protocol、MCP transport 和 command process 都是 private implementation。

## Public interfaces

| Interface | 唯一职责 |
|---|---|
| `TaskManageObserverInterface` | 在有界 tick 上 fresh poll Root Tree，并发出 changed-only 完整观察事件 |
| `TaskManageCommandInterface` | 对 capability-scoped caller 实现 provider-neutral Issue/relation query/mutation 与 fresh read-back |
| `RootReconcillFactoryInterface` | 为一个 Root 和 Root Home 创建 identity-bound、code-read-only `RootReconcill` |
| `RootReconcillInterface` | 在 Define、Cycle approval、acceptance 和 delivery 边界运行 semantic ReAct loop |
| `CycleMachineInterface` | 从 approved Cycle 的 fresh facts 计算并执行恰好一个合法 mechanical transition |
| `StagePerformerInterface` | `PlanPerformerInterface | WorkPerformerInterface | VerifyPerformerInterface` closed family；每个实例只执行自己的 role |
| `GitWorkspaceInterface` | 为 Conductor 实现 Root-scoped worktree、status、diff 和 exact commit operations |
| `DeliveryInterface` | 对 accepted exact revision 实现 remote ref 和 pull request operations |

这些接口由 caller 拥有。Linear SDK object、Codex event/thread、MCP session、Git process、filesystem handle 和 credential 不得跨 public boundary。

## Markdown contract

Root description、Root ADR、Cycle/Stage description、所有 role handoff、sanitized summary 和 acceptance reason 都使用一个 branded `MarkdownText`：合法 UTF-8、非空、bounded，并以 `text/markdown` 解释。Markdown 是人和模型可读的 semantic payload，不携带 hidden Symphony JSON、credential、provider metadata 或 runtime control field。

identity、revision、status、correlation、dependency edge、seal digest 和 exact Git revision 保持独立 typed fields；Conductor 不通过自然语言 string matching 推导机械 transition。需要检查 Markdown heading/section 时必须通过标准 Markdown parser 和 closed document schema，不使用 ad-hoc substring parsing。

Task Manager Markdown 和 repository content 都是不可信模型输入，不是 capability。prompt 中的任何指令都不能扩大 out-of-band typed identity、permission、revision 或 tool schema；secret-bearing paths 在读取前由 permission boundary 拒绝，而不是依靠 prompt 要求模型忽略。

## Closed contract families

Phase 1 只需要以下 contract families：

```text
TaskObservationEvent
RootBootstrap | RootFactDiff
TaskSnapshot | GitSnapshot
TaskMcpCall | TaskMcpResult
RootDefinition | CycleSpecification | CycleExecutionSnapshot
CycleAdvanceRequest | CycleAdvanceResult
PlanRequest | WorkRequest | VerifyRequest
PlanResult | WorkResult | VerifyResult
GitToolCall | GitToolResult
DeliveryToolCall | DeliveryToolResult
RootTurnOutcome | RootRuntimeState
```

所有跨 public interface 或 process boundary 的 envelope 都有 `schema_version: 1`、target identity 和 correlation。绑定 runtime 的 envelope 还必须有 `runtime_generation`。版本不是协商机制；unknown variant、missing identity、非 `1` schema、stale generation 或 capability mismatch 均 fail closed。

Public contract 不得包含 SDK object、credential、raw provider payload、Codex config/session、process/thread/filesystem handle、database record、arbitrary metadata、durable next action、persisted diff 或 persisted Performer result。

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
  root_thread_id, performer_thread_ids,
  accepted_observation_digest, in_flight_correlation | null
}
```

`TaskSnapshot` 和 `GitSnapshot` 是 fresh read 的不可变规范化结果。`TaskObservationEvent` 首次观察使用 `from_task_digest: null`、完整 snapshot 和空 changes；后续只在 digest 改变时发出。事件可按 Root 合并为最新完整 snapshot，不作为 action replay；Conductor 从自己的 accepted snapshot重新计算 Root-facing diff。

`ConcreteTaskChange` 只允许 `issue_created | issue_archived | field_changed | relation_added | relation_removed`；`field_changed` 的 field 只允许 `status | title | description | parent | labels | delegate | priority`。diff 只陈述事实，不携带 semantic advice。

## Root and Cycle contracts

```text
RootDefinition {
  root_id, root_revision,
  requirement_markdown, root_adr_markdown,
  acceptance_markdown
}

CycleSpecification {
  cycle_id, cycle_revision, root_id,
  root_definition_revision,
  cycle_description_markdown, root_adr_markdown,
  seal_digest, status: in_progress
}

CycleExecutionSnapshot {
  specification: CycleSpecification,
  plan_issue?, sealed_work_issues[], verify_issue?, sealed_relations[],
  git: GitSnapshot
}
```

`RootDefinition` 的三个 Markdown values 通过标准 Markdown AST 从同一个 Root Issue description 的 closed named sections 得到。`CycleSpecification.root_adr_markdown` 则来自 Cycle description 中在 approval 前复制的 ADR snapshot，绝不在 Plan 或 restart 时读取当前 Root description 重新填充。

Cycle Draft 可以变化，但不构成 approved attempt。`Draft -> In Progress` 的 fresh read-back 生成 `CycleSpecification`；此后 `cycle_description_markdown`、`root_adr_markdown` 和 `seal_digest` 不得变化。Work/Verify graph 由一个 completed PlanResult 一次性物化，并在第一次完整 read-back 后 seal；之后只有 status 和外部执行 facts 可以单向前进。

`CycleMachineInterface.advance` 每次只接受一个 fresh、identity-unique `CycleExecutionSnapshot`，并只返回一个 closed `CycleAdvanceResult`：`advanced | awaiting_acceptance | terminal_failed | precondition_failed | no_action`。它不得返回新需求、架构选择、重规划建议或 successor design。

## Task Manager contracts

每个 generic function 都有独立 typed input/output schema。list function 使用 cursor pagination；mutation input 含 exact target identity、partial desired fields、fresh expected revision 和 caller capability。

```text
TaskMutationResult {
  outcome: applied | not_applied | precondition_failed |
           acceptance_unknown | readback_mismatch,
  correlation_id, target_identity, fresh_resource?, concrete_diff?, sanitized_reason?
}
```

Root capability 只允许 Define、Draft review/seal、Awaiting Acceptance 和 terminal successor 边界的 exact mutations。Cycle-machine capability 只允许 approved Cycle 中的一次性 Stage/DAG materialization 和 closed status transitions。Performer capability 集为空。MCP schema 不暴露 `StartCycle`、`ContinueCycle`、`CloseCycleAndReplan` 或其他 Symphony lifecycle command。

`precondition_failed` 是 tool result，不是 process-level error。Root caller 重新 Observe/Reason；Cycle machine fresh read 后只计算同一 sealed specification 下唯一的机械 transition，否则 terminally fails。

## Performer requests and results

```text
PlanRequest {
  cycle_id, cycle_revision,
  cycle_description_markdown, root_adr_markdown
}

PlanResult {
  outcome: completed | failed | canceled,
  plan_summary_markdown,
  work_items: [{ local_key, title, description_markdown, depends_on_local_keys }],
  verify: { title, description_markdown },
  traceability_markdown
}

WorkRequest {
  cycle_id, cycle_revision, work_issue_id, work_issue_revision,
  cycle_description_markdown, work_issue_description_markdown
}

WorkResult {
  outcome: completed | failed | canceled,
  work_issue_id, workspace_changed, checks, sanitized_summary_markdown
}

VerifyRequest {
  cycle_id, cycle_revision, verify_issue_id, verify_issue_revision,
  cycle_description_markdown, verify_issue_description_markdown,
  revision
}

VerifyResult {
  conclusion: passed | failed | inconclusive,
  verify_issue_id, revision, checks, sanitized_summary_markdown
}
```

Plan request 不含 code capability；Plan 不能补做 Define 或增加 decision。PlanResult 的 local keys 只用于一次 materialization，不能伪装 provider identity。Work Performer instance 绑定一个 Cycle/worktree；同一实例和 thread 可按 sealed graph 依次处理多个 Work Issues，但每个 turn 的显式 input 只有 Cycle Markdown 和当前 Work Markdown。Verify instance 绑定一个 Verify Issue 与 exact revision，并在 fresh context 中只读检查。

Performer result 不创建或更新 Issue，不推进 status，不包含 provider receipt。Conductor只验证 closed evidence、执行被状态机唯一确定的 exact mutation并 fresh read-back；它不解释 summary Markdown。

## Turn outcomes and errors

`RootTurnOutcome` 只表示 semantic boundary turn 的 `quiescent | stopped | timed_out | canceled`，不驱动 approved Cycle 的 Stage。Cycle transitions 只通过 `CycleAdvanceResult` 表达。

Public boundary error 是 closed union：

```text
invalid_contract | stale_generation | capability_denied | timed_out |
canceled | boundary_unavailable | acceptance_unknown | readback_mismatch |
sealed_spec_changed | execution_graph_invalid | lost_execution_context
```

错误带 identity、correlation 和 sanitized Markdown reason，不携带 raw payload、credential、command line 或可能包含 secret 的 stack。

## Fresh read-back rule

所有 Task Manager、Git 和 Delivery mutation 后都必须重新读取同一 exact identity。只有 fresh state 与请求结果一致时，对应事实才能前进；polling observation baseline 仍只由完整成功 poll 推进。

Root boundary 的并发变化返回 Root Reconcill；Cycle machine 的并发变化只允许按相同 seal digest 重新计算机械 transition。sealed specification、graph、HEAD 或 exact revision 无法唯一确认时，不修改当前设计、不选择替代 target，直接产生可见 terminal failure。
