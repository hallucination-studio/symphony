# Symphony架构术语表

状态：目标架构术语唯一事实源。`docs/architecture`中的业务名词、代码类型名和字段名
必须遵守本文；类型后缀和文件组织遵守[代码模块与命名规范](code-organization.md)。

## 1. 使用规则

1. 文档第一次出现领域概念时使用本文的Canonical Term。
2. 代码类型使用本文给出的PascalCase名称，不按作者偏好创建近义类型。
3. JSON Schema、managed code block和跨语言wire字段使用`lower_snake_case`。
4. TypeScript文件名与主要类型同名；Python文件使用对应`snake_case`。
5. UI label可以面向用户翻译，但不能反向成为领域状态或代码enum名称。
6. `Interface`表达稳定能力，`Impl`表达内部实现；调用方只依赖Interface。

## 2. 产品角色

| Canonical Term | 代码/目录名 | 定义 | 不使用 |
|---|---|---|---|
| Symphony | repository/product | 完整产品 | 把四个角色称为四个产品 |
| Podium Desktop | `apps/podium-desktop` | 用户使用的本地Desktop产品 | Desktop Client、Podium Client |
| Podium | `packages/podium` | Desktop内部control-plane类库和Linear所有者 | Podium Server、Podium Backend作为领域名 |
| Conductor | `apps/conductor` | 读取Linear/Git、跨Root排序并materialize RootDirective的TypeScript daemon；不做语义解释 | Scheduler Service、Agent Manager |
| Performer | `apps/performer` | 承载Root Reconciler和Plan/Work/Verify role threads的Python Agent runtime | Worker Service、Codex Runner |

`Podium Backend`只允许描述Desktop进程拓扑中的Podium宿主，不是独立业务角色。

## 3. Conductor与Project

| Canonical Term | 代码类型/字段 | 定义 |
|---|---|---|
| Conductor Identity | `ConductorId` / `conductor_id` | Podium创建的稳定完整身份 |
| Conductor Short Hash | `ConductorShortHash` / `conductor_short_hash` | 用于Linear Label的短公开标识 |
| Repository Context | `RepositoryContext` / `repository_context` | repository identity、display、root和base branch的绑定输入 |
| Conductor Binding | `ConductorBinding` | Podium持久化的Conductor Identity + Repository Context；不包含权威Project或process state |
| Conductor Project Label | `ConductorProjectLabel` | Linear Project上的`symphony:conductor/<short-hash>`；表示该Conductor是Project Conductor Pool成员 |
| Project Conductor Pool | `ProjectConductorPool` | 一个Project上全部唯一Conductor Project Labels形成的非空执行成员集合 |
| Root Conductor Label | `RootConductorLabel` | Root Issue上的唯一`symphony:conductor/<short-hash>`；从Project Conductor Pool中选择该Root的唯一执行者 |
| Root Routing | `RootRouting` | 由Project Conductor Pool和Root Conductor Label派生的routed、unrouted或conflict路由事实；不是runtime ownership或lease |
| Resolved Conductor Project | `ResolvedConductorProject` | 当前唯一携带本Conductor Project Label的Project；该Project可以同时携带其他Conductor Project Labels |
| Project Resolution | `ProjectResolutionResult` | unique、unbound或conflict的解析结果 |

禁止使用没有限定的`Project Binding`。需要表达Podium持久化对象时使用
`Conductor Binding`；需要表达Label解析结果时使用`Resolved Conductor Project`。

TypeScript中的`ConductorBinding`字段固定为：

```text
bindingId
conductorId
conductorShortHash
linearInstallationId
organizationId
repositoryContext
```

`RepositoryContext`负责承载repository相关字段，不在`ConductorBinding`中重复展开。

TypeScript中的`RepositoryContext`字段固定为：

```text
repositoryIdentity
repositoryDisplayName
repositoryRoot
baseBranch
```

## 4. Root Run领域

| Canonical Term | 代码类型/字段 | 定义 |
|---|---|---|
| Root Issue | `RootIssueSnapshot` | 被delegated给Symphony的顶层Linear Issue |
| Root Run | 领域概念 | Symphony对一个Root Issue的完整处理生命周期 |
| Root Workflow State | `RootWorkflowState` | Root允许的Todo、In Progress、Needs Approval、Needs Info、In Review、Done或Canceled Linear status |
| Root Reconciliation View | `RootReconciliationView` | 从fresh active/archived Linear Tree和Git事实重建的当前内存视图 |
| Root Safety Policy | `RootSafetyPolicyInterface` | 只验证ownership、coverage、schema、capability、budget、convergence和mutation preconditions；lifecycle/Tree矛盾只产出bootstrap/delta事实 |
| Root Directive | `RootDirective` | Root Reconciler基于session baseline和当前bootstrap/delta返回的一个closed语义下一步proposal |
| Root Bootstrap Snapshot | `RootBootstrapSnapshot` | fresh Root Reconciler session首次接收的完整active/archived Linear/Git事实；普通advance禁止使用 |
| Root Delta | `RootDelta` | 从matching session baseline到fresh target digest的当前值/tombstone增量；不包含旧值、业务diff或独立lifecycle |
| Agent Execution Policy | `AgentExecutionPolicy` | Profile保存的sandbox mode和有界command allowlist/denylist；作为Stage policy输入由Provider Backend映射 |
| Root Managed Comment | 领域概念 | Symphony在Root下管理的用户可见comment，包括Control Record、Timeline和Reconciler Reply |
| Root Control Record Comment | `RootControlRecordCommentSnapshot` | claim时创建的Symphony-managed Root comment；只承载ownership、fixed Profile等明确Root records，不保存status、current Cycle、ready node、activity或runtime observation |
| Root Timeline Comment | `LinearCommentSnapshot` | Root timeline event subscriber写到Root Issue的Markdown + `symphony` block comment |
| User Comment Input | `UserCommentInput` | human actor创建/修改的comment body version或native thread change；reaction不是pending input |
| Root Reconciler Reply | `RootReconcilerReplyRecord` | matching RootDirective处理用户comment后写入原生thread并read-back的reply、reaction和thread action |

不使用`Managed Run`作为新架构代码名。历史语义在本架构中统一为`Root Run`；
持久化Aggregate不存在，代码只使用`RootReconciliationView`。

## 5. Linear Cycle DAG与节点

| Canonical Term | 代码类型/字段 | 定义 |
|---|---|---|
| Linear Issue Tree | `WorkflowRootTreeSnapshot` | Root Issue的完整active和archived Linear descendant tree |
| Root Cycle DAG | `RootCycleDagSnapshot` | Root下全部Cycle Issues及其typed nodes、relations和managed outcomes |
| Cycle Issue | `CycleIssueSnapshot` | Root direct child；一轮bootstrap-to-sealed graph lifecycle的container和结果汇总，不可dispatch |
| Cycle State | `CycleState` | Cycle authoritative Linear custom status：draft、planning、sealed、executing、verifying、succeeded、changes_required、inconclusive、escalated或canceled |
| DAG Node | `LinearDagNodeSnapshot` | Cycle direct child；kind closed为plan、work或verify；archive=false时可参与active DAG |
| Bootstrap Plan Node | `PlanNodeSnapshot` | Cycle创建时唯一存在的Plan Stage target；输出Plan Contract但不由该execution DAG调度 |
| Plan Contract Digest | `plan_contract_digest` | Conductor对accepted Plan Contract计算的精确digest；sealed Work/Verify Nodes使用它证明共属同一approved graph |
| Work Node | `WorkNodeSnapshot` | 一个self-contained Work Stage target，可依赖同Cycle其他Work Nodes |
| Verify Node | `VerifyNodeSnapshot` | 审核本Cycleapproved Plan和全部Work evidence的Stage target |
| Stage Node State | `StageNodeState` | Plan/Work/Verify允许的todo、in_progress、in_review、done、failed或canceled Linear status子集 |
| Node Readiness | `NodeReadiness` | 每次从fresh Linear DAG、approval和matching execution record派生的blocked、ready或executing内存值；不持久化 |
| Verify Conclusion | `VerifyConclusion` | successful Verify execution形成的passed、changes_required、inconclusive或escalate_human结论 |
| Finding Record | `FindingRecordSnapshot` | Verify针对固定artifact revision提出并由Conductor接受的scope内证据与remediation |
| Finding Disposition Record | `FindingDispositionRecord` | 后续Verify对immutable Finding记录still_open、resolved或Human-approved waived |
| Root Convergence Policy | `RootConvergencePolicy` | Root级cycle、open Finding persistence、no-progress、token、deadline与kill-switch约束 |
| Root Convergence View | `RootConvergenceView` | 从完整Linear Root历史重建、用于机械熔断的一次性内存计算 |
| Human Action Issue | `HumanActionIssueSnapshot` | Root或Cycle direct child；用专用status/comment承载用户决定，不是DAG执行节点 |
| Native Archive Membership | `is_archived` | Linear原生archive flag；决定Issue是否属于active DAG，同时保留完整历史 |

`Sub Issue`只用于说明Linear的parent/child产品形态。业务逻辑不使用`Task`或`Work Item`；统一使用
Cycle Issue、Plan Node、Work Node或Verify Node。

Cycle Human Action是Cycle direct child并link相关节点；Root Action是Root direct child。Root waiting status只做
header summary，Action status/comment和closed resolution是用户交互事实。

## 6. Managed Linear数据

| Canonical Term | 代码类型/字段 | 定义 |
|---|---|---|
| Symphony Managed Comment | `SymphonyManagedComment` | validated Symphony actor写入、包含用户Markdown和唯一strict `symphony` code block的Linear comment |
| Cycle Issue Record | `CycleIssueRecord` | Cycle key、trigger、predecessor、approved Plan Contract identity、Git baseline和Root identity |
| DAG Node Issue Record | `DagNodeIssueRecord` | Cycle、node key、node kind和matching `plan_contract_digest` |
| Plan Contract Comment | `PlanContractCommentSnapshot` | 本Cycle approved execution contract和Git/Root baseline |
| Stage Execution Comment | `StageExecutionCommentSnapshot` | Stage execution identity、source manifest、context digest、deadline、token reservation和owner generation identity |
| Stage Terminal Comment | `StageTerminalCommentSnapshot` | execution outcome和sanitized terminal error |
| Work Completion Comment | `WorkCompletionCommentSnapshot` | 人可读summary/checks/commit及matching strict code block组成的Linear完成证据 |
| Verify Input Comment | `VerifyInputCommentSnapshot` | Root/Plan/Work/Finding source references、immutable Git artifact revision与matching Stage context digest |
| Verify Result Comment | `VerifyResultCommentSnapshot` | accepted Verify conclusion、validated Finding identities及matching artifact evidence |
| Root Convergence Comment | `RootConvergenceCommentSnapshot` | policy、override与Root级convergence evidence的closed managed record |
| Progress Assessment | `ProgressAssessment` | Cycle间prior Finding的精确resolution或passed acceptance/check key真超集 |
| Human Action Request Record | `HumanActionRequestRecord` | Action identity、parent scope、links、proposal digest和source directive |
| Human Action Resolution Record | `HumanActionResolutionRecord` | validated status/comment、actor、proposal和terminal resolution |
| Root Reconciler Failure Record | `RootReconcilerFailureRecord` | matching Reconciler turn的transport、timeout、schema或stale-output失败证据与usage；不含下一步 |
| Model Turn Record | `ModelTurnRecord` | 一次Root Reconciler/Plan/Work/Verify Provider调用的actual model、outcome和required Turn Usage |
| Workflow Timeline Record | `WorkflowTimelineRecord` | deterministic event ID到Root/Cycle Linear comment的幂等关联；不拥有Workflow状态 |
| Root Reconciler Reply Record | `RootReconcilerReplyRecord` | source human comment version到read-back后Linear thread reply、reaction和thread action的幂等关联 |
| Performer Profile ID | `PerformerProfileId` / `performer_profile_id` | Root固定使用的Performer Profile身份 |

所有restart-required managed事实都在strict `symphony` code block中。旧HTML marker、`ManagedMarker`、
`managed_marker`和dual reader不是canonical term，也没有兼容语义。

## 7. Linear Gateway

### 7.1 Interface与实现

```text
LinearGatewayInterface
  <- PodiumLinearGatewayClientImpl
     -> LinearGatewayProtocol
        -> LinearGatewayProtocolHandlerImpl
           -> LinearClientInterface
              <- LinearSdkImpl
```

| 名称 | 责任 |
|---|---|
| `LinearGatewayInterface` | Conductor定义的业务能力边界 |
| `PodiumLinearGatewayClientImpl` | Conductor内部private protocol client |
| `LinearGatewayProtocolHandlerImpl` | Podium内部generated protocol handler |
| `LinearClientInterface` | Podium内部最小Linear SDK能力边界 |
| `LinearSdkImpl` | 唯一Linear SDK实现 |

### 7.2 Snapshot与Result

| 代码类型 | 定义 |
|---|---|
| `LinearProjectSnapshot` | Gateway读取到的Project外部事实副本 |
| `RootIssueSnapshot` | Root header、delegation、Priority、blockers和bounded Control Record外部事实副本；不含完整Tree |
| `WorkflowRootTreeSnapshot` | 一个Root的完整descendant tree副本 |
| `LinearIssueNodeSnapshot` | Tree中的单个Issue节点副本 |
| `LinearCommentSnapshot` | Linear Comment外部事实副本 |
| `LinearBlockerSnapshot` | Root blocker relation外部事实副本 |
| `ProjectResolutionResult` | unique、unbound或conflict的Project解析结果 |
| `WorkflowMutationResult` | 一个closed Workflow mutation的执行结果 |
| `ProtocolError` | 跨进程Protocol统一使用的结构化、脱敏失败 |

### 7.3 Query

```text
ResolveConductorProjectQuery
ListRootIssuesQuery
GetWorkflowIssueTreeQuery
```

### 7.4 Command

```text
WorkflowMutationCommand
  = CreateWorkflowIssueCommand
  | UpdateWorkflowIssueCommand
  | AppendWorkflowCommentCommand
  | CreateCommentReplyCommand
  | SetCommentReceiptReactionCommand
  | SetCommentThreadStateCommand
  | CreateWorkflowRelationCommand
```

不使用含义不完整的`RootProjectionCommand`或只有字符串variant的
`LinearIssueMutationCommand`作为public contract。完整的command precondition、native Linear含义和read-back
规则只由[Contracts](contracts.md)定义；不存在`ProjectRootCommentCommand`、另一条Root comment writer或
compatibility command。

## 8. Conductor模块与能力

| Module | 拥有或依赖的Interface | 主要行为 |
|---|---|---|
| `linear-gateway` | 拥有`LinearGatewayInterface` | 通过Podium读取和修改封闭Linear事实 |
| `root-discovery` | 依赖`LinearGatewayInterface` | 发现Root Issue和读取调度输入 |
| `root-scheduling` | 拥有`RootSchedulingPolicyInterface` | 在多个runnable Roots中选择一个 |
| `root-reconciliation` | 拥有`RootSafetyPolicyInterface` | 从fresh facts验证安全边界、计算delta和机械矛盾；不选择业务下一步 |
| `root-reconciler-client` | 拥有`RootReconcilerClientInterface` | open发送一次bootstrap，advance只发送delta，并调用Performer Reconciler |
| `root-directive-materialization` | 拥有`RootDirectiveMaterializerInterface` | 验证、幂等执行和read-back directive |
| `performer-agent-client` | 拥有`PerformerAgentClientInterface` | 驱动Reconciler及三个Stage role session/turn request-response |
| `workflow-events` | 拥有`WorkflowTimelinePublisherInterface` | 发布typed Root/Cycle timeline event |
| `timeline-comments` | timeline comment subscribers | 渲染并写入Root/Cycle Linear timeline comments |
| `performer-profiles` | 拥有`PerformerProfileStoreInterface`和`PerformerProfileControlInterface` | 保存Profile并通过Performer SDK执行登录/status |
| `git-workspaces` | 拥有`GitWorkspaceInterface` | 创建、恢复、提交Root Git Workspace |
| `root-delivery` | 拥有`RootDeliveryInterface` | push并交付PR、remote branch或local branch |
| `runtime-logs` | 拥有`RuntimeLogPublisherInterface` | 只向Podium发布脱敏process/Profile日志；online/offline由Podium观察channel |

实现名称：

```text
PerformerAgentClientInterface
  <- SessionPerformerAgentClientImpl

GitWorkspaceInterface
  <- NativeGitWorkspaceImpl

RootDeliveryInterface
  <- GitRootDeliveryImpl

RuntimeLogPublisherInterface
  <- PodiumRuntimeLogPublisherImpl

RootSchedulingPolicyInterface
  <- LinearPriorityRootSchedulingPolicyImpl

PerformerProfileStoreInterface
  <- FilePerformerProfileStoreImpl

PerformerProfileControlInterface
  <- SubprocessPerformerProfileControlImpl

PerformerProfileProtocolHandlerImpl
  -> PerformerProfileStoreInterface
  -> PerformerProfileControlInterface
```

内部编排和纯规则使用：

| 代码类型 | 定义 |
|---|---|
| `ReconcileRootUseCase` | 为一个已admit Root执行一个fresh-derived bounded decision |
| `LinearPriorityPolicy` | `root-scheduling`内部的Linear Priority比较规则 |

不使用`PullRequestInterface`，因为交付能力不只包含PR；不使用没有所有者的
`RuntimeReportInterface`。

## 9. Performer

| Canonical Term | 代码类型 | 定义 |
|---|---|---|
| Root Reconciler Session | `RootReconcilerSession` | 一个Root专属、跨Cycles的模型ReAct role thread；只返回RootDirective |
| Role Session | `RoleSession` | Root Reconciler或一个Cycle内Plan、Work、Verify的隔离Provider thread runtime |
| Stage Turn | `StageTurn` | Conductor在Plan/Work/Verify role session上发起的一次有界调用 |
| Stage Turn Request Envelope | `StageTurnRequestEnvelope` | role/session/turn、target、instructions、facts、policy和limits的closed request |
| Stage Instruction Bundle | `StageInstructionBundle` | trusted Symphony Stage instructions、output schema和适用repository instructions |
| Plan Turn Context | `PlanTurnContext` | Root Contract、Cycle trigger、prior Plan/Findings/Human resolutions和Git facts |
| Work Turn Context | `WorkTurnContext` | approved Contract、current DAG、selected Work、dependencies和workspace baseline |
| Verify Turn Context | `VerifyTurnContext` | approved Contract、complete evidence、archived nodes和固定Git artifact |
| Stage Event | `StageEvent` | best-effort实时观察，不参与Workflow |
| Stage Result | `PlanResult` / `WorkResult` / `VerifyResult` | matching role turn的唯一terminal typed outcome |
| Stage Limits | `StageLimits` | context、wall time、tool和message的有界运行限制 |
| Turn Usage | `TurnUsage` | Root Reconciler或Stage调用的measured五维token usage，或显式unavailable原因 |
| Provider Backend | `ProviderBackendInterface` | Performer内部Provider能力边界 |
| Codex Backend | `CodexBackendImpl` | 当前唯一Provider实现 |

Plan、Work、Verify request/result语义只由[Stage Contracts](stage-orchestration.md)定义；Root Reconciler语义只由
[Root Reconciliation](root-reconciliation.md)定义。当前不设计role内部sub-agents或第二Provider。

### 9.1 Performer Profile

| Canonical Term | 代码类型 | 定义 |
|---|---|---|
| Performer Profile | `PerformerProfile` | Conductor保存的一组Codex登录上下文和Turn设置 |
| Active Performer Profile | `activeProfileId` | Conductor为新Root选择的Profile |
| Codex Home | `CODEX_HOME` | Codex SDK拥有的auth、session和runtime state根目录 |
| Codex Turn Settings | `CodexTurnSettings` | model、reasoning effort和Fast设置；V1 reasoning闭合集为none、minimal、low、medium、high、xhigh |
| Profile Readiness | `PerformerProfileReadiness` | login-required、ready或invalid |
| Usage Aggregate Snapshot | `UsageAggregateSnapshot` | 从Linear immutable ModelTurnRecords派生的Stage Issue、Cycle或Root累计与completeness；不是ledger |

一个Profile对应一个独立`CODEX_HOME`。Conductor只保存`PerformerProfile`和
`activeProfileId`；Codex-owned文件只由`CodexBackendImpl`通过官方SDK访问。
Profile的`backendKind`和`authenticationMethod`创建后不可修改；切换登录方式使用新
Profile。
每个role turn携带一次当前`CodexTurnSettings`快照；它是closed产品DTO，不是SDK
config。

Profile Command/Query：

```text
GetPerformerProfilesQuery
GetPerformerProfileStatusQuery
CreatePerformerProfileCommand
UpdatePerformerProfileCommand
StartCodexChatGPTLoginCommand
SetCodexApiKeyCommand
ActivatePerformerProfileCommand
```

Profile Result/Event：

```text
PerformerProfileCommandResult
  = PerformerProfileSavedResult
  | PerformerProfileActivatedResult
  | CodexLoginStartedResult

CodexLoginPendingEvent
CodexLoginSucceededEvent
CodexLoginFailedEvent
```

`CodexLoginStartedResult`只表示登录流程已被Conductor接受。认证成功必须由
`CodexLoginSucceededEvent`或后续`GetPerformerProfileStatusQuery`确认。

## 10. Git与交付

| Canonical Term | 代码类型 | 定义 |
|---|---|---|
| Git Workspace | `GitWorkspaceSnapshot` | 一个Root的deterministic branch + worktree |
| Delivery Branch | `DeliveryBranch` | `symphony/runs/<root-identifier-lower>` |
| Root Delivery | `RootDeliveryResult` | pull request、remote branch或local branch交付结果 |
| Pull Request Delivery | `PullRequestDeliveryResult` | 已创建或复用PR |
| Remote Branch Delivery | `RemoteBranchDeliveryResult` | 已push但没有PR |
| Local Branch Delivery | `LocalBranchDeliveryResult` | 无法push时保留local branch |

不使用`Delivery Receipt`；交付事实来自Git，Linear Root status只表达Workflow lifecycle。

## 11. Podium与Desktop

### 11.1 Protocol

| 代码类型 | 定义 |
|---|---|
| `PodiumClientProtocol` | React与Podium Backend之间的closed Command/Query/View协议 |
| `DesktopHostProtocol` | Podium Backend与Tauri Host之间的本地Host能力协议 |
| `ConductorRuntimeProtocol` | Podium与Conductor之间的handshake、health和shutdown协议 |
| `LinearGatewayProtocol` | Conductor经Podium执行closed Linear Query/Command的协议 |
| `PerformerProfileProtocol` | Podium经private channel管理Conductor Performer Profiles的协议 |
| `PerformerProfileControlProtocol` | Conductor调用Performer SDK登录和account/status的协议 |

`*Protocol`只命名跨进程closed wire边界，不代替业务`*Interface`。

### 11.2 Podium接口

```text
PodiumDesktopInterface
  <- PodiumDesktopImpl

DesktopViewInterface
  <- PodiumDesktopViewImpl

SqlitePodiumStoreImpl
  -> LinearInstallationStoreInterface
  -> ConductorBindingStoreInterface

PerformerProfileRelayInterface
  <- ConductorPerformerProfileRelayImpl
```

`PodiumDesktopInterface`是Desktop组合Podium用例的公开入口；
`DesktopViewInterface`只查询named Desktop Views。禁止使用含义过宽的`PodiumRuntimeInterface`和
`OperatorViewInterface`。

Podium的持久化Interface由事实所有者定义，不使用含义过宽的`PodiumStoreInterface`。
`SqlitePodiumStoreImpl`可以同时实现多个小Interface。
`PerformerProfileRelayInterface`只转发Profile Protocol，不持久化Profile或secret。
active Profile只有在Conductor接受`ActivatePerformerProfileCommand`后才改变，Podium
不拥有或乐观提交该事实。

### 11.3 Desktop Command

```text
ConnectLinearCommand
ReconnectLinearCommand
CreateConductorCommand
StartConductorCommand
StopConductorCommand
RestartConductorCommand
CreatePerformerProfileCommand
UpdatePerformerProfileCommand
StartCodexChatGPTLoginCommand
SetCodexApiKeyCommand
ActivatePerformerProfileCommand
```

这些Command只改变Desktop control-plane状态，不编辑Linear Workflow。

### 11.4 Desktop View

```text
DesktopOverviewView
LinearConnectionView
ConductorSummaryView
ConductorDetailView
ConductorPresenceView
RuntimeLogView
PerformerProfileSummaryView
PerformerProfileDetailView
ApplicationInfoView
```

Desktop View不得包含Workflow事实，是可丢弃查询结果而不是数据库事实。文档不使用没有具体类型名的
`安全View`、`Runtime View`或`Operator View`代替代码名称。

## 12. 状态名称

### 12.1 领域状态

- `RootDirective`使用closed semantic variants：`execute_plan`、`execute_work`、`execute_verify`、`rerun_stage`、
  `revise_root_tree`、`replan_current_cycle`、`supersede_cycle`、
  `create_cycle`、`request_human_action`、`conclude_cycle`、
  `conclude_root`、`cancel_root`、`wait`和`acknowledge`。
- `RootWorkflowState`使用：`todo`、`in_progress`、`needs_approval`、`needs_info`、`in_review`、
  `done`、`canceled`。
- `CycleState`使用：`draft`、`planning`、`sealed`、`executing`、`verifying`、`succeeded`、
  `changes_required`、`inconclusive`、`escalated`、`canceled`。
- `StageNodeState`使用：`todo`、`in_progress`、`in_review`、`done`、`failed`、`canceled`；
  Plan/Work/Verify各自只允许其中明确子集。
- Approval Human Action使用`todo`、`in_progress`、`approved`、`rejected`、`canceled`；Clarification使用
  `todo`、`in_progress`、`answered`、`canceled`。
- `StageNodeState`是Linear lifecycle；`NodeReadiness`是每次重算的内存值；`VerifyConclusion`是Result evidence。
  三者不能互相替代或另行持久化。
- `VerifyConclusion`使用：`passed`、`changes_required`、`inconclusive`、
  `escalate_human`；suspended和execution failure属于Stage execution outcome，不是Verify conclusion或
  terminal Cycle outcome。
- Linear display status使用Title Case；contract enum使用`UPPER_SNAKE_CASE`。完整display/category/enum
  映射只由[Root Issue工作流](root-issue.md)定义。
- Desktop公开连接状态只使用`LinearConnection: connected | disconnected`和
  `ConductorPresence: online | offline`；不得增加daemon lifecycle或Workflow派生状态。
- `PerformerProfileReadiness`使用：
  `login-required`、`ready`、`invalid`。

### 12.2 UI label

Desktop的连接与daemon状态只显示Connected、Disconnected、Online和Offline；Profile页面可以显示配置/认证Result，
但不能把它组合成新的daemon或Workflow状态。Workflow用户语言只出现在Linear comments和statuses。

## 13. 后缀引用

后缀含义和文件组织只由
[代码模块与命名规范](code-organization.md)定义。本文为每个领域概念指定完整代码
类型名；其他文档不得去掉后缀、替换为近义后缀，或把`Snapshot`、`View`和持久化事实
混为一类。

## 14. 禁止的模糊名称

| 不使用 | 改用 |
|---|---|
| Project Binding | Conductor Binding或Resolved Conductor Project |
| Managed Run | Root Run / RootReconciliationView |
| Task | Cycle Issue或Plan/Work/Verify Node |
| Agent Config、Agent Profile（代码类型） | Performer Profile |
| Human Node、Plan Approval Node | Human Action Issue |
| Root Gate Node、Verify Gate | Verify Node |
| Desktop Workflow/next action View | 不提供；在Linear查看 |
| safe/runtime/operator view（代码类型） | 具体`*View`名称 |
| `PullRequestInterface` | `RootDeliveryInterface` |
| `RuntimeReportInterface` | `RuntimeLogPublisherInterface` |
| `OperatorViewInterface` | `DesktopViewInterface` |
| `PodiumRuntimeInterface` | `PodiumDesktopInterface` |
| `SubprocessPerformerImpl` | `SessionPerformerAgentClientImpl` |
| `NativeGitWorktreeImpl` | `NativeGitWorkspaceImpl` |
| `GhPullRequestImpl` | `GitRootDeliveryImpl` |
| `PodiumRuntimeReportImpl` | `PodiumRuntimeLogPublisherImpl` |
| Manager、Service、Helper、Utils | 表达真实能力或行为的领域名称 |

## 15. 文档审阅规则

新增或修改架构文档时：

1. 先在本文查找现有概念；
2. 没有合适名称时，先判断是否真的出现了新业务概念；
3. 新跨模块类型必须同时说明owner、consumer和suffix；
4. 同一个概念不得同时拥有业务别名和代码别名；
5. UI文案与代码enum分开记录；
6. 搜索本文“禁止的模糊名称”，确保没有重新引入。
