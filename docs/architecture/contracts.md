# 契约与接口边界

状态：目标架构提案。所有模块交互只依赖`*Interface`和closed generated schemas；具体实现使用`*Impl`并保持
内部可见。目标架构只维护一个当前Protocol版本，不为旧短Stage架构保留兼容union。

## 1. 主要接口

```text
LinearGatewayInterface                 <- PodiumLinearGatewayClientImpl
RootSchedulingPolicyInterface          <- LinearPriorityRootSchedulingPolicyImpl
RootSafetyPolicyInterface              <- LinearRootSafetyPolicyImpl
RootReconcilerClientInterface          <- PerformerRootReconcilerClientImpl
RootDirectiveMaterializerInterface     <- LinearRootDirectiveMaterializerImpl
PerformerAgentClientInterface          <- SessionPerformerAgentClientImpl
WorkflowTimelinePublisherInterface     <- InProcessWorkflowTimelinePublisherImpl
RootTimelineCommentSubscriberInterface <- LinearRootTimelineCommentSubscriberImpl
CycleTimelineCommentSubscriberInterface <- LinearCycleTimelineCommentSubscriberImpl
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
comment thread resolution + reactions
source change identities + actor kinds + stable write correlations
```

`WorkflowRootTreeSnapshot`必须同时包含`source_manifest`和`coverage`。每个
`WorkflowSourceManifestEntry`至少携带`source_kind`、`source_id`、`source_version`和`actor_kind`，其中source kind只允许
`linear_issue`、`linear_comment`、`linear_comment_thread_change`、`linear_relation`和`linear_status_catalog`；actor kind只允许`human`、
`symphony`、`linear_integration`、`external_automation`和`unknown`。由Symphony写入且可从Linear稳定关联的来源可以带
`stable_write_id`，但Podium不得猜测或伪造该关联。

Comment source必须包含native thread resolved/unresolved当前值以及reaction当前集合。comment正文编辑使用comment
source version；thread resolve/unresolve还必须携带稳定source change identity、change actor和occurred time，使
“comment作者”和“执行本次thread action的人”不会混淆。reaction集合用于Symphony回执write/read-back与审计；human
reaction不是Workflow command或Root pending input。Podium不得把reaction翻译成approval、rejection或其他Workflow语义。
Reaction-only current-value changes不进入Root canonical fact digest或`RootDelta`；它们只供matching reply materializer
校验native receipt是否存在。

`WorkflowSourceCoverage`必须明确`is_complete`和`omissions`。active与archived Issue、comment、relation和status
catalog以及human comment thread change的required source都必须进入manifest；任何无法分页读取、无法证明identity/version或无法判断覆盖范围的情况都必须
返回不完整coverage，使matching Root fail closed。Gateway无法证明actor时返回closed `unknown`，不能把它猜成human或
Symphony。除matching stable write correlation和明确排除的reaction-only变化外，所有human、external automation和
unknown source changes都作为pending Root inputs；普通advance payload仍只包含变化source的当前值或tombstone，不透传完整activity history。

`WorkflowMutationCommand`是唯一公开的Linear写入union：

```text
CreateWorkflowIssueCommand
| UpdateWorkflowIssueCommand
| AppendWorkflowCommentCommand
| CreateCommentReplyCommand
| SetCommentReceiptReactionCommand
| SetCommentThreadStateCommand
| CreateWorkflowRelationCommand
```

`CreateCommentReplyCommand`只能向明确的source comment thread创建child reply；
`SetCommentReceiptReactionCommand`只能把Symphony自己的matching receipt收敛为`check`、`cross`或`none`；
`SetCommentThreadStateCommand`只能把明确thread收敛为`resolved`或`unresolved`。三者都必须携带matching directive/
reply write identity、target remote version及相关thread/reaction precondition，并在fresh semantic read-back后才成功。
`none`只删除同一reply identity先前写入的Symphony receipt，绝不修改human或其他actor的reaction。它们不接受任意emoji、
顶层reply、comment rewrite或Workflow语义字段。其他Root/Issue mutation同样携带binding、Project pool、Root
routing/ownership、explicit target、expected remote version、expected status/archive/parent和stable write ID。
`CreateWorkflowRelationCommand`以`relation_state: present | absent`收敛指定source、target和kind之间的relation，
因此不存在第二个remove relation command或隐式删除路径。没有arbitrary
GraphQL、JSON mutation或SDK passthrough。

## 3. Conductor-Performer boundary

Conductor始终是caller。公共message union覆盖：

```text
OpenRootReconcilerRequest    | RootReconcilerOpenedResult
AdvanceRootReconcilerRequest | RootDirective
PlanTurnRequest             | PlanResult
WorkTurnRequest             | WorkResult
VerifyTurnRequest           | VerifyResult
CloseCycleStageSessionsCommand | CloseCycleStageSessionsResult
CloseRootReconcilerCommand  | CloseRootReconcilerResult
PerformerProfileControlRequest | PerformerProfileControlResult
```

Root Reconciler bootstrap/delta、用户input/reply字段只由[Root Reconciliation](root-reconciliation.md)定义；
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
每个timeline event只materialize一条Linear comment；comment同时包含closed renderer生成的用户Markdown和一个
machine-readable `symphony` fenced code block。两个Interface都使用closed materialized/failed Result，只有matching
Linear comment及其code block read-back、strict decode和stable identity校验成功后才成功；
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
based_on_target_root_digest
root_directive_id
evidence_refs[]
consumed_input_ids[]
comment_replies[]
human_action_resolutions[]
```

`OpenRootReconcilerRequest`是唯一允许携带完整`RootBootstrapSnapshot`的Conductor-Performer message；matching
`RootReconcilerOpenedResult`包含该bootstrap turn产生的initial `RootDirective`。
`AdvanceRootReconcilerRequest`只允许携带`base_root_digest`、`target_root_digest`和`RootDeltaChange[]`；schema不提供
full snapshot、before/after diff或兼容union。baseline不匹配返回closed failure并要求fresh session bootstrap。
Conductor可以为了计算delta在自己的单轮内存视图中读取完整active和archived Tree，但不得把该视图、完整source manifest
或历史activity复制到advance message。只有新建session、session丢失或baseline无法证明时，才允许再次发送完整bootstrap。
`RootDelta`没有独立的Linear revision/event lifecycle，也不进入任何durable queue、checkpoint或本地镜像；它只表示
本轮从已确认baseline到fresh target的当前值/tombstone传输。传输失败或不连续时必须丢弃session并重新bootstrap，不能
重放、补猜或兼容旧delta。

这也是唯一的传输矩阵：新建、丢失或无法证明baseline的session使用一次`OpenRootReconcilerRequest`完整bootstrap；可证明
连续的session使用`AdvanceRootReconcilerRequest`增量。普通用户修改不会单独触发bootstrap，Conductor也不能因为计算
delta而把完整Tree、source manifest或历史activity放入advance请求。Linear mutation仍可作为accepted directive的机械
materialization手段，但它不产生用户修改的revision/change-event生命周期，也不改变Root Reconciler的语义所有权。

source version/hash、`RootDelta`、accepted `RootDirectiveRecord`和单次Linear write的职责分层由[Root Reconciliation](root-reconciliation.md)
的“Revision、Delta与Linear写入的唯一分层”定义。本文不增加revision、change-event、pending mutation或timeline
contract；Linear Gateway只执行directive materializer交给它的closed write command并返回read-back Result。

Root Reconciler和Stage turn Result都必须关联实际调用model与closed Turn Usage；Stage Result还至少关联
role/session/turn/execution、Root/Cycle/target、Tree/context digest和Git revision（如适用）。usage无法从Provider
取得时使用显式`unavailable` variant，不能省略或写零。字段与聚合语义由
[Performer Profile](performer-profiles.md)定义。
Timeline event至少关联source durable record identity和deterministic event ID；reply至少关联source comment version或
native comment thread-change identity、Root directive和deterministic reply ID。

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
RootReconcilerFailureRecord
RootReconcilerReplyRecord
ModelTurnRecord
StageExecutionRecord
PlanContractRecord
PlanResult | WorkResult | VerifyResult
HumanActionRequestRecord
HumanActionResolutionRecord
FindingRecord
ProgressAssessment
CycleOutcome
WorkflowTimelineRecord
```

每个durable managed comment使用同一外壳；Symphony创建的Root descendant Issue description使用相同的Markdown +
唯一`symphony` block格式承载其Issue kind record：

````text
<closed renderer生成的bounded用户Markdown；允许普通Markdown和非symphony fenced code block>

```symphony
{"kind":"<closed record kind>","version":1,"record_id":"<stable id>",...}
```
````

一条managed comment或managed Issue description必须恰有一个`info string = symphony`的fenced code block。该block必须
是strict JSON、使用closed versioned schema、拒绝unknown字段，并携带stable identity与source references。managed
comment身份只在以下条件全部成立时成立：

- Linear actor是当前Binding验证过的Symphony actor；
- code block完整通过matching closed schema decode；
- record scope、target Issue、stable write ID和ownership correlation一致；
- comment与code block已经fresh read-back。

managed Issue description还必须关联Symphony stable create/write ID、matching Issue kind label、parent scope和fresh remote
version。用户后续删除、复制或修改code block只产生新的Linear事实和mechanical violation，不能伪造另一Issue身份，也
不能由Conductor静默恢复。

human actor写入相同code block、普通文本声称自己是Symphony、作者显示名相同或comment位于第一条，都不能伪造managed
record。Symphony actor写出的缺失、重复或无效`symphony` block是mechanical violation，也不能降级成另一种旧marker。
所有旧`<!-- symphony ... -->`HTML marker、`managed_marker`字段、reader、writer和兼容union均被硬删除；没有迁移、
dual read、fallback或legacy root恢复路径。

## 9. Interface ownership

- Conductor定义Linear consumer、Root safety policy、Root Reconciler client、directive materializer、Performer client和timeline
  publisher/comment subscriber interfaces；
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
7. Timeline和Reconciler reply都是required Linear writes；任一comment、code block、reaction或thread action
   write/read-back失败时matching Root停止推进。
8. SDK、database、transport handle、raw thread和secrets不跨public interface。
9. 不为旧短Stage、第二Provider或任意metadata保留compatibility variant。
10. Root delta不拥有业务状态；advance contract不允许完整snapshot或旧协议兼容variant。
11. 所有restart-required managed事实只存在于Linear中strict `symphony` code block；不存在HTML marker或第二record格式。
