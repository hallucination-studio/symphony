# 契约与接口边界

状态：目标架构提案。所有模块交互只依赖`*Interface`和closed generated schemas；具体技术实现使用
`*Impl`并保持内部可见。目标架构只维护一个当前Protocol版本，不为旧状态机保留兼容union。

## 1. 模块接口

```text
LinearGatewayInterface          <- PodiumLinearGatewayClientImpl
RootSchedulingPolicyInterface   <- LinearPriorityRootSchedulingPolicyImpl
LinearTreeContextInterface      <- BoundedLinearTreeContextImpl
AgentSymphonyHarnessInterface   <- AgentSymphonyHarnessImpl
AgentCommandBrokerInterface     <- ScopedAgentCommandBrokerImpl
PerformerProcessInterface       <- SubprocessPerformerProcessImpl
GitWorkspaceInterface           <- NativeGitWorkspaceImpl
RootDeliveryInterface           <- GitRootDeliveryImpl
ProviderBackendInterface        <- CodexBackendImpl
```

命名规则的唯一事实源是[代码模块与命名规范](code-organization.md)。Interface不能包含SDK、数据库、
transport、process handle或credential type。

## 2. Public Desktop protocol

`PodiumClientProtocol`连接React和Desktop Backend。主要Views：

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

主要Commands覆盖Linear connection、Conductor Binding lifecycle和Performer Profile lifecycle。唯一
Root recovery command是`AcknowledgeRootRetryBlockCommand`；它只确认一个带exact observation
precondition的Conversation retry block。Desktop不能发送其他Root workflow command、任意Linear
mutation、Provider prompt或process control handle。

所有响应不包含Token、cookie、Authorization header、API Key、SDK object、raw Provider output、绝对
Profile path或arbitrary metadata。

## 3. Podium-Conductor protocol

Podium与Conductor private protocol承载三类closed消息：

```text
LinearGatewayProtocol
PerformerProfileRelayProtocol
ConductorRuntimeReportingProtocol
```

`LinearGatewayProtocol`使用generated request/result schemas传输业务DTO。Podium Handler验证
organization、Project、pagination、payload大小和remote response shape，再调用Linear SDK。

`RootIssueSnapshot`是header DTO，包含Root native fields、delegation、Priority、blockers和最多两条
`root_managed_comments`，用于发现ownership/retry事实；它不包含descendants、phase labels、Human
answers或完整Tree。只有候选Root的`GetIssueTreeQuery`返回这些完整事实。

Conductor Project级command必须携带：

```text
conductor_short_hash
expected_project_id
```

Root/Issue mutation还携带full Conductor ownership、Root、显式target、expected remote version/state/
parent和stable `write_id`。Protocol没有arbitrary GraphQL、arbitrary JSON mutation或SDK passthrough。

## 4. Agent command channel

Root Turn通过继承的private、turn-scoped channel调用`AgentCommandBrokerInterface`：

```text
AgentCommandEnvelope
  protocol_version
  request_id
  turn_id
  root_issue_id
  performer_id
  command

AgentCommandResult
  = AgentCommandSucceededResult
  | AgentCommandConflictResult
  | AgentCommandUnconfirmedResult
  | AgentCommandRejectedResult
  | AgentCommandFailedResult
```

公共错误字段保持一致：

```text
code
sanitized_reason
retryable
latest_facts?
next_steps?
```

Broker在边界strict validate envelope和command schema，再fresh读取current Root/Conversation/Git facts。
Linear Issue内容和Agent payload都是untrusted input；知道ID或payload字段不是mutation authority。

Channel描述可以进入`RootTurnCommand`，但不能包含Token、socket secret、host credential或可在Turn外
复用的capability。Turn取消、command limit、Root terminal、ownership变化或Conversation替换后，
所有旧request返回`AgentCommandRejectedResult`。

## 5. Conductor-Performer protocol

Conductor通过request/result文件和唯一stdout Event stream执行：

```text
OpenRootConversationCommand
  -> RootConversationOpenedResult
   | ConversationOpenFailedResult

RootTurnCommand
  -> RootTurnCompletedResult
   | RootConversationUnavailableResult
   | RootTurnFailedResult
   | RootTurnCanceledResult
```

详细字段只由[Performer Command与Result契约](performer-command-contracts.md)定义。Event字段只由
[Performer Event设计](performer-events.md)定义。

Contract不包含按Plan、Leaf Work或Root Gate拆分的业务Turn，也不包含Leaf target字段。Root是唯一
业务target；Plan/Work/Human/Gate/Delivery effect只能通过command
broker写入Linear/Git。

`openRootConversation`没有Root context、workspace或command channel。`RootTurnCommand`必须携带
已经在Linear read-back确认的current `performer_id`；Performer不能在Root Turn内部静默创建或替换
Conversation。

`AcknowledgeRootRetryBlockCommand`只携带`root_issue_id`和`retry_observed_at`。Podium在existing private
channel转发，Conductor从Primary重新读取expected performer ID和failure code；成功清除必须验证full
ownership、Root非终态、current pointer和exact observation，并在Linear semantic read-back确认。

## 6. Performer Profile protocol

Profile login/account/status使用独立`PerformerProfileControlProtocol`，不复用Root Turn：

```text
GetPerformerProfileStatusQuery
StartCodexChatGPTLoginCommand
SetCodexApiKeyCommand
```

API Key通过bounded secret stdin frame传给Performer control process，不进入JSON、日志、View或
Podium storage。Codex login handle只存在于当前control process。

## 7. Validation与correlation

所有第三方响应、Issue content、comments、Provider Result和Event都在对应边界strict validate。

Root Turn correlation：

```text
protocol_version
turn_id
root_issue_id
performer_profile_id
performer_id
context_digest
```

Result只有全部字段与原Command、current Root ownership和current Conversation匹配时才有效。即使有效，
Result也不能声明Workflow完成；Conductor read-back Linear/Git后重新评估Root。

Agent command correlation额外包含`request_id`，每个write还包含remote/Git precondition和
stable `write_id`。ambiguous write返回统一`unconfirmed` shape，调用方必须read-back。

## 8. Error与fail-closed

跨进程错误使用closed code和sanitized reason，不返回raw exception、stack中的secret、SDK object或
任意details map。边界不能混用throw/null/partial success表达同一失败；每种Protocol使用显式Result
union。

`RootConversationUnavailableResult`只表示Provider确认Conversation不存在或不可恢复。network timeout、
rate-limit、invalid settings或Profile未ready必须使用其他错误code，避免错误触发Root-level retry。

未知variant、未知field、超长payload、invalid enum、scope mismatch和stale Turn全部fail closed。

## 9. Interface ownership

- Conductor定义`LinearGatewayInterface` consumer DTO和`AgentCommandBrokerInterface`；
- Podium实现`LinearGatewayProtocolHandlerImpl`和内部`LinearSdkImpl`；
- Conductor定义`AgentSymphonyHarnessInterface`、`RootSchedulingPolicyInterface`、
  `LinearTreeContextInterface`、`PerformerProcessInterface`、`GitWorkspaceInterface`和
  `RootDeliveryInterface`；
- Performer定义`ProviderBackendInterface`；
- Podium定义Desktop/Binding/installation/runtime observation interfaces；
- Impl不从package public exports导出，调用方不能deep import另一role实现。

## 10. V4/V5扩展

V4 child Turn broker复用`AgentCommandEnvelope`和Root scope，不增加顶层Workflow Protocol。V5只新增
`ProviderBackendInterface`实现，继续输出相同Conversation bootstrap、RootTurn Result和Event schemas。

Target architecture不保留旧Plan/Work/Gate Turn schemas或并行Protocol版本。实现迁移必须作为明确
授权的独立工作，不在契约中增加compatibility shim。

## 11. 不变量

1. 所有public/cross-process inputs和outputs有closed typed schemas。
2. Root是Conductor-Performer唯一业务target。
3. Conversation bootstrap无业务副作用，Root Turn不能静默换Conversation。
4. mutation必须通过fresh Linear/Git read-back，不能由payload、Issue文本、summary或缓存决定。
5. Error shape一致、脱敏且fail closed。
6. SDK、database、transport handle和secrets不跨public interface。
7. Result/Event不决定Linear/Git状态。
8. V4/V5扩展同一Root contract，不复制控制面。
