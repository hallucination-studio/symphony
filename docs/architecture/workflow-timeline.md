# Root与Cycle Workflow Timeline

状态：目标架构提案。本文是Root Reconciliation和Cycle Supervisor时间轴事件、发布/订阅机制及Linear
comment投影的唯一事实源。本文只定义可见性投影，不定义Root/Cycle业务状态或Agent contract。

## 1. 目标

用户应能直接在对应Linear Issue中理解：系统读到了什么、做了什么决定、执行结果是什么、为什么暂停，以及
下一步会发生什么。时间轴不能散落为各业务模块直接拼接comment，也不能依赖代码日志、Provider transcript
或Desktop本地状态。

设计两条独立时间轴：

```text
Root Reconciliation Timeline
  -> comments on the Root Issue

Cycle Supervisor Timeline
  -> comments on the matching Cycle Issue
```

Plan、Work、Verify和Human Action Issue保留自己的description、用户comments和managed records；面向用户的
跨节点执行叙事统一投影到所属Cycle时间轴。跨Cycle、convergence和delivery叙事统一投影到Root时间轴。

## 2. 解耦机制

Root Loop、Cycle Supervisor client、Stage materializer和Human Action materializer只发布closed workflow
event，不直接创建或渲染时间轴comment：

```text
business mutation / accepted Result
-> semantic read-back
-> publish WorkflowTimelineEvent
-> matching subscriber validates event
-> render stable human-readable comment
-> append comment to Root or Cycle Issue
-> read back projection marker
```

```text
WorkflowTimelinePublisherInterface
  publish(event: WorkflowTimelineEvent)

RootTimelineProjectionSubscriber
  consumes RootTimelineEvent
  appends Root Issue comment

CycleTimelineProjectionSubscriber
  consumes CycleTimelineEvent
  appends Cycle Issue comment
```

publisher/subscriber是Conductor内的接口边界，不是外部消息系统。当前不增加Kafka、durable event bus、
outbox数据库或第二套workflow store。业务正确性只依赖已经read-back的Linear/Git事实，不依赖subscriber是否
即时成功。

## 3. Delivery与恢复语义

事件只能在对应业务事实成功read-back后发布。事件使用从durable fact identity确定生成的`timeline_event_id`：

```text
timeline_event_id = stable event kind + root/cycle identity + source durable record identity
```

Timeline comment包含managed projection marker：

```text
TimelineProjectionRecord
  timeline_event_id
  timeline_kind: root_reconciliation | cycle_supervisor
  target_issue_id
  source_record_ids[]
  source_versions[]
  rendered_schema_version
  projected_at
```

投影至少一次、comment效果幂等：

- duplicate event先查询matching projection marker，存在则不重复创建；
- process在业务mutation后、comment前崩溃时，下一次reconciliation从durable facts重新派生同一event ID并补投影；
- comment创建成功但read-back失败时按同一event ID查找，不能盲目追加；
- timeline投影失败写structured error/attention，但不能回滚或改变已接受业务事实；
- comment不作为Root/Cycle readiness、Supervisor input或Result acceptance的唯一来源；canonical records仍是authority。

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
  actor: conductor | supervisor | plan | work | verify | human
  summary
  input_refs[]
  output_refs[]
  next_step?
```

事件是closed、versioned discriminated union，使用generated types。不得包含raw Provider reasoning、完整
transcript、secret、credential、任意metadata map或未bounded stdout/stderr。

## 5. Root Reconciliation Timeline

### 5.1 事件类型

```text
RootTimelineEvent =
  | RootClaimedEvent
  | RootStatusChangedEvent
  | CycleCreatedEvent
  | CycleConcludedEvent
  | RootWaitingHumanEvent
  | RootHumanResolvedEvent
  | RootConvergenceEvaluatedEvent
  | SuccessorCycleCreatedEvent
  | DeliveryStartedEvent
  | DeliveryCompletedEvent
  | RootAttentionRequiredEvent
  | RootCanceledEvent
```

Root时间轴只记录跨Cycle或Root级业务边界，不复制每个Work turn。`RootConvergenceEvaluatedEvent`展示本次
Cycle count、Finding persistence、no-progress、token/deadline和触发阈值；不得只写“budget exceeded”。

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
- <created Cycle, accepted conclusion, delivery or attention>

Next
<what the Root Loop will wait for or do next>
```

没有对应字段的section省略，不显示空占位。comment标题和段落顺序稳定，具体文本来自structured event而不是
重新调用模型生成。

## 6. Cycle Supervisor Timeline

### 6.1 事件类型

```text
CycleTimelineEvent =
  | SupervisorDecisionAcceptedEvent
  | PlanTurnCompletedEvent
  | WorkTurnStartedEvent
  | WorkTurnCompletedEvent
  | WorkTurnBlockedEvent
  | CycleTreeRevisedEvent
  | NodeArchivedEvent
  | NodeRestoredEvent
  | VerifyTurnCompletedEvent
  | CycleHumanActionRequestedEvent
  | CycleHumanActionResolvedEvent
  | CycleBudgetUpdatedEvent
  | CycleConclusionProposedEvent
  | CycleAttentionRequiredEvent
```

Supervisor每个accepted directive必须有一个`SupervisorDecisionAcceptedEvent`，但普通模型retry、schema-invalid
output和内部reasoning不展示给用户；只有最终accepted directive进入时间轴。

`CycleTreeRevisedEvent`必须列出create/update/archive/restore/reorder/dependency operations及其业务原因。
archived Issue使用Linear链接继续可访问。Human Action事件展示请求、用户选择和下一步，不复制用户comment全文。

### 6.2 Cycle comment模板

```text
## Symphony · Cycle Supervisor

<concise decision or execution outcome>

Observed
- <new Plan/Work/Verify Result, Human resolution or Tree change>

Decision
- <selected closed directive>
- Why: <Supervisor rationale>

Changes
- <created/updated/archived/restored nodes or relations>

Evidence
- <Linear/Git references>

Next
<next Plan/Work/Verify/Human/wait/conclusion step>
```

Stage Result comment使用同一Cycle模板，但`Decision`替换为`Result`，只展示bounded事实、checks、Findings和
artifact references。不得输出模型思维链或未经验证的成功声明。

## 7. 结构化渲染规则

- event contract保存语义字段，renderer负责Markdown，不让业务模块提供任意完整comment；
- Issue、Cycle、Action、Result和Git revision使用可点击引用；
- status、directive kind、outcome使用用户可理解名称，不暴露内部enum作为正文；
- reason必须来自accepted Supervisor rationale或deterministic Root gate facts；
- comment明确区分`Observed`、`Decision/Result`和`Next`，不能把proposal写成已完成事实；
- archived、canceled、superseded和failed使用精确词义，不能统一显示为“removed”或“done”；
- comment有严格byte bound；超限时保留结论和source links，省略项数量必须可见；
- renderer按`rendered_schema_version`演进，旧comment不回写重排。

## 8. 输入输出覆盖

时间轴需要覆盖以下可见I/O，但只投影durable、validated版本：

| 输入/输出 | Root comment | Cycle comment |
|---|---:|---:|
| Root status与ownership | 是 | 否 |
| Cycle create/conclusion | 是 | 是 |
| Supervisor observation摘要 | 否 | 是 |
| accepted CycleDirective | 否 | 是 |
| Plan Result | 否 | 是 |
| Work target与Result | 否 | 是 |
| Verify Result与Findings | Root只在terminal摘要 | 是 |
| DAG create/update/archive/restore | Root只在Cycle摘要 | 是 |
| Cycle Human Action request/resolution | Root只投影waiting/resumed | 是 |
| Root convergence Human Action | 是 | 否 |
| delivery | 是 | 否 |

## 9. 噪音控制

以下内容不创建timeline comment：

- heartbeat、token stream和tool progress；
- Work内部普通command失败后已自行恢复的中间步骤；
- webhook wake-up、poll、cache hit或无状态变化的reconciliation；
- invalid/stale Supervisor output，除非最终进入attention；
-重复read-back和幂等`already_applied`。

同一个durable边界只产生一条comment。Timeline用于用户理解和审计，不是运行日志镜像。

## 10. 不变量

1. Root Timeline只写Root Issue；Cycle Timeline只写matching Cycle Issue。
2. 业务模块发布typed event，不直接渲染或追加timeline comment。
3. comment只能投影已经read-back的durable facts。
4. event transport不是durable workflow authority，也不引入新数据库或队列。
5. deterministic event ID和projection marker保证crash recovery与幂等。
6. Timeline comment面向用户、结构稳定、可引用，不包含raw reasoning或secret。
7. Timeline失败不改变业务状态；下一次reconciliation可以补投影。
