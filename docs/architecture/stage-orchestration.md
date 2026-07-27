# Performer Plan、Work与Verify Contracts

状态：目标架构提案。本文是Conductor调用Performer执行Plan、Work和Verify的request/result contract、角色
thread、capability和Result语义的唯一事实源。Root/Cycle下一步和用户comment处理由
[Root Reconciliation](root-reconciliation.md)决定。本文不定义RootNextAction或Human Action状态。

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

Plan、Work和Verify Result只报告执行事实，不决定下一个Stage、不创建Human Action、不修改Cycle DAG。Result被Conductor
materialize为native Linear/Git current facts并进入下一份Root delta后，Root Reconciler才决定下一步；fresh Reconciler
session从完整bootstrap获得这些native consequences，而不是重建旧Result object。

### 1.1 Role prompt职责

三个英文Markdown prompt必须把以下职责写成明确、可执行的role instructions，但不得新增本文件后续contract中不存在
的字段或Result variant。Provider structured output、Performer codec和Conductor validation共同机械拒绝缺字段、未知字段、
错误variant、stale correlation或越权结果；prompt本身不是validation boundary。

每个prompt必须至少包含`Role and Authority`、`Trigger Conditions`、编号`Workflow`、`Anti-Rationalization`、
`Red Flags`、可验证`Exit Criteria`和`Output Contract`。涉及分支、重试或停止条件时必须使用Mermaid明确表达；
Plan、Work和Verify三个prompt都包含各自的`flowchart TD`，图只能组织现有request facts、capabilities和Result variants。
“上下文看起来足够”、“通常可以跳过”、“稍后再补证据”或类似措辞不能放宽contract、required checks或退出条件。

Cycle执行与Root REVIEW的唯一衔接如下。`REVIEW`不是第四个Stage；它只在Cycle terminal status、Findings和matching Git
evidence已经fresh read-back后，由Root Reconciler在后续turn执行：

```mermaid
flowchart TD
    A["Root Reconciler requests PLAN"] --> B["Plan returns one closed PlanResult"]
    B --> C{"Is the Plan complete, feasible and approved through durable facts?"}
    C -- "No" --> C1["Root Reconciler chooses replan, rerun, Human Action or terminal handling"]
    C1 --> A
    C -- "Yes" --> D["Conductor materializes the approved Work DAG"]
    D --> E["Root Reconciler selects one mechanically ready Work Issue"]
    E --> F["Work performs BUILD and returns one closed WorkResult"]
    F --> G{"Are required active Work Issues complete?"}
    G -- "No" --> E
    G -- "Blocked or invalid" --> G1["Root Reconciler chooses repair, replan, Human Action or terminal handling"]
    G1 --> A
    G -- "Yes" --> G2["Conductor prepares and reads back the immutable target commit"]
    G2 --> H["Verify checks the immutable target and returns one closed VerifyResult"]
    H --> I{"Does fresh evidence support a terminal Cycle conclusion?"}
    I -- "No" --> I1["Root Reconciler chooses rerun, repair, replan or Human Action"]
    I1 --> E
    I -- "Yes" --> J["Conductor writes and reads back native Cycle terminal facts"]
    J --> K["Root Reconciler performs REVIEW against the complete Root history"]
    K --> L{"Is the Root satisfied and ready for delivery?"}
    L -- "No" --> M["Root Reconciler specifies a bounded successor Cycle requirement or Human Action"]
    M --> A
    L -- "Yes" --> N["Root Reconciler chooses SHIP through conclude_root"]
```

#### Plan

Plan在返回`plan_completed`前必须先完成需求拆解和计划评审：

- 从Root contract提取objective、included/excluded scope、assumptions、constraints、acceptance criteria和verification
  requirements，不得用猜测填补缺失业务要求；
- 把工作拆成粒度适中、可独立派发和验收的Work单元。每个`work_node`用现有`title`、`description`、
  `expected_outcome`和`required_checks[]`明确目标、边界、预期成果与验收方法；只有输入或repository facts支持时才写
  具体文件路径和参考模式，不能虚构路径；
- 用每个`work_node.dependency_proposal_keys[]`表达真实依赖和执行顺序，不创建另一个sequence/status字段；
  `dependency_edges[]`在Plan proposal中必须是空数组，因为materialization前还不存在可引用的Work Issue ID。并行单元
  不得制造不必要依赖，有依赖的单元必须说明上游成果如何成为下游输入；
- 证明全部Root acceptance criteria都由Work checks或Verify requirements覆盖，且Verify node可以在immutable target
  revision上独立判定；
- 评审可行性、风险、权限、遗漏、scope冲突、假设和历史失败。信息不足时返回`plan_needs_information`，无法形成安全
  计划时返回`plan_blocked`，不能为了推进流程而返回残缺的`plan_completed`。

Plan只提出Contract和DAG。它不创建Linear Issue、请求Human Action、批准自己的Plan、派发Work或选择workflow下一步。
Plan也不在Root worktree创建`SPEC.md`、`PLAN.md`、repository task checklist或其他计划文件；transient Plan Result由
Conductor渲染为Plan Issue description与native status，并fresh read-back后才成为后续角色可见的durable fact。

#### Work

Work只完成本轮`selected_work`，遵守approved Plan Contract、dependency evidence、workspace capability和明确scope。
它应在预算内读取事实、修改授予的worktree、运行required checks、诊断普通失败并修复重试；不得顺带执行另一个Work
Issue、扩大scope、修改DAG、commit/push或声称整个Cycle完成。完成时返回实际变化、checks、artifacts、discovered facts
和evidence；假设失效、scope冲突、权限或信息缺失时使用matching现有special/blocked variant，让Root Reconciler决定
后续动作。

Work不得把DEFINE、Plan、REVIEW、SHIP或执行进度写成repository workflow文档。只有selected Work Issue本身明确要求
修改项目documentation时，相关文件才属于产品scope；transient Work Result由Conductor收敛为Work Issue的native
status、description以及matching Git/check facts，不在Linear保存Result object。

全部required active Work完成后，Conductor通过`GitWorkspaceInterface`机械准备并read-back用于Verify的immutable
target commit。commit message、数量和Git command不由任何prompt输出决定；HEAD、worktree coverage或read-back不满足时
不得调用Verify。Verify通过后SHIP只能交付该exact commit，不能在delivery时创建新commit或改变内容。

#### Verify

Verify与Plan、Work和Root Reconciler conversation隔离，并只读检查`immutable_target_revision`。它必须逐项验证approved
Plan Contract的acceptance criteria和verification requirements，检查matching Work evidence、required checks、Git facts
及unresolved findings，且每个结论都有可引用evidence。Verify不能修复代码、补做Work、改变Finding或选择下一步；证据
不足时返回`verify_inconclusive`或`verify_blocked`，发现缺陷时返回`verify_changes_required`或
`verify_plan_contract_violation`，不得把未运行或无法证明的检查记为passed。

Verify的审阅结论由Conductor从transient Verify Result渲染为Verify Issue的native status、description以及matching
Finding/Git/check facts，不能写入repository report、comment file或task checklist，也不在Linear保存Result object。

三个Stage prompt的退出条件必须绑定matching request、target、capability、evidence和closed Result。任何required
input缺失、事实冲突、越权需求、未运行required check或无法验证的结论都是red flag；role必须选择matching
blocked、needs-information、inconclusive、changes-required、contract-violation或execution failure variant，而不是
输出不完整的success variant。schema-invalid输出由机械边界拒绝，不能通过自然语言解释、重试猜测或fallback推进。

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
  role_context_update:
    StageRoleContextInitial | StageRoleContextDelta
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
  model_observation: RuntimeModelObservation
  outcome:
    PlanResult | WorkResult | VerifyResult
```

`role`是discriminator；context和result variant必须matching。未知字段、未知variant、role/session不匹配、
source coverage不完整、digest错误或超出bound均fail closed。所有schema使用`additionalProperties: false`，由
JSON Schema生成各语言的generated codecs；生成语言集合由[契约与接口边界](contracts.md)统一定义。
`instruction_bundle`携带本轮命令、target identity和output contract identity，是validated Stage request data；它不选择、
替换或修改Performer随应用打包的role Markdown prompt，也不得重新嵌入stable role workflow、完整role context或
structured-output schema文本。base prompt resource与本轮request必须同时matching `role`，否则fail closed。
`model_observation`由Performer根据实际Provider调用填充，不属于模型structured output。它只供当前process日志、metrics和
operator诊断，不能持久化到Linear或影响restart。其语义只由[Performer Profile](performer-profiles.md)定义。

## 3. Session与turn

- 一个Cycle最多一个Plan role session、一个Work role session和一个Verify role session；
- role sessions不得共享Provider thread，也不得跨Cycle复用；
- Plan和Verify role可以有多个turn，例如Plan rejection后的fresh Plan turn或同Cycle修复后的再次Verify；
- Work role在同一Cycle跨多个Work Issues和turn持续存在，以保留实现上下文；
- 每个turn有独立`stage_execution_id`、context digest、deadline、reservation和terminal Result；
- role thread是runtime continuity，不是durable authority；thread丢失时从Linear/Git facts创建fresh role session；
- stale session/turn output不得materialize。

同一thread不会放宽每个turn的target和capability。历史conversation只能帮助执行，不能授权当前request未授予
的scope、workspace access或workflow mutation。

### 3.1 Role context初始化与增量

Plan、Work和Verify都从fresh、空Provider conversation创建，不继承Root Reconciler、另一个Stage role或前一Cycle的
conversation。创建session时，Performer先注入一次matching stable role base instructions，再注入一次role-scoped
initial context；后续turn只追加当前`instruction_bundle`和从该role已确认Provider-visible baseline计算出的context delta。
这等价于不fork任何其他role history，而不是从完整Root conversation复制后再过滤。

```text
StageRoleContextInitial
  kind: initial
  target_context_digest
  sources[]: StageRoleContextCurrentValue

StageRoleContextDelta
  kind: delta
  base_context_digest
  target_context_digest
  changes[]: StageRoleContextChange

StageRoleContextCurrentValue
  source_kind: linear_issue | linear_comment | linear_relation | git | repository_instruction
  source_id
  source_version_or_digest
  actor_kind
  observed_at
  value: PlanContextSourceValue | WorkContextSourceValue | VerifyContextSourceValue

StageRoleContextChange
  source_kind: linear_issue | linear_comment | linear_relation | git | repository_instruction
  source_id
  source_version_or_digest
  actor_kind
  observed_at
  operation:
    StageRoleContextCurrentValue {
      kind: current_value,
      value: PlanContextSourceValue | WorkContextSourceValue | VerifyContextSourceValue
    } |
    StageRoleContextReplacement {
      kind: replacement,
      replaces_source_version_or_digest,
      value: PlanContextSourceValue | WorkContextSourceValue | VerifyContextSourceValue
    } |
    StageRoleContextTombstone {
      kind: tombstone,
      removes_source_version_or_digest,
      reason: deleted | left_role_scope
    }
```

Conductor从fresh Linear/Git/repository facts构造本role允许的完整当前投影，并与该session上一次确认的
`target_context_digest`比较生成initial或delta；Performer校验base/target连续性，并只把matching initial或changes编码为
Provider incremental items。matching Result的`context_digest`确认本次Provider-visible target，二者的baseline都只存在于
runtime session state。

initial与delta是Provider可见事实的两种互斥输入。`initial`只允许出现在fresh role session的首个turn；已有且连续的
session只允许`delta`。新增immutable fact追加current-value fragment；更新追加带被替换source identity/version的
replacement；删除或不再属于matching role projection的fact追加tombstone。已进入conversation的旧fragment永不改写，
后续turn也不得把`PlanTurnContext`、`WorkTurnContext`或`VerifyTurnContext`重新完整序列化。

`source_kind + source_id`是fragment identity；version/digest只标识该identity的current value。`initial.sources[]`必须完整
列出matching role当前投影中的每个source，全部使用`current_value`，并按`source_kind, source_id` canonical排序。delta的一个
冻结批次内每个identity最多一个change：new identity使用`current_value`；existing identity只能使用且必须使用
`replacement`，其`replaces_source_version_or_digest`精确匹配base；删除或离开role projection只能使用`tombstone`，其
`removes_source_version_or_digest`精确匹配base。source kind、actor、observed time与typed value必须来自fresh事实；value union
必须同时匹配request `role`和下文该role最大事实集合。重复identity、错误variant、version不连续、cross-role value或digest
无法由canonical projection重算时，整个turn fail closed并关闭matching role session。

三个`*ContextSourceValue`都是由request `role`判别的closed union，不是arbitrary object：Plan只允许组成
`PlanTurnContext`的Root Contract、Cycle/Plan/Finding/Human Action和planning Git/repository facts；Work只允许组成
`WorkTurnContext`的approved Plan、selected/dependency/prior Work、Cycle DAG、Human Action和worktree/Git facts；Verify只允许
组成`VerifyTurnContext`的approved Plan、active/archived DAG、Work/Finding/Human Action、verification requirement、immutable
revision和repository snapshot facts。每个value variant还必须用业务含义作discriminator并引用matching closed fact schema；
不得以字段全可选的单一object、generic JSON、完整Root/Cycle blob或cross-role superset表达。

Conductor在构造Stage turn时冻结current command、matching role完整fresh projection、coverage、source manifest和
`target_context_digest`。冻结后发生的Linear/Git/repository变化只进入下一turn。projection不变时允许空`changes[]`且
base/target digest相等，只append当前`instruction_bundle`；fresh session仍必须发送非增量的完整initial，不能用空delta启动。

Cycle是Stage事实可见范围的硬上限，不是默认把完整Cycle全部注入。每个role只能接收完成当前命令所需的最小投影：

- Plan：minimal explicit Root Contract、当前Cycle trigger、current Plan target、相关prior Plan attempt Issue facts、
  approved Plan description facts、Finding Issue facts、Human Action thread facts和planning所需Git/repository facts；
- Work：approved Plan Issue description facts、当前selected Work、其dependency evidence、相关prior Work attempt
  Issue/Git/check facts、当前Cycle内必要DAG facts、Human Action thread facts以及worktree/Git facts；
- Verify：approved Plan Issue description facts、required Work Issue native status/description与checks、当前Cycle Finding Issue
  和Human Action thread facts、verification requirements以及immutable target revision和matching repository snapshot。

这里的minimal Root Contract是从Root requirement显式投影的objective、requested scope、constraints、acceptance
criteria和verification requirements；它不是Root Tree、Root Reconciler transcript或其他Cycles历史的别名。除该contract
外，Root级事实只有在matching role contract明确要求且能证明相关性时才可进入Stage initial/delta。

Stage request不得携带完整Root Tree、完整active/archived Root history、Root Reconciler conversation、另一个role的
conversation或其他Cycle context。`observed_tree_digest`、coverage、correlation、limits和Provider structured-output schema
是机械request metadata，不因存在于transport envelope就自动成为model-visible conversation item。Performer只能把
`instruction_bundle`与`role_context_update`中的允许内容追加给model。

`repository_context.workspace_root_capability`只授予matching tool boundary，不进入prompt；其中baseline revision、diff、
repository instructions或其他需要模型理解的值必须作为versioned sources进入matching role initial/delta，不能再从
`repository_context`每turn重复注入一份。transport可以为precondition validation携带这些字段的identity/digest，但不能
借此绕过Provider-visible baseline。

Performer为每个role session在runtime内独立维护Provider-visible context digest。已确认进入Provider history但尚未产生
可接受Result的facts不在同一live thread重复注入；无法证明append或baseline连续性时关闭该role session，并从Linear/Git
durable facts重建一次fresh role-scoped initial context。该baseline不持久化，不是workflow checkpoint或authority。

## 4. 公共source、repository与limits

```text
StageContextSource
  source_kind: linear_issue | linear_comment | linear_relation | git | repository_instruction
  source_id
  version_or_digest
  actor_kind
  observed_at

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

matching role所需的Root Contract projection、current Plan facts、target Node、dependencies、Human Action thread facts和
Git revision是matching turn的required facts。coverage证明该role projection完整，不要求把整个Root或Cycle搬进请求；被
role-scope明确排除的无关历史不属于omission。required fact缺失或静默截断必须fail closed。

下文`PlanTurnContext`、`WorkTurnContext`和`VerifyTurnContext`定义各role允许的逻辑投影；wire initial把该投影规范化为
`sources[]`，wire delta只携带这些source的typed current/replacement/tombstone。一个组合字段若来源于多个native/Git事实，
必须拆为可独立version的sources；一个source value可以包含由同一native object或同一Git observation原子读取的多个字段，
但不能把不同生命周期的source合并成无法单独replacement的聚合blob。

## 5. Plan contract

### 5.1 PlanTurnRequest

```text
PlanTurnContext
  root_contract
    objective
    requested_scope
    constraints[]
    acceptance_criteria[]
    verification_requirements[]
  cycle
    cycle_issue_id
    trigger
    predecessor_cycle?
  current_plan_issue
  prior_plan_attempt_facts[]
  prior_approved_plan_facts[]
  unresolved_finding_issue_facts[]
  human_action_thread_facts[]
  current_git_facts
  required_output
```

该结构定义Plan role initial projection及后续delta可更新的最大事实集合，不表示每个Plan turn都重新发送完整结构。

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
`PlanBlockedResult`报告无法形成有效Plan的closed reason和attempts。validated Plan proposal被渲染为Plan Issue的
human-readable description；native Plan ID和remote version限定其approval scope。

`proposed_work_dag.work_nodes[].dependency_proposal_keys[]`是Plan阶段唯一可解析的Work dependency identity；
Plan尚未materialize时不存在Work Issue ID，因此proposal中的`dependency_edges[]`必须为空。Conductor只在matching
approved Plan DAG materialization时把这些keys解析为`blocks` relations。materialization完成后只使用created Work/Verify
native Issue IDs、primary kind labels、parent和relations；不得创建stable key、digest marker或第二种Node identity。

## 6. Work contract

### 6.1 WorkTurnRequest

```text
WorkTurnContext
  approved_plan
    issue_id
    description
    remote_version
    approval_thread_facts
  current_active_work_dag
  selected_work
    issue_id
    title
    description
    expected_outcome
    required_checks[]
    dependency_evidence[]
  completed_work_evidence[]
  prior_work_attempt_facts[]
  human_action_thread_facts[]
  git_baseline
  workspace_capability
```

该结构定义Work role initial projection及后续delta可更新的最大事实集合，不表示每个Work turn都重新发送完整结构。

一个Cycle只有一个Work thread。Conductor在不同turn中把Root Reconciler选择且机械ready的Work Issue依次交给
它。Work thread可以在当前turn内部执行Claude Code式tool loop：读取代码、修改、运行命令、观察普通错误、
修复和重试，直到完成、需要外部输入或达到turn预算。

Work只能修改授予的Root worktree，不能commit、push、创建worktree、调用Linear、改变DAG或执行另一个
Work Issue。发现需要调整DAG时只报告structured observation；Root Reconciler决定是否提出Tree patch。

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
capability内继续时才返回blocked/specialized result。`suggested_dag_changes`只是observation，不是RootNextAction。

## 7. Verify contract

### 7.1 VerifyTurnRequest

```text
VerifyTurnContext
  approved_plan
    issue_id
    description
    remote_version
    approval_thread_facts
  complete_active_cycle_dag
  archived_cycle_nodes[]
  completed_work_issue_facts[]
  unresolved_finding_issue_facts[]
  human_action_thread_facts[]
  verification_requirements[]
  immutable_target_revision
  repository_snapshot
```

该结构定义Verify role initial projection及后续delta可更新的最大事实集合，不表示每个Verify turn都重新发送完整结构，
也不表示从Linear重建或持久化过往Work Result object。

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

Conductor验证target revision和evidence，将Result materialize为native Linear/Git facts并fresh read-back后交给Root
Reconciler。Conductor不把
`verify_changes_required`机械映射为successor Cycle；Root Reconciler可以在当前Cycle预算内继续Work，也可以提出
repair conclusion。

## 8. 公共terminal variants

```text
StageBudgetExhaustedResult
  kind: budget_exhausted
  budget_kind
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

Provider transport/crash/schema failure与业务blocked必须区分。只有validated Result可以materialize native Linear/Git
facts；无业务Result的process failure把matching Node收敛为`Failed`或`Interrupted`并记录sanitized runtime observation，
不能伪造业务结论或创建failure payload comment。

## 9. Human input边界

Plan、Work、Verify不能创建Human Action。它们只能通过typed Result报告：

```text
information_required
permission_required
plan_assumption_invalid
scope_conflict
verification_blocked
```

Conductor materialize native result facts后，Root Reconciler决定是否请求Human Action、调整DAG、继续执行或结束Cycle。
resolved Human Action thread在Conductor验证后作为current native facts进入matching下一turn。

## 10. Result与materialization

Performer可以返回bounded runtime progress/heartbeat/tool summary，但它不决定业务完成、不写Linear，也不成为恢复输入。
每个turn必须有一个terminal Result，或由Conductor归一化process/transport failure。

Result接受顺序固定：

```text
fresh-read Root/Cycle/target/Git preconditions
-> validate wire schema, role/session/turn correlation and context digest
-> validate target revision and capability-specific evidence
-> materialize native Issue/status/label/relation/comment/Finding/Git postconditions
-> fresh semantic read-back
-> emit sanitized runtime model/usage observation
-> rebuild complete native Root object graph
-> derive and advance Root delta, or bootstrap a fresh Reconciler session
```

Plan Result渲染为Plan description和status；Work Result渲染为Work status、Git/check evidence和必要的简短comment；Verify
Result渲染为Verify conclusion label/status、Finding Issues、Git revision和必要的简短comment。具体native事实由
[Root Issue工作流](root-issue.md)定义。

只有用户理解结论所必需的内容才写comment。comment不得包含transport Result、model/usage、session/turn correlation、
machine serialization或内部“已记录”receipt。native postcondition read-back失败时matching Root停止，不能以runtime Result
或日志代替。

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
calls和output token limits。取消、Root routing/process generation变化、Cycle terminal或archive active target时，Conductor使
matching turn/session失效并拒绝late output。

## 12. 不变量

1. 每个Cycle的Plan、Work、Verify使用三个不同Provider thread。
2. Work thread跨当前Cycle多个Work Issues和turn复用，但每turn只执行一个selected target。
3. Plan/Work/Verify都不决定下一步、不修改DAG、不创建Human Action。
4. 所有request/result是closed、versioned、generated的强类型contract。
5. Conductor是唯一caller；Performer不反向调用Conductor。
6. Result必须materialize为native Linear/Git facts并read-back后才能交给Root Reconciler。
7. Provider thread不是durable authority；丢失后从Linear/Git facts恢复。
8. Plan/Verify read-only，Work只能修改授予的Root worktree。
9. 实际model和usage只作为runtime observation；缺失观测不能伪造workflow事实。
10. Plan必须在现有Plan Contract和DAG字段中完整表达任务单元、scope、依赖顺序和验收覆盖；残缺或冲突的
    `plan_completed`不能推进Plan review或DAG materialization。
11. Work只执行selected target；Verify只验证immutable target。二者的Result都是Root Reconciler输入，不拥有下一步语义。
