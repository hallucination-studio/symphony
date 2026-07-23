# Linear Workflow Loop与Performer Stage Context

状态：目标架构提案。本文是Conductor Loop、Plan/Work/Verify Stage和Performer注入内容的唯一事实源。
本文只设计一次Stage调用需要什么，不设计Provider内部协作、跨调用memory或Desktop多Root展示。

## 1. 架构决定

Symphony与通用Loop Engineering模式做同一件事：反复读取外部事实、选择一个有界动作、隔离执行、验证
结果并把结果写回外部事实。Symphony的关键约束是Linear Issue Tree本身就是Workflow，不存在
`STATE.md`、Workflow数据库或Provider conversation作为第二条状态脊柱。

```text
wake
-> read fresh Linear Issue Tree + Git facts
-> derive one ready Plan | Work | Verify Stage
-> build one closed StageContextEnvelope
-> invoke one Performer with a fresh Provider context
-> validate StageResult
-> materialize accepted facts to Linear/Git
-> semantic read-back
-> discard all invocation state
-> repeat
```

Loop不是持久化领域对象。它是Conductor不断执行上述reconciliation的运行行为。Stage也不是可恢复
conversation；它是对一个Linear typed node的一次有界尝试。

## 2. Scope record

```text
authorized
  - Linear Issue Tree作为Workflow authority
  - Root、Cycle和Stage Node的Linear custom status与transition
  - Conductor的fresh-read、select、invoke、materialize、read-back Loop
  - Plan、Work、Verify三类Stage
  - 每次Stage的公共和stage-specific注入内容
  - fresh Provider context和stage-specific tool capability
  - Stage Result的最小closed outcomes
  - Finding structured persistence、repair grouping和Root级convergence circuit breaker

required_consequences
  - Performer不读取Linear，也不决定下一个Stage
  - Conductor不保存Workflow DB、durable queue、checkpoint或conversation pointer
  - 跨Stage连续性只来自下一次从Linear/Git重建的context
  - 每个Work Node必须在Linear中自包含到足以独立执行
  - Human等待必须先写Linear，再结束当前Stage
  - Result只有经Conductor验证、写入Linear/Git并read-back后才成为事实
  - 所有影响恢复、retry、token budget或下一Stage选择的context必须固化为Linear managed record

out_of_scope
  - sub-agents、maker/checker、child-agent fan-out或Agent Cluster
  - Provider memory、跨Stage transcript、向量库、summary store或conversation resume
  - Desktop多Root列表、聚合Workflow图、并行Root进度展示
  - remote Performer、长连接优化和Provider-specific wire扩展
  - 并行Work、多writer和跨Root执行协调
  - Provider transcript压缩、向量检索和非Linear memory优化
  - authoritative monetary cost gate、pricing snapshot或cost reservation

assumptions_requiring_approval
  - none

deferred_ideas
  - 多Root调度的产品化与Desktop显示
  - Stage内部独立验证或多agent协作
  - 多Provider Backend
  - Provider边界能够提供统一可信费用事实后的cost budget
```

## 3. Loop Engineering primitives在Symphony中的映射

| 通用Loop primitive | Symphony边界 |
|---|---|
| Scheduling | Conductor startup reconcile、Linear变化wake-up和bounded periodic poll |
| State / Memory | Linear保存Workflow状态、context manifest、attempt、Finding和token budget；Git保存代码、diff和交付事实；不另建memory组件 |
| Worktree | 一个Root一个deterministic Git worktree |
| Skills / instructions | 每次调用注入的trusted Stage instructions和适用repository instructions |
| Connectors | Podium拥有Linear SDK；Conductor materialize closed mutations；Performer不持有Linear connector |
| Sub-agents | 当前不设计；一个Stage只有一个fresh Provider context |
| Human gate | Root Linear state、comment和Human reply；不在Performer中等待 |

通用模式中的state file、attempt ledger、human inbox和run outcome在Symphony里不能变成本地文件或数据库。
只要它们会影响下一次选择，就必须是Linear中的Issue、relation、state或managed comment。Git只回答代码
和交付事实，不能代替Workflow状态。

## 4. Linear就是Workflow

一个Root的Workflow结构直接存在于Linear：

```text
Root Issue
└── Cycle Issue
    └── Bootstrap Plan Node

after approved Plan materialization:
Cycle Issue
├── Bootstrap Plan Node(Done)
├── Work Node(s), ordered by blockedBy
└── Verify Node, blocked by required Work
```

- Root Issue是scope、Human gate、worktree和delivery单位；
- Cycle Issue是一轮Plan -> Work -> Verify的container，不是Stage target；
- Bootstrap Plan、Work、Verify Node是仅有的Stage targets；
- parent/child和`blockedBy` relation定义结构与ready条件；
- Root、Cycle和Node各自使用允许子集内的authoritative Linear custom status；
- closed managed comments记录approval、attempt、Finding、token reservation、progress和terminal outcome；
- Verify要求修改时，由Conductor在Linear创建下一Cycle，不在旧conversation里继续；
- 下一次Loop永远从fresh Linear/Git事实重新派生，不使用上一次内存decision。

Conductor可以在一次reconciliation内持有snapshot、process handle、deadline和Event，但这些对象全部可丢弃，
不能成为恢复输入。

完整status catalog、三类Issue允许的状态子集与transition只由
[Root Issue工作流](root-issue.md)定义。由于Linear status是Team级配置，
Conductor必须同时验证status ID/category和managed Issue kind；错误状态不能通过本地派生值覆盖。

## 5. Stage选择

Conductor只选择一个明确ready的typed node：

```text
Plan
  current Cycle is Draft | Planning
  current Cycle只有Todo | In Review Bootstrap Plan Node，尚无approved Plan Contract

Work
  current Cycle is Sealed | Executing
  Plan已经approved且Done
  selected Work Node为Todo | In Progress
  所有blockedBy Work Nodes已经Done且有matching completion evidence

Verify
  current Cycle is Sealed | Executing | Inconclusive | resolved Escalated
  Plan已经approved且Done
  所有required Work Nodes已经Done且有matching completion evidence
  target Git revision已固定
```

同一reconciliation最多执行一个Stage或一个Linear/Git mutation。事实冲突、多个同key active nodes、
missing dependency或Git baseline不匹配时fail closed，不通过本地排序猜测。

## 6. Root级收敛与熔断

Conductor在创建Cycle和每次claim Stage前，从完整Root Tree重建`RootConvergenceView`并机械执行gate。创建
successor Cycle不会重置任何计数：

```text
RootConvergencePolicy
  max_cycles_per_root: 3
  max_same_open_finding_cycles: 2
  max_consecutive_no_progress: 2
  max_total_tokens
  deadline_at

RootConvergenceView
  cycle_count
  open_finding_persistence[]
    finding_id
    open_cycle_count
  consecutive_no_progress
  settled_tokens
  open_token_reservations[]
  is_deadline_exceeded
  root_is_canceled
```

`cycle_count`统计Root下全部managed Cycle Issues，包括initial Cycle。`open_cycle_count`统计同一
`finding_id`自首次被接受起，在accepted Verify中出现或被精确标记`still_open`的Cycle数。
`consecutive_no_progress`跨连续completed repair Cycles累计，不按Cycle清零。达到任一上限、deadline已过、
令牌预算不足以reserve下一Stage，或Root进入
`Canceled`时，gate必须拒绝新的Cycle/Stage。

比较规则没有prompt解释空间：创建Cycle前要求`cycle_count < max_cycles_per_root`；同一open
`finding_id`的计数达到`max_same_open_finding_cycles`即触发；连续no-progress达到
`max_consecutive_no_progress`即触发；`now >= deadline_at`即触发；charged usage加下一Stage reservation超过
token budget即触发。每次gate把输入计数、阈值与trigger写入Linear decision record。

非manual cancellation的breaker动作顺序固定：写closed `ConvergenceEscalationRecord`；若当前Cycle仍为
nonterminal或正在接受Verify conclusion，把它置/结论选择为`Escalated`；若它已经terminal则保持审计不可变。
随后在Root创建matching approval action并把Root置`Needs Approval`，逐项read-back，然后释放Performer
capacity。Human可以批准一个closed policy override、修改deadline/token budget或取消Root；只有override record与
Root action都read-back后才允许fresh reconciliation。prompt不能放宽这些限制。

### 6.1 进展定义

Conductor接受terminal Verify后计算`ProgressAssessment`并写入Cycle outcome。相对上一accepted Verify，只有下列
可由Conductor精确比较的事实才是progress：

- 至少一个prior open `finding_id`被当前evidence明确标记`resolved`；
- passed acceptance/check key集合是前一轮的真超集。

只创建了新Plan、新Cycle、新commit，修改了自然语言标题，或声称风险、scope或错误形态改善，
都不算progress。这些变化可以作为人类可读evidence，但不参与breaker。

### 6.2 Token reservation

Stage启动前，Conductor根据bounded context和output limit在Node execution comment中写入token reservation。
所有settled token usage加open reservations必须不超过Root policy。Result接受后用actual usage结算；
usage缺失或process丢失时reservation继续全额计入。一次已启动Stage最多可以消耗自己的reservation，
不能借用后续Cycle预算。Cost可以作为runtime telemetry展示，当前不定义pricing snapshot、
cost reservation或authoritative cost gate；未来只能在Provider边界提供可信的统一费用事实后增加。

## 7. 注入模型

Conductor是唯一context builder。它从Linear、Git、repository instructions和产品policy构造一个closed、
有digest的`StageContextEnvelope`。Performer只消费该Envelope和当前调用授予的workspace capability。

```text
StageContextEnvelope
  protocol_version
  stage_execution
    stage_execution_id
    stage: plan | work | verify
    started_at
    deadline_at
  target
    root_issue_id
    cycle_issue_id
    node_issue_id
    plan_contract_digest?
  source_manifest[]
  coverage
  instruction_bundle
  workflow_context
    PlanStageContext | WorkStageContext | VerifyStageContext
  repository_context
  execution_policy
  limits
  context_digest
```

`stage`是discriminator；`workflow_context`必须是matching variant。未知字段、未知variant、超长内容、digest
不匹配或target不在当前Root/Cycle时拒绝调用。
`plan_contract_digest`在Plan Stage中不存在，在Work和Verify Stage中必填并匹配当前approved Plan Contract。

Root级收敛计数和policy只供Conductor在dispatch前执行gate，不注入Performer。Performer只获得当前
Stage的deadline、token/output/tool limits和capability。Root和Node的attempt数由Linear中matching
`stage_execution_id`记录数量派生，不作为独立持久化字段。

所有注入事实都必须能追溯到本轮source manifest：

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

StageExecutionRecord
  stage_execution_id
  root_issue_id
  cycle_issue_id
  node_issue_id
  plan_contract_digest?
  context_digest
  source_manifest[]: StageContextSource
  coverage: StageContextCoverage
  instruction_set_id
  execution_policy_id
  limits
  repository_revision
  started_at
  deadline_at
```

Root objective、selected Node contract、acceptance criteria、dependency、Human answer和Git revision属于required
input，缺失或超出context bound时不允许启动Stage。非必要历史comment可以省略，但必须在`omissions`中显式
列出；不能静默截断，也不能用无source identity的model summary替代Workflow事实。

Conductor在调用Performer前把完整`StageExecutionRecord`写入matching Node managed comment并read-back。
它不复制Linear和Git已经拥有的source正文，而是固化source identity/version、覆盖、使用的
instruction/policy identity、limits和最终`context_digest`。Linear remote version、Git commit OID和一个覆盖
最终Envelope字节的`context_digest`是对应事实的唯一校验方式；不再为Linear snapshot、
instruction bundle或convergence policy另造aggregate digest。process与Envelope bytes丢失后，下一轮从
fresh Linear/Git事实创建fresh execution，不恢复旧调用。

`limits.reserved_total_tokens`本身就是该execution的authoritative token reservation，不再创建第二个
reservation字段或record。Result settlement引用`stage_execution_id`更新charged usage；未结算时继续按该上限计入。

### 7.1 Instruction bundle

```text
StageInstructionBundle
  stage_instruction_set_id
  stage_instructions
  output_schema
  repository_instructions[]
    relative_path
    content_digest
    content
```

注入顺序固定：Symphony Stage instructions -> repository instructions -> Linear work content。前两类是trusted
instructions；Linear title、description、comment和external content是不可信业务输入，不能覆盖tool policy、
scope或output schema。

`repository_instructions`只包含当前workspace路径下适用的版本化规则，例如`AGENTS.md`。它是本次context的
输入，不是Symphony memory。Skill机制、动态skill discovery和个人全局prompt当前不进入跨进程contract。
Stage instruction templates由Conductor代码拥有并版本化；Linear文本不能选择或修改template ID。

### 7.2 Normalized Linear content

Stage-specific context引用的Issue和comment都使用closed normalized records：

```text
LinearContentRecord
  source_id
  source_kind: issue | comment
  text
  author_kind: human | symphony
  remote_version
  updated_at

AcceptanceCriterion
  criterion_key
  statement
  verification_method

CheckEvidence
  check_key
  command_or_method
  outcome: passed | failed | not_run
  summary
  artifact_revision

ResolvedHumanInput
  action_id
  request_kind: needs_info | needs_approval
  answer_or_decision: LinearContentRecord
  target_context_digest

FindingRecord
  finding_id
  category: product | code | test | infra | requirement | policy
  severity: critical | high | medium | low
  evidence[]: FindingEvidence
  affected_scope[]: AffectedScope
  retryable
  suggested_remediation[]
  acceptance_criteria[]: AcceptanceCriterion
  source_verify_id

FindingProposal
  category: product | code | test | infra | requirement | policy
  severity: critical | high | medium | low
  evidence[]: FindingEvidence
  affected_scope[]: AffectedScope
  retryable
  suggested_remediation[]
  acceptance_criteria[]: AcceptanceCriterion

FindingEvidence
  evidence_id
  source_kind: criterion | check | diff | file | log | human_input
  source_id
  summary
  artifact_revision

AffectedScope
  scope_kind: repository_path | criterion | component | workflow_boundary
  identity

FindingDispositionRecord
  finding_id
  disposition: still_open | resolved | waived
  evidence[]
  source_verify_id

FindingDispositionProposal
  finding_id
  disposition: still_open | resolved | waived
  evidence[]

AttemptSummary
  stage_execution_id
  cycle_issue_id
  node_issue_id
  stage
  attempted_approach
    approach_id
    objective
    target_finding_ids[]
    remediation_steps[]
    affected_scope[]
    expected_criterion_keys[]
  terminal_outcome
  failure_code?
  changed_paths[]
  checks[]: CheckEvidence
  usage_or_reservation
```

`FindingRecord`由Conductor为accepted new Finding分配`finding_id`并一次创建，之后不可改写；
`FindingDispositionRecord`形成后续精确身份审计链。每个Verify Result必须对所有prior open
`finding_id`各返回一个disposition，不通过自然语言或模糊相似度判断“同一Finding”。evidence必须绑定
source identity和Git artifact revision；`affected_scope`使用closed repository path、criterion key或
named system boundary，不能是任意metadata。

不注入Linear SDK object、任意custom field map、raw webhook payload或HTML。关系使用显式source/target Issue
IDs和relation kind，不把title文本解析成依赖。

### 7.3 Repository context与capability

```text
RepositoryContext
  repository_identity
  base_branch
  workspace_revision
  baseline_revision
  status_summary
  relevant_paths[]
  workspace_access: read_only | read_write
```

实际workspace root是本地launch capability，不进入model-visible text、Result、日志或Linear。Plan和Verify
为`read_only`；Work为`read_write`。Performer不能commit、push、创建worktree或改变Git topology，这些动作由
Conductor负责。

### 7.4 Execution policy与limits

```text
StageExecutionPolicy
  performer_profile_id
  model_settings
  sandbox_mode
  allowed_tools[]
  denied_tools[]
  network_policy

StageLimits
  max_context_bytes
  max_result_bytes
  max_wall_time_ms
  max_tool_calls
  max_command_duration_ms
  reserved_total_tokens
  max_output_tokens
```

Profile只选择Provider登录上下文和model settings，不携带Workflow memory。`CODEX_HOME`中的auth、session和
SDK runtime state属于Provider SDK，不能被Conductor读取，也不能被Performer当成跨Stage Workflow上下文。

## 8. Plan Stage注入

Plan把Root目标和当前Cycle输入变成可物化的Work contracts与Verify contract。

```text
PlanStageContext
  root
    identifier
    title
    objective
    acceptance_criteria[]
    relevant_comments[]: LinearContentRecord
    remote_version
  cycle
    cycle_key
    trigger: initial | verify_changes | review_changes
    predecessor_cycle?
      cycle_issue_id
      approved_plan: PlanContract
      verify_evidence
        verify_result_id
        verified_revision
        criteria_results[]
        checks[]
      completion_summary
  actual_changes
    baseline_revision
    target_revision
    diff_entries[]
      relative_path
      change_kind: added | modified | deleted | renamed
      before_blob?
      after_blob?
    diff_summary
  unresolved_findings[]: FindingRecord
  attempted_approaches[]: AttemptSummary
  review_inputs[]: LinearContentRecord
  existing_nodes[]
    issue_id
    kind: cycle | plan | work | verify
    title
    business_state
    blocked_by_issue_ids[]
  repository_snapshot
    head_revision
    status_summary
    top_level_paths[]
```

Plan不需要旧Planner transcript。Successor Cycle必须同时注入Root goal、previous accepted Plan Contract、
Git中实际baseline-to-target diff、previous Verify evidence、完整unresolved Finding records和已尝试方案；只给
Finding自然语言标题或只给上一轮summary不满足context coverage。Workflow records与Git commit OID在
Linear中持久化，实际代码和diff hunks从matching Git revision通过Plan read-only workspace重建；
`diff_summary`不能替代真实diff。任一required source丢失、digest不匹配或超出
bound时fail closed并请求Human处理，不能用无source的model summary补洞。

Plan Performer为read-only。它不能修改workspace、调用Linear、commit或delivery。完成结果必须包含：

```text
PlanStageResult.completed
  plan_contract
    objective_summary
    included_scope[]
    excluded_scope[]
    acceptance_criteria[]
    work_nodes[]
      work_key
      title
      description
      acceptance_criteria[]
      dependency_work_keys[]
    verify_node
      title
      acceptance_criteria[]
      required_checks[]
```

Plan只输出logical keys和dependency keys，不能指定Linear Issue ID、status、parent、relation ID或
managed marker。Conductor为accepted Plan Contract计算一个`plan_contract_digest`，并在materialization前必须证明：

- `work_key`唯一且数量/edge数量在policy上限内；
- 每个dependency key都引用同一Result中的Work，且graph无self-edge、无cycle；
- Verify contract唯一，所有required Work都会直接阻塞Verify；
- entry Work到Done Bootstrap Plan的guard relation由Conductor添加，不由Plan生成；
- 每个Work contract都有非空scope和acceptance criteria，且不超出Root/Plan boundary。

任一证明失败都拒绝Result并保持Cycle `Planning`。每个Work Node必须是self-contained：未来的Work Performer仅凭
该Node contract、有限Root边界和fresh Git
workspace即可执行，不依赖Planner history或另一个Work transcript。

Conductor验证Plan Result后先把closed Plan Contract及其`plan_contract_digest`写入Bootstrap Plan Node，把Plan置
`In Review`并通过Root Linear state请求Human approval。approval read-back后才创建/reconcile引用该digest的
Work与Verify Nodes、写relations、把Plan置`Done`并把Cycle置`Sealed`。Plan输出本身不直接修改Workflow。

## 9. Work Stage注入

Work只推进一个selected Work Node。它获得最小但完整的执行上下文：

```text
WorkStageContext
  root_boundary
    root_issue_id
    objective_summary
    included_scope[]
    excluded_scope[]
    relevant_acceptance_criteria[]
  work_node
    issue_id
    work_key
    title
    description
    acceptance_criteria[]
    relevant_comments[]: LinearContentRecord
    remote_version
  dependency_state[]
    work_key
    terminal_outcome
    commit_revision?
  resolved_human_input[]: ResolvedHumanInput
  git_baseline
    head_revision
    status_summary
```

`dependency_state`只证明predecessor已经完成，并在必要时给出Git revision；不注入dependency transcript或
任意Result正文。依赖产出的代码通过当前worktree可见。跨Work业务约束必须由Plan写进目标Work Node，不能靠
隐式记忆传播。

Work Performer拥有当前worktree的read-write capability，可以编辑文件和执行policy允许的命令，但不能：

- 读取或修改其他Root workspace；
- 调用Linear、改变Issue或选择下一个Node；
- commit、push、merge、创建branch/worktree或delivery；
- 扩大Node与Root contract定义的scope。

```text
WorkStageResult.completed
  summary
  changed_paths[]
  checks[]
  observed_workspace_revision
```

Conductor重新检查diff、status、scope和checks后负责commit，再把Work completion写Linear并read-back。

## 10. Verify Stage注入

Verify检查一个固定Git artifact是否满足Root和approved Plan，不验证正在变化的workspace。

```text
VerifyStageContext
  root_contract
    objective
    acceptance_criteria[]
  approved_plan
    included_scope[]
    excluded_scope[]
    acceptance_criteria[]
    verify_contract
  work_evidence[]
    work_key
    completion_summary
    changed_paths[]
    checks[]
    commit_revision
  prior_open_findings[]: FindingRecord
  prior_attempts[]: AttemptSummary
  artifact
    baseline_revision
    target_revision
    changed_paths[]
  required_checks[]
  delivery_preconditions[]
```

Verify Performer为read-only，不获得代码mutation、Linear mutation、commit或delivery capability。它不读取
Planner/Writer transcript，也不使用同一个Provider thread。Result只能针对matching `target_revision`：

```text
VerifyStageResult.completed
  conclusion: passed | changes_required | inconclusive | escalate_human
  criteria_results[]
  checks[]
  new_findings[]: FindingProposal
  finding_dispositions[]: FindingDispositionProposal
  verified_revision
```

- `passed`：required criteria和checks满足；
- `changes_required`：存在有证据、在Root scope内且可执行的blocking finding；
- `inconclusive`：证据或环境不足，不能当作代码缺陷；
- `escalate_human`：需要需求、架构、安全、权限或不可自动修复的Human decision。

Conductor验证revision、criteria、checks、Finding proposal、prior Finding disposition和source identity后，
为new Findings分配ID、为所有accepted proposals补充`source_verify_id`，并把完整records写入matching Verify Node。
每个prior open `finding_id`必须恰好有
一条disposition；缺失、重复或未知ID都拒绝整个Result。只有accepted `changes_required`可以进入
Root convergence gate和repair grouping；execution failure不能伪装成Finding。多个Findings按dependency、
affected scope与共同acceptance criteria分组，不能机械地一条Finding创建一个Cycle。

## 11. Human输入

任一Stage发现缺少事实或授权时，以terminal suspension结束：

```text
StageResult.suspended
  request_kind: needs_info | needs_approval
  question_or_proposal
  reason
  impact
  context_digest
```

Conductor把closed request写入Root managed comment、设置matching Root custom state并read-back，然后关闭
Stage。用户在Linear回答后，Conductor把resolved answer作为下一次fresh StageContext的
`resolved_human_input`注入。Performer不等待用户、不保留thread，也没有resume token。

Plan contract approval是Conductor在Linear中建立的Human gate，不需要保持Plan Performer存活。
Human decision使用target Node上的普通Linear comment承载，但它不是任意文本约定。首个非空行必须
精确匹配以下closed command之一：

```text
/symphony approve <action_id>
/symphony reject <action_id>
<non-empty reason>
```

`approve`不接受额外正文；`reject`必须有非空reason。Conductor只接受位于matching target Node、晚于
Pending Human Action、由Human author写入且action ID与当前action精确匹配的一个decision。普通评论、
unknown/stale action、重复或冲突decision全部不推进Workflow并产生可诊断的fail-closed结果。
Conductor为accepted decision写closed Human resolution record；Linear comment本身是source fact，不能作为
未校验的workflow authority。

## 12. Stage Wire与Result

当前contract只需要单向调用和观察：

```text
Conductor                                   Performer
  |-- ExecuteStage(StageContextEnvelope) ------>|
  |<----------------------- StageEvent* --------|
  |<------------------------ StageResult --------|
```

`StageEvent`只有started、bounded progress、warning和heartbeat，best-effort且不参与Workflow。每次调用恰好
一个terminal `StageResult`：

```text
StageResult
  protocol_version
  stage_execution_id
  stage
  root_issue_id
  cycle_issue_id
  node_issue_id
  context_digest
  completed_at
  usage?
  outcome
    PlanCompleted | WorkCompleted | VerifyCompleted
    | Suspended | ExecutionFailed | Canceled
```

不设计Performer -> Conductor反向RPC、interactive callback或通用tool passthrough。Plan submission和Human
request都是terminal Result variant。Result必须匹配execution identity、target和context digest；stale Result
一律拒绝。

## 13. Linear mutation与read-back顺序

Linear不提供本设计所需的跨Issue transaction。下列每一步都是带remote precondition与stable `write_id`的
closed mutation；每组完成后必须semantic read-back。partial success或timeout立即结束本轮decision，下一轮从
完整Root Tree继续收敛，不执行尚未由read-back证明的后续步骤。

### 13.1 Initial Cycle与Plan

```text
verify Root In Progress + convergence gate
-> create Cycle(Draft) + CycleMarker
-> create Bootstrap Plan(Todo) + DagNodeMarker
-> read back parent/kind/status/keys
-> set Cycle Planning + Plan In Progress
-> build exact Plan Envelope
-> append StageExecutionRecord(source manifest/context digest/limits)
-> read back, then invoke Plan Performer
```

### 13.2 Plan Result与approval

```text
accept Plan Result against execution/context
-> append PlanContractComment with plan_contract_digest
-> set Plan In Review
-> create Root Pending Human Action
-> set Root Needs Approval
-> read back all four facts and end Stage

approved Human action
-> validate exact approve command and persist resolution
-> create/reconcile Work(Todo), Verify(Todo), blockedBy relations referencing plan_contract_digest
-> read back exact node/relation set and matching plan_contract_digest
-> set Bootstrap Plan Done + Cycle Sealed + Root In Progress
-> read back before any Work claim

plan revision requested
-> validate exact reject command with reason and persist resolution
-> set Plan In Progress + Root In Progress
-> build a fresh Plan Envelope, append execution record with limits and keep Cycle Planning
```

Approve和reject都由Conductor从fresh Linear Tree处理；外部用户不直接修改Root、Cycle或Node status。
Reject必须结束当前approval action、以closed resolution明确supersede旧Plan Contract，并创建新的Plan
execution。action ID必须关联execution或contract digest，不能只关联Root/Cycle；新Plan产生新的contract
digest和新的action ID。旧contract、旧action和旧decision都不能被后续Plan复用。任何accepted decision
mutation后都执行semantic read-back。

### 13.3 Work

```text
verify Cycle Sealed | Executing + Work readiness + convergence gate
-> set Cycle Executing + selected Work In Progress
-> build exact Work Envelope
-> append StageExecutionRecord(source manifest/context digest/limits)
-> read back, then invoke Work Performer
-> validate Result and Git diff
-> Conductor commit
-> append WorkCompletionComment with commit/check evidence
-> settle token usage + set Work Done
-> read back Linear and Git
```

Retriable execution failure写terminal attempt，Node保持`In Progress`，下一次execution使用新identity。不可重试
failure或熔断把Node置`Failed`、Cycle置`Escalated`并建立Root Human action；不能把failure写成Verify Finding。

### 13.4 Verify与Cycle conclusion

```text
verify all required Work Done + immutable target revision + convergence gate
-> set Cycle Verifying + Verify In Progress
-> build exact Verify Envelope
-> append VerifyInputComment and StageExecutionRecord(source manifest/context digest/limits)
-> read back, then invoke Verify Performer
-> validate Result/findings against target revision
-> append VerifyResult/Finding/Disposition/Progress records
-> settle token usage + set Verify Done
-> for changes_required/inconclusive, evaluate Root convergence gate
-> set Cycle Succeeded | Changes Required | Inconclusive | Escalated
-> read back complete Cycle and Git revision
```

Stage启动前已有有效reservation，因此accepted `passed`可以直接进入`Succeeded`并做delivery precondition
检查，不因“没有下一次预算”被改成失败。`Changes Required`表示Root convergence gate已经通过，
之后才可创建deterministic repair group Cycle；breaker触发时本Cycle选择`Escalated`且不创建successor。
`Inconclusive`只在gate允许时把同一Verify
Node重新置`In Progress`并从`Inconclusive -> Verifying`开始fresh execution。

### 13.5 Human wait、successor与cancel

任何Stage suspension先写Pending Human Action及target projection，再设置Root `Needs Info`或
`Needs Approval`并read-back，之后才结束process。恢复先写resolution、恢复Root `In Progress`及matching
Cycle/Node state并read-back，再创建fresh Stage execution。

Successor Cycle只能引用已经read-back的repair group、predecessor Cycle、Finding IDs、previous Plan、Verify
evidence和Git revision。Root cancellation先把Root置`Canceled`并read-back以使旧Result失效，再把active Cycle
和非terminal Node置`Canceled`；中途失败由下一轮fresh Tree继续收敛。

## 14. Failure与恢复

```text
process/transport failure
-> discard Provider context and invocation state
-> read complete Linear status/attempt/reservation/Finding facts and Git workspace
-> apply Root convergence gate
-> create a new Stage execution with a new context digest

partial Work edits
-> preserve worktree
-> next Work context includes fresh status and baseline
-> Performer audits existing changes before continuing

Human wait
-> persist request in Linear
-> release Performer
-> inject resolved Linear answer into a new invocation
```

普通progress、Event、Provider transcript、snapshot、decision和process handle都可以丢失。会影响下一次选择的
status、attempt、token reservation、deadline、Human action、Plan、Finding、progress与terminal outcome必须已经在Linear；
代码/diff必须在matching Git revision中可观察，并由Linear保存source identity/version与Git commit OID引用。restart不读取旧内存或
Provider context，恢复输入只来自fresh Linear/Git/repository instructions。

## 15. 不变量

1. Linear custom status、Issue Tree和managed records等于Workflow本身，不存在第二份Workflow state或memory。
2. Conductor每轮只从fresh Linear/Git事实选择一个Stage并构造context。
3. Performer只执行一个明确的Plan、Work或Verify Node，不选择下一步。
4. 每个Stage使用fresh Provider context；没有跨Stage thread、transcript或resume pointer。
5. 公共注入只有trusted instructions、stage-specific Workflow facts、repository facts、policy和当前Stage limits。
6. Plan/Verify read-only；Work只获得当前Root worktree的bounded read-write capability。
7. Performer不拥有Linear connector、Git topology、commit或delivery能力。
8. Human等待结束当前Stage；恢复总是新的Stage execution。
9. Event不改变Workflow；Result经Conductor materialize并read-back后才成为事实。
10. Finding是structured Linear record；repair grouping按耦合关系，不按Finding数量机械拆Cycle。
11. cycle、open Finding persistence、no-progress、token、deadline和kill switch全部在Root级机械执行，
    不能由prompt覆盖。
12. 任一内存对象和process都可丢；每次启动、恢复和Stage boundary都从Linear/Git重建。
13. sub-agents、独立memory和Desktop多Root展示不属于当前设计。
