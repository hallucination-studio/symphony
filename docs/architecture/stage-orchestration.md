# Performer Plan、Work与Verify Contracts

状态：目标架构提案。本文是Conductor调用Performer执行Plan、Work和Verify的request/result contract、角色
thread、capability和Result语义的唯一事实源。Root/Cycle下一步和用户comment处理由
[Root Reconciliation](root-reconciliation.md)决定。本文不定义Root directive或Human Action状态。

## 1. 决定

每个Cycle拥有三个互相隔离的执行角色thread：

```text
Plan Thread
  -> only PlanTurnRequest / PlanResult

Work Thread
  -> multiple WorkTurnRequest / WorkResult across multiple Work Issues

Verify Thread
  -> only VerifyTurnRequest / VerifyResult
```

它们与Root Reconciler thread也互相隔离。Conductor是唯一caller；Performer独占Provider SDK、thread、turn、
tool loop和Provider错误归一化。Performer不调用Linear、Conductor或Git topology。

Plan、Work和Verify Result只报告执行事实，不决定下一个Stage、不创建Human Action、不修改Cycle DAG。Result
被Conductor持久化并进入完整Root Tree后，Root Reconciler才决定下一步。

## 2. 公共wire envelope

三个request共享closed envelope：

```text
StageTurnRequestEnvelope
  protocol_version
  request_id
  stage_execution_id
  role: plan | work | verify
  role_session_id
  role_turn_id
  root_issue_id
  cycle_issue_id
  target_issue_id
  observed_tree_digest
  source_manifest[]
  coverage
  instruction_bundle
  workflow_context:
    PlanTurnContext | WorkTurnContext | VerifyTurnContext
  repository_context
  execution_policy
  limits
  context_digest
```

```text
StageTurnResultEnvelope
  protocol_version
  request_id
  stage_execution_id
  role
  role_session_id
  role_turn_id
  root_issue_id
  cycle_issue_id
  target_issue_id
  observed_tree_digest
  context_digest
  completed_at
  outcome:
    PlanResult | WorkResult | VerifyResult
  usage?
```

`role`是discriminator；context和result variant必须matching。未知字段、未知variant、role/session不匹配、
source coverage不完整、digest错误或超出bound均fail closed。所有schema使用`additionalProperties: false`，由
JSON Schema生成各语言的generated codecs；生成语言集合由[契约与接口边界](contracts.md)统一定义。

## 3. Session与turn

- 一个Cycle最多一个Plan role session、一个Work role session和一个Verify role session；
- role sessions不得共享Provider thread，也不得跨Cycle复用；
- Plan和Verify role可以有多个turn，例如Plan rejection后的revision或同Cycle修复后的再次Verify；
- Work role在同一Cycle跨多个Work Issues和turn持续存在，以保留实现上下文；
- 每个turn有独立`stage_execution_id`、context digest、deadline、reservation和terminal Result；
- role thread是runtime continuity，不是durable authority；thread丢失时从Linear/Git facts创建fresh role session；
- stale session/turn output不得materialize。

同一thread不会放宽每个turn的target和capability。历史conversation只能帮助执行，不能授权当前request未授予
的scope、workspace access或workflow mutation。

## 4. 公共source、repository与limits

```text
StageContextSource
  source_kind: linear_issue | linear_comment | linear_relation | git | repository_instruction
  source_id
  version_or_digest

StageContextCoverage
  is_complete
  omissions[]
    source_id
    reason

RepositoryContext
  workspace_root_capability
  baseline_revision
  target_revision?
  diff_summary
  repository_instructions[]

StageLimits
  max_context_bytes
  max_result_bytes
  max_output_tokens
  max_tool_calls
  max_wall_time_ms
  deadline_at
```

Root objective、current Plan Contract、target Node、dependencies、Human resolutions和Git revision是matching
turn的required input。非必要历史可以省略，但必须在coverage中列出source identity和原因；不能静默截断。

## 5. Plan contract

### 5.1 PlanTurnRequest

```text
PlanTurnContext
  root_contract
    objective
    requested_scope
    constraints[]
    acceptance_criteria[]
  cycle
    cycle_issue_id
    trigger
    predecessor_cycle?
  current_plan_issue
  prior_plan_results[]
  prior_plan_contracts[]
  unresolved_findings[]
  human_resolutions[]
  current_git_facts
  required_output
```

Plan is read-only. It may inspect repository and history but cannot edit files, mutateLinear, createIssues or execute
delivery. A Plan turn returns a proposal; only Root Reconciler can request materialization/review.

### 5.2 PlanResult

```text
PlanResult =
  | PlanCompletedResult
  | PlanNeedsInformationResult
  | PlanBlockedResult
  | StageBudgetExhaustedResult
  | StageCanceledResult
  | StageExecutionFailedResult
```

```text
PlanCompletedResult
  kind: plan_completed
  plan_contract
    objective
    included_scope[]
    excluded_scope[]
    assumptions[]
    constraints[]
    acceptance_criteria[]
    verification_requirements[]
  proposed_work_dag
    work_nodes[]
      proposal_key
      title
      description
      expected_outcome
      required_checks[]
    dependency_edges[]
    verify_node
  risks[]
  required_permissions[]
  evidence_refs[]
```

`PlanNeedsInformationResult`只报告缺失问题、其影响和evidence；它不能创建clarification Action。
`PlanBlockedResult`报告无法形成有效Plan的closed reason和attempts。Plan Contract digest由Conductor对validated
canonical Result计算并持久化，不信任模型自报digest。

## 6. Work contract

### 6.1 WorkTurnRequest

```text
WorkTurnContext
  approved_plan_contract
  current_active_work_dag
  selected_work
    issue_id
    title
    description
    expected_outcome
    required_checks[]
    dependency_evidence[]
  completed_work_evidence[]
  prior_turn_results[]
  human_resolutions[]
  git_baseline
  workspace_capability
```

一个Cycle只有一个Work thread。Conductor在不同turn中把Root Reconciler选择且机械ready的Work Issue依次交给
它。Work thread可以在当前turn内部执行Claude Code式tool loop：读取代码、修改、运行命令、观察普通错误、
修复和重试，直到完成、需要外部输入或达到turn预算。

Work只能修改授予的Root worktree，不能commit、push、创建worktree、调用Linear、改变DAG或执行另一个
Work Issue。发现需要调整DAG时只报告structured observation；Root Reconciler决定是否提出Tree revision。

### 6.2 WorkResult

```text
WorkResult =
  | WorkCompletedResult
  | WorkBlockedResult
  | WorkPlanAssumptionInvalidResult
  | WorkScopeConflictResult
  | WorkPermissionRequiredResult
  | WorkInformationRequiredResult
  | StageBudgetExhaustedResult
  | StageCanceledResult
  | StageExecutionFailedResult
```

```text
WorkCompletedResult
  kind: work_completed
  actual_changes[]
  checks[]
    check_key
    command_or_method
    outcome
    evidence_ref
  artifacts[]
  discovered_facts[]
  git_worktree_state
  evidence_refs[]
```

```text
WorkBlockedResult
  kind: work_blocked
  blocker_kind
  sanitized_reason
  attempted_approaches[]
  failed_check_evidence[]
  discovered_facts[]
  suggested_dag_changes[]
```

普通command或test失败不是自动terminal Result；Work agent应在turn预算内继续诊断。只有无法在当前target和
capability内继续时才返回blocked/specialized result。`suggested_dag_changes`只是observation，不是directive。

## 7. Verify contract

### 7.1 VerifyTurnRequest

```text
VerifyTurnContext
  approved_plan_contract
  complete_active_cycle_dag
  archived_cycle_nodes[]
  completed_work_results[]
  unresolved_findings[]
  human_resolutions[]
  verification_requirements[]
  immutable_target_revision
  repository_snapshot
```

Verify使用独立、read-only thread，不继承Plan、Work或Root Reconciler conversation。它不能修改文件、补做Work、
修改DAG、创建Human Action或改变Finding状态。每个Result绑定immutable target revision。

### 7.2 VerifyResult

```text
VerifyResult =
  | VerifyPassedResult
  | VerifyChangesRequiredResult
  | VerifyInconclusiveResult
  | VerifyPlanContractViolationResult
  | VerifyBlockedResult
  | StageBudgetExhaustedResult
  | StageCanceledResult
  | StageExecutionFailedResult
```

```text
VerifyPassedResult
  kind: verify_passed
  target_revision
  acceptance_results[]
  checks[]
  resolved_finding_ids[]
  evidence_refs[]

VerifyChangesRequiredResult
  kind: verify_changes_required
  target_revision
  acceptance_results[]
  findings[]
    finding_id
    severity
    description
    evidence_refs[]
    related_work_issue_ids[]
  checks[]
```

```text
VerifyInconclusiveResult
  kind: verify_inconclusive
  target_revision
  missing_evidence[]
  attempted_methods[]
  retryable
```

Conductor验证target revision和evidence，持久化Result后交给Root Reconciler。Conductor不把
`verify_changes_required`机械映射为successor Cycle；Root Reconciler可以在当前Cycle预算内继续Work，也可以提出
repair conclusion。

## 8. 公共terminal variants

```text
StageBudgetExhaustedResult
  kind: budget_exhausted
  budget_kind
  usage
  attempted_approaches[]
  resumable_facts[]

StageCanceledResult
  kind: canceled
  sanitized_reason

StageExecutionFailedResult
  kind: execution_failed
  error_code
  sanitized_reason
  retryable
```

Provider transport/crash/schema failure与业务blocked必须区分。只有validated Result能进入Linear；无Result的
process failure写execution failure record并由下一次Root Reconciler observation处理，不能伪造业务结论。

## 9. Human input边界

Plan、Work、Verify不能创建Human Action。它们只能通过typed Result报告：

```text
information_required
permission_required
plan_assumption_invalid
scope_conflict
verification_blocked
```

Conductor持久化Result后，Root Reconciler决定是否请求Human Action、调整DAG、继续执行或结束Cycle。
resolved Human Action在Conductor验证后作为closed `human_resolutions[]`进入matching下一turn。

## 10. Event、Result与materialization

Performer可以返回bounded progress/heartbeat/tool summary Event，但Event不决定业务完成，也不成为恢复输入。
每个turn必须有一个terminal Result，或由Conductor记录process/transport failure。

Result接受顺序固定：

```text
fresh-read Root/Cycle/target/Git preconditions
-> validate wire schema, role/session/turn correlation and context digest
-> validate target revision and capability-specific evidence
-> persist immutable Result record with stable execution ID
-> semantic read-back
-> settle token reservation
-> rebuild complete Root Tree
-> advance Root Reconciler
```

## 11. Provider boundary与安全

```text
ProviderBackendInterface
  open_role_session(role, settings)
  execute_role_turn(session, request, workspace_capability?)
  close_role_session(session)
```

只有Performer backend使用Provider SDK。公共contract不能包含SDK object、raw Provider thread ID、Token、
credential path、raw reasoning或完整transcript。Performer映射model、effort、sandbox、deadline、interrupt和
structured output；无法表达execution policy时fail closed。

Plan和Verify必须read-only；Work是workspace-write。每个turn执行wall time、context bytes、result bytes、tool
calls和output token limits。取消、Root ownership变化、Cycle terminal或archive active target时，Conductor使
matching turn/session失效并拒绝late output。

## 12. 不变量

1. 每个Cycle的Plan、Work、Verify使用三个不同Provider thread。
2. Work thread跨当前Cycle多个Work Issues和turn复用，但每turn只执行一个selected target。
3. Plan/Work/Verify都不决定下一步、不修改DAG、不创建Human Action。
4. 所有request/result是closed、versioned、generated的强类型contract。
5. Conductor是唯一caller；Performer不反向调用Conductor。
6. Result必须durable并read-back后才能交给Root Reconciler。
7. Provider thread不是durable authority；丢失后从Linear/Git facts恢复。
8. Plan/Verify read-only，Work只能修改授予的Root worktree。
