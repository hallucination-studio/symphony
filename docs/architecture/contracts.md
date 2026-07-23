# 契约与接口边界

状态：目标架构提案。所有模块交互只依赖`*Interface`和closed generated schemas；具体实现使用`*Impl`并保持
内部可见。目标架构只维护一个当前Protocol版本，不为旧短Stage架构保留兼容union。

## 1. 主要接口

```text
LinearGatewayInterface                 <- PodiumLinearGatewayClientImpl
RootSchedulingPolicyInterface          <- LinearPriorityRootSchedulingPolicyImpl
RootReconciliationPolicyInterface      <- LinearRootReconciliationPolicyImpl
CycleSupervisorClientInterface         <- PerformerCycleSupervisorClientImpl
CycleDirectiveMaterializerInterface    <- LinearCycleDirectiveMaterializerImpl
PerformerAgentClientInterface          <- SessionPerformerAgentClientImpl
WorkflowTimelinePublisherInterface     <- InProcessWorkflowTimelinePublisherImpl
RootTimelineProjectionInterface        <- LinearRootTimelineProjectionImpl
CycleTimelineProjectionInterface       <- LinearCycleTimelineProjectionImpl
GitWorkspaceInterface                  <- NativeGitWorkspaceImpl
RootDeliveryInterface                  <- GitRootDeliveryImpl
ProviderBackendInterface               <- CodexBackendImpl
```

Interface不能包含SDK、database、credential、raw Provider thread、process handle或arbitrary metadata。

## 2. Podium-Conductor boundary

Podium独占Linear OAuth、Token和SDK。Conductor通过closed `LinearGatewayProtocol`读取Project、status catalog、
Root headers以及完整Root Tree，并执行受限mutation。

完整Tree查询必须支持：

```text
include_archived: true
issues + comments + relations + labels + statuses + remote versions
```

Root/Issue mutation携带binding、Project pool、Root routing/ownership、explicit target、expected remote version、
expected status/archive/parent和stable write ID。没有arbitrary GraphQL、JSON mutation或SDK passthrough。

## 3. Conductor-Performer boundary

Conductor始终是caller。公共message union覆盖：

```text
OpenCycleSupervisorRequest | SupervisorOpenedResult
CycleSupervisorObservation | CycleDirective
PlanTurnRequest             | PlanResult
WorkTurnRequest             | WorkResult
VerifyTurnRequest           | VerifyResult
CloseCycleSessionsCommand   | CloseCycleSessionsResult
PerformerProfileControlRequest | PerformerProfileControlResult
```

Supervisor字段只由[Cycle Supervisor](cycle-supervisor.md)定义；Plan/Work/Verify字段只由
[Performer Stage Contracts](stage-orchestration.md)定义。本文不维护第二份字段表。

Protocol传输Symphony session/turn correlation，不传raw Provider conversation pointer。response/event是当前
Conductor call的输出，不能包含Performer callback或Conductor command endpoint。

## 4. Workflow timeline event boundary

```text
WorkflowTimelineEvent = RootTimelineEvent | CycleTimelineEvent
```

业务模块只发布generated event。Projection subscriber负责Markdown和Linear comment；event不允许携带任意完整
comment、raw transcript或unbounded output。字段和delivery语义只由
[Workflow Timeline](workflow-timeline.md)定义。

## 5. Performer Profile protocol

Profile login/account/status使用独立`PerformerProfileControlProtocol`：

```text
GetPerformerProfileStatusQuery
StartCodexChatGPTLoginCommand
SetCodexApiKeyCommand
```

API Key通过bounded secret stdin frame进入Performer，不进入JSON、日志、View或Podium storage。Provider login
handle只存在于当前control process。

## 6. Validation与correlation

所有第三方responses、Issue content、comments、Supervisor directive、Stage Result和timeline event都在边界strict
validate。JSON Schema使用`additionalProperties: false`，unknown variant/field、invalid enum、超长payload、
digest mismatch或incomplete required coverage一律fail closed。

Supervisor directive至少关联：

```text
cycle_id
supervisor_session_id
supervisor_turn_id
observed_tree_digest
directive_id
evidence_refs[]
```

Stage Result至少关联role/session/turn/execution、Root/Cycle/target、Tree/context digest和Git revision（如适用）。
Timeline event至少关联source durable record identity和deterministic event ID。

## 7. Error语义

每个Protocol使用显式Result union，不能混用throw/null/partial success表达同一失败。跨进程错误包含closed code、
category、sanitized reason、retryability和action required，不返回raw exception、stack、secret或任意details map。

业务blocked、budget exhausted、Provider transport failure和schema-invalid output是不同variants。Conductor不能把
execution failure伪装成Verify Finding、Cycle repair或Human rejection。

## 8. Managed record contracts

Linear durable records使用同一schema生成机制：

```text
RootOwnershipRecord
RootConvergencePolicy
CycleSupervisorDirectiveRecord
StageExecutionRecord
PlanContractRecord
PlanResult | WorkResult | VerifyResult
HumanActionRequestRecord
HumanActionResolutionRecord
FindingRecord
ProgressAssessment
CycleOutcome
TimelineProjectionRecord
```

record marker有schema version、stable identity和source references。Issue正文和普通comment不能伪造managed record。

## 9. Interface ownership

- Conductor定义Linear consumer、Root policy、Supervisor client、directive materializer、Performer client和timeline
  publisher/projection interfaces；
- Podium实现Linear protocol handler和内部Linear SDK；
- Performer定义Provider backend和四role session runtime；
- schemas是唯一手写wire source，generated TypeScript/Python/Rust代码不包含业务Policy；
- Impl不从public exports导出，role不能deep import另一role实现。

## 10. 不变量

1. 所有public/cross-process input和output有closed versioned schema。
2. Root Loop不调用模型；Cycle下一步只来自typed Supervisor directive。
3. Plan、Work、Verify都有独立强类型request/result，不能返回任意next-step mutation。
4. 每个Cycle四个role thread互相隔离；Work thread跨多个Work targets复用。
5. Linear完整Tree contract必须包含native archive flag并支持archived Issues。
6. mutation必须fresh read-back，不能由model payload、cache或transcript决定成功。
7. Timeline event/comment是projection，不是workflow authority。
8. SDK、database、transport handle、raw thread和secrets不跨public interface。
9. 不为旧短Stage、第二Provider或任意metadata保留compatibility variant。
