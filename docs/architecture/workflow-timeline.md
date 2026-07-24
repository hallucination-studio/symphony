# Root与Cycle Workflow Timeline

状态：目标架构提案。本文是Root/Cycle时间轴事件、发布/订阅机制和Linear comment materialization的唯一
事实源。本文只定义时间轴，不定义Root/Cycle业务状态、Root Reconciler reply或Agent contract。

## 1. 目标

用户应能直接在对应Linear Issue中理解：系统读到了什么、做了什么决定、执行结果是什么、为什么暂停，以及
下一步会发生什么。时间轴不能散落为各业务模块直接拼接comment，也不能依赖代码日志、Provider transcript
或Desktop本地状态。

设计两条独立时间轴：

```text
Root Reconciliation Timeline
  -> comments on the Root Issue

Cycle Timeline
  -> comments on the matching Cycle Issue
```

Plan、Work、Verify和Human Action Issue保留自己的description、用户comments和managed records；面向用户的
跨节点执行叙事统一写到所属Cycle时间轴。跨Cycle、convergence和delivery叙事统一写到Root时间轴。

## 2. 解耦机制

Root Reconciliation host、Root Reconciler client、Stage materializer和Human Action materializer只发布closed
timeline event，不直接创建或渲染comment：

```text
business mutation / accepted Result
-> semantic read-back
-> publish WorkflowTimelineEvent
-> matching subscriber validates event
-> render stable human-readable Markdown + one symphony code block
-> append exactly one comment to Root or Cycle Issue
-> read back and strict-decode the complete comment
```

```text
WorkflowTimelinePublisherInterface
  publish(event: WorkflowTimelineEvent) -> WorkflowTimelineMaterializationResult

RootTimelineCommentSubscriber
  consumes RootTimelineEvent
  appends Root Issue comment

CycleTimelineCommentSubscriber
  consumes CycleTimelineEvent
  appends Cycle Issue comment
```

```text
WorkflowTimelineMaterializationResult =
  TimelineMaterializedResult |
  TimelineMaterializationFailedResult
```

`TimelineMaterializedResult`只有在matching Linear comment、用户Markdown和唯一`symphony` code block都read-back，
且code block通过closed schema和stable identity校验后才能返回。publish、render、create或read-back任一步失败都返回
closed failure；调用方打印correlated error并停止当前Root。接口没有
`accepted`、`queued`或fire-and-forget成功variant。

publisher/subscriber是Conductor内的接口边界，不是外部消息系统。当前不增加Kafka、durable event bus、
outbox数据库或第二套workflow store。Timeline comment是required Linear write；subscriber失败时当前Root停止，
不能把“event已发布”当成成功。

subscriber只是typed event到Linear comment的同步materializer，不表示Linear之外存在projection状态、eventual
consistency或可选写入。唯一durable结果是Linear中成功read-back的完整comment。

## 3. Linear写入与幂等语义

事件只能在对应业务事实成功read-back后发布。事件使用从durable fact identity确定生成的`timeline_event_id`：

```text
timeline_event_id = stable event kind + root/cycle identity + source durable record identity
```

Timeline comment底部唯一`symphony` code block包含：

```text
WorkflowTimelineRecord
  timeline_event_id
  timeline_kind: root | cycle
  target_issue_id
  source_record_ids[]
  source_versions[]
  rendered_schema_version
  materialized_at
```

comment materialization至少一次、Linear效果幂等：

- duplicate event先查询并strict decode matching `WorkflowTimelineRecord`，存在则不重复创建；
- process在业务mutation后、comment前崩溃时，下一次reconciliation从Linear source fact重新派生同一event ID并补写；
- comment创建成功但read-back失败时按同一event ID查找，不能盲目追加；
- timeline create或read-back失败时停止当前Root推进并打印correlated sanitized structured error log；不得执行
  下一个workflow action；
- 已经read-back的前序业务事实不回滚。恢复时从该Linear source record和缺失的matching timeline record重试同一
  event ID，成功前不调用Root Reconciler；
- timeline comment不是用户输入或Result acceptance的替代品；validated Symphony actor和matching
  `WorkflowTimelineRecord`使它不会回流为pending human input。

## 4. 公共事件contract

```text
WorkflowTimelineEvent =
  RootTimelineEvent |
  CycleTimelineEvent
```

```text
TimelineEventBase
  protocol_version
  timeline_event_id
  timeline_kind
  root_issue_id
  cycle_issue_id?
  occurred_at
  source_record_ids[]
  source_versions[]
  actor: conductor | root_reconciler | plan | work | verify | human
  summary
  input_refs[]
  output_refs[]
  next_step?
```

事件是closed、versioned discriminated union，使用generated types。不得包含raw Provider reasoning、完整
transcript、secret、credential、任意metadata map或未bounded stdout/stderr。
`next_step`若存在，只是时间轴中面向用户的bounded说明文字；它不驱动Conductor调度、Linear状态迁移、Stage执行或
任何其他语义决策。所有Workflow决策只能来自Root Reconciler返回的closed `RootDirective.action`。
若该事件需要展示usage，subscriber只根据`source_record_ids[]`和fresh Linear `ModelTurnRecord`确定性派生本次与累计
快照，不能由业务event producer或模型提供任意累计值；字段和聚合规则由
[Performer Profile](performer-profiles.md)定义。

## 5. Root Reconciliation Timeline

### 5.1 事件类型

```text
RootTimelineEvent =
  | RootClaimedEvent
  | RootDecisionAcceptedEvent
  | RootStatusChangedEvent
  | RootTreePatchedEvent
  | RootContractChangedEvent
  | CycleCreatedEvent
  | CycleConcludedEvent
  | RootWaitingHumanEvent
  | RootHumanResolvedEvent
  | RootConvergenceEvaluatedEvent
  | SuccessorCycleCreatedEvent
  | DeliveryStartedEvent
  | DeliveryCompletedEvent
  | RootFailureRecordedEvent
  | RootCanceledEvent
```

Root时间轴只记录跨Cycle或Root级业务边界，不复制每个Work turn。`RootConvergenceEvaluatedEvent`展示本次
Cycle count、Finding persistence、no-progress、token/deadline和触发阈值；不得只写“budget exceeded”。
`RootContractChangedEvent`说明最新Root contract变化和旧delivery/Cycle是否仍匹配。

### 5.2 Root comment模板

```text
## Symphony · Root Reconciliation

<concise outcome>

Status
- From: <previous status>
- To: <current status>

Reason
<human-readable reason grounded in source facts>

Inputs
- <Cycle / Human Action / gate / Git references>

Result
- <created Cycle, accepted conclusion, delivery or fail-closed reason>

Usage
- <this Root Reconciler turn model and usage>
- <Root cumulative: all Cycle Stage turns + all Root Reconciler turns; completeness>

Next
<what Root Reconciliation will wait for or do next>
```

没有对应字段的section省略，不显示空占位。comment标题和段落顺序稳定，具体文本来自structured event而不是
重新调用模型生成。

## 6. Cycle Timeline

### 6.1 事件类型

```text
CycleTimelineEvent =
  | CycleDecisionAcceptedEvent
  | PlanTurnCompletedEvent
  | WorkTurnStartedEvent
  | WorkTurnCompletedEvent
  | WorkTurnBlockedEvent
  | CycleTreePatchedEvent
  | CycleReplannedEvent
  | CycleSupersededEvent
  | NodeArchivedEvent
  | NodeRestoredEvent
  | VerifyTurnCompletedEvent
  | CycleHumanActionRequestedEvent
  | CycleHumanActionResolvedEvent
  | CycleBudgetUpdatedEvent
  | CycleConclusionProposedEvent
  | CycleExecutionFailureRecordedEvent
```

每个accepted `RootDirective`按action scope产生恰好一个`RootDecisionAcceptedEvent`或
`CycleDecisionAcceptedEvent`。普通模型retry、schema-invalid output和内部reasoning不展示给用户；只有最终
accepted directive进入时间轴。

`RootTreePatchedEvent`和`CycleTreePatchedEvent`只在matching Root Reconciler directive已接受并完成read-back后产生，
必须列出create/update/archive/restore/reorder/dependency operations及其业务原因。它们不表示Conductor自动修正了
用户状态；Conductor只能执行directive要求的受限操作。archived Issue使用Linear链接继续可访问。Human Action事件展示请求、用户选择和下一步，不复制用户comment全文。
`CycleReplannedEvent`与`CycleSupersededEvent`必须区分同Cycle fresh Plan和successor Cycle，不能都显示成
“重新开始”。

### 6.2 Cycle comment模板

```text
## Symphony · Cycle

<concise decision or execution outcome>

Observed
- <new Plan/Work/Verify Result, Human resolution or Tree change>

Decision
- <selected closed directive>
- Why: <Root Reconciler rationale>

Changes
- <created/updated/archived/restored nodes or relations>

Evidence
- <Linear/Git references>

Usage
- <this Stage turn model and usage, when applicable>
- <Cycle cumulative Plan/Work/Verify usage by stage/model; completeness>

Next
<next Plan/Work/Verify/Human/wait/conclusion step>
```

Stage Result comment使用同一Cycle模板，但`Decision`替换为`Result`，只展示bounded事实、checks、Findings和
artifact references。不得输出模型思维链或未经验证的成功声明。

## 7. 结构化渲染规则

- event contract保存语义字段，renderer负责Markdown，不让业务模块提供任意完整comment；
- 一个event恰好生成一条comment；comment上半部分是用户Markdown，底部恰好一个`symphony` block保存
  `WorkflowTimelineRecord`，两部分作为一次required Linear materialization共同read-back；
- 用户Markdown允许bounded普通fenced code block；只有info string精确为`symphony`的block参与managed decode；
- Issue、Cycle、Action、Result和Git revision使用可点击引用；
- status、directive kind、outcome使用用户可理解名称，不暴露内部enum作为正文；
- reason必须来自accepted Root Reconciler rationale或deterministic Root gate facts；
- comment明确区分`Observed`、`Decision/Result`和`Next`，不能把proposal写成已完成事实；
- archived、canceled、superseded和failed使用精确词义，不能统一显示为“removed”或“done”；
- comment有严格byte bound；超限时保留结论和source links，省略项数量必须可见；
- renderer按`rendered_schema_version`演进，旧comment不回写重排。

Stage Result自身的immutable Result、model和turn usage只写在matching Plan/Work/Verify Issue的canonical managed
comment；Cycle timeline event只能引用该source record并展示本次结果与派生Cycle累计值。前者是唯一的Result
materialization，后者是面向用户的typed timeline event：两者使用不同record kind和target，timeline不得作为第二个
Result、Root input或usage source，也不得把Cycle累计snapshot再次计入usage。

因此，Stage Result comment不是Cycle timeline comment，也不使用`WorkflowTimelineRecord`。它由Stage Result contract
materialize并携带nested `ModelTurnRecord`；随后的Cycle event只在该comment成功read-back后发布。任一实现若从timeline
comment恢复Stage结果、以timeline snapshot累计usage，或把同一Stage结果再写成第二个canonical record，都违反本架构。

## 8. 输入输出覆盖

时间轴需要覆盖以下可见I/O，但只表达durable、validated版本：

| 输入/输出 | Root timeline | Cycle timeline |
|---|---:|---:|
| Root status与ownership | 是 | 否 |
| Cycle create/conclusion | 是 | 是 |
| Root Reconciler bootstrap/delta摘要 | 否 | 是 |
| accepted RootDirective | Root级动作 | Cycle级动作 |
| Plan Result | 否 | 是 |
| Work target与Result | 否 | 是 |
| Verify Result与Findings | Root只在terminal摘要 | 是 |
| DAG create/update/archive/restore | Root只在Cycle摘要 | 是 |
| Cycle Human Action request/resolution | Root只记录waiting/resumed | 是 |
| Root convergence Human Action | 是 | 否 |
| delivery | 是 | 否 |

## 9. 噪音控制

以下内容不创建timeline comment：

- heartbeat、token stream和tool progress；
- Work内部普通command失败后已自行恢复的中间步骤；
- webhook wake-up、poll、cache hit或无状态变化的reconciliation；
- invalid/stale Root Reconciler output的内部retry；最终持久化的failure单独记录；
-重复read-back和幂等`already_applied`。

同一个timeline event只产生一条comment。一个Stage durable boundary先在Stage Issue materialize canonical Result comment，
再发布一个引用该Result的Cycle timeline event；两条comment使用不同record kind和target，usage只从Stage
`ModelTurnRecord`计数。这个可见的两条comment不是两套结果或双写恢复路径：只有Stage Result comment是execution
事实，Cycle comment只是由已read-back事实派生的叙事。Timeline用于用户理解和审计，不是运行日志镜像。

## 10. 不变量

1. Root Timeline只写Root Issue；Cycle Timeline只写matching Cycle Issue。
2. 业务模块发布typed event，不直接渲染或追加timeline comment。
3. comment只能表达已经read-back的durable facts。
4. event transport不是durable workflow authority，也不引入新数据库或队列。
5. deterministic event ID和`WorkflowTimelineRecord`只保证timeline comment写入幂等，不恢复或决定Workflow。
6. Timeline comment面向用户、结构稳定、可引用，不包含raw reasoning或secret。
7. Timeline Linear write或read-back失败时当前Root停止推进；恢复后先完成同一event ID再继续。
8. 一个event、一条comment、两层内容是固定契约；不得拆成独立用户comment和machine-state comment。
9. Stage canonical Result与引用它的Cycle timeline只能分别承担execution事实和用户叙事；后者不得参与恢复、调度、
   usage累计或Root input。
