# Root Reconciliation

状态：目标架构提案。本文是Root Reconciler语义角色、Conductor reconciliation host、完整Root observation、
用户comment输入与回复、Root/Cycle revision、`RootDirective`以及跨Cycle恢复的唯一事实源。Plan、Work、Verify
执行contract由[Performer Stage Contracts](stage-orchestration.md)定义；Human Action生命周期由
[Human Action](human-actions.md)定义；用户可见时间轴由[Workflow Timeline](workflow-timeline.md)定义。

## 1. 决定

每个Root只有一个语义决策者：运行在Performer中的Root Reconciler。它跨当前Root的全部Cycles持续追求Root
目标，观察Linear/Git durable facts，解释用户普通comment和Stage Results，并返回一个closed、versioned
`RootDirective`告诉Conductor下一步。

Cycle不是独立自治workflow，也没有Cycle Supervisor。Cycle是Root Reconciler管理的一次有预算执行尝试；
Cycle的Plan、Work、Verify、DAG、Human Actions和status都是Root reconciliation state的一部分。

```text
Root
├── Root Reconciler Session       # one semantic role across all Cycles
├── Cycle 1
│   ├── Plan Session
│   ├── Work Session
│   └── Verify Session
├── Cycle 2
│   ├── Plan Session
│   ├── Work Session
│   └── Verify Session
└── Root Human Actions
```

Conductor仍是唯一caller和副作用owner。它确定性地读取、校验、materialize、read-back和恢复，但不解释自然
语言、不选择下一个Stage，也不自行判断replan或successor Cycle。

## 2. 一个Reconciliation，两种职责

Root Reconciliation是一个产品控制机制，由两个不能互相替代的执行边界组成：

| 边界 | owner | 职责 |
|---|---|---|
| Reconciliation host | Conductor TypeScript | wake、fresh read、机械gate、调用、materialize、read-back、恢复 |
| Root Reconciler role | Performer Python | 解释完整Root事实并选择唯一下一步 |

这不是两个语义loop。只有Root Reconciler决定业务下一步；Conductor只实施不可由模型绕过的机械不变量。
Root Reconciler不能调用Linear/Git/Conductor，不能直接执行Plan/Work/Verify，也不能返回任意GraphQL、shell
command或callback。Conductor不包含Agent SDK或Provider兼容逻辑。

```text
wake on durable change
-> Conductor reads fresh complete Root Tree and Git facts
-> enforce immediate safety and lifecycle gates
-> call Root Reconciler with one complete observation
-> validate one RootDirective
-> persist accepted directive
-> materialize one semantic action with stable write IDs
-> semantic read-back
-> materialize and read back required user-comment replies
-> publish and materialize required timeline events
-> discard transient view
```

Root Reconciliation是event-driven的，不是持续消耗token的poll loop。没有新的durable事实、未materialize
directive或到期机械deadline时，不调用模型。

## 3. Session与角色隔离

- 每个active Root最多一个Root Reconciler session；它可以跨多个Cycles和turn复用；
- 每个Cycle最多一个Plan、一个Work和一个Verify role session，三个session互相隔离；
- Root Reconciler session不能兼任Plan、Work或Verify；
- Cycle结束时关闭该Cycle的三个Stage sessions，successor Cycle使用fresh Stage sessions；
- Root Reconciler thread只提供runtime continuity，不是durable authority；丢失后从Linear/Git打开fresh session；
- 每次Reconciler turn仍注入完整authoritative observation，旧transcript不能覆盖本轮事实。

## 4. RootReconcilerObservation contract

```text
RootReconcilerObservation
  protocol_version
  request_id
  reconciler_session_id
  reconciler_turn_id
  observed_at
  root
    root_issue
    objective
    scope
    acceptance_criteria[]
    constraints[]
    root_status
    ownership
    convergence_summary
  cycles[]
    cycle_issue
    predecessor_cycle?
    cycle_status
    is_archived
    active_plan_contract?
    budget
    outcome?
    issues[]
    relations[]
    plan_results[]
    work_results[]
    verify_results[]
    findings[]
    human_action_records[]
    human_action_resolutions[]
  root_human_actions[]
  accepted_root_directives[]
  pending_user_comments[]
  handled_user_comment_versions[]
  external_linear_changes[]
  workflow_change_resolutions[]
  git_facts
  delivery
  source_manifest[]
  coverage
  observed_root_tree_digest
  limits
```

observation必须包含Root下全部active和archived Cycles、每个Cycle下全部active和archived Issues、relations、
managed records、Human resolutions和用户comment。Linear读取必须分页到完整并使用include-archived能力。

所有Linear文本和Provider输出都是untrusted data。每个source保留identity、actor kind、remote version或digest
和长度边界。未知字段、required source被静默截断、Tree digest不匹配或coverage不完整时不得调用Reconciler。

## 5. 用户comment输入

用户可以在Root、Cycle、Plan、Work、Verify或Human Action Issue下用普通自然语言comment改变、纠正或询问
执行，不需要JSON、command、directive ID或结构化revision。例如：

```text
这个Plan漏了数据库迁移，请重新规划。
当前实现方向不合理，改成事件驱动。
测试环境刚才有问题，请重新跑Verify。
认证暂时不做，先完成只读查询。
```

### 5.1 过滤规则

`pending_user_comments`只包含human actor创建且没有Symphony managed marker的普通comment。必须排除：

- Root Primary Status Comment；
- Root/Cycle Timeline projection comments；
- Root Reconciler directive和reply records；
- Plan/Work/Verify Result records；
- Human Action request/resolution records；
- Finding、budget、convergence和delivery records；
- Symphony bot、Linear integration或其他automation actor创建的comment。

过滤依据是validated actor identity与managed marker，不是“第一条comment”、作者显示名、文本前缀或comment
位置。即使Primary Status Comment不再是第一条也必须排除；用户创建的第一条普通comment必须保留。

```text
UserCommentInput
  comment_id
  comment_version
  issue_id
  issue_kind: root | cycle | plan | work | verify | human_action
  cycle_issue_id?
  author_user_id
  body
  created_at
  updated_at
```

同一`comment_id + comment_version`最多处理一次。编辑后的comment version是新的输入；已经materialize的旧
comment决定不会因删除或编辑自动回滚，用户必须通过新version或新comment明确纠正。

Human Action中的用户comment既保留为完整Action上下文，也只有在matching status和时序校验后才能形成
`HumanActionResolutionRecord`；Root Reconciler不能把普通comment伪造成Approved、Rejected或Answered。Action
仍为Todo/In Progress时，reason/answer comment可以收到“等待状态选择”的回复，但不能提前产生审批后果。若同一
comment明确提出独立Root/Cycle revision，Reconciler必须把该revision disposition与尚未成立的Action resolution
分开记录。

### 5.2 非comment的Linear变化

用户直接修改status、description、archive、parent或relation也会wake Root Reconciliation。Conductor根据最新
Linear remote version、上一份accepted source manifest以及Symphony stable write IDs，生成内部变化事实；用户
不创建或填写该结构。

```text
ExternalLinearChangeInput
  change_id
  actor_kind: human | external_automation | unknown
  target_issue_id
  issue_kind: root | cycle | plan | work | verify | human_action
  change_kind: status | content | archive | parent | relation
  before_version_or_digest
  after_version_or_digest
  changed_field_names[]
  relation_ids[]
  observed_at
```

Symphony自身已read-back且带matching stable write ID的mutation不生成external change。每个`change_id`最多被一个
accepted directive处理，并写`WorkflowChangeResolutionRecord`；这样重启后不会重复replan或重复创建Cycle。

### 5.3 reconciliation barrier与并发

新的pending用户comment或external Linear change会wake Root Reconciliation并阻止新的Stage dispatch。
Conductor记录当前in-flight execution identity和Git state，但不会自行猜测业务影响。

Root Reconciler可以决定当前turn继续，也可以要求cancel/rerun/replan/supersede。若directive使当前turn失效，
Conductor先取消matching execution并read-back cancellation，再执行后续动作。barrier后产生的late Result必须
同时匹配execution identity、target remote version、Git precondition以及当前Root Tree digest或matching
`ExecutionContinuationRecord`，否则拒绝。

## 6. 用户comment回复contract

每个被处理的pending comment version必须由同一个`RootDirective`给出一个closed disposition和用户可见回复。
多个comment表达同一意图时可以共享一个decision，但每个comment version仍必须被显式覆盖。

```text
UserCommentDisposition
  source_comment_id
  source_comment_version
  interpretation:
    question | feedback | execution_instruction | requirement_revision |
    approval_context | cancellation_request | no_action
  impact:
    none | current_stage | current_cycle_dag | current_cycle_plan |
    root_contract | human_action
  decision_ref
  reply
    acknowledgement
    interpreted_request
    decided_action
    next_step
```

回复是bounded自然语言字段，不包含raw reasoning、transcript、secret、内部ID要求或未经read-back的成功声明。
回复是accepted `RootDirective`的必需Linear materialization，不是event projection。Conductor在matching
directive及其必要mutation read-back后，把回复作为带managed marker的`RootReconcilerReplyRecord`写到原
comment所在Issue并read-back：

```text
RootReconcilerReplyRecord
  reply_id
  root_directive_id
  source_comment_id
  source_comment_version
  target_issue_id
  materialized_outcome_refs[]
  rendered_schema_version
  replied_at
```

`RootReconcilerReplyWriterInterface`只在reply comment与marker均read-back后返回success；不存在queued或accepted
中间成功。失败返回closed error并触发相同的Root停止语义。

reply comment由closed renderer生成，marker使它永远不会重新进入`pending_user_comments`。accepted directive
一经durable，该comment version即绑定到该directive，不得再次交给模型。reply create或read-back失败时，当前
Root reconciliation立即停止，打印包含Root/directive/reply correlation的sanitized structured error log，不得dispatch
下一个Stage或接受另一个directive。恢复后Conductor从Linear中accepted directive和缺失的matching reply继续
materialize同一`reply_id`；ambiguous write先查询，不能盲目追加，也不能重新调用模型。

## 7. RootDirective contract

```text
RootDirective
  protocol_version
  request_id
  root_directive_id
  reconciler_session_id
  reconciler_turn_id
  based_on_root_tree_digest
  rationale
  evidence_refs[]
  comment_dispositions[]
  external_change_dispositions[]
  action:
    ExecutePlanDirective |
    ExecuteWorkDirective |
    ExecuteVerifyDirective |
    RerunStageDirective |
    RestoreWorkflowStateDirective |
    ReviseCycleTreeDirective |
    ReplanCurrentCycleDirective |
    SupersedeCycleDirective |
    CreateSuccessorCycleDirective |
    RequestHumanActionDirective |
    ConcludeCycleDirective |
    ConcludeRootDirective |
    WaitDirective |
    AcknowledgeDirective
```

所有variants是closed、versioned、`additionalProperties: false`的discriminated union。每个turn最多返回一个
directive；需要多个Linear/Git writes的单一领域动作共享一个stable directive ID，Conductor按明确顺序幂等
materialize并read-back，不能在partial success后重新询问模型制造第二份逻辑动作。

```text
ExternalLinearChangeDisposition
  change_id
  impact:
    none | lifecycle | current_stage | current_cycle_dag |
    current_cycle_plan | root_contract | invalid_structure
  decision_ref
```

`comment_dispositions`和`external_change_dispositions`只覆盖本轮observation中的pending inputs。任何会改变下一步
的pending input未被覆盖时，Conductor拒绝directive；无业务影响也必须显式标记`none`。

### 7.1 Stage执行与重跑

```text
ExecutePlanDirective
  kind: execute_plan
  cycle_issue_id
  plan_issue_id
  plan_goal
  required_outputs[]
  prior_plan_result_ids[]
  human_resolution_ids[]

ExecuteWorkDirective
  kind: execute_work
  cycle_issue_id
  work_issue_id
  execution_goal
  required_checks[]
  dependency_evidence_refs[]

ExecuteVerifyDirective
  kind: execute_verify
  cycle_issue_id
  verify_issue_id
  target_git_revision
  required_evidence_refs[]

RerunStageDirective
  kind: rerun_stage
  cycle_issue_id
  role: plan | work | verify
  target_issue_id
  invalidated_execution_ids[]
  reason
  preserved_evidence_refs[]
```

Conductor机械验证Cycle active、target membership、ready conditions、Plan Contract、Git revision、budget和
capability。rerun总是创建fresh execution/turn；不能恢复旧turn或只改status伪造重跑。

### 7.2 恢复非法workflow status

```text
RestoreWorkflowStateDirective
  kind: restore_workflow_state
  reason
  changes[]
    target_issue_id
    issue_kind: root | cycle | plan | work | verify | human_action
    observed_status
    restored_status
    expected_remote_version
    durable_evidence_refs[]
```

该variant只恢复与durable Results、Human resolutions和lifecycle事实不一致的derived status，不得撤销合法Human
terminal status、伪造Stage完成或绕过Root cancel。若用户状态变化表达了明确合法意图，Reconciler必须选择
matching lifecycle/replan/supersede directive；无法判断时请求Human Action，不能静默改回。

### 7.3 Cycle DAG revision

```text
ReviseCycleTreeDirective
  kind: revise_cycle_tree
  cycle_issue_id
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

该variant只适用于Approved Plan Contract仍成立的执行调整。每个operation携带matching target remote version、
status、archive、parent和relation preconditions。语义delete使用Linear原生archive flag；archived Issue仍进入
后续完整Root observation。active dependency不得悬空指向archived node。

### 7.4 当前Cycle replan

```text
ReplanCurrentCycleDirective
  kind: replan_current_cycle
  cycle_issue_id
  reason
  superseded_plan_contract_ids[]
  invalidate_execution_ids[]
  preserve_evidence_refs[]
  archive_or_restore_operations[]
  plan_issue_id
  fresh_plan_goal
```

Root目标和contract未发生实质变化，但当前Plan错误、假设失效或执行方案需要重构时，可以在当前Cycle内
replan。旧Plan Contract immutable并通过`PlanContractSupersessionRecord`失效；fresh Plan turn产生新Contract。
旧Work evidence只有被新Plan显式引用时才可复用。

### 7.5 结束当前Cycle并创建successor

```text
SupersedeCycleDirective
  kind: supersede_cycle
  current_cycle_issue_id
  reason: root_requirement_revision | destructive_cycle_revision | no_safe_replan
  invalidated_execution_ids[]
  unresolved_finding_ids[]
  preserved_evidence_refs[]
  successor
    create: true
    plan_trigger
    inherited_fact_refs[]
```

Root objective、scope、acceptance criteria或protected constraints发生实质变化时，旧Cycle不能继续声称满足最新
Root contract。Conductor结束当前Cycle、通过Root convergence gate、创建successor Cycle，并使用fresh Plan、
Work、Verify sessions。当前Cycle写`CycleOutcome.conclusion=superseded`并进入`Changes Required`；旧Cycle和Git
成果保留为provenance，不默认满足新Plan。

终态Cycle永远不能被该variant修改。最新Cycle已经terminal但Root仍需继续时，使用独立successor directive：

```text
CreateSuccessorCycleDirective
  kind: create_successor_cycle
  predecessor_cycle_issue_id?
  reason:
    root_requirement_revision | repair_required | exhausted |
    user_requested_retry | unresolved_findings
  plan_trigger
  inherited_fact_refs[]
  invalidated_delivery_record_ids[]
```

Conductor机械验证不存在另一个nonterminal active Cycle、Root仍可运行、convergence允许且predecessor保持terminal，
再创建fresh Cycle和三个fresh Stage sessions。`invalidated_delivery_record_ids`只标记旧delivery不再匹配最新Root
contract，不删除PR、branch、commit或历史record。

### 7.6 Human、conclusion与wait

`RequestHumanActionDirective`提供parent scope、related Issues、requested decision、context、options、comment
requirement和evidence。Root/Cycle Action层级、status与resolution由Human Action文档定义。

```text
ConcludeCycleDirective
  kind: conclude_cycle
  cycle_issue_id
  conclusion: succeeded | repair_required | exhausted | canceled
  completed_work_ids[]
  unresolved_finding_ids[]
  attempted_approach_refs[]
  verification_evidence_refs[]
  successor_recommendation?

ConcludeRootDirective
  kind: conclude_root
  conclusion: ready_for_delivery | canceled | accepted
  evidence_refs[]

WaitDirective
  kind: wait
  reason_code
  blocking_fact_refs[]

AcknowledgeDirective
  kind: acknowledge
  reason
  continue_execution_id?
```

当pending comment被判定不影响当前in-flight execution时，`continue_execution_id`必须匹配barrier前的execution。
Conductor写入`ExecutionContinuationRecord`，关联comment versions、旧context digest、新Root Tree digest和Git
precondition；该record只允许matching late Result继续接受，不改变target、capability或Plan Contract。没有该record，
barrier前execution的Result不能跨新Tree digest materialize。

`wait`必须对应active Human Action、外部事实或有界runtime condition，不能制造无deadline等待。Cycle budget、
Root convergence、passed Verify和delivery gates始终由Conductor机械验证。

## 8. Revision业务语义

Root Reconciler根据用户comment、Issue field/status、archive和relation变化判断业务影响，而不是要求用户创建
结构化Revision。

| 用户变化 | 默认语义 | 允许结果 |
|---|---|---|
| Root `Canceled` | 放弃整个目标 | 立即安全取消；Reconciler收敛记录，不创建successor |
| Root requirement实质变化 | 旧Cycle contract失效 | supersede当前Cycle并创建successor、或请求澄清 |
| Plan错误但Root contract未变 | 当前执行方案失效 | 当前Cycle replan |
| Work内容、顺序或依赖调整 | 可能仍在Contract内 | continue、rerun、DAG revision、replan |
| Verify环境或要求变化 | 当前证据可能失效 | rerun Verify、replan、successor或Human Action |
| 用户手工修改derived status | 不自动伪造Result | 接受合法lifecycle意图、恢复合法投影或请求澄清 |
| 普通讨论或无执行含义comment | 不改变workflow | acknowledge并继续 |

Root Reconciler负责语义分类，但以下结果不是自由裁量：Root `Canceled`立即停止新dispatch；没有matching Result
不能把Work/Verify手工`Done`当作成功；没有passed Verify不能交付；terminal Root不会因普通comment自动重开。

### 8.1 Root requirement revision所在阶段

| 当前事实 | 实质Root requirement变化后的处理 |
|---|---|
| 尚无Cycle | 新需求成为initial Cycle的Plan输入，不制造空的superseded Cycle |
| 已有nonterminal Cycle | 当前Cycle `superseded` terminal，创建successor Cycle并fresh Plan |
| 最新Cycle已terminal、Root仍active | 不改写terminal Cycle；`create_successor_cycle`并fresh Plan |
| Root `In Review` | 旧delivery保留但不再匹配最新Root contract；Root回到`In Progress`并`create_successor_cycle` |
| Root `Done`或`Canceled` | comment/content edit不自动重开；必须先有合法、明确的Root lifecycle变化 |

### 8.2 Cycle revision结果

Cycle内用户修改由Root Reconciler结合Approved Plan Contract判断：无影响则acknowledge/continue；Contract内执行
变化使用rerun或DAG revision；Plan错误但Root contract未变使用当前Cycle replan；修改破坏Root contract或无法在
当前Cycle安全收敛时使用supersede并创建successor。Conductor不按field name或comment关键词机械选择结果。

## 9. Lifecycle与恢复

### 9.1 初始Cycle

```text
active Root has no Cycle
-> Conductor validates ownership and convergence
-> create initial Cycle and Plan Issue
-> open Root Reconciler session
-> Reconciler requests Plan
```

### 9.2 Stage Result

```text
Stage Result returned
-> validate role/session/turn/context/Git preconditions
-> persist immutable Result
-> read back
-> rebuild complete Root observation
-> Root Reconciler chooses the next directive
```

Result不能直接映射为下一Stage。Provider crash、schema failure和business blocked是不同durable facts；普通Work
错误应先在Work tool loop预算内自行诊断和重试。

### 9.3 Human Action

用户status/comment经Conductor验证并形成`HumanActionResolutionRecord`后，完整Root observation交给Root
Reconciler。Conductor不硬编码Approved后Work或Rejected后replan；Reconciler决定继续、replan、调整DAG、
successor或新Action。

### 9.4 process与session恢复

Conductor不保存workflow DB、Queue、checkpoint或durableProvider pointer。重启后从Linear/Git重建Root；任何
accepted但未完成directive按stable write ID继续materialize。Root Reconciler或Stage session丢失时使用fresh
session和完整facts；旧session output失效。

```text
WorkflowChangeResolutionRecord
  resolution_id
  external_change_ids[]
  root_directive_id
  dispositions[]
  materialized_outcome_refs[]
  resolved_root_tree_digest
  resolved_at
```

该record只证明某个外部变化已被观察和处理，不镜像当前Tree；当前状态仍由fresh Linear/Git读取决定。

## 10. Timeline与comment reply区别

- Timeline由typed event subscriber写入Root或matching Cycle Issue；
- comment reply由`RootDirective`携带并作为该directive的必需Linear mutation写回原Issue；
- 两者都使用closed renderer、managed marker和deterministic ID，不由业务模块拼任意Markdown；
- 两者写入或read-back失败都会停止当前Root推进并记录correlated error；
- 不存在Linear之外的pending reply/projection状态。恢复只根据Linear source record与matching managed comment是否
  存在继续同一写入；timeline和reply都不会作为新的用户comment输入。

## 11. Budget与性能

Root Reconciler只在durable checkpoint调用：新用户comment、Stage Result、Human resolution、外部Tree变化、
execution failure、Cycle conclusion或到期deadline。heartbeat、token stream、tool progress和重复webhook不调用模型。
accepted directive缺少required reply或timeline comment时也不调用模型；Conductor先完成同一Linear
materialization，成功read-back后才能继续。

Reconciler有Root级turn/token/deadline limits；Stage仍有Cycle/turn budgets。完整Tree超出context bound时必须通过
closed coverage明确缺失并进入attention或使用由durable source支持的bounded history view，不能静默截断或让
旧transcript补全事实。

## 12. 不变量

1. 每个Root只有一个模型驱动的Root Reconciler语义角色，没有Cycle Supervisor。
2. Conductor始终调用Performer；Performer从不回调Conductor或直接修改Linear/Git。
3. Root Reconciler session跨Cycles；Plan、Work、Verify sessions按Cycle隔离且不跨Cycle复用。
4. 每次Reconciler turn读取完整active和archived Root Tree，并最多返回一个closed `RootDirective`。
5. 用户普通comment只按human actor和managed marker识别；系统、timeline、status和reply comments全部排除。
6. 每个处理过的用户comment version都有matching disposition和read-back后回复；缺少回复时Root停止推进。
7. 每个external Linear change最多有一个durable resolution；Symphony自身mutation不能自触发revision。
8. Root requirement实质变化不能继续沿用旧Cycle成功声明；必须successor或澄清。
9. Plan错误但Root contract未变可以在当前Cycle内replan；Contract内执行变化可以修改DAG或rerun。
10. Stage Result必须durable并read-back后才能进入下一次Root reconciliation。
11. Linear/Git是durable authority；Provider thread、timeline和reply都不是恢复authority。
