# Performer Event 设计

状态：目标架构提案。Event只用于观察一次Performer Turn的实时进度；丢失全部Event也不能改变Root、Work或Gate结果。

## 1. Event边界

Event可以表达：

- Turn开始；
- Provider-neutral phase；
- 低频progress checkpoint；
- warning；
- token usage checkpoint；
- heartbeat。

Event不能表达：

- Plan或新节点树；
- Work完成；
- Human Input请求；
- Gate通过或失败；
- Linear state/Label/Comment mutation；
- Git commit或交付。

这些信息必须来自closed Result或Conductor重新读取的Linear/Git事实。

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

PerformerUsageUpdatedEvent
  input_tokens
  cached_input_tokens
  output_tokens
  reasoning_output_tokens
  total_tokens

PerformerHeartbeatEvent
```

Event不包含Provider reasoning、tool arguments、自由命令、diff、stdout/stderr、Token、Provider ID或raw exception。

## 3. 产生与消费

Provider Backend把SDK callback映射为closed Event。Conductor检查：

```text
turn_id matches
root_issue_id matches
work_issue_id matches when present
sequence increases within this process
```

重复、迟到或不匹配Event直接丢弃。Event channel使用有界buffer；buffer满时可以覆盖旧进度，不得阻塞Provider和最终Result。

## 4. Linear映射

Performer永远不直接写Linear。Conductor默认只把Event写入结构化日志。只有需要人工
关注的安全warning可以更新Root Managed Comment中的`last_error`：

| Event | Linear行为 |
|---|---|
| Turn Started | 不写 |
| Progress | 只记日志 |
| Warning Raised | 需要人工关注时更新`last_error` |
| Usage Updated | 只更新Desktop实时观察；最终累计以Result为准 |
| Heartbeat | 只记日志 |

Event不得创建Work、Human或Comment，不更新Title、Description、Label或Issue state。

## 5. Disconnect与重启

- Event不持久化、不replay；
- Conductor重启后不尝试补齐历史Event；
- 新Turn使用新的`turn_id`和sequence；
- 是否继续由Linear节点、Git和`performer_id`决定，不由Event决定。

## 6. 不变量

1. Event是best-effort观察，不是命令或事实账本。
2. Event不能结束Turn或推进Workflow。
3. Event不能恢复Human Node。
4. Event不能触发commit、PR或branch交付。
5. 最终业务状态只能来自Result加Linear/Git read-back。
6. Usage Event可以丢失，不能代替Result中的`PerformerTurnUsageSnapshot`。
