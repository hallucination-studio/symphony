# Symphony架构术语表

状态：目标架构术语唯一事实源。`docs/architecture`中的业务名词、代码类型名和字段名
必须遵守本文；类型后缀和文件组织遵守[代码模块与命名规范](code-organization.md)。

## 1. 使用规则

1. 文档第一次出现领域概念时使用本文的Canonical Term。
2. 代码类型使用本文给出的PascalCase名称，不按作者偏好创建近义类型。
3. JSON Schema、Managed Marker和跨语言wire字段使用`lower_snake_case`。
4. TypeScript文件名与主要类型同名；Python文件使用对应`snake_case`。
5. UI label可以面向用户翻译，但不能反向成为领域状态或代码enum名称。
6. `Interface`表达稳定能力，`Impl`表达内部实现；调用方只依赖Interface。

## 2. 产品角色

| Canonical Term | 代码/目录名 | 定义 | 不使用 |
|---|---|---|---|
| Symphony | repository/product | 完整产品 | 把四个角色称为四个产品 |
| Podium Desktop | `apps/podium-desktop` | 用户使用的本地Desktop产品 | Desktop Client、Podium Client |
| Podium | `packages/podium` | Desktop内部control-plane类库和Linear所有者 | Podium Server、Podium Backend作为领域名 |
| Conductor | `apps/conductor` | 解释Linear事实并调度Root Run的TypeScript daemon | Scheduler Service、Agent Manager |
| Performer | `apps/performer` | 执行一个Plan、Work或Verify Stage的Python进程 | Worker Agent、Codex Runner |

`Podium Backend`只允许描述Desktop进程拓扑中的Podium宿主，不是独立业务角色。

## 3. Conductor与Project

| Canonical Term | 代码类型/字段 | 定义 |
|---|---|---|
| Conductor Identity | `ConductorId` / `conductor_id` | Podium创建的稳定完整身份 |
| Conductor Short Hash | `ConductorShortHash` / `conductor_short_hash` | 用于Linear Label的短公开标识 |
| Repository Context | `RepositoryContext` / `repository_context` | repository identity、display、root和base branch的绑定输入 |
| Conductor Binding | `ConductorBinding` | Podium持久化的Conductor Identity + Repository Context + desired state；不包含权威Project |
| Conductor Project Label | `ConductorProjectLabel` | Linear Project上的`symphony:conductor/<short-hash>` |
| Resolved Conductor Project | `ResolvedConductorProject` | 当前唯一携带Conductor Project Label的Project |
| Project Resolution | `ProjectResolutionResult` | unique、unbound或conflict的解析结果 |
| Last Resolved Project | `lastResolvedProjectId` / `last_resolved_project_id` | Podium保存的可丢弃观察，仅用于Desktop解释Project变化 |

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
desiredState
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
| Root DAG View | `RootDagView` | 从fresh Linear Cycle DAG和Git事实重建的当前内存视图 |
| Root Workflow Policy | `RootWorkflowPolicyInterface` | 从Root DAG View派生一个closed业务decision的纯Policy边界 |
| Root Workflow Decision | `RootWorkflowDecision` | create Cycle、await Human、execute node、deliver等一次性派生结果；只存在于内存 |
| Linear DAG Execution | `LinearDagExecutionInterface` | claim并执行一个ready typed node、materialize结果和read-back的Conductor边界 |
| Agent Execution Policy | `AgentExecutionPolicy` | Profile保存的sandbox mode和有界command allowlist/denylist；作为Stage policy输入由Provider Backend映射 |
| Root Activity Projection | `RootActivityProjection` | planning、awaiting-human、working、reviewing、delivering、blocked、failed的人类可见派生值 |
| Root Activity Label | `RootActivityLabel` | Linear上的`symphony:run/*` best-effort投影；不参与readiness、eligibility或恢复 |
| Root Managed Comment | 领域概念 | Symphony在Root下管理的用户可见comment，分为Primary Status与Timeline两类 |
| Root Primary Status Comment | `RootManagedCommentSnapshot` | claim时创建的第一条Symphony-managed Root comment；保存恢复字段并按comment ID实时upsert观察状态 |
| Root Timeline Comment | `LinearCommentSnapshot` | Plan、terminal Stage error、Verify findings和delivery等重要事件的受管comment |
| Root Dispatch Assessment | `RootDispatchAssessment` | Conductor从当前`RootRunView`派生的runnable/waiting/attention/terminal内存判断 |
| Next Action View | `NextActionView` | Desktop向用户展示的下一动作，不是Workflow命令 |

不使用`Managed Run`作为新架构代码名。历史语义在本架构中统一为`Root Run`；
持久化Aggregate不存在，代码只使用`RootDagView`。

## 5. Linear Cycle DAG与节点

| Canonical Term | 代码类型/字段 | 定义 |
|---|---|---|
| Linear Issue Tree | `LinearIssueTreeSnapshot` | Root Issue的完整Linear descendant tree |
| Root Cycle DAG | `RootCycleDagSnapshot` | Root下全部Cycle Issues及其typed nodes、relations和managed outcomes |
| Cycle Issue | `CycleIssueSnapshot` | Root direct child；一轮bootstrap-to-sealed graph lifecycle的container和结果汇总，不可dispatch |
| Cycle State | `CycleState` | Cycle authoritative Linear custom status：draft、planning、sealed、executing、verifying、succeeded、changes_required、inconclusive、escalated或canceled |
| DAG Node | `LinearDagNodeSnapshot` | Cycle direct child；kind closed为plan、work或verify |
| Bootstrap Plan Node | `PlanNodeSnapshot` | Cycle创建时唯一存在的Plan Stage target；输出Plan Contract但不由该execution DAG调度 |
| Plan Contract Digest | `plan_contract_digest` | Conductor对accepted Plan Contract计算的精确digest；sealed Work/Verify Nodes使用它证明共属同一approved graph |
| Work Node | `WorkNodeSnapshot` | 一个self-contained Work Stage target，可依赖同Cycle其他Work Nodes |
| Verify Node | `VerifyNodeSnapshot` | 审核本Cycleapproved Plan和全部Work evidence的Stage target |
| Stage Node State | `StageNodeState` | Plan/Work/Verify允许的todo、in_progress、in_review、done、failed或canceled Linear status子集 |
| Node Scheduling State | `NodeSchedulingState` | 从Linear DAG、approval和当前execution派生的blocked、ready或executing |
| Verify Conclusion | `VerifyConclusion` | successful Verify execution形成的passed、changes_required、inconclusive或escalate_human结论 |
| Finding Record | `FindingRecordSnapshot` | Verify针对固定artifact revision提出并由Conductor接受的scope内证据与remediation |
| Finding Disposition Record | `FindingDispositionRecord` | 后续Verify对immutable Finding记录still_open、resolved或Human-approved waived |
| Root Convergence Policy | `RootConvergencePolicy` | Root级cycle、open Finding persistence、no-progress、token、deadline与kill-switch约束 |
| Root Convergence View | `RootConvergenceView` | 从完整Linear Root历史重建、用于机械熔断的一次性内存计算 |
| Pending Human Action | `PendingHumanAction` | 写入Root managed comment并由Root `Needs Approval`或`Needs Info`表达的等待事实 |

`Sub Issue`只用于说明Linear的parent/child产品形态。业务逻辑不使用`Task`或`Work Item`；统一使用
Cycle Issue、Plan Node、Work Node或Verify Node。

Human action不创建专用DAG Node。approval和need-info的custom state都只作用于Root；action marker保存
matching Cycle/node identity。

## 6. Managed Linear数据

| Canonical Term | 代码类型/字段 | 定义 |
|---|---|---|
| Managed Marker | `ManagedMarker` | Symphony写入Linear对象的稳定identity与幂等关联字段 |
| Cycle Marker | `CycleMarker` | Cycle key、trigger、predecessor、approved Plan Contract identity、Git baseline和Root identity |
| DAG Node Marker | `DagNodeMarker` | Cycle、node key、node kind和matching `plan_contract_digest` |
| Plan Contract Comment | `PlanContractCommentSnapshot` | 本Cycle approved execution contract和Git/Root baseline |
| Stage Execution Comment | `StageExecutionCommentSnapshot` | Stage execution identity、source manifest、context digest、deadline、token reservation和owner generation identity |
| Stage Terminal Comment | `StageTerminalCommentSnapshot` | execution outcome和sanitized terminal error |
| Work Completion Comment | `WorkCompletionCommentSnapshot` | 人可读summary/checks/commit及幂等marker组成的Linear完成证据 |
| Verify Input Comment | `VerifyInputCommentSnapshot` | Root/Plan/Work/Finding source references、immutable Git artifact revision与matching Stage context digest |
| Verify Result Comment | `VerifyResultCommentSnapshot` | accepted Verify conclusion、validated Finding identities及matching artifact evidence |
| Root Convergence Comment | `RootConvergenceCommentSnapshot` | policy、override与Root级convergence evidence的closed managed record |
| Progress Assessment | `ProgressAssessment` | Cycle间prior Finding的精确resolution或passed acceptance/check key真超集 |
| Pending Action Marker | `PendingHumanAction` | Root approval/input的action ID、Cycle/node target、digest和remote precondition |
| Performer Profile ID | `PerformerProfileId` / `performer_profile_id` | Root固定使用的Performer Profile身份 |

文档正文使用完整名称；只有在代码块、字段说明或同一段明确上下文中才简写为
`marker`或`evidence`。

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
| `RootIssueSnapshot` | Root header、delegation、Priority、blockers和bounded Primary Comment外部事实副本；不含完整Tree |
| `LinearIssueTreeSnapshot` | 一个Root的完整descendant tree副本 |
| `LinearIssueNodeSnapshot` | Tree中的单个Issue节点副本 |
| `LinearCommentSnapshot` | Linear Comment外部事实副本 |
| `LinearBlockerSnapshot` | Root blocker relation外部事实副本 |
| `RootUsageSnapshot` | 一个managed Root的Profile、delivery和累计usage副本 |
| `ProjectResolutionResult` | unique、unbound或conflict的Project解析结果 |
| `LinearMutationResult` | 一个closed Linear mutation的执行结果 |
| `ProtocolError` | 跨进程Protocol统一使用的结构化、脱敏失败 |

### 7.3 Query

```text
ResolveConductorProjectQuery
ListRootIssuesQuery
GetIssueTreeQuery
ListRootUsageQuery
```

### 7.4 Command

```text
LinearMutationCommand
  = CreateManagedNodeCommand
  | UpdateManagedNodeCommand
  | UpdateIssueStateCommand
  | ReorderIssueNodeCommand
  | ReplaceRootActivityLabelCommand
  | UpsertRootManagedCommentCommand
  | ProjectRootCommentCommand
```

不使用含义不完整的`RootProjectionCommand`或只有字符串variant的
`LinearIssueMutationCommand`作为public contract。
`ProjectRootCommentCommand`是closed exclusive union：`comment_id` variant upsert
Root Primary Status Comment，`event_key` variant append Root Timeline Comment。

## 8. Conductor模块与能力

| Module | 拥有或依赖的Interface | 主要行为 |
|---|---|---|
| `linear-gateway` | 拥有`LinearGatewayInterface` | 通过Podium读取和修改封闭Linear事实 |
| `root-discovery` | 依赖`LinearGatewayInterface` | 发现Root Issue和读取调度输入 |
| `root-scheduling` | 拥有`RootSchedulingPolicyInterface` | 在多个runnable Roots中选择一个 |
| `root-workflow` | 拥有`RootWorkflowPolicyInterface` | 从fresh Cycle DAG/Git派生业务decision |
| `linear-dag` | 拥有`LinearDagExecutionInterface` | 验证DAG、构造context、claim并执行一个ready typed node、materialize Result |
| `performer-stage-client` | 拥有`PerformerStageClientInterface` | 通过短进程传输StageContext、Event和Result |
| `performer-profiles` | 拥有`PerformerProfileStoreInterface`和`PerformerProfileControlInterface` | 保存Profile并通过Performer SDK执行登录/status |
| `git-workspaces` | 拥有`GitWorkspaceInterface` | 创建、恢复、提交Root Git Workspace |
| `root-delivery` | 拥有`RootDeliveryInterface` | push并交付PR、remote branch或local branch |
| `runtime-reporting` | 拥有`ConductorRuntimeReporterInterface` | 向Podium报告构建named Desktop Views所需的脱敏状态 |

实现名称：

```text
PerformerStageClientInterface
  <- ShortProcessPerformerStageClientImpl

GitWorkspaceInterface
  <- NativeGitWorkspaceImpl

RootDeliveryInterface
  <- GitRootDeliveryImpl

ConductorRuntimeReporterInterface
  <- PodiumConductorRuntimeReporterImpl

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
| Stage Execution | `StageExecution` | 对一个Cycle内typed node的一次有界调用，使用fresh Provider context |
| Stage Context Envelope | `StageContextEnvelope` | Conductor为一次Stage构造的closed公共Envelope，包含identity、instructions、stage-specific facts、repository facts、policy和limits |
| Stage Instruction Bundle | `StageInstructionBundle` | trusted Symphony Stage instructions、output schema和适用repository instructions |
| Plan Stage Context | `PlanStageContext` | Root目标、previous Plan、实际Git diff、Verify evidence、unresolved Findings和attempted approaches |
| Work Stage Context | `WorkStageContext` | selected self-contained Work contract、有限Root边界、dependency terminal facts和Git baseline |
| Verify Stage Context | `VerifyStageContext` | Root/Plan criteria、Work evidence和固定Git artifact |
| Stage Wire | `StageWire` | Conductor创建并拥有的Stage message channel |
| Stage Event | `StageEvent` | best-effort实时观察，不参与Workflow |
| Stage Result | `StageResult` | 一个Stage execution的唯一terminal outcome |
| Stage Limits | `StageLimits` | context、wall time、tool和message的有界运行限制 |
| Stage Usage | `StageUsage` | Stage结束后的wall time与Provider token观察值 |
| Stage Suspension | `StageSuspension` | Performer缺少事实或授权时返回的terminal needs_info/needs_approval payload |
| Provider Backend | `ProviderBackendInterface` | Performer内部Provider能力边界 |
| Codex Backend | `CodexBackendImpl` | 当前唯一Provider实现 |

Plan、Work、Verify注入、Wire message和Human suspend/resume的完整语义只由
[Linear Workflow Loop与Performer Stage Context](stage-orchestration.md)定义。当前不设计sub-agents、
cross-Stage memory或第二Provider。

### 9.1 Performer Profile

| Canonical Term | 代码类型 | 定义 |
|---|---|---|
| Performer Profile | `PerformerProfile` | Conductor保存的一组Codex登录上下文和Turn设置 |
| Active Performer Profile | `activeProfileId` | Conductor为新Root选择的Profile |
| Codex Home | `CODEX_HOME` | Codex SDK拥有的auth、session和runtime state根目录 |
| Codex Turn Settings | `CodexTurnSettings` | model、reasoning effort和Fast设置；V1 reasoning闭合集为none、minimal、low、medium、high、xhigh |
| Profile Readiness | `PerformerProfileReadiness` | login-required、ready或invalid |
| Stage Usage | `StageUsageSnapshot` | 一次Stage Result携带的Codex SDK token使用量 |

一个Profile对应一个独立`CODEX_HOME`。Conductor只保存`PerformerProfile`和
`activeProfileId`；Codex-owned文件只由`CodexBackendImpl`通过官方SDK访问。
Profile的`backendKind`和`authenticationMethod`创建后不可修改；切换登录方式使用新
Profile。
每个Stage携带一次当前`CodexTurnSettings`快照；它是closed产品DTO，不是SDK
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

不使用`Delivery Receipt`；交付事实来自Git和Root Primary Status Comment。

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
  -> RuntimeObservationStoreInterface

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
RootSummaryView
RootDetailView
AttentionItemView
RuntimeEventView
NextActionView
PerformerProfileSummaryView
PerformerProfileDetailView
PerformerUsageView
```

`View`是可丢弃组合结果，不是Workflow或数据库事实。文档不使用没有具体类型名的
`安全View`、`Runtime View`或`Operator View`代替代码名称。

## 12. 状态名称

### 12.1 领域状态

- `RootDispatchAssessment.readiness`使用：`runnable`、`waiting_human`、`needs_attention`、`terminal`。
- `RootWorkflowDecision`使用closed variants：`create_initial_cycle`、`await_human`、`execute_node`、
  `create_successor_cycle`、`deliver`、`wait_in_review`、`terminal`、`needs_attention`。
- `RootWorkflowState`使用：`todo`、`in_progress`、`needs_approval`、`needs_info`、`in_review`、
  `done`、`canceled`。
- `CycleState`使用：`draft`、`planning`、`sealed`、`executing`、`verifying`、`succeeded`、
  `changes_required`、`inconclusive`、`escalated`、`canceled`。
- `StageNodeState`使用：`todo`、`in_progress`、`in_review`、`done`、`failed`、`canceled`；
  Plan/Work/Verify各自只允许其中明确子集。
- `StageNodeState`、`NodeSchedulingState`和`VerifyConclusion`是独立状态层，不能互相推断。
- `VerifyConclusion`使用：`passed`、`changes_required`、`inconclusive`、
  `escalate_human`；suspended和execution failure属于Stage execution outcome，不是Verify conclusion或
  terminal Cycle outcome。
- `RootActivityProjection`使用：`planning`、`awaiting-human`、`working`、`reviewing`、
  `delivering`、`blocked`、`failed`；它不是Workflow state。
- Linear display status使用Title Case；contract enum使用`UPPER_SNAKE_CASE`。完整display/category/enum
  映射只由[Root Issue工作流](root-issue.md)定义。
- `ConductorRuntimeStatus`使用：
  `stopped`、`starting`、`ready`、`recovering`、`unbound`、
  `project-conflict`、`not-responding`、`crashed`。
- `ConductorDesiredState`使用：`running`、`stopped`。
- `PerformerProfileReadiness`使用：
  `login-required`、`ready`、`invalid`。

### 12.2 UI label

UI可以显示Planning、Needs your attention、Working、Reviewing result、Preparing
delivery、Ready for review、Action required等用户语言；这些label不是领域enum。

## 13. 后缀引用

后缀含义和文件组织只由
[代码模块与命名规范](code-organization.md)定义。本文为每个领域概念指定完整代码
类型名；其他文档不得去掉后缀、替换为近义后缀，或把`Snapshot`、`View`和持久化事实
混为一类。

## 14. 禁止的模糊名称

| 不使用 | 改用 |
|---|---|
| Project Binding | Conductor Binding或Resolved Conductor Project |
| Managed Run | Root Run / RootDagView |
| Task | Cycle Issue或Plan/Work/Verify Node |
| Agent Config、Agent Profile（代码类型） | Performer Profile |
| Human Node、Plan Approval Node | Pending Human Action |
| Root Gate Node、Verify Gate | Verify Node |
| next action（代码类型） | `RootDispatchAssessment`或`NextActionView` |
| safe/runtime/operator view（代码类型） | 具体`*View`名称 |
| `PullRequestInterface` | `RootDeliveryInterface` |
| `RuntimeReportInterface` | `ConductorRuntimeReporterInterface` |
| `OperatorViewInterface` | `DesktopViewInterface` |
| `PodiumRuntimeInterface` | `PodiumDesktopInterface` |
| `SubprocessPerformerImpl` | `ShortProcessPerformerStageClientImpl` |
| `NativeGitWorktreeImpl` | `NativeGitWorkspaceImpl` |
| `GhPullRequestImpl` | `GitRootDeliveryImpl` |
| `PodiumRuntimeReportImpl` | `PodiumConductorRuntimeReporterImpl` |
| Manager、Service、Helper、Utils | 表达真实能力或行为的领域名称 |

## 15. 文档审阅规则

新增或修改架构文档时：

1. 先在本文查找现有概念；
2. 没有合适名称时，先判断是否真的出现了新业务概念；
3. 新跨模块类型必须同时说明owner、consumer和suffix；
4. 同一个概念不得同时拥有业务别名和代码别名；
5. UI文案与代码enum分开记录；
6. 搜索本文“禁止的模糊名称”，确保没有重新引入。
