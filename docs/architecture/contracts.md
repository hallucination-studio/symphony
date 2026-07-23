# 契约与接口边界

状态：目标架构提案。所有模块交互只依赖`*Interface`和closed generated schemas；具体实现使用`*Impl`并保持
内部可见。目标架构只维护一个当前Protocol版本，不为旧短Stage架构保留兼容union。

## 1. 主要接口

```text
LinearGatewayInterface                 <- PodiumLinearGatewayClientImpl
RootSchedulingPolicyInterface          <- LinearPriorityRootSchedulingPolicyImpl
RootReconciliationPolicyInterface      <- LinearRootReconciliationPolicyImpl
RootReconcilerClientInterface          <- PerformerRootReconcilerClientImpl
RootDirectiveMaterializerInterface     <- LinearRootDirectiveMaterializerImpl
PerformerAgentClientInterface          <- SessionPerformerAgentClientImpl
WorkflowTimelinePublisherInterface     <- InProcessWorkflowTimelinePublisherImpl
RootTimelineProjectionInterface        <- LinearRootTimelineProjectionImpl
CycleTimelineProjectionInterface       <- LinearCycleTimelineProjectionImpl
RootReconcilerReplyWriterInterface     <- LinearRootReconcilerReplyWriterImpl
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
OpenRootReconcilerRequest | RootReconcilerOpenedResult
RootReconcilerObservation | RootDirective
PlanTurnRequest             | PlanResult
WorkTurnRequest             | WorkResult
VerifyTurnRequest           | VerifyResult
CloseCycleStageSessionsCommand | CloseCycleStageSessionsResult
CloseRootReconcilerCommand  | CloseRootReconcilerResult
PerformerProfileControlRequest | PerformerProfileControlResult
```

Root Reconciler、用户comment disposition/reply字段只由[Root Reconciliation](root-reconciliation.md)定义；
Plan/Work/Verify字段只由
[Performer Stage Contracts](stage-orchestration.md)定义。本文不维护第二份字段表。

Protocol传输Symphony session/turn correlation，不传raw Provider conversation pointer。response/event是当前
Conductor call的输出，不能包含Performer callback或Conductor command endpoint。

## 4. Workflow timeline event boundary

```text
WorkflowTimelineEvent = RootTimelineEvent | CycleTimelineEvent
```

业务模块只发布generated timeline event。Timeline subscriber负责Markdown和Linear comment；event不允许携带
任意完整comment、raw transcript或unbounded output。用户comment reply不是event，由accepted `RootDirective`
携带并通过`RootReconcilerReplyWriterInterface`完成必需Linear write。Timeline字段由
[Workflow Timeline](workflow-timeline.md)定义；reply字段由[Root Reconciliation](root-reconciliation.md)定义。
两个Interface都使用closed materialized/failed Result，只有matching Linear comment和marker read-back后才成功；
不提供queued、accepted或fire-and-forget variant。

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

所有第三方responses、Issue content、comments、Root directive、Stage Result、reply和timeline event都在边界strict
validate。JSON Schema使用`additionalProperties: false`，unknown variant/field、invalid enum、超长payload、
digest mismatch或incomplete required coverage一律fail closed。

Root directive至少关联：

```text
root_id
reconciler_session_id
reconciler_turn_id
observed_root_tree_digest
root_directive_id
evidence_refs[]
comment_dispositions[]
```

Stage Result至少关联role/session/turn/execution、Root/Cycle/target、Tree/context digest和Git revision（如适用）。
Timeline event至少关联source durable record identity和deterministic event ID；reply至少关联source comment
version、Root directive和deterministic reply ID。

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
RootDirectiveRecord
RootReconcilerReplyRecord
WorkflowChangeResolutionRecord
StageExecutionRecord
ExecutionContinuationRecord
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

- Conductor定义Linear consumer、Root policy、Root Reconciler client、directive materializer、Performer client和timeline
  publisher/projection interfaces；
- Podium实现Linear protocol handler和内部Linear SDK；
- Performer定义Provider backend、Root Reconciler和三个Stage role session runtime；
- schemas是唯一手写wire source，generated TypeScript/Python/Rust代码不包含业务Policy；
- Impl不从public exports导出，role不能deep import另一role实现。

## 10. 不变量

1. 所有public/cross-process input和output有closed versioned schema。
2. Conductor host不调用模型；Root和Cycle下一步只来自typed Root Reconciler directive。
3. Plan、Work、Verify都有独立强类型request/result，不能返回任意next-step mutation。
4. 每个Root一个Reconciler thread；每个Cycle三个Stage role thread互相隔离，Work跨多个targets复用。
5. Linear完整Tree contract必须包含native archive flag并支持archived Issues。
6. mutation必须fresh read-back，不能由model payload、cache或transcript决定成功。
7. Timeline和Reconciler reply都是required Linear writes；任一write/read-back失败时matching Root停止推进。
8. SDK、database、transport handle、raw thread和secrets不跨public interface。
9. 不为旧短Stage、第二Provider或任意metadata保留compatibility variant。
