# Cycle Supervisor

状态：目标架构提案。本文是模型驱动的Cycle ReAct、完整Cycle observation、DAG修改、Human Action proposal
和`CycleDirective`协议的唯一事实源。Root级确定性控制由
[Root Reconciliation Loop](root-reconciliation.md)定义；Plan、Work、Verify执行contract由
[Performer Stage Contracts](stage-orchestration.md)定义；用户可见Cycle时间轴只由
[Workflow Timeline](workflow-timeline.md)定义。

## 1. 目标

Cycle Supervisor持续观察当前Cycle的完整durable facts，并告诉Conductor下一步如何推进。它解决无法由
机械状态机健壮处理的语义问题：

- Plan Result是否完整、是否应请求review或再次Plan；
- 当前应执行哪个ready Work；
- Work失败后应继续、换方法、调整DAG、请求Human还是结束Cycle；
- 是否需要新增、更新、归档、恢复、重排或重连节点；
- Verify Result应继续修复、结束Cycle还是请求Human；
- Human Action创建什么内容，以及resolution后如何恢复；
- 当前Cycle是否`succeeded`、`repair_required`、`exhausted`或`canceled`。

Supervisor运行在Performer内并使用独立Provider thread。它不执行Plan/Work/Verify，不修改代码，不调用
Linear/Git/Conductor，也不拥有durable workflow state。

## 2. 每个Cycle四个隔离角色

```text
Cycle
├── Supervisor Thread  # semantic ReAct and next-step proposal
├── Plan Thread        # Plan turns only
├── Work Thread        # multiple Work Issues and turns
└── Verify Thread      # Verify turns only
```

四个角色不共享Provider thread。一个thread不能兼任另一个角色；Work尤其不能兼任Supervisor。每个thread只
存在于一个Cycle，不能跨Cycle复用。角色thread可以有多个turn，但每个turn都必须由Conductor主动调用。

## 3. ReAct边界

Supervisor的loop由连续的Conductor calls组成：

```text
Observation: complete current Cycle Tree + new durable facts
Reason:      model evaluates contract, DAG, results, Human input and budget
Action:      one closed CycleDirective
Materialize: Conductor validates, writes and reads back
Observation: next complete current Cycle Tree
```

Supervisor不能在一次turn中隐藏多步workflow。每次最多返回一个directive；需要多个durable mutation的领域动作
由Conductor按一个stable directive ID幂等materialize并read-back。后续决策必须等待更新后的Tree。
accepted directive和materialized outcome通过typed Cycle Timeline events发布；Supervisor和materializer都不
直接创建用户时间轴comment。

## 4. CycleSupervisorObservation contract

```text
CycleSupervisorObservation
  protocol_version
  request_id
  supervisor_session_id
  supervisor_turn_id
  observed_at
  root
    root_issue
    objective
    scope
    acceptance_criteria[]
    constraints[]
    root_status
    convergence_summary
  cycle
    cycle_issue
    predecessor_cycle?
    cycle_status
    active_plan_contract?
    budget
  tree
    issues[]
      issue_id
      kind: plan | work | verify | human
      parent_issue_id
      title
      description
      status
      remote_version
      is_archived
      archived_at?
    relations[]
    comments[]
    plan_results[]
    work_results[]
    verify_results[]
    human_action_records[]
    human_action_resolutions[]
    accepted_directives[]
  git_facts
  latest_changes[]
  source_manifest[]
  coverage
  observed_tree_digest
  limits
```

`tree`必须包含当前Cycle下全部active和archived Issues、相关relations、用户comments、managed comments、
Stage Results和Human Action resolutions。Linear读取必须使用include-archived能力；默认省略archive的查询不是
完整observation。

所有用户和Provider文本都是untrusted data，必须保留source identity、author kind、remote version和长度
边界。未知字段、截断required fact、Tree digest不匹配或无法证明完整coverage时不得调用Supervisor。

同一Supervisor thread允许Provider利用历史上下文和prompt cache，但每个turn仍注入完整authoritative Tree。
transcript中的旧事实不能覆盖本轮observation。

## 5. CycleDirective contract

```text
CycleDirective
  protocol_version
  request_id
  directive_id
  supervisor_session_id
  supervisor_turn_id
  based_on_tree_digest
  rationale
  evidence_refs[]
  action:
    ExecutePlanDirective |
    ReviseCycleTreeDirective |
    ExecuteWorkDirective |
    ExecuteVerifyDirective |
    RequestHumanActionDirective |
    WaitDirective |
    ConcludeCycleDirective
```

所有variants都是closed、versioned、`additionalProperties: false`的discriminated union。Supervisor不能返回
GraphQL、Linear字段patch、shell command、任意callback或未知状态名。

### 5.1 ExecutePlanDirective

```text
kind: execute_plan
plan_issue_id
plan_goal
required_outputs[]
prior_plan_result_ids[]
human_resolution_ids[]
```

Conductor验证Plan属于当前Cycle且可以进入Plan turn，再按Stage contract调用Plan thread。

### 5.2 ReviseCycleTreeDirective

```text
kind: revise_cycle_tree
reason
operations[]:
  CreateNodeOperation |
  UpdateNodeOperation |
  ArchiveNodeOperation |
  RestoreNodeOperation |
  ReorderNodesOperation |
  ReplaceDependenciesOperation |
  CreateRelationOperation |
  RemoveRelationOperation
```

每个operation携带matching target、`expected_remote_version`、`expected_status`、
`expected_is_archived`和必要的parent/relationship precondition。Conductor拒绝跨Root/Cycle target、循环依赖、
重复managed key、stale precondition或无法read-back的patch。

一次Tree revision可以包含多个相互依赖的operation，但它们共享一个directive ID和一个期望Tree digest。
Conductor按确定顺序执行；partial materialization后必须从remote facts幂等收敛，不能重新询问模型并制造第二份
逻辑patch。

### 5.3 Archive与restore

Supervisor语义上的delete使用Linear原生archive flag：

```text
ArchiveNodeOperation
  issue_id
  reason
  replacement_issue_ids[]
  dependency_rewrites[]

RestoreNodeOperation
  issue_id
  reason
  restored_status_id
  dependency_rewrites[]
```

archive不是物理删除。Issue description、status、comments、results、relations和Human Action links全部保留，
后续observation继续包含该Issue。archive flag是active DAG membership authority：

- `is_archived=false`的Plan/Work/Verify才参与ready和terminal计算；
- `is_archived=true`的Issue不dispatch，但仍参与历史、budget、attempt和审计；
- status描述Issue归档前最后一个workflow lifecycle state；archive flag独立描述结构成员资格；
- restore必须显式给出允许的active status和依赖重写，不能隐式恢复旧execution；
- archive active/running node前Conductor必须终止matching execution并read-back；
- active dependency不能悬空指向archived node，除非同一patch提供replacement或dependency rewrite。

Linear relation本身没有Issue archive flag。删除或重写relation使用`RemoveRelationOperation`；旧relation identity、
原因和replacement保存在immutable accepted directive record中，不能伪造原生relation archive。

Human Action改变业务需求后，Supervisor可以据resolution归档、恢复或替换节点；旧节点和用户决定永久可见。

### 5.4 ExecuteWorkDirective

```text
kind: execute_work
work_issue_id
execution_goal
required_checks[]
dependency_evidence_refs[]
```

target必须是当前active DAG中的ready Work。Conductor负责机械验证ready条件；Supervisor负责语义选择哪个
ready Work以及为什么。整个Cycle只有一个Work thread，多个Work Issues通过多个turn顺序交给它。

### 5.5 ExecuteVerifyDirective

```text
kind: execute_verify
verify_issue_id
target_revision
required_evidence_refs[]
```

Conductor验证active required Work和依赖已经完成、target revision固定后，调用独立Verify thread。

### 5.6 RequestHumanActionDirective

```text
kind: request_human_action
action_kind
parent_scope: cycle | root
related_issue_ids[]
title
requested_decision
context
options[]
  terminal_status
  meaning
  workflow_consequence
  comment_requirement
evidence_refs[]
```

Cycle Action是Cycle直接子Issue，只通过relations链接Plan/Work/Verify；Root全局Action是Root直接子Issue。
Supervisor生成用户需要理解的完整语义内容，Conductor使用固定模板、labels和managed marker创建并read-back。
Action status、comment要求和resolution由[Human Action](human-actions.md)定义。

### 5.7 Wait与Conclude

```text
WaitDirective
  kind: wait
  reason_code
  blocking_fact_refs[]

ConcludeCycleDirective
  kind: conclude_cycle
  conclusion: succeeded | repair_required | exhausted | canceled
  completed_work_ids[]
  unresolved_finding_ids[]
  attempted_approach_refs[]
  verification_evidence_refs[]
  successor_reason?
```

Supervisor不能通过`wait`制造无deadline的隐式等待。等待必须对应active Human Action、外部事实或有界runtime
condition。`exhausted`必须匹配Conductor可机械验证的Cycle budget事实。

## 6. Result与用户变化如何进入Supervisor

Plan、Work、Verify返回的Result由Conductor先验证和持久化，不能直接作为transient prompt继续：

```text
Stage Result
-> validate correlation/schema/preconditions
-> persist managed Result record
-> semantic read-back
-> rebuild complete Cycle Tree including Result
-> advance Supervisor
```

Human Action同样遵循：

```text
user status/comment change
-> fresh read complete Action
-> validate actor, transition, comment requirements and stale facts
-> persist closed resolution
-> rebuild complete Cycle Tree including Action and resolution
-> advance Supervisor
```

用户对Cycle内任意Issue的合法修改、comment、archive/restore和relation变化都进入`latest_changes`并反映在完整
Tree中。Supervisor必须基于新digest重新决定；旧directive不能重放。

## 7. Budget与成本

Root Loop不消耗模型token。Cycle Supervisor确实增加模型调用，但只在durable checkpoint运行，不在每个
Provider tool call、heartbeat或普通命令错误后运行。普通实现错误由当前Work turn内部处理。

Supervisor拥有独立model/effort/output配置和Cycle级预算：

```text
SupervisorLimits
  max_turns
  max_total_tokens
  max_input_bytes_per_turn
  max_output_bytes_per_turn
  deadline_at
```

完整Tree必须bounded；超过限制时fail closed并产生可见attention，不能静默省略required facts或用没有source
identity的模型摘要替代。Provider prompt cache和同thread增量历史只能优化费用，不能改变正确性。

## 8. 失败与恢复

| 故障 | 处理 |
|---|---|
| Supervisor output不符合schema | 拒绝并在预算内对同一observation创建fresh turn |
| directive stale | 不materialize；fresh Tree后再次advance |
| partial Linear mutation | 使用directive ID和remote read-back幂等收敛 |
| Supervisor thread丢失 | 用完整Cycle Tree打开fresh Supervisor thread |
| Stage thread丢失 | Result未持久化则丢弃，从facts创建fresh matching role thread/turn |
| Cycle budget耗尽 | Supervisor返回`exhausted`；Root Loop执行Root gate |
| Root canceled/ownership变化 | 终止四个role sessions，拒绝任何late output |

## 9. 不变量

1. 每个Cycle恰有一个active Supervisor session；恢复时旧session立即失效。
2. Supervisor、Plan、Work、Verify四个Provider thread互相隔离且不跨Cycle。
3. Supervisor是Cycle下一步语义的唯一模型决策者，但不是Workflow authority。
4. 每次Supervisor turn读取完整active和archived Cycle Tree。
5. 每个turn最多返回一个closed `CycleDirective`。
6. 所有Linear/Git副作用由Conductor验证、materialize和read-back。
7. 原生archive flag决定active DAG membership；archive永不等于物理删除。
8. Plan/Work/Verify Result和Human resolution必须durable后才能成为observation。
9. Performer不反向调用Conductor。
