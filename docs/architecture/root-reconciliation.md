# Root Reconciliation

状态：目标架构提案。本文是Root Reconciler语义角色、Conductor reconciliation host、Root bootstrap/delta、
全部用户Linear输入与回复、Root/Cycle修改、`RootDirective`以及跨Cycle恢复的唯一事实源。Plan、Work、Verify
执行contract由[Performer Stage Contracts](stage-orchestration.md)定义；Human Action生命周期由
[Human Action](human-actions.md)定义；用户可见时间轴由[Workflow Timeline](workflow-timeline.md)定义。

## 1. 决定

每个Root只有一个语义决策者：运行在Performer中的Root Reconciler。它跨当前Root的全部Cycles持续追求Root
目标，观察Linear/Git durable facts，解释用户普通comment和Stage Results，并返回一个closed、versioned
`RootDirective`告诉Conductor下一步。

Cycle不是独立自治workflow或语义决策边界，而是Root Reconciler管理的一次有预算执行尝试；
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

Conductor仍是唯一caller和副作用owner。它确定性地读取、建立执行屏障、校验边界、materialize、read-back和恢复，
但不解释任何用户status、title、description、archive、parent、relation或comment变化，不选择下一个Stage，也不
自行修正用户变化或判断replan、successor Cycle和Human Action。

## 2. 一个Reconciliation，两种职责

Root Reconciliation是一个产品控制机制，由两个不能互相替代的执行边界组成：

| 边界 | owner | 职责 |
|---|---|---|
| Reconciliation host | Conductor TypeScript | wake、执行屏障、fresh read、安全gate、调用、materialize、read-back、恢复 |
| Root Reconciler role | Performer Python | 从一次完整bootstrap和后续增量事实解释Root并选择唯一下一步 |

这不是两个语义loop。只有Root Reconciler决定业务下一步；Conductor只实施不可由模型绕过的安全、ownership、
完整性、schema、staleness、capability、budget、convergence和write precondition约束。可读取的lifecycle、DAG或
Tree不一致是bootstrap/delta中的事实，不是Conductor在调用模型前修正或拒绝的业务结论。
Root Reconciler不能调用Linear/Git/Conductor，不能直接执行Plan/Work/Verify，也不能返回任意GraphQL、shell
command或callback。Conductor不包含Agent SDK或Provider兼容逻辑。

```text
wake on durable change
-> establish one Root execution barrier
-> settle or cancel any in-flight Stage turn without assigning business meaning
-> Conductor reads fresh complete Root Tree, Linear input sources and Git facts internally
-> enforce ownership, coverage, schema and execution-safety gates
-> open a fresh session with one bootstrap, or compute one RootDelta from the session baseline
-> obtain one directive from that bootstrap turn or delta turn
-> validate one RootDirective
-> persist accepted directive
-> materialize and read back any Human Action resolutions
-> materialize one semantic action with stable write IDs
-> semantic read-back
-> materialize and read back required user-comment replies
-> publish and materialize required timeline events
-> discard transient view
```

Root Reconciliation是fact-driven的，不是持续消耗token的poll loop。Webhook、poll和process wake只表示“重新
读取”，不是durable业务event或第二套状态机。没有新的未消费Root input、Stage/Runtime事实、未materialize
directive或到期机械deadline时，不调用模型。

## 3. Session与角色隔离

- 每个owned Root最多一个Root Reconciler session；它可以跨多个Cycles和turn复用；
- 每个Cycle最多一个Plan、一个Work和一个Verify role session，三个session互相隔离；
- Root Reconciler session不能兼任Plan、Work或Verify；
- Cycle结束时关闭该Cycle的三个Stage sessions，successor Cycle使用fresh Stage sessions；
- Root Reconciler thread只提供runtime continuity，不是durable authority；丢失后从Linear/Git打开fresh session；
- fresh session只在open时接收一次完整`RootBootstrapSnapshot`；已打开session后只接收严格连续的`RootDelta`；
- Provider thread中的既有上下文不能覆盖新delta；baseline digest无法证明时必须丢弃session并重新bootstrap。

## 4. Bootstrap与Delta contract

### 4.1 新Session bootstrap

```text
OpenRootReconcilerRequest
  protocol_version
  request_id
  reconciler_session_id
  reconciler_turn_id
  observed_at
  bootstrap
    root_snapshot
      root
      cycles[]
      issues[]
      relations[]
      managed_records[]
      user_comments[]
      git_facts
      delivery
      mechanical_violations[]
    source_manifest[]
    coverage
    root_digest
    pending_input_ids[]
  limits

RootReconcilerOpenedResult
  reconciler_session_id
  bootstrap_root_digest
  initial_directive: RootDirective
```

bootstrap必须包含Root下全部active和archived Cycles、Issues、relations、managed records、用户comments和Git事实。
其中Linear source manifest必须覆盖active与archived Issue、comment、relation和status catalog，并为每个source提供稳定
identity、version和actor kind；`coverage.is_complete`为false或存在未解释的required omission时，Conductor不得调用
Reconciler。Linear读取必须分页到完整并使用include-archived能力。它只允许用于新建Root Reconciler session，或原session丢失、
baseline mismatch、context无法继续可信使用后的fresh session；普通advance不得携带完整snapshot。
open本身执行首个ReAct turn并返回`initial_directive`，不能再发送空delta来取得第一步。

所有Linear文本和Provider输出都是untrusted data。每个source保留identity、actor kind、remote version或digest
和长度边界。未知字段、required source被静默截断、Tree digest不匹配或coverage不完整时不得调用Reconciler。

### 4.2 已有Session delta

```text
AdvanceRootReconcilerRequest
  protocol_version
  request_id
  reconciler_session_id
  reconciler_turn_id
  observed_at
  delta
    base_root_digest
    target_root_digest
    changes[]
    pending_input_ids[]
  limits

RootDeltaChange =
  IssueCurrentValue |
  IssueDetached |
  CommentCurrentValue |
  CommentRemoved |
  RelationCurrentValue |
  RelationRemoved |
  ManagedRecordCurrentValue |
  ManagedRecordRemoved |
  GitFactsCurrentValue |
  MechanicalViolationsCurrentValue
```

每个change只携带该source的当前bounded值或明确tombstone，不携带旧值、自然语言diff、业务影响或建议动作。
description变化发送新的完整description；comment新增或编辑发送新的完整body；status、archive、parent和relation
发送新的当前值。每个change携带source identity、source version、actor kind和observed time；删除或脱离Tree使用
明确tombstone。`base_root_digest`必须精确等于该session已确认baseline，`target_root_digest`必须等于Conductor本轮
fresh完整读取计算出的digest。delta本身必须足以把session内的base facts严格推进到target facts，不发送完整target
source manifest。

Conductor每轮仍完整读取Linear/Git，但完整Tree只在Conductor内存中用于coverage、diff和precondition校验；正常
advance只把`RootDelta`发送给Performer。session baseline snapshot和source manifest只存在于runtime memory，不写
workflow DB、checkpoint或Linear镜像。合法directive返回后baseline推进到target digest；directive invalid、session
丢失、delta不连续或baseline无法证明时，关闭旧session并从fresh完整事实重新bootstrap，不尝试兼容或猜测缺失delta。

因此，完整读取和完整传输是两个不同的边界：Conductor可以每轮从Linear重建完整事实来保证diff正确，但Performer
已有session永远只看到从已确认baseline到新target的当前值/tombstone增量。任何把完整Tree塞入advance request的实现都
违反本架构，即使它同时附带了delta或声称只是为了安全校验。

### 4.3 Delta不是第二套状态模型

`RootDelta`是一次Root Reconciler turn的传输输入，不是Linear revision、change event或独立的业务状态对象。它没有
自己的创建、确认、重试、完成、失效或恢复生命周期；Conductor不得把delta写入Linear、Workflow DB、queue、checkpoint
或本地revision store。Conductor只在本轮内存中将fresh Linear/Git facts与当前session baseline比较，生成一份delta；
Performer在成功消费并返回directive后，仅推进自己的runtime baseline。

delta传输失败、过期、不连续、schema无效或session丢失时，不补发旧delta、不猜测缺失变化、不引入revision事件状态机。
Conductor关闭不可证明的session，从新的完整Linear/Git事实发送一次`RootBootstrapSnapshot`。Linear中实际存在的Issue、
comment、relation、managed record和accepted directive仍是唯一durable事实；delta只是把这些事实交给同一个Root
Reconciler session的增量边界。

`root_digest`只覆盖canonical Root Reconciler Fact Set：业务Issue当前值、relations、业务managed records、普通human
comments、Git/delivery事实和mechanical violations。Raw SDK对象、Timeline comments、Reconciler reply comments、
transport heartbeat和其他明确排除的automation comments不属于该fact set，其写入不会改变digest或触发模型。
fresh bootstrap和每份delta必须使用同一canonicalization/schema version。

`MechanicalViolationsCurrentValue`只陈述从fresh facts计算出的可验证矛盾，例如多个nonterminal Cycles、Canceled Root仍有
active Cycle、active dependency指向archived Node或无matching Result的Done Stage。它们必须交给Root Reconciler
选择接受、修复、取消、replan、supersede或请求Human Action。只有无法证明ownership、读取不完整、schema无法
安全解析或目标越出owned Root时，Conductor才可以在调用模型前fail closed。

## 5. Root输入

每个用户对owned Root Tree的修改都必须进入Root Reconciler，包括status、title、description、archive/restore、
parent、relation、普通comment以及Human Action的status/comment。用户不需要创建结构化change request、选择mutation
类型或理解Symphony协议。

Conductor把需要Root Reconciler解释的用户变化统一为一个很小的closed input union，并作为matching delta change
的identity传输：

```text
RootInput =
  UserIssueInput |
  UserCommentInput |
  UserRelationInput

RootInputIdentity
  input_id
  actor_kind: human | external_automation | unknown
  root_issue_id
  source_id
  source_version
  observed_at
```

`input_id`优先使用Linear activity/comment/version的稳定identity；没有独立activity identity时，使用source identity和
remote version生成。它只用于去重、stale detection和把directive绑定到已观察输入，不保存旧值、字段diff、业务
分类或处理状态。

Issue输入携带该version的当前bounded Issue内容；Relation输入携带当前relation事实；Comment输入携带完整当前body。
删除、detachment或relation removal使用matching tombstone input，不伪造空值。是否改变业务语义只能由Root
Reconciler结合thread baseline和本轮delta判断。delta不拥有独立业务生命周期。

每个accepted `RootDirectiveRecord`直接保存`consumed_input_ids[]`。Conductor从Linear当前非Symphony source versions
减去accepted directive已经消费的identity，派生`pending_input_ids[]`；不创建本地checkpoint，也不创建另一份input lifecycle。
Symphony自身带matching stable write ID且已经read-back的mutation会进入后续delta，但不作为新的用户输入再次
触发语义判断。accepted directive尚未完成时，Conductor只恢复同一materialization，不调用模型。

### 5.1 用户comment与过滤

用户可以在Root、Cycle、Plan、Work、Verify或Human Action Issue下用普通自然语言comment改变、纠正或询问
执行，不需要JSON、command、directive ID或结构化change request。例如：

```text
这个Plan漏了数据库迁移，请重新规划。
当前实现方向不合理，改成事件驱动。
测试环境刚才有问题，请重新跑Verify。
认证暂时不做，先完成只读查询。
```

pending `UserCommentInput`不是持久集合。Conductor每次从完整Linear comments减去accepted directive中的
`consumed_input_ids[]`后派生；只包含human actor创建且没有Symphony managed marker的普通comment。必须排除：

- Root Control Record Comment；
- Root/Cycle Timeline projection comments；
- Root Reconciler directive和reply records；
- Plan/Work/Verify Result records；
- Human Action request/resolution records；
- Finding、budget、convergence和delivery records；
- Symphony bot、Linear integration或其他automation actor创建的comment。

过滤依据是validated actor identity与managed marker，不是“第一条comment”、作者显示名、文本前缀或comment
位置。即使Root Control Record Comment不再是第一条也必须排除；用户创建的第一条普通comment必须保留。

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

同一`comment_id + comment_version`形成一个稳定`input_id`并最多处理一次。编辑后的comment version是新的输入；
已经materialize的旧comment决定不会因删除或编辑自动回滚，用户必须通过新version或新comment明确纠正。

Human Action中的用户comment既保留为完整Action上下文，也只有在matching status和时序事实成立后，Root
Reconciler才能通过directive形成`HumanActionResolutionRecord`；Conductor不能把普通comment解释成Approved、
Rejected或Answered。Action
仍为Todo/In Progress时，reason/answer comment可以收到“等待状态选择”的回复，但不能提前产生审批后果。

### 5.2 reconciliation barrier与并发

任何pending用户输入都会建立同一种Root execution barrier并阻止新的Stage dispatch。Conductor不按field、status
或comment内容决定屏障强度，也不猜测业务影响。它先请求当前in-flight Stage turn在安全边界停止，持久化并
read-back真实attempt/Git事实，再构造稳定的fresh target facts和delta。late Result不能跨该barrier被接受。

Root Reconciler随后决定continue、fresh rerun、replan、Tree patch、supersede、cancel或Human Action。即使输入只是
普通讨论，也必须由Root Reconciler返回`acknowledge`或其他directive后才能重新dispatch；barrier前的turn不能跨
旧Tree digest复用。

## 6. 用户comment回复contract

每个被消费且仍存在的用户comment input必须由同一个`RootDirective`给出用户可见回复。多个comment表达同一意图
时可以共享一个action，但每个现存comment input仍必须有matching reply。用户删除comment产生tombstone input并被
directive消费，但已经不存在可回复target，因此不生成reply。

```text
UserCommentReply
  source_input_id
  source_comment_id
  source_comment_version
  acknowledgement
  interpreted_request
  decided_action
  next_step
```

这些字段是bounded自然语言，不包含raw reasoning、transcript、secret、内部ID要求或未经read-back的成功声明。
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

reply comment由closed renderer生成，marker使它永远不会重新进入pending inputs。accepted directive
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
  based_on_target_root_digest
  consumed_input_ids[]
  rationale
  evidence_refs[]
  comment_replies[]
  human_action_resolutions[]
  action:
    ExecutePlanDirective |
    ExecuteWorkDirective |
    ExecuteVerifyDirective |
    RerunStageDirective |
    ReviseRootTreeDirective |
    ReplanCurrentCycleDirective |
    SupersedeCycleDirective |
    CreateCycleDirective |
    RequestHumanActionDirective |
    ConcludeCycleDirective |
    ConcludeRootDirective |
    CancelRootDirective |
    WaitDirective |
    AcknowledgeDirective
```

没有产生可接受directive的turn必须写Linear failure evidence：

```text
RootReconcilerFailureRecord
  failure_id
  reconciler_session_id
  reconciler_turn_id
  target_root_digest
  category: transport_failed | timed_out | schema_invalid | stale_output
  sanitized_reason
  usage?
  failed_at
```

该record只参与retry/budget计数和用户时间轴，不拥有Root/Cycle status或下一步。写入并read-back失败时matching Root
立即停止；不得把失败只记在memory/log后继续调用模型。

所有variants是closed、versioned、`additionalProperties: false`的discriminated union。每个turn最多返回一个
directive；需要多个Linear/Git writes的单一领域动作共享一个stable directive ID，Conductor按明确顺序幂等
materialize并read-back，不能在partial success后重新询问模型制造第二份逻辑动作。

`consumed_input_ids[]`必须精确覆盖本轮bootstrap或delta中的pending inputs，不能遗漏，也不能引用本轮request
中不存在的输入。
`comment_replies[]`必须精确覆盖其中全部仍存在的用户comment inputs，并排除comment tombstones。无业务影响时也
返回`acknowledge`并消费输入，不创建另一份disposition状态。`human_action_resolutions[]`只在matching Action terminal status、actor、proposal digest和
所需comment事实成立时出现；Conductor验证并materialize，但不能自行生成resolution。

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

### 7.2 Root Tree patch

```text
ReviseRootTreeDirective
  kind: revise_root_tree
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

该variant是Root Reconciler接受、修正或重组现有Root Tree的唯一通用patch，不限于“非法lifecycle”或Cycle DAG。
它可以处理用户status、content、archive、parent、relation和DAG变化，也可以修复bootstrap/delta中的机械矛盾。
每个operation携带matching target remote version、status、archive、parent和relation preconditions。语义delete使用
Linear原生archive flag；archived Issue仍进入后续delta和fresh bootstrap。Conductor只检查operation安全和precondition，
不能自行生成该directive或替换其中的requested outcome。

### 7.3 当前Cycle replan

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

### 7.4 结束当前Cycle并创建successor

```text
SupersedeCycleDirective
  kind: supersede_cycle
  current_cycle_issue_id
  reason: root_contract_changed | cycle_change_not_absorbable | no_safe_replan
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
CreateCycleDirective
  kind: create_cycle
  predecessor_cycle_issue_id?
  reason:
    initial | root_contract_changed | repair_required | exhausted |
    user_requested_retry | unresolved_findings
  plan_trigger
  inherited_fact_refs[]
  invalidated_delivery_refs[]
```

`initial`只允许Root尚无Cycle时使用；其他reason必须携带matching predecessor。Conductor机械验证不存在另一个
nonterminal active Cycle、Root仍可运行、convergence允许且predecessor保持terminal，再创建fresh Cycle和三个fresh
Stage sessions。`invalidated_delivery_refs`引用Git中的旧PR、branch或commit，说明其
不再匹配最新Root contract；不删除或复制这些Git事实。

### 7.5 Human、conclusion与wait

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
  conclusion: ready_for_delivery
  evidence_refs[]

CancelRootDirective
  kind: cancel_root
  reason
  active_cycle_issue_id?
  invalidated_execution_ids[]
  preserved_fact_refs[]

WaitDirective
  kind: wait
  reason_code
  blocking_fact_refs[]

AcknowledgeDirective
  kind: acknowledge
  reason
```

`cancel_root`是把用户取消意图收敛为durable Root终止事实的唯一语义动作。Conductor验证ownership和remote
preconditions后停止matching executions、将nonterminal Cycle以`canceled` outcome收敛、关闭Root/Cycle sessions并
保持Root `Canceled`；用户已经直接修改Root status时不得重复回滚或重写该选择。

`acknowledge`消费无业务影响的pending inputs并写matching comment replies。barrier前的Stage turn已经settle或cancel；
继续执行时Root Reconciler必须在下一轮基于fresh digest返回新的execute/rerun directive，不能复用旧turn。

`wait`必须对应active Human Action、外部事实或有界runtime condition，不能制造无deadline等待。Cycle budget、
Root convergence、passed Verify和delivery gates始终由Conductor机械验证。

## 8. 用户修改的业务语义

Root Reconciler根据用户comment、Issue field/status、archive和relation变化判断业务影响，而不是要求用户创建
结构化change request。

| 用户变化 | 默认语义 | 允许结果 |
|---|---|---|
| Root `Canceled` | 可能表达放弃整个目标 | `cancel_root`、修复状态或请求澄清 |
| Root requirement实质变化 | 旧Cycle contract失效 | supersede当前Cycle并创建successor、或请求澄清 |
| Plan错误但Root contract未变 | 当前执行方案失效 | 当前Cycle replan |
| Work内容、顺序或依赖调整 | 可能仍在Contract内 | continue、rerun、DAG patch、replan |
| Verify环境或要求变化 | 当前证据可能失效 | rerun Verify、replan、successor或Human Action |
| 用户手工修改managed Issue status | status是lifecycle事实，但不自动伪造Result | 接受合法lifecycle意图、拒绝无证据完成或请求澄清 |
| 普通讨论或无执行含义comment | 不改变workflow | acknowledge并继续 |

Root Reconciler负责全部业务语义分类。Conductor对任何用户输入都先建立相同屏障，不能因为观察到`Canceled`、
`Done`或其他status而自行完成取消、回滚或重开。没有matching Result不能把Work/Verify手工`Done`作为Stage成功证据，
没有passed Verify不能materialize delivery；这些是directive执行precondition，不是Conductor对用户意图的解释。

### 8.1 Root contract变化所在阶段

| 当前事实 | 实质Root requirement变化后的处理 |
|---|---|
| 尚无Cycle | 新需求成为initial Cycle的Plan输入，不制造空的superseded Cycle |
| 已有nonterminal Cycle | 当前Cycle `superseded` terminal，创建successor Cycle并fresh Plan |
| 最新Cycle已terminal、Root仍active | 不改写terminal Cycle；`create_cycle`并fresh Plan |
| Root `In Review` | 旧delivery保留但不再匹配最新Root contract；Root回到`In Progress`并`create_cycle` |
| Root `Done`或`Canceled` | Root Reconciler结合全部输入决定保持terminal、重开、修复或请求澄清 |

### 8.2 Cycle内修改的结果

Cycle内用户修改由Root Reconciler结合Approved Plan Contract判断：无影响则acknowledge/continue；Contract内执行
变化使用rerun或DAG patch；Plan错误但Root contract未变使用当前Cycle replan；修改破坏Root contract或无法在
当前Cycle安全收敛时使用supersede并创建successor。Conductor不按field name或comment关键词机械选择结果。

## 9. Lifecycle与恢复

### 9.1 初始Cycle

```text
owned Root has no Cycle
-> Conductor validates ownership, complete coverage and convergence
-> open Root Reconciler session with the empty-Cycle fact
-> Reconciler returns create_cycle(reason=initial)
-> Conductor materializes and reads back initial Cycle
-> next Reconciler turn requests Plan
```

### 9.2 Stage Result

```text
Stage Result returned
-> validate role/session/turn/context/Git preconditions
-> persist immutable Result
-> read back
-> fresh read and derive RootDelta from the session baseline
-> Root Reconciler chooses the next directive
```

Result不能直接映射为下一Stage。Provider crash、schema failure和business blocked是不同durable facts；普通Work
错误应先在Work tool loop预算内自行诊断和重试。

### 9.3 Human Action

用户status/comment经Conductor做actor、source version、scope和schema验证后作为pending inputs进入下一份
`RootDelta`。Root Reconciler决定它们是否形成`HumanActionResolutionRecord`以及随后继续、replan、调整Tree、
successor或新Action；Conductor不硬编码Approved后Work或Rejected后replan。

### 9.4 process与session恢复

Conductor不保存workflow DB、Queue、checkpoint或durableProvider pointer。重启后从Linear/Git重建Root；任何
accepted但未完成directive按stable write ID继续materialize。Root Reconciler session丢失时使用fresh完整facts进行
一次bootstrap；正常session advance始终只发送delta。旧session output失效。

输入是否已经处理只由Linear中的accepted `RootDirectiveRecord.consumed_input_ids[]`证明。输入和delta不拥有独立
业务lifecycle；恢复时从fresh source versions、accepted directives和未完成materialization直接收敛。

## 10. Timeline与comment reply区别

- Timeline由typed event subscriber写入Root或matching Cycle Issue；
- comment reply由`RootDirective`携带并作为该directive的必需Linear mutation写回原Issue；
- 两者都使用closed renderer、managed marker和deterministic ID，不由业务模块拼任意Markdown；
- 两者写入或read-back失败都会停止当前Root推进并记录correlated error；
- 不存在Linear之外的pending reply/projection状态。恢复只根据Linear source record与matching managed comment是否
  存在继续同一写入；timeline和reply都不会作为新的用户comment输入。

## 11. Budget与性能

Root Reconciler只在durable Linear/Git边界调用：新用户输入、Stage Result、Human resolution、Tree变化、
execution failure、Cycle conclusion或到期deadline。heartbeat、token stream、tool progress和重复webhook不调用模型。
accepted directive缺少required reply或timeline comment时也不调用模型；Conductor先完成同一Linear
materialization，成功read-back后才能继续。

Reconciler有Root级turn/token/deadline limits；Stage仍有Cycle/turn budgets。bootstrap或delta超出context bound时必须
通过closed coverage明确缺失并使matching Root fail closed，或使用由durable source支持的bounded history view；
不能静默截断或让旧transcript补全事实。

## 12. 不变量

1. 每个Root只有一个模型驱动的Root Reconciler语义角色；Cycle没有独立语义决策角色。
2. Conductor始终调用Performer；Performer从不回调Conductor或直接修改Linear/Git。
3. Root Reconciler session跨Cycles；Plan、Work、Verify sessions按Cycle隔离且不跨Cycle复用。
4. 新Root Reconciler session接收一次完整active和archived bootstrap；后续turn只接收从matching baseline严格连续的
   `RootDelta`，并最多返回一个closed `RootDirective`。
5. 所有用户status、content、archive、parent、relation和普通comment变化都作为pending inputs进入Root Reconciler；
   managed/system comments按actor和marker排除。
6. 每个处理过且仍存在的用户comment version都有matching consumed input和read-back后回复；comment tombstone只
   消费不回复，其他缺少回复时Root停止推进。
7. 每个input identity最多被一个accepted directive消费；delta没有独立业务状态，Symphony自身mutation不作为新的
   用户输入回流。
8. Root requirement实质变化不能继续沿用旧Cycle成功声明；必须successor或澄清。
9. Plan错误但Root contract未变可以在当前Cycle内replan；Contract内执行变化可以修改DAG或rerun。
10. Stage Result必须durable并read-back后才能进入下一次Root reconciliation。
11. Linear/Git是durable authority；Provider thread、timeline和reply都不是恢复authority。
