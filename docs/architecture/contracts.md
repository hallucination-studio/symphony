# 契约与接口边界

状态：目标架构提案。所有模块交互只依赖`*Interface`和closed generated schemas；具体技术实现使用
`*Impl`并保持内部可见。目标架构只维护一个当前Protocol版本，不为旧状态机保留兼容union。

## 1. 模块接口

```text
LinearGatewayInterface          <- PodiumLinearGatewayClientImpl
RootSchedulingPolicyInterface   <- LinearPriorityRootSchedulingPolicyImpl
RootWorkflowPolicyInterface     <- LinearCycleRootWorkflowPolicyImpl
LinearDagExecutionInterface     <- LinearDagExecutionImpl
PerformerStageClientInterface   <- ShortProcessPerformerStageClientImpl
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

主要Commands覆盖Linear connection、Conductor Binding lifecycle和Performer Profile lifecycle。
Desktop不能发送Root workflow command、任意Linear
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

`GetIssueTreeQuery`同时返回resolved Team的closed workflow status catalog。Status DTO只包含`status_id`、
精确display name、category和position；Conductor按
[Root Issue工作流](root-issue.md)验证Root/Cycle/Node允许子集。SDK status
object或任意custom field map不能跨Gateway。

`RootIssueSnapshot`是header DTO，包含Root native fields、delegation、Priority、blockers和bounded
`root_managed_comments`，用于发现ownership/pending action事实；它不包含descendants、phase labels、Human
answers或完整Tree。只有候选Root的`GetIssueTreeQuery`返回这些完整事实。

Conductor Project级command必须携带：

```text
conductor_short_hash
expected_project_id
```

Root/Issue mutation还携带full Conductor ownership、Root、显式target、expected remote version/state/
parent和stable `write_id`。Protocol没有arbitrary GraphQL、arbitrary JSON mutation或SDK passthrough。

## 4. Conductor-Performer Stage boundary

Conductor-Performer只使用caller-owned StageWire。`StageContextEnvelope`明确包含Root、Cycle和typed node
identity，并用`stage`区分Plan、Work和Verify context。Plan Result输出closed logical graph；Conductor计算
`plan_contract_digest`并负责物化节点与relations。注入字段、workspace capability、Event、Result和correlation只由
[Linear Workflow Loop与Performer Stage Context](stage-orchestration.md)定义。

## 5. Performer Profile protocol

Profile login/account/status使用独立`PerformerProfileControlProtocol`，不复用StageWire：

```text
GetPerformerProfileStatusQuery
StartCodexChatGPTLoginCommand
SetCodexApiKeyCommand
```

API Key通过bounded secret stdin frame传给Performer control process，不进入JSON、日志、View或
Podium storage。Codex login handle只存在于当前control process。

## 6. Validation与correlation

所有第三方响应、Issue content、comments、Provider Result和Event都在对应边界strict validate。
Stage correlation和Result acceptance只由
[Linear Workflow Loop与Performer Stage Context](stage-orchestration.md)定义；本文不维护第二份字段表。

Stage execution outcome与Verify conclusion使用不同closed union。Public contract不能把Provider/transport/
timeout/verification error编码成`changes_required`，也不能只用Linear Completed category代替matching Node
`Done`与completion evidence。
Plan approval、execution attempt、token reservation、Human action、Finding、progress和terminal outcome通过版本化
closed schemas进入Linear managed records；不允许任意metadata map。`FindingRecord`至少包含`finding_id`、
closed category/severity、evidence、affected scope、retryable、suggested remediation、acceptance criteria和
`source_verify_id`。`finding_id`由Conductor为accepted new Finding分配；后续Verify必须对每个prior open ID
返回精确disposition，不定义语义fingerprint。`VerifyConclusion`必须closed为`passed | changes_required | inconclusive |
escalate_human`；`changes_required`必须包含与matching immutable revision绑定的structured Findings。

`RootConvergencePolicy`和`RootConvergenceView`是Conductor domain contracts，不进入Stage Envelope。
Performer只获得当前Stage的deadline、limits和capability，不能修改limit、声明override或创建Cycle。

## 7. Error与fail-closed

跨进程错误使用closed code和sanitized reason，不返回raw exception、stack中的secret、SDK object或
任意details map。边界不能混用throw/null/partial success表达同一失败；每种Protocol使用显式Result
union。

未知variant、未知field、超长payload、invalid enum、status catalog缺失/重复/category错误、Issue kind/state
mismatch、invalid transition、scope mismatch和stale Stage全部fail closed。多Issue mutation返回逐项closed
result；partial/unknown success必须触发完整Tree read-back，不能返回推测的aggregate success。

## 8. Interface ownership

- Conductor定义`LinearGatewayInterface` consumer DTO和`PerformerStageClientInterface`；
- Podium实现`LinearGatewayProtocolHandlerImpl`和内部`LinearSdkImpl`；
- Conductor定义`RootWorkflowPolicyInterface`、`LinearDagExecutionInterface`、
  `RootSchedulingPolicyInterface`、`GitWorkspaceInterface`和
  `RootDeliveryInterface`；
- Performer定义`ProviderBackendInterface`；
- Podium定义Desktop/Binding/installation/runtime observation interfaces；
- Impl不从package public exports导出，调用方不能deep import另一role实现。

## 9. 当前扩展边界

Target architecture只保留当前StageContext/Result schemas。sub-agents、cross-Stage memory、第二Provider和
remote transport没有当前contract。实现迁移必须作为明确授权的独立工作，不增加compatibility shim。

## 10. 不变量

1. 所有public/cross-process inputs和outputs有closed typed schemas。
2. Stage request明确包含Root、Cycle和typed node；Cycle container不能作为Stage target。
3. 每个Stage使用fresh Provider context，不持久化conversation pointer。
4. mutation必须通过fresh Linear/Git read-back，不能由payload、Issue文本、summary或缓存决定。
5. Error shape一致、脱敏且fail closed。
6. SDK、database、transport handle和secrets不跨public interface。
7. Result/Event不直接决定Linear/Git状态；accepted Result必须投影到Root/target Node并read-back。
8. 不为sub-agents、memory或未来Provider预建variant。
9. Verify conclusion只有在successful execution和matching immutable artifact revision上才可接受。
10. Repair successor Cycle只能来自accepted `changes_required`、Root convergence gate和deterministic repair
    group，不能来自execution failure或一条Finding一个Cycle的机械映射。
11. 所有影响restart恢复的status、attempt、token reservation、Finding、progress和Human override都必须有Linear closed schema。
12. Cycle创建时只有Bootstrap Plan；引用approved `plan_contract_digest`的exact graph必须完整
    materialize并read-back后才可dispatch。
13. 每次Stage的source manifest、coverage、context digest、deadline和包含token reservation的limits必须先写Linear并
    read-back；attempt数由execution records派生。
