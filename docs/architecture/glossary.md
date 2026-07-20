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
| Performer | `apps/performer` | 执行一个Performer Turn的Python进程 | Worker Agent、Codex Runner |

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
| Root Run View | `RootRunView` | 从Linear、Git和current Performer ID重建的当前内存视图 |
| Agent Symphony Harness | `AgentSymphonyHarnessInterface` | 评估Root readiness、组装Root context、运行Root Turn并read-back的Conductor边界 |
| Harness Cycle | `RunAgentRootTurnUseCase` | 一次read、Root Turn、read-back和discard；不是持久Run或Stage |
| Agent Root Context | `AgentRootContext` | trusted harness、human context和executable commands组成的有界Root Turn输入 |
| Agent Command Broker | `AgentCommandBrokerInterface` | 校验Root scope和precondition后调用Linear/Git owner的Harness边界 |
| Agent Execution Policy | `AgentExecutionPolicy` | Profile保存的sandbox mode和有界command allowlist/denylist；由Provider Backend映射 |
| Agent Cluster | `AgentClusterConfig` | V4受信任Agent/Profile/role/effect能力集合；不是Workflow graph或Queue |
| Root Activity Projection | `RootActivityProjection` | planning、awaiting-human、working、reviewing、delivering、blocked、failed的人类可见派生值 |
| Root Activity Label | `RootActivityLabel` | Linear上的`symphony:run/*` best-effort投影；不参与readiness、eligibility或恢复 |
| Root Managed Comment | 领域概念 | Symphony在Root下管理的用户可见comment，分为Primary Status与Timeline两类 |
| Root Primary Status Comment | `RootManagedCommentSnapshot` | claim时创建的第一条Symphony-managed Root comment；保存恢复字段并按comment ID实时upsert观察状态 |
| Root Retry Block | `RootRetryBlockSnapshot` | 新Conversation创建失败后写入Primary marker的closed retry interlock |
| Root Timeline Comment | `LinearCommentSnapshot` | Plan、retry、terminal error、Gate findings和delivery等重要事件的受管comment |
| Root Dispatch Assessment | `RootDispatchAssessment` | Harness从当前`RootRunView`派生的runnable/waiting/attention/terminal内存判断 |
| Next Action View | `NextActionView` | Desktop向用户展示的下一动作，不是Workflow命令 |

不使用`Managed Run`作为新架构代码名。历史语义在本架构中统一为`Root Run`；
持久化Aggregate不存在，代码只使用`RootRunView`。

## 5. Workflow Tree与节点

| Canonical Term | 代码类型/字段 | 定义 |
|---|---|---|
| Workflow Tree | `LinearIssueTreeSnapshot` | Root Issue的完整Linear descendant tree |
| Workflow Node | `LinearIssueNodeSnapshot` | Tree中的一个Linear Issue事实 |
| Work Node | `WorkNodeSnapshot` | `kind: work`的节点 |
| Work Leaf | `WorkLeafView` | 没有children、由Root Agent按Linear顺序处理的Work Node |
| Work Group | `WorkGroupView` | 有children、只用于组织和聚合状态的Work Node |
| Human Node | `HumanNodeSnapshot` | `kind: human`的叶子节点 |
| Plan Approval Node | `PlanApprovalNodeView` | Root级固定Human Node，批准当前Plan |
| Planned Input Node | `PlannedInputNodeView` | Plan预先要求的Human输入 |
| Runtime Input Node | `RuntimeInputNodeView` | Root Turn运行时创建的Human输入 |
| Root Gate Node | `RootGateNodeView` | 唯一的`[Root Gate]` managed Work child，保存严格Markdown checklist和read-back事实 |
| Root Gate Rework Node | `RootGateReworkNodeView` | 唯一的`[Rework] Root Gate Findings` Work Leaf |
| Planned Workflow Node | `PlannedWorkflowNode` | Root Agent Plan通过broker创建/reconcile的Linear节点 |

`Sub Issue`只用于说明Linear的parent/child产品形态。业务逻辑中不使用`Task`或
`Work Item`；统一使用Work Node、Work Leaf或Work Group。

`[Human Action]`只作为Linear Issue title prefix。领域类型统一称为Human Node。

## 6. Managed Linear数据

| Canonical Term | 代码类型/字段 | 定义 |
|---|---|---|
| Managed Marker | `ManagedMarker` | Symphony写入Linear对象的稳定身份marker；Human Node还在其中携带kind/target |
| Plan Comment Marker | `PlanCommentMarker` | Plan comment的稳定identity和Root remote version，不保存Plan state |
| Work Completion Comment | `WorkCompletionCommentSnapshot` | 人可读summary/checks/commit及幂等marker组成的Linear完成证据 |
| Performer ID | `PerformerId` / `performer_id` | Provider-neutral current Root Conversation pointer，可经Root retry替换 |
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
| `linear-tree` | 拥有`LinearTreeContextInterface` | 验证、规范化和裁剪完整Root Tree context |
| `agent-symphony-harness` | 拥有`AgentSymphonyHarnessInterface`和`AgentCommandBrokerInterface` | 评估Root、组装context、broker窄命令并运行read-back cycle |
| `performer-turns` | 拥有`PerformerProcessInterface` | bootstrap Conversation并启动一个Root Turn进程 |
| `performer-profiles` | 拥有`PerformerProfileStoreInterface`和`PerformerProfileControlInterface` | 保存Profile并通过Performer SDK执行登录/status |
| `git-workspaces` | 拥有`GitWorkspaceInterface` | 创建、恢复、提交Root Git Workspace |
| `root-delivery` | 拥有`RootDeliveryInterface` | push并交付PR、remote branch或local branch |
| `runtime-reporting` | 拥有`ConductorRuntimeReporterInterface` | 向Podium报告构建named Desktop Views所需的脱敏状态 |

实现名称：

```text
PerformerProcessInterface
  <- SubprocessPerformerProcessImpl

GitWorkspaceInterface
  <- NativeGitWorkspaceImpl

RootDeliveryInterface
  <- GitRootDeliveryImpl

ConductorRuntimeReporterInterface
  <- PodiumConductorRuntimeReporterImpl

RootSchedulingPolicyInterface
  <- LinearPriorityRootSchedulingPolicyImpl

LinearTreeContextInterface
  <- BoundedLinearTreeContextImpl

AgentSymphonyHarnessInterface
  <- AgentSymphonyHarnessImpl

AgentCommandBrokerInterface
  <- ScopedAgentCommandBrokerImpl

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
| `RunAgentRootTurnUseCase` | 为一个已调度Root执行bounded Harness cycle |
| `LinearPriorityPolicy` | `root-scheduling`内部的Linear Priority比较规则 |

不使用`PullRequestInterface`，因为交付能力不只包含PR；不使用没有所有者的
`RuntimeReportInterface`。

## 9. Performer

| Canonical Term | 代码类型 | 定义 |
|---|---|---|
| Root Conversation Bootstrap | `OpenRootConversationCommand` / `RootConversationOpenedResult` | 无业务副作用地创建Provider Conversation |
| Root Turn | `RootTurnCommand` / `RootTurnCompletedResult` | 一次有界、Root-scoped Performer调用 |
| Root Turn Limits | `RootTurnLimits` | context launch、whole-Turn wall time和broker/mutation command上限 |
| Root Turn Usage | `RootTurnUsage` | 完整Turn结束后的wall/context/Provider token/command观察值 |
| Conversation Unavailable Result | `RootConversationUnavailableResult` | current Conversation不存在/不可恢复，触发Root-level retry |
| Root Turn Failure Result | `RootTurnFailedResult` | Root Turn以结构化失败结束 |
| Root Turn Cancellation Result | `RootTurnCanceledResult` | Root Turn被有界取消 |
| Performer Event | `PerformerTurnEvent` | best-effort实时观察 |
| Turn Started Event | `PerformerTurnStartedEvent` | Performer Turn已经开始 |
| Progress Event | `PerformerProgressEvent` | Provider-neutral进度阶段 |
| Warning Event | `PerformerWarningRaisedEvent` | 需要记录的脱敏warning |
| Error Event | `PerformerErrorRaisedEvent` | 需要用户关注的脱敏Turn error观察，不代替`TurnFailedResult` |
| Heartbeat Event | `PerformerHeartbeatEvent` | 当前Turn仍存活 |
| Turn Completed Event | `PerformerTurnCompletedEvent` | closed Result发布后的Turn completion观察，不表达Root完成 |
| Provider Backend | `ProviderBackendInterface` | Performer内部Provider能力边界 |
| Codex Backend | `CodexBackendImpl` | 当前唯一Provider实现 |

V3只有Root-scoped业务Turn。Plan、Work、Human、Root Gate、Rework和Delivery由Root Agent经closed
commands推进，不是Performer Result variants。V4 role只约束Root内child Turns；V5只扩展Provider
Backend。

只使用`Root Gate`，不使用没有范围的`Gate`作为领域对象。`Root Gate Node`是Linear Tree中的
managed Work child，不是新的Conductor dispatch unit或Performer Turn variant。

### 9.1 Performer Profile

| Canonical Term | 代码类型 | 定义 |
|---|---|---|
| Performer Profile | `PerformerProfile` | Conductor保存的一组Codex登录上下文和Turn设置 |
| Active Performer Profile | `activeProfileId` | Conductor为新Root选择的Profile |
| Codex Home | `CODEX_HOME` | Codex SDK拥有的auth、session和runtime state根目录 |
| Codex Turn Settings | `CodexTurnSettings` | model、reasoning effort和Fast设置；V1 reasoning闭合集为none、minimal、low、medium、high、xhigh |
| Profile Readiness | `PerformerProfileReadiness` | login-required、ready或invalid |
| Turn Usage | `PerformerTurnUsageSnapshot` | 一次Codex Turn的token使用量 |

一个Profile对应一个独立`CODEX_HOME`。Conductor只保存`PerformerProfile`和
`activeProfileId`；Codex-owned文件只由`CodexBackendImpl`通过官方SDK访问。
Profile的`backendKind`和`authenticationMethod`创建后不可修改；切换登录方式使用新
Profile。
每个Performer Turn携带一次当前`CodexTurnSettings`快照；它是closed产品DTO，不是SDK
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
- `RootActivityProjection`使用：`planning`、`awaiting-human`、`working`、`reviewing`、
  `delivering`、`blocked`、`failed`；它不是Workflow state。
- Linear Issue state使用Linear名称：`Todo`、`In Progress`、`In Review`、`Done`、
  `Canceled`。
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
| Managed Run | Root Run / RootRunView |
| Work Item、Task | Work Node、Work Leaf或Work Group |
| Agent Config、Agent Profile（代码类型） | Performer Profile |
| Human Action（领域类型） | Human Node |
| Gate（无范围的独立领域对象） | Root Gate Node |
| next action（代码类型） | `RootDispatchAssessment`或`NextActionView` |
| safe/runtime/operator view（代码类型） | 具体`*View`名称 |
| `PullRequestInterface` | `RootDeliveryInterface` |
| `RuntimeReportInterface` | `ConductorRuntimeReporterInterface` |
| `OperatorViewInterface` | `DesktopViewInterface` |
| `PodiumRuntimeInterface` | `PodiumDesktopInterface` |
| `SubprocessPerformerImpl` | `SubprocessPerformerProcessImpl` |
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
