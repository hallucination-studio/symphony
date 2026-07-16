# 契约与接口边界

状态：目标架构提案。所有模块交互只依赖`*Interface`；具体技术实现使用`*Impl`并保持内部可见。

## 1. 命名

命名规则的唯一事实源是[代码模块与命名规范](code-organization.md)。本文件只约束
跨模块和跨进程契约，不重新定义后缀表。

边界示例：

```text
LinearGatewayInterface    <- PodiumLinearGatewayClientImpl
RootSchedulingPolicyInterface <- LinearPriorityRootSchedulingPolicyImpl
LinearTreeTraversalPolicyInterface <- LinearDepthFirstTreeTraversalPolicyImpl
RootActionPolicyInterface <- RootRunActionPolicyImpl
PerformerProcessInterface <- SubprocessPerformerProcessImpl
GitWorkspaceInterface     <- NativeGitWorkspaceImpl
ProviderBackendInterface  <- CodexBackendImpl
```

## 2. 跨进程Protocol

### `PodiumClientProtocol`

React与Desktop Backend的Command/Query/View。禁止Token、process handle、SDK object和原始本地路径。

主要View是：

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
```

主要Command只覆盖`ConnectLinearCommand`、`ReconnectLinearCommand`、
`CreateConductorCommand`、`StartConductorCommand`、`StopConductorCommand`和
`RestartConductorCommand`，以及目标Conductor的closed Performer Profile
Command/Query：

```text
GetPerformerProfilesQuery
GetPerformerProfileStatusQuery
CreatePerformerProfileCommand
UpdatePerformerProfileCommand
StartCodexChatGPTLoginCommand
SetCodexApiKeyCommand
ActivatePerformerProfileCommand
```

只有`SetCodexApiKeyCommand`可以携带secret input。该值只允许从Desktop表单经private
内存relay进入Conductor和Performer stdin，不进入View、response body或任何持久化
Command文件。

Workflow编辑、Plan Approval Node、Human回答、Priority、blocker和Done不进入该Protocol，
仍在Linear完成。具体页面和状态见[Podium Desktop](podium-desktop.md)。

### `DesktopHostProtocol`

Backend与Tauri Host的窗口、浏览器、Git Context、Conductor process lifecycle和shutdown。

### Podium-Conductor Protocol

包含三组能力：

```text
ConductorRuntimeProtocol
LinearGatewayProtocol
PerformerProfileProtocol
```

Conductor Runtime：

- conductor identity/repository handshake；
- Conductor health/report；
- shutdown。

Linear Gateway：

- closed Linear Command/Query/Result；
- pagination；
- sanitized SDK failure。

Performer Profile：

- Profile CRUD中的Create/Update和active选择；
- SDK ChatGPT/API Key login触发；
- sanitized Profile/account/status View；
- secret-bearing API Key relay。

除`SetCodexApiKeyCommand`的bounded secret frame外，不传Token、GraphQL、SDK object或
Workflow decision。API Key不得出现在JSON metadata frame。

Profile Command只有在Conductor返回成功Result后才改变Desktop View；Podium不提供
local optimistic commit。`UpdatePerformerProfileCommand`不能修改`backendKind`或
`authenticationMethod`。

### Conductor-Performer Protocol

通过request/result文件和可选Event stream传输三种Turn：

```text
PlanTurnCommand
WorkTurnCommand
RootGateTurnCommand
```

Command、Result、`TurnCanceledResult`和Envelope的唯一事实源是
[Performer Turn Command与Result契约](performer-command-contracts.md)。Event的唯一
事实源是[Performer Event设计](performer-events.md)。

Profile登录和status使用独立`PerformerProfileControlProtocol`：

```text
GetPerformerProfileStatusQuery
StartCodexChatGPTLoginCommand
SetCodexApiKeyCommand
```

secret-free metadata使用bounded stdin/stdout JSON；API Key作为独立length-delimited
stdin frame传入，不写request/result文件。详细边界见
[Performer Profile与Codex配置](performer-profiles.md)。

不包含Linear mutation、Root Phase、Priority、blocker、Git topology或Provider SDK type。
`CodexTurnSettings`是当前唯一允许跨该边界的Provider相关产品DTO；它不包含SDK type、
credential、配置文件内容或任意map。

## 3. Linear Gateway DTO

DTO只表达Conductor需要的Linear事实：

```text
RootIssueSnapshot
LinearProjectSnapshot
ResolvedConductorProject
ProjectResolutionResult
LinearIssueTreeSnapshot
LinearIssueNodeSnapshot
LinearCommentSnapshot
LinearBlockerSnapshot
RootUsageSnapshot
LinearMutationResult
```

每个Snapshot包含稳定id、remote version/updated_at、必要state/order/parent字段和有界内容。

每个Project级Linear mutation Command包含`conductor_short_hash`和
`expected_project_id`，作为Resolved Conductor Project的远端precondition；目标架构
不创建Conductor Binding版本对象。

每个修改已有Issue、Comment或Label的Command还必须携带它实际依赖的远端
precondition：

```text
expected_issue_id
expected_updated_at
expected_state?
expected_parent_issue_id?
expected_managed_marker?
```

Gateway只在precondition仍成立时执行mutation；不成立返回
`linear_precondition_conflict`，Conductor丢弃旧Snapshot并重新计算。用户把Root或Work
置为Done/Canceled、修改parent或更新内容后，旧Command不能覆盖该变化。

create Command使用稳定Managed Marker作为幂等键。timeout或连接中断后先按Managed Marker
read-back，确认远端不存在时才重试create。

## 4. Performer Turn契约

Envelope字段、Result union和各Turn业务输入只在
[Performer Turn Command与Result契约](performer-command-contracts.md)定义。
`turn_id`是process correlation，`performer_id`是Conversation continuation，
`turn_input_hash`是旧Snapshot保护；三者不能互相替代。

## 5. 输入输出验证

- unknown field/variant拒绝；
- text/list/tree depth/node count有上限；
- path canonicalization；
- Linear响应验证organization/project/parent/order/state；
- Provider Result验证turn/root/work correlation；
- Provider Result验证`performer_profile_id` correlation；
- `CodexTurnSettings`验证closed字段、长度、reasoning enum和Fast认证约束；
- Provider Result验证`turn_input_hash` correlation；
- Linear mutation验证Project Resolution和目标对象remote precondition；
- Root/Work Description按不可信用户输入处理；
- Token、Header、SDK object、raw exception、raw reasoning禁止越界。
- Profile API Key只允许通过声明过的secret frame越界，并在所有日志/View/Result中拒绝。

## 6. 错误

统一使用`ProtocolError`：

```text
ProtocolError
code
category
sanitized_reason
retryable
action_required
next_action
```

SDK/Provider exception在拥有该SDK的Impl中归一化。

## 7. Interface所有权

- Conductor的`linear-gateway`模块定义`LinearGatewayInterface`，并由
  `PodiumLinearGatewayClientImpl`实现；
- Podium实现generated `LinearGatewayProtocolHandlerImpl`，并在内部调用`LinearSdkImpl`；
- Conductor定义`PerformerProcessInterface`和`GitWorkspaceInterface`；
- Conductor定义`PerformerProfileStoreInterface`和`PerformerProfileControlInterface`；
- Podium定义`PerformerProfileRelayInterface`，由
  `ConductorPerformerProfileRelayImpl`实现；
- Performer定义`ProviderBackendInterface`；
- Podium定义`LinearInstallationStoreInterface`、`ConductorBindingStoreInterface`、
  `RuntimeObservationStoreInterface`、`PodiumDesktopInterface`和`DesktopViewInterface`；
- Podium内部使用`PodiumDesktopImpl`实现`PodiumDesktopInterface`，使用
  `PodiumDesktopViewImpl`实现`DesktopViewInterface`；
- Podium内部定义`LinearClientInterface <- LinearSdkImpl`；
- 调用方不能深路径导入对方Impl。

## 8. 不变量

1. Interface不出现具体SDK/数据库/transport类型。
2. Impl不从package public exports导出。
3. 一个Interface只表达一个相干能力。
4. 跨进程只使用generated closed Schema，详细wire字段只在对应契约文档定义一次。
5. 不维护多Protocol版本或兼容shim。
6. Podium不持久化Performer Profile或Codex secret；Conductor不读取Codex-owned文件。
