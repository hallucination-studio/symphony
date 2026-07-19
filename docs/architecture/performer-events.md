# Performer Event 设计

状态：目标架构提案。Event只用于观察一次Performer Turn的实时进度；丢失全部Event也不能改变Root、Work或Gate结果。需要用户关注的Event可以投影为Root Managed Comment，但该comment不是Workflow事实。

## 1. Event边界

Event可以表达：

- Turn开始；
- Provider-neutral phase；
- 低频progress checkpoint；
- warning；
- sanitized error；
- token usage checkpoint；
- heartbeat；
- 已经产生closed Result的Turn completion观察。

Event不能表达：

- Plan或新节点树；
- Work修改或完成payload；
- Human Input请求payload；
- Gate findings或业务判定权威；
- Linear state/Label/Comment mutation；
- Git commit或交付。

这些信息必须来自closed Result或Conductor重新读取的Linear/Git事实。
`turn_completed.result_kind`只说明Performer已经发布对应closed Result，不能代替Result。

## 2. Wire Shape

```text
PerformerTurnEvent
  protocol_version
  turn_id
  root_issue_id
  work_issue_id?
  sequence
  occurred_at
  body
```

Closed body union：

```text
PerformerTurnStartedEvent

PerformerProgressEvent
  stage:
    context_loaded
    planning
    analyzing
    editing
    checking
    reviewing
    finalizing
    waiting_provider

PerformerWarningRaisedEvent
  warning_code
  sanitized_summary

PerformerErrorRaisedEvent
  error_code
  sanitized_summary
  retryable

PerformerUsageUpdatedEvent
  input_tokens
  cached_input_tokens
  output_tokens
  reasoning_output_tokens
  total_tokens

PerformerTurnCompletedEvent
  result_kind
  sanitized_summary

PerformerHeartbeatEvent
```

Event不包含Provider reasoning、tool arguments、自由命令、diff、stdout/stderr、Token、Provider ID或raw exception。

## 3. 唯一实时传输与消费

Provider Backend把SDK callback映射为closed Event。Turn模式的Performer process只使用
一个Event传输：stdout中的newline-delimited closed Event frames，并在每帧后flush。
stderr只输出脱敏诊断；closed Result继续原子写入Result文件。

Conductor启动process前先订阅stdout并逐chunk排空。它对每个完整frame检查：

```text
turn_id matches
root_issue_id matches
work_issue_id matches when present
sequence equals the next expected value for this Turn
```

重复、迟到、不匹配或损坏的Event不投影，记录脱敏的correlation failure。同一Turn的
有界process retry由Conductor在内存中传入下一个`event_sequence_start`；新Turn从0开始。
Event channel限制总bytes、单帧大小和帧数；排空stdout不能等待Linear写入，buffer满时
可以覆盖旧progress/heartbeat，但不得阻塞Provider和最终Result。

禁止`turn-events.ndjson`、`--event-path`、Result旁路`events`数组或process退出后的
Event批量回放。Event不是journal；Conductor重启不补齐旧Event。

成功Turn先原子发布closed Result，再发`turn_completed`。`error_raised`携带脱敏错误和
retryable观察，但最终失败、重试和Workflow行为仍只由closed Result决定。

## 4. Linear映射

Performer永远不直接写Linear。Conductor把Event写入结构化日志，并把需要用户关注的
Event通过通用Root managed comment projection写入Linear。Conductor持有Root Primary
Status Comment的`comment_id`：连续状态事件按该ID upsert；warning、error和Turn
complete不带comment ID，默认append Root Timeline Comment。append以`turn_id:sequence`
作为幂等key，重复消费不得创建第二条comment。Linear comment identity不能进入
Performer Event contract。

| Event | Linear行为 |
|---|---|
| Turn Started | 按comment ID upsert Primary Status Comment |
| Progress | 按comment ID upsert Primary Status Comment |
| Warning Raised | append Timeline Comment |
| Error Raised | append Timeline Comment |
| Usage Updated | upsert Primary Status Comment；最终累计仍以Result为准 |
| Turn Completed | append Timeline Comment；不能代替Result |
| Heartbeat | 按comment ID upsert Primary Status Comment |

Event不得创建Work或Human，不更新Title、Description、Label或Issue state。Root Primary
Status Comment中的观察字段和Root Timeline Comments都不进入Issue Tree revision、input
hash、Result stale校验或调度决策；按comment ID upsert或append都不得要求刷新Root
snapshot或comment revision。日志或Linear projection失败只产生相关联的观察warning，
不能改变Result验收、retry或Workflow mutation。

## 5. Disconnect与重启

- Event channel本身不持久化、不replay；已经投影的Root managed comments保留在Linear；
- Conductor重启后不尝试补齐历史Event；
- 新Turn使用新的`turn_id`并从sequence 0开始；
- 是否继续由Linear节点、Git和`performer_id`决定，不由Event决定。

## 6. 不变量

1. Event是best-effort观察，不是命令或事实账本。
2. Event不能结束Turn或推进Workflow。
3. Event不能恢复Human Node。
4. Event不能触发commit、PR或branch交付。
5. 最终业务状态只能来自Result加Linear/Git read-back。
6. Usage Event可以丢失，不能代替Result中的`PerformerTurnUsageSnapshot`。
7. Root Primary Status和Timeline Comment中的Event状态只面向用户观察，不能成为恢复、调度或Result验收事实。
8. stdout live stream是唯一Event传输，不保留文件收集或退出后批量投影路线。
